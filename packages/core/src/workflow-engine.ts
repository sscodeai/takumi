import {
  AgentResult,
  AgentRuntimeAdapter,
  AgentTask,
  ApprovalRequest,
  ArtifactStore,
  TestResultDetail,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
  runTaskAndCollect,
  topoSort,
  validateCapabilities,
} from './index.js';
import { groupByLevel } from './workflow.js';
import { detectHardFailure, judgeGate, parseTestReport } from './quality-gate.js';
import { createGitRunner, type GitRunner } from './git-runner.js';
import { ProviderError } from './provider-error.js';
import type { CheckSummary, DeliveryMergeMethod, DeliveryProvider, MergeOutcome, PullRequestRef, PullRequestStatus } from './delivery.js';
import type { DeliveryBoardPort, DeliveryBoardProjection } from './delivery-board.js';
import { DELIVERY_BOARD_LABELS, DELIVERY_BOARD_STEP_STATES } from './delivery-board.js';
import { executeCiConfigStep, executeAwaitChecksStep } from './ci-pipeline.js';
import { collectReviewInput, verdictFromFindings } from './review.js';
import {
  describeFindings,
  isTestPath,
  runReviewRules,
  type ReviewFinding,
} from './review-rules.js';
import { randomUUID } from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requirementDigest, shortDigest } from './review-digest.js';
import { appendFeedback, parseFeedback } from './requirement-feedback.js';
import { writeRunRecord, type RunRecord, type RunRecordStep, type RunStepStatus } from './run-record.js';
import { readRequirementConfirmation, type RequirementConfirmation } from './standing-authorization.js';
import type { Usage } from './types.js';
import type { StepSandbox } from './sandbox.js';
import type { SandboxRoots } from './sandbox.js';
import { parse as parseYamlText } from 'yaml';
import { readFileSync as readTextFileSync, statSync as statFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
const execAsync = promisify(exec);
/** Runs a harness FILE without a shell, so a path in a manifest is never a shell string. */
const execFileAsync = promisify(execFile);

/**
 * HOW the document this run was bound to was confirmed (ADR-045 §4).
 *
 * The engine reads it from the DOCUMENT, which the digest has already bound: the block it copies is the
 * one the confirmation wrote, so the record cannot claim a confirmation the document does not carry. A
 * document that carries no block — a digest approved out of band (ADR-025) — reads as `digest-only`,
 * and an unreadable document does not invent one.
 */
function confirmationOf(cwd: string, ref: string): RequirementConfirmation {
  try {
    return readRequirementConfirmation(readTextFileSync(joinPath(cwd, ref), 'utf8'));
  } catch {
    return readRequirementConfirmation('');
  }
}


/**
 * What the next delivery attempt is told (ADR-034). The judge's own `not ok` lines, verbatim, plus the
 * decisions they touch — and NOTHING else: the fixtures, the expectations and the judge's source stay
 * outside the implementer's context, because an implementer that could read them could fit them (ADR-026).
 */
export function failureLinesOf(acceptanceSummary: string): string {
  const failing = acceptanceSummary
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /^not ok\b/.test(line) || /^# decisions declared here/.test(line));
  if (failing.length === 0) {
    return 'the acceptance failed without naming a failing check the engine could read: treat the run log as the brief, and note that a judge which reported nothing has told you nothing';
  }
  return failing.slice(0, 40).join('\n');
}

/**
 * One line per check that is not green, for the host issue and the pull-request comment. The list is
 * what the failure IS: a check that passed is not part of it, and a check's URL travels with it so a
 * reader can open the failing run.
 */
function renderNotGreenChecks(checks: readonly CheckSummary[]): string[] {
  return checks
    .filter((c) => c.conclusion !== 'success')
    .map((c) => `- ${c.name}: ${c.conclusion}${c.url !== undefined && c.url.length > 0 ? ` (${c.url})` : ''}`);
}

/**
 * One shell/argv command a step wants to run, and where. The engine routes every
 * step command through `runStepCommand`, which is the single place a step can
 * reach a boundary. `shell` and `argv` are mutually exclusive: a harness file is
 * run as argv (`bash <file>`) so a path in a manifest is never shell syntax.
 */
export interface StepCommandRequest {
  /** Shell command, run as `<sh> -c <shell>`. */
  shell?: string;
  /** argv form; `argv[0]` is the program, the rest are its arguments. */
  argv?: string[];
  /** Host-side working directory. Mirrored at the same absolute path inside a boundary. */
  cwd: string;
  /** Extra environment for the command, merged over the host environment. */
  env?: Record<string, string>;
  /** Wall-clock timeout in ms (default 120_000). */
  timeoutMs?: number;
  /**
   * Ask for the PLATFORM-FLAVOURED boundary: the platform repository mirrored READ-ONLY (never
   * writable), so a platform tool can run from where it lives while whatever IT runs stays
   * contained. Used by the acceptance step, whose harness is the platform's but whose SUBJECT is
   * the delivered project — model-authored code.
   *
   * Only a step that says so gets it, and only when the run has such a boundary configured
   * (`ctx.sandboxPlatform`). A run with no boundary at all runs open, which is consistent with
   * what its own record already says (`sandbox: none`).
   */
  boundary?: 'platformReadOnly';
}

/** The shape `runStepCommand` throws for a non-zero/timed-out command. */
export type StepCommandError = Error & {
  stdout?: string;
  stderr?: string;
  code?: number;
  timedOut?: boolean;
};

/**
 * Run a step command — a command that comes from the WORKFLOW DEFINITION, i.e. the PLATFORM'S OWN
 * TOOLING (`run:` scripts in this repository, the judge forge, the acceptance harness). This is
 * the only path such a command takes.
 *
 * It is deliberately NOT the path the MODEL's commands take, and that distinction is ledger #79.
 * #38 applied the boundary HERE as well, which made the platform repository invisible to the
 * platform's own tools: the chain died at `judge_forge` with `No such file or directory` while
 * the boundary's tests stayed green (ledger #75). The model's hands are contained in the runtime
 * seam (`ctx.runtime` with `sandbox` + `sandboxRoots`), which is where an agent step goes.
 *
 * Non-zero exit and timeout are reported by THROWING an error that carries `stdout`/`stderr`/
 * `code`, which is the contract the call sites already used with `exec`/`execFile`.
 */
export async function runStepCommand(
  ctx: WorkflowExecutionContext,
  req: StepCommandRequest,
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = req.timeoutMs ?? 120000;
  if ((req.shell === undefined) === (req.argv === undefined)) {
    throw new Error('runStepCommand: exactly one of shell/argv is required');
  }
  // A step that ASKS for the platform-flavoured boundary gets it (ledger #79's open item: the
  // acceptance step runs the DELIVERED project, so the subject of the check must be contained even
  // though the check itself is the platform's). Routed before the open path below, and only when
  // the run really has one.
  if (req.boundary === 'platformReadOnly' && ctx.sandboxPlatform !== undefined) {
    const res = await ctx.sandboxPlatform.runStep({
      ...(req.shell === undefined ? {} : { shell: req.shell }),
      ...(req.argv === undefined ? {} : { argv: req.argv }),
      cwd: req.cwd,
      ...(req.env === undefined ? {} : { env: req.env }),
      timeoutMs,
    });
    if (res.code !== 0) {
      const err = new Error(
        res.timedOut ? `command timed out after ${timeoutMs}ms` : `command exited with code ${res.code}`,
      ) as StepCommandError;
      err.stdout = res.stdout;
      err.stderr = res.stderr;
      err.code = res.code;
      err.timedOut = res.timedOut;
      throw err;
    }
    return { stdout: res.stdout, stderr: res.stderr };
  }
  // NO BOUNDARY ON THIS SEAM FOR EVERYTHING ELSE, deliberately — see the doc comment above and
  // ledger #79.
  //
  // Every caller here is a workflow-defined command: the platform's own tooling, which lives
  // INSIDE the repository a boundary makes invisible. Confining it confined the platform's
  // ability to see itself.
  //
  // The model's hands are contained in the RUNTIME seam instead, and that is not weakened by
  // this: an agent step's task carries `sandbox` + `sandboxRoots` into `ctx.runtime`, which
  // builds a confined session from them (runtimes/pi `confinementOf` → confined tools, and its
  // bash through the kernel boundary). `ctx.sandbox` is still consumed there; a test below pins
  // that, so this file cannot lose the boundary by dropping it here.
  const options = {
    cwd: req.cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    ...(req.env === undefined ? {} : { env: { ...process.env, ...req.env } }),
  };
  if (req.argv !== undefined) {
    const [file, ...args] = req.argv;
    if (file === undefined) throw new Error('runStepCommand: argv must not be empty');
    return await execFileAsync(file, args, options);
  }
  return await execAsync(req.shell as string, options);
}

export interface WorkflowExecutionContext {
  /** Project working directory (steps run here). */
  cwd: string;
  /** Runtime used for agent steps. */
  runtime: AgentRuntimeAdapter;
  /** Artifact store for persisting step outputs. */
  artifacts: ArtifactStore;
  /**
   * Approval callback. Return true to continue, false to abort the run.
   * CLI implementation prompts [a] approve / [r] reject / [v] view.
   */
  onApproval?: (req: ApprovalRequest) => Promise<boolean> | boolean;
  /** Optional event observer (progress reporting). */
  onEvent?: (stepId: string, message: string) => void;
  /**
   * Git seam for steps that read the real change set (`rule_review`). Absent
   * means the engine builds the default async runner — the step never spawns
   * git itself, so a test can inject a runner that refuses.
   */
  git?: GitRunner;
  /**
   * The requirement digest a human CONFIRMED for this run, and the ref it covers (ADR-025).
   *
   * An `acceptance` step refuses to run when the document at its `requirementRef` does not hash to
   * this digest: the confirmation and the acceptance must be about the same document, and a document
   * edited after the confirmation fails the step by name. Absent means no confirmation is on record,
   * which fails the step — an acceptance nobody confirmed is a machine grading its own work.
   */
  confirmedRequirement?: { ref: string; digest: string };
  /**
   * Where the IMPLEMENTATION is produced, when that is not the run's own directory (ADR-026).
   *
   * Defaults to `cwd`. The point of naming it is that the judge must live OUTSIDE it: a judge the
   * implementer can read is a judge the implementer can fit, and with a separate worktree that
   * separation is a path property a test can assert rather than a promise in a comment.
   */
  worktree?: string;
  /**
   * The run id to use. When absent the engine generates one. The CLI pre-generates it
   * so a boundary can name this run's judge directory before the first step runs.
   */
  runId?: string;
  /**
   * How this run's commands were sandboxed, as a human-readable string recorded in the
   * run record: 'unshare', 'none', or 'none (unsafe override)'. Absent records 'none'
   * honestly rather than implying a boundary that was not there (ADR-058).
   */
  sandboxNote?: string;
  /**
   * The boundary every step command in this run is routed through (ADR-058).
   * Absent means no boundary: non-delivery runs pass through, and a delivery run
   * is refused by the CLI preflight before its first agent step rather than
   * running its step commands unconfined.
   */
  sandbox?: StepSandbox;
  /**
   * The platform-flavoured boundary (project root mirrored read-only). Present for a delivery run;
   * a step must ASK for it (`StepCommandRequest.boundary`).
   */
  sandboxPlatform?: StepSandbox;
  /**
   * The roots the in-process agent tool adapters may touch (ADR-058 S5). The
   * kernel boundary confines a `bash` command; `read`/`write`/`edit`/`ls`/`find`
   * run in-process and are contained by resolving real paths against these roots.
   * Present exactly when `sandbox` is; absent leaves the runtime open (legacy).
   */
  sandboxRoots?: SandboxRoots;
  /** Max attempts per agent step before failing (default 1). */
  defaultMaxAttempts?: number;
  /**
   * Optional root of the skills registry (e.g. `<project>/extensions/skills`).
   * When set and a step declares `skill`, the step's prompt is resolved from
   * that skill's prompt template (prompts/<action>.md) — so skills drive
   * behavior, not just artifact folder naming (acceptance Gate 8).
   */
  skillsRoot?: string;
  /**
   * Loads a workflow by ref, for a `repair` step's sub-workflow (ADR-034). Injected rather than imported:
   * the engine has no opinion about where a project keeps its workflows, and a test can hand it a
   * definition. Absent means a `repair` step fails closed, saying so.
   */
  loadWorkflow?: (ref: string) => Promise<WorkflowDefinition>;
  /**
   * The host this run may publish to (ADR-037): the delivery port, injected by the caller exactly like the
   * workflow loader. The engine never talks to a code host on its own — an unattended run that can push
   * wherever it likes is a run nobody can reason about — so a `publish` step with no provider FAILS rather
   * than quietly producing a local bundle and calling it delivered.
   *
   * `openIssue` is optional on the seam because the port itself is pull-request shaped: a host that cannot
   * record an issue says so in the step summary instead of the run pretending one exists.
   */
  delivery?: DeliveryProvider & {
    openIssue?: (req: { title: string; body: string; labels?: string[] }) => Promise<{ number: string; url: string }>;
    // The return value is not used by the engine (only the host's identity is, when the call
    // succeeds), so it is `unknown` rather than `void`: a real provider answers with the comment's
    // id/url, and `Promise<{id,url}>` is not assignable to `Promise<void>`.
    commentOnPullRequest?: (ref: PullRequestRef, body: string) => Promise<unknown>;
  };
  /**
   * Defaults a `publish` step falls back to when the step does not declare them, taken from the
   * project's `delivery:` configuration. A step's own `baseBranch`/`remote` still wins. Without this
   * a base branch named once in `takumi.yaml` would reach no step, which is the "config with no
   * reader" defect in a new costume.
   */
  deliveryDefaults?: { baseBranch?: string; remote?: string };
  /**
   * The board this run PROJECTS its delivery onto for a human to read (ADR-044): write-only, injected
   * by the caller exactly like `ctx.delivery`. The engine has no default board and no board config of
   * its own, and a run with no board port projects nowhere — which is not an error: the projection is
   * for readers, and a run nobody is watching is still a run.
   *
   * ONE DELIVERY = ONE ROW, keyed by the run id: a re-run UPDATES the row it wrote before rather than
   * filing a second one, and an implementation MUST be idempotent on that id. A projection failure is
   * LOUD and NEVER FATAL (ADR-017 rule 2): the delivery was accepted by the pipeline, the judge and the
   * host, and a decorative board must not be able to un-accept it — the failure is named in the step's
   * own summary so a reader knows the row is stale, and the run is otherwise unaffected.
   */
  board?: DeliveryBoardPort;
  /**
   * Set by the repair loop on every round that is NOT the last: the failure being handled is going to be
   * retried, so the requirement document must not be edited per attempt (ADR-034). Exactly one `FB-nnn`
   * comes out of a run, whatever it spends its rounds on.
   */
  withholdAcceptanceFeedback?: boolean;
  /**
   * Durable resume (P2): previously-completed steps to skip.
   * `completed` maps stepId → its recorded result; any step in `completed`
   * is replayed from history instead of re-executed, so a long workflow can
   * continue after a crash/timeout from where it left off.
   */
  resume?: {
    completed: Map<string, WorkflowStepResult>;
    /** Set true when the whole run was previously completed (all steps done). */
    fullyCompleted?: boolean;
  };
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'completed' | 'failed' | 'skipped' | 'cancelled';
  summary: string;
  artifacts: string[];
  tests: TestResultDetail[];
}

export interface WorkflowRunResult {
  run: WorkflowRun;
  steps: WorkflowStepResult[];
  status: 'completed' | 'failed' | 'cancelled';
  /**
   * The run's final variable table. A step that learns a fact later steps need writes it here (a
   * `publish` sets `deliveryRef`, an `acceptance` sets `acceptedHead`, a `merge` sets `deliveryMerged`),
   * and a caller that runs a workflow WITHIN a workflow — the `repair` step — reads it back so a fact the
   * sub-run established (which commit the judge accepted) reaches the run that invoked it. Without this a
   * `merge` after a `repair` could not say which commit it was landing.
   */
  vars: Record<string, string>;
}

const RUNNING = new Set<string>();

/** The verdicts a prose reviewer is allowed to emit. */
export type ReviewVerdict = 'pass' | 'findings' | 'blocked';

/** Result of reading a `REVIEW_VERDICT` marker out of prose. */
export interface ParsedReviewVerdict {
  verdict?: ReviewVerdict;
  /** Why no verdict could be trusted; present exactly when `verdict` is absent. */
  error?: string;
}

const REVIEW_VERDICT_VALUES: readonly ReviewVerdict[] = ['pass', 'findings', 'blocked'];

/**
 * Strip the decoration a markdown-minded reviewer wraps around the VALUE
 * (`pass.`, `**pass**`, `` `pass` ``, "pass"). Only decoration is removed: the
 * value still has to be one of the three verdicts, and the strict
 * one-marker-per-review rule is unchanged.
 */
function normaliseVerdictToken(raw: string): string {
  return raw
    .replace(/^[*`"'\u201c\u201d\u2018\u2019]+/, '')
    .replace(/[*`"'\u201c\u201d\u2018\u2019.,;:!?\u3002\uff01\uff1f]+$/, '');
}

/**
 * Read the reviewer's verdict from a STRUCTURED marker, never from its prose.
 *
 * The reviewer must emit a line `REVIEW_VERDICT: <value>` (a `=` separator is
 * accepted; the key and the value are case-insensitive). Matching a word list
 * against free text was wrong in both directions: a real defect phrased
 * "脆弱性" or "broken" did not match, so the review passed, while `ng` without
 * a word boundary matched "all tests passing" and `Critical` matched
 * "No Critical or High issues found", so a clean review failed.
 *
 * Fail closed: a missing marker, an unknown value, or two conflicting markers
 * all produce `error` and NO verdict. The prose decides nothing.
 */
export function parseReviewVerdict(text: string): ParsedReviewVerdict {
  const seen: ReviewVerdict[] = [];
  let unknown: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*REVIEW_VERDICT\s*[:=]\s*(\S+)\s*$/i.exec(line);
    if (!match) continue;
    const raw = normaliseVerdictToken(match[1] ?? '');
    const value = raw.toLowerCase();
    if ((REVIEW_VERDICT_VALUES as readonly string[]).includes(value)) {
      seen.push(value as ReviewVerdict);
    } else if (unknown === undefined) {
      unknown = raw;
    }
  }
  if (unknown !== undefined) {
    return { error: `unrecognised REVIEW_VERDICT value "${unknown}" (expected pass, findings or blocked)` };
  }
  if (seen.length === 0) {
    return { error: 'the review verdict marker "REVIEW_VERDICT: <pass|findings|blocked>" was missing' };
  }
  const unique = [...new Set(seen)];
  if (unique.length > 1) {
    return { error: `ambiguous REVIEW_VERDICT: the review emitted both ${unique.join(' and ')}` };
  }
  return { verdict: unique[0] };
}

/** The values an acceptance harness may report. */
export const ACCEPT_VERDICT_VALUES = ['pass', 'fail'] as const;
export type AcceptVerdict = (typeof ACCEPT_VERDICT_VALUES)[number];

export interface ParsedAcceptVerdict {
  verdict?: AcceptVerdict;
  error?: string;
}

/**
 * Read the acceptance harness's verdict from a STRUCTURED marker (ADR-025), never from its prose.
 *
 * The harness is written by the same side that wants the delivery accepted, so its sentences are
 * not evidence. `ACCEPT_VERDICT: pass` is the only thing that makes the step pass, and fail-closed
 * is the rule the rest of this engine already follows: a missing marker, an unknown value, or two
 * conflicting markers all produce an error and NO verdict — which fails the step.
 */
export function parseAcceptVerdict(text: string): ParsedAcceptVerdict {
  const seen: AcceptVerdict[] = [];
  let unknown: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*ACCEPT_VERDICT\s*[:=]\s*(\S+)\s*$/i.exec(line);
    if (!match) continue;
    const raw = normaliseVerdictToken(match[1] ?? '');
    const value = raw.toLowerCase();
    if ((ACCEPT_VERDICT_VALUES as readonly string[]).includes(value)) {
      seen.push(value as AcceptVerdict);
    } else if (unknown === undefined) {
      unknown = raw;
    }
  }
  if (unknown !== undefined) {
    return { error: `unrecognised ACCEPT_VERDICT value "${unknown}" (expected pass or fail)` };
  }
  if (seen.length === 0) {
    return { error: 'the acceptance verdict marker "ACCEPT_VERDICT: <pass|fail>" was missing' };
  }
  const unique = [...new Set(seen)];
  if (unique.length > 1) {
    return { error: `ambiguous ACCEPT_VERDICT: the harness emitted both ${unique.join(' and ')}` };
  }
  return { verdict: unique[0] };
}

/**
 * One finding per line, for a step summary and the review artifact. The rules
 * already know how to render a finding; this only chooses the line shape.
 */
function renderFindingsLines(findings: readonly ReviewFinding[]): string {
  return findings.length === 0 ? '(no findings)' : findings.map((finding) => `- ${describeFindings([finding])}`).join('\n');
}

/** Extract trace IDs (REQ-xxx, UT-xxx, DESIGN-xxx...) from free text. */
export function extractTraceIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\b(REQ|UT|IT|DESIGN|EVIDENCE)-\d+\b/g)) {
    seen.add(m[0]);
  }
  return [...seen];
}

/** Determine the artifact kind for a completed workflow step. */
export function stepArtifactKind(step: WorkflowStep, fallback: string): string {
  // Artifact kind is driven by the declared step kind / workflow context, not
  // by string-prefix stripping of a runtime name (architecture invariant:
  // Core never special-cases a runtime or a vendor convention).
  return step.type === 'approval' ? 'approval' : fallback;
}

/** Render a step prompt by resolving {placeholders} from the run context. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

/** Resolve trace ids carried in the run vars (REQ-001, DESIGN-001, ...). */
function taskTraceFor(_step: WorkflowStep, vars: Record<string, string>): string[] {
  return vars['trace.ids'] ? vars['trace.ids'].split(',') : [];
}

/**
 * Resolve a step's prompt, honoring its skill (acceptance Gate 8).
 *
 * If `step.skill` is set AND `skillsRoot` is provided, load the skill's prompt
 * template from `<skillsRoot>/<skill>/prompts/<action>.md` (action from
 * `step.skillAction`, else the first entry declared in the skill manifest).
 * The resolved template then has {placeholders} substituted. Falls back to
 * `step.prompt` when no skill is configured or the skill isn't found —
 * so a missing skill never silently hangs, but a configured skill genuinely
 * drives the prompt the runtime receives.
 */
export async function resolveStepPrompt(
  step: WorkflowStep,
  skillsRoot: string | undefined,
  vars: Record<string, string>,
): Promise<string> {
  const fallback: string = renderPrompt(step.prompt ?? `Execute workflow step "${step.id}"`, vars);
  if (!step.skill || !skillsRoot) return fallback;
  const path = await import('node:path');
  const fsx = await import('node:fs');
  const skillDir = path.join(skillsRoot, step.skill);
  const manifestFile = [path.join(skillDir, 'manifest.yaml'), path.join(skillDir, 'manifest.json')].find(fsx.existsSync);
  if (!manifestFile) return fallback;
  const { parse } = await import('yaml');
  const raw = fsx.readFileSync(manifestFile, 'utf8');
  const manifest = (manifestFile.endsWith('.json') ? JSON.parse(raw) : parse(raw)) as {
    prompts?: Record<string, string>;
  };
  const prompts = manifest.prompts ?? {};
  const action = step.skillAction ?? Object.keys(prompts)[0];
  const rel = action ? prompts[action] : undefined;
  if (!rel) return fallback;
  const templatePath = path.join(skillDir, rel);
  if (!fsx.existsSync(templatePath)) return fallback;
  const template = fsx.readFileSync(templatePath, 'utf8');
  return renderPrompt(template, vars);
}

/**
 * Run a task with a hard timeout (High fix: no hung runtime can hang the
 * workflow forever). On timeout, cancel the runtime (subprocess/session abort)
 * and resolve a FAILED result with a clear message — never leave the caller
 * suspended and never silently re-run the task.
 */
async function runStepWithTimeout(
  runtime: AgentRuntimeAdapter,
  task: AgentTask,
  timeoutMs: number | undefined,
): Promise<AgentResult> {
  if (!timeoutMs) {
    return runTaskAndCollect(runtime, task);
  }
  /** The bound's timer, kept so the `finally` below can clear it (see docs/bugs-fixed.md #71). */
  let handle: ReturnType<typeof setTimeout> | undefined;
  const runPromise = runTaskAndCollect(runtime, task);
  const timeoutResult: AgentResult = {
    taskId: task.id,
    status: 'failed',
    summary: `step timed out after ${timeoutMs}ms`,
    changedFiles: [],
    tests: [],
    usage: { runtimeId: '', model: null, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, durationMs: timeoutMs },
    artifacts: [],
    trace: [],
    error: `timeout after ${timeoutMs}ms`,
  };
  const timer = new Promise<AgentResult>((resolve) => {
    handle = setTimeout(() => {
      // Best-effort cancel; the in-flight run settles in the background. We
      // resolve FAILED immediately — never hang the workflow on a stuck runtime.
      void runtime.cancel(task.id);
      resolve(timeoutResult);
    }, timeoutMs);
    // A step's bound must not outlive the step. Without this the handle keeps the event loop alive for the
    // whole bound after the work is done (observed 2026-10-12: a test whose step declared a 600 s bound
    // finished all its assertions and then sat there for ten minutes — docs/bugs-fixed.md #71), which is
    // the one way a declared bound makes a process LESS well behaved than no bound at all.
    handle.unref?.();
  });
  try {
    return await Promise.race([runPromise, timer]);
  } finally {
    // Cleared, not a no-op: a timer that outlives its step is a leaked handle, and clearing it is what
    // makes "the step was bounded" true of the process as well as of the workflow.
    if (handle !== undefined) clearTimeout(handle);
  }
}
export async function executeWorkflow(
  workflow: WorkflowDefinition,
  ctx: WorkflowExecutionContext,
  inputVars: Record<string, string> = {},
): Promise<WorkflowRunResult> {
  // Capability validation before anything runs (invariant: validate before execute)
  const required = [...(workflow.requires ?? []), ...workflow.steps.flatMap((s) => s.requires ?? [])];
  const capCheck = validateCapabilities(ctx.runtime, required as string[]);
  if (!capCheck.ok) {
    const missing = (capCheck as { ok: false; missing: string[] }).missing;
    throw new Error(
      `workflow "${workflow.name}" requires capabilities [${missing.join(', ')}] not provided by runtime "${ctx.runtime.metadata().id}"`,
    );
  }

  const order = topoSort(workflow.steps);
  const runId = ctx.runId ?? `wf-${randomUUID().slice(0, 8)}`;
  const run: WorkflowRun = {
    id: runId,
    workflow,
    runtimeId: ctx.runtime.metadata().id,
    stepStatus: Object.fromEntries(order.map((id) => [id, 'pending'] as const)),
    stepResults: {},
    order,
    status: 'pending',
    startedAt: Date.now(),
  };
  const stepResults: WorkflowStepResult[] = [];
  const vars: Record<string, string> = { ...inputVars };

  // --- what the run record needs, collected as the run happens -------------------------------
  // Per-step wall-clock duration: the start is stamped when a step begins and the finish when
  // its result is recorded. A step's result is pushed through `pushStep`, so every one of the
  // loop's branches is timed without touching each branch.
  const stepStartedAt = new Map<string, number>();
  const stepDurationMs = new Map<string, number>();
  const pushStep = (result: WorkflowStepResult): void => {
    if (!stepDurationMs.has(result.stepId)) {
      const started = stepStartedAt.get(result.stepId) ?? run.startedAt;
      stepDurationMs.set(result.stepId, Math.max(0, Date.now() - started));
    }
    stepResults.push(result);
  };
  /**
   * The token usage the RUNTIME reported, one entry per agent task that came back with a real
   * result. A timeout's synthesized usage is NOT collected (it carries `usageUnavailable`): the
   * runtime never reported it, and recording a zero would read as "free" rather than "unknown".
   */
  const usages: Usage[] = [];
  const collectUsage = (usage: Usage | undefined): void => {
    if (usage === undefined) return;
    if ((usage.extra ?? {})['usageUnavailable'] !== undefined) return;
    usages.push(usage);
  };
  // The references the run opened/landed, captured structurally (the step summaries are prose;
  // a later reader must not have to parse them). Null until a step sets them.
  let publishedPr: { number: string; url: string } | null = null;
  let publishedIssue: { number: string } | null = null;
  let boardRowId: string | null = null;
  /**
   * The document THIS RUN was confirmed against (ADR-025). Every step that names `{requirement}` —
   * in a `requirementRef` or in a prompt — means THAT document, so the name is filled once, here,
   * for the whole run.
   *
   * This used to be filled only for steps that carry a `requirementRef`, and NOT for the ones that
   * carry a prompt. The implementer's prompt therefore kept the literal text `{requirement}`: the
   * agent was told to read a document whose path had never been substituted, went looking for a
   * requirement on its own, found a different document in the repository and implemented THAT — with
   * its own tests passing, because a green suite only says the implementer agrees with the
   * implementer. A run confirmed against one document delivered another (docs/bugs-fixed.md, 34).
   * A placeholder the run cannot fill is a prompt that lies, so the workflow is refused before any
   * step runs rather than after an agent has been paid to guess.
   */
  const confirmedRef = ctx.confirmedRequirement?.ref ?? '';
  vars['requirement'] = confirmedRef;
  if (confirmedRef.length === 0) {
    const namesRequirement = workflow.steps.filter((s) =>
      [s.prompt ?? '', s.requirementRef ?? '', s.acceptanceRef ?? '', s.forgeRef ?? ''].some((t) =>
        t.includes('{requirement}'),
      ),
    );
    if (namesRequirement.length > 0) {
      throw new Error(
        `workflow "${workflow.name}" names {requirement} in step(s) [${namesRequirement
          .map((s) => s.id)
          .join(', ')}] — the document the run was confirmed against — but this run has no confirmed requirement on record (pass --requirement and --confirmed-requirement)`,
      );
    }
  }

  /**
   * A step may say `requirementRef: "{requirement}"`: the document THIS RUN was confirmed against
   * (ADR-025). It is the difference between a workflow that can only ever run on one file and one that
   * runs on whatever a human confirmed — and it fails closed when there is no confirmation to point at,
   * rather than resolving to a path nobody confirmed.
   */
  const requirementRefOf = (raw: string | undefined): { ref: string; error?: string } => {
    const ref = renderPrompt(raw ?? '', vars).trim();
    if (raw !== undefined && raw.includes('{requirement}') && confirmedRef.length === 0) {
      return {
        ref,
        error:
          'this workflow points at {requirement} — the document the run was confirmed against — but this run has no confirmed requirement on record (pass --requirement and --confirmed-requirement)',
      };
    }
    return { ref };
  };

  /**
   * The row title a delivery projects under: the confirmed requirement's ref when there is one, else
   * the workflow's name — the SAME `itemId` the `publish` step already uses, so a board row and the
   * pull request it is about name the same thing.
   */
  const boardItemId = ctx.confirmedRequirement?.ref ?? workflow.name;

  /**
   * Project one delivery step onto the board (ADR-044) and return the line a reader sees in the step's
   * own summary — or `null` when this run has no board port, so a run that projects nowhere is not
   * decorated with a line about a board it never had.
   *
   * LOUD and NEVER FATAL: the projection is for readers, and a decorative board must not be able to
   * un-accept a delivery the pipeline, the judge and the host already accepted. So every failure is
   * caught HERE and reported as what it is, and no caller's step outcome depends on this returning.
   */
  const projectBoard = async (input: Omit<DeliveryBoardProjection, 'runId' | 'title'>): Promise<string | null> => {
    const board = ctx.board;
    if (board === undefined) return null;
    try {
      const ref = await board.project({ runId, title: boardItemId, ...input });
      boardRowId = ref.id;
      return `board: row ${ref.created ? 'created' : 'updated'} (${ref.id}${ref.url.length > 0 ? `, ${ref.url}` : ''})`;
    } catch (e) {
      return `board: COULD NOT be written (${e instanceof Error ? e.message : String(e)}) — the delivery is unaffected; the row is stale`;
    }
  };

  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const failedIds = new Set<string>();
  // Steps that did not run because their own dependencies were unmet. A skipped
  // step must propagate: it is not evidence that its dependency succeeded.
  const skippedIds = new Set<string>();
  // Per-run sequential ids for ACCEPT artifacts, in manifest order (ACCEPT-001, ...). An acceptance
  // is identified by the requirement it is about, so several in one workflow stay distinguishable.
  const acceptanceIds = new Map<string, string>();
  for (const s of workflow.steps) {
    if (s.type === 'acceptance') acceptanceIds.set(s.id, `ACCEPT-${String(acceptanceIds.size + 1).padStart(3, '0')}`);
  }
  // Rejections are numbered in the order they happen: a run may hold several acceptances.
  let rejectSeq = 0;
  /**
   * At most ONE pipeline-failure issue per run (ADR-037). A host issue is a record of a failure;
   * a second `await_checks` step failing for the same run must not file a second one. The flag is
   * set BEFORE the attempt, so a create that actually succeeded but whose response was lost cannot
   * produce a duplicate on the next step.
   */
  let pipelineIssueFiled = false;

  /**
   * Assemble and write the run's machine-readable record: `.takumi/runs/<run-id>.json`.
   *
   * WHAT HAPPENS WHEN IT CANNOT BE PRODUCED — the decision this workstream asks for: a PARTIAL
   * record is written, marked `partial: true` with the reason, rather than failing the run. The
   * run's outcome is decided by its steps; a record-keeping failure must not rewrite that outcome,
   * and no file at all would be indistinguishable from a run that never happened — silently
   * dropping this run out of every future statistic the aggregator computes. If even the partial
   * write fails (a full disk, a read-only tree), the failure is LOUD on the run's own event channel
   * and NEVER FATAL, for the same reason.
   */
  const writeRecord = (finalStatus: 'completed' | 'failed' | 'cancelled'): void => {
    const steps: RunRecordStep[] = stepResults.map((s) => ({
      id: s.stepId,
      // The step's declared type from the definition; the synthetic `workflow` failure entry
      // (an error thrown outside any step) has no definition, so it is kinded `workflow`.
      kind: byId.get(s.stepId)?.type ?? 'workflow',
      // `completed` is recorded as `done`: the record says what happened, not which enum the
      // engine happens to use. cancelled/failed/skipped pass through unchanged.
      status: (s.status === 'completed' ? 'done' : s.status) as RunStepStatus,
      durationMs: stepDurationMs.get(s.stepId) ?? 0,
      summary: s.summary,
    }));
    const firstFailed = stepResults.find((s) => s.status === 'failed');
    const models = [...new Set(usages.map((u) => u.model ?? '').filter((m) => m.length > 0))];
    // COST: the runtime's own numbers, or a plain statement that it reported none. Never a 0 that
    // would read as "free", and never an omitted field that would read as "not measured".
    const cost: RunRecord['cost'] =
      usages.length === 0
        ? { available: false, why: 'the runtime reports no token usage' }
        : {
            available: true,
            runtimeId: run.runtimeId,
            models,
            promptTokens: usages.reduce((n, u) => n + u.promptTokens, 0),
            completionTokens: usages.reduce((n, u) => n + u.completionTokens, 0),
            totalTokens: usages.reduce((n, u) => n + u.totalTokens, 0),
            costUsd: usages.reduce((n, u) => n + u.costUsd, 0),
            stepsReporting: usages.length,
          };
    const finishedAt = run.finishedAt ?? Date.now();
    const record: RunRecord = {
      runId,
      workflow: workflow.name,
      requirement:
        ctx.confirmedRequirement === undefined
          ? null
          : {
              ref: ctx.confirmedRequirement.ref,
              digest: ctx.confirmedRequirement.digest,
              // Read from the document, not from the caller: the record says HOW the document was
              // confirmed, and the digest is what makes the block it copies the confirmation's own.
              confirmation: confirmationOf(ctx.cwd, ctx.confirmedRequirement.ref),
            },
      startedAt: new Date(run.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: Math.max(0, finishedAt - run.startedAt),
      steps,
      outcome: finalStatus,
      // The same mapping the CLI's exit code uses: a failed or cancelled run is not a success.
      exitCode: finalStatus === 'completed' ? 0 : 1,
      // "Accepted" here is the run's own completion: no step failed. The JUDGE's verdict, when the
      // run ran an acceptance, is recorded in the ACCEPT artifact the acceptance step wrote.
      accepted: finalStatus === 'completed',
      failure: firstFailed === undefined ? null : { stepId: firstFailed.stepId, message: firstFailed.summary },
      published: {
        pullRequest: publishedPr,
        issue: publishedIssue,
        mergedSha: vars['mergedHead'] ?? null,
      },
      boardRowId,
      cost,
      sandbox: ctx.sandboxNote ?? 'none',
    };
    const result = writeRunRecord(ctx.cwd, record);
    ctx.onEvent?.(
      'workflow',
      result.written
        ? `run record: ${result.path}`
        : `run record COULD NOT be written (${result.error ?? 'unknown error'}): the run's outcome is unaffected, but this run will be missing from \`takumi runs\``,
    );
  };

  try {
    // P2 parallel: pre-execute all no-dependency AGENT steps concurrently.
    // (Independent steps at topo level 0 can run in parallel; their results
    // are cached and the main loop replays them from cache.)
    const levels = groupByLevel(workflow.steps, order);
    const preRun = new Map<string, WorkflowStepResult>();
    if (levels[0] && levels[0].length > 1 && ctx.runtime.capabilities().capabilities.includes('parallelExecution')) {
      const lvl0 = levels[0].filter((id) => byId.get(id)?.type === 'agent');
      if (lvl0.length > 1) {
        const runOne = async (stepId: string): Promise<WorkflowStepResult> => {
          const step = byId.get(stepId)!;
          run.stepStatus[stepId] = 'running';
          ctx.onEvent?.(stepId, `parallel run`);
          const task: AgentTask = {
            id: `${runId}:${stepId}:1`,
            prompt: await resolveStepPrompt(step, ctx.skillsRoot, vars),
            cwd: ctx.worktree ?? ctx.cwd,
            trace: vars['trace.ids'] ? vars['trace.ids'].split(',') : [],
            context: { workflowStep: stepId, workflow: workflow.name, ...vars },
            options: {
              ...(ctx.sandbox === undefined ? {} : { sandbox: ctx.sandbox }),
              ...(ctx.sandboxRoots === undefined ? {} : { sandboxRoots: ctx.sandboxRoots }),
            },
          };
          try {
            const res = await runStepWithTimeout(ctx.runtime, task, step.timeoutMs);
            collectUsage(res.usage);
            if (res.status === 'completed') {
              const art = res.summary ? await ctx.artifacts.write({
                taskId: task.id, kind: stepArtifactKind(step, stepId.split('_')[0] ?? 'output'),
                fileName: `${stepId}.md`, content: `# ${stepId}\n\n${res.summary}\n`,
                contentType: 'text/markdown', trace: task.trace ?? [],
              }).catch(() => null) : null;
              return { stepId, status: 'completed', summary: res.summary, artifacts: art ? [art.path] : [], tests: res.tests };
            }
            return { stepId, status: 'failed', summary: res.error ?? res.summary, artifacts: [], tests: res.tests };
          } catch (e) {
            return { stepId, status: 'failed', summary: e instanceof Error ? e.message : String(e), artifacts: [], tests: [] };
          }
        };
        const batchStart = Date.now();
        const results = await Promise.all(lvl0.map(runOne));
        // Parallel steps share one wall-clock window: each records the duration of the batch,
        // which is what the run actually spent on them.
        const batchMs = Math.max(0, Date.now() - batchStart);
        for (const r of results) {
          stepDurationMs.set(r.stepId, batchMs);
          preRun.set(r.stepId, r);
          vars[`step.${r.stepId}`] = r.summary;
        }
      }
    }
    for (const stepId of order) {
      // Stamp the step's start: `pushStep` turns this into the step's recorded duration.
      stepStartedAt.set(stepId, Date.now());
      const step = byId.get(stepId);
      if (!step) {
        run.stepStatus[stepId] = 'failed';
        throw new Error(`workflow step ${stepId} not found in definition`);
      }

      // Replay a concurrently pre-executed level-0 agent step.
      const pre = preRun.get(stepId);
      if (pre) {
        run.stepStatus[stepId] = pre.status;
        pushStep(pre);
        if (pre.status === 'completed') done.add(stepId);
        else if (pre.status === 'skipped') skippedIds.add(stepId);
        else failedIds.add(stepId);
        ctx.onEvent?.(stepId, `parallel result: ${pre.status}`);
        continue;
      }

      // Skip a step whose dependencies failed OR were themselves skipped: a step
      // that did not run cannot be a satisfied dependency. Checking only the
      // failed set let a failure stop its DIRECT children while the rest of the
      // pipeline still ran — observed with a failed quality_gate whose dependent
      // rule_review was skipped, after which artifact_acceptance and delivery both
      // executed and reported success.
      const deps = step.dependsOn ?? [];
      const unmet = deps.filter((d) => failedIds.has(d) || skippedIds.has(d));
      if (unmet.length > 0) {
        const because = unmet.some((d) => failedIds.has(d)) ? 'dependency failed' : 'dependency skipped';
        run.stepStatus[stepId] = 'skipped';
        skippedIds.add(stepId);
        pushStep({ stepId, status: 'skipped', summary: `skipped (${because}: ${unmet.join(', ')})`, artifacts: [], tests: [] });
        continue;
      }

      // Durable resume: replay a previously-completed step from history
      // instead of re-executing it (P2). Its recorded result is reused as-is.
      const resumed = ctx.resume?.completed.get(stepId);
      if (resumed) {
        run.stepStatus[stepId] = 'completed';
        pushStep(resumed);
        done.add(stepId);
        ctx.onEvent?.(stepId, `resumed from history (${resumed.status})`);
        continue;
      }
      // A fully-completed prior run means everything is already done.
      if (ctx.resume?.fullyCompleted) {
        run.stepStatus[stepId] = 'completed';
        continue;
      }

      if (step.type === 'approval') {
        run.stepStatus[stepId] = 'running';
        ctx.onEvent?.(stepId, 'approval required');
        const req: ApprovalRequest = {
          id: `${runId}:${stepId}`,
          workflowRunId: runId,
          taskId: '',
          stepId,
          prompt: step.prompt ?? `Do you approve step "${stepId}"?`,
          options: ['approve', 'reject', 'view'],
          createdAt: Date.now(),
        };
        const approved = await (ctx.onApproval ? ctx.onApproval(req) : true);
        if (!approved) {
          run.stepStatus[stepId] = 'failed';
          run.status = 'cancelled';
          pushStep({ stepId, status: 'failed', summary: 'rejected by approver', artifacts: [], tests: [] });
          run.finishedAt = Date.now();
          writeRecord('cancelled');
          return { run, steps: stepResults, status: 'cancelled', vars };
        }
        run.stepStatus[stepId] = 'completed';
        pushStep({ stepId, status: 'completed', summary: 'approved', artifacts: [], tests: [] });
        done.add(stepId);
        continue;
      }

      // Tool step: run a real shell command in the project cwd (Gate 9).
      // A tool step's `prompt` is the command to execute with {placeholders}
      // resolved. Its stdout becomes the step summary and is persisted as an
      // artifact — so Tool Plugins are real, not a TODO.
      if (step.type === 'tool') {
        run.stepStatus[stepId] = 'running';
        const cmd = renderPrompt(step.prompt ?? '', vars);
        try {
          ctx.onEvent?.(stepId, `tool run: ${cmd}`);
          const { stdout, stderr } = await runStepCommand(ctx, { shell: cmd, cwd: ctx.worktree ?? ctx.cwd, timeoutMs: step.timeoutMs ?? 120000 });
          const out = (stdout?.trim() || stderr?.trim() || '(no output)').slice(0, 4000);
          const kind = step.id.split('_')[0] ?? 'tool';
          const artifact = await ctx.artifacts.write({
            taskId: `${runId}:${stepId}`,
            kind,
            fileName: `${stepId}.output.txt`,
            content: `$ ${cmd}\n${out}`,
            contentType: 'text/plain',
            trace: taskTraceFor(step, vars),
          });
          run.stepStatus[stepId] = 'completed';
          pushStep({ stepId, status: 'completed', summary: out, artifacts: [artifact.path], tests: [] });
          ctx.onEvent?.(stepId, `tool completed (${artifact.path})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          run.stepStatus[stepId] = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary: `tool failed: ${msg}`, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `tool failed: ${msg}`);
        }
        done.add(stepId);
        continue;
      }

      // Quality Gate step: enforce a test/quality threshold — a REAL gate.
      // Its `prompt` is a command whose stdout is parsed for test results
      // (# fail N / not ok / failure). Any failing test (or non-zero exit)
      // FAILS the gate and ABORTS the workflow (no downstream step runs).
      // This is the Japanese SI Quality Gate — not decorative.
      if (step.type === 'quality_gate') {
        run.stepStatus[stepId] = 'running';
        const cmd = renderPrompt(step.prompt ?? 'npm test', vars);
        ctx.onEvent?.(stepId, `quality gate run: ${cmd}`);
        let out = '';
        let exitOk = true;
        try {
          const r = await runStepCommand(ctx, { shell: cmd, cwd: ctx.worktree ?? ctx.cwd, timeoutMs: step.timeoutMs ?? 300000 });
          out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        } catch (e) {
          exitOk = false;
          const msg = e instanceof Error && 'stdout' in e ? `${(e as { stdout?: string }).stdout ?? ''}${(e as { stderr?: string }).stderr ?? ''}` : e instanceof Error ? e.message : String(e);
          out = msg;
        }
        // Parse and judge test outcome in a pure, testable module. The parser
        // recognises TAP, jest/vitest, pytest, Maven and gradle/JUnit shapes;
        // anything else is `unrecognised` and FAILS CLOSED (there is no
        // `fails > 0 ? fails : 1` fallback: no known summary = no evidence).
        // A gate with ZERO tests is NOT green (Quality Gate must be enforced:
        // no tests at all = the gate has nothing to vouch for → ABORT).
        const report = parseTestReport(out);
        // A build that gave up (compile error, toolchain refusal) is a hard fail.
        // Judged on the BUILD's output, not on the runner's reporting lines: a
        // test name mentioning a build failure is not a build failure.
        const hardFail = detectHardFailure(out);
        const verdict = judgeGate(report, { exitOk, hardFail });
        const gatePassed = verdict.passed;
        const fails = report.shape === 'unrecognised' ? 0 : report.failed;
        const totalTests = report.shape === 'unrecognised' ? 0 : report.total;
        // Keep the summary diagnosable: the raw command, the parser verdict and
        // the output tail, so a human does not reach for `|| true` first.
        const shapeLine =
          report.shape === 'unrecognised'
            ? `shape: unrecognised (no known test summary found in the output)\ncommand: ${cmd}`
            : `shape: ${report.shape}\ncommand: ${cmd}`;
        const summary = `quality_gate ${gatePassed ? 'PASSED' : 'FAILED'}: ${fails} failing over ${totalTests} tests, exit ${exitOk ? 0 : '!0'}\n${shapeLine}\nreason: ${verdict.reason}\n${out.slice(0, 1200)}`;
        if (gatePassed) {
          run.stepStatus[stepId] = 'completed';
          pushStep({ stepId, status: 'completed', summary, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `quality gate PASSED (${fails} failing)`);
        } else {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `quality gate FAILED (${fails} failing) — workflow aborted`);
        }
        done.add(stepId);
        continue;
      }

      // Repair step (ADR-034): the delivery attempt, and the rounds that follow a refusal. The
      // sub-workflow is the chain that produces evidence (implementation → tests → gate → review → forge
      // → acceptance). This step runs it, and on a refusal hands the FAILING CHECKS to the next attempt
      // as `{repairFailures}` — the implementer sees what failed, never the judge's fixtures, its
      // expectations or its source. Every round re-runs the whole chain: a repair is a delivery like any
      // other, so an agent that "fixes" a failing relation by weakening the test that covers it is caught
      // by rule_review in the same round, not after the fact. Only the LAST round writes the failure back
      // into the requirement document (ctx.withholdAcceptanceFeedback), so a run that repairs itself
      // leaves the human's document untouched.
      if (step.type === 'repair') {
        run.stepStatus[stepId] = 'running';
        const repairRef = (step.repairRef ?? '').trim();
        const maxRounds = step.maxRounds ?? 1;
        const failStep = (summary: string): void => {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `repair FAILED: ${summary.split('\n')[0]}`);
        };
        if (ctx.loadWorkflow === undefined) {
          failStep(
            `a repair step needs a workflow loader to read "${repairRef}" and this run has none (ctx.loadWorkflow): the sub-workflow could not be read, so no delivery attempt was made`,
          );
          done.add(stepId);
          continue;
        }
        let sub: WorkflowDefinition;
        try {
          sub = await ctx.loadWorkflow(repairRef);
        } catch (e) {
          failStep(
            `the repair sub-workflow "${repairRef}" could not be loaded (${e instanceof Error ? e.message : String(e)}): a repair loop with nothing to run is not a repair`,
          );
          done.add(stepId);
          continue;
        }
        // WHAT JUDGES AN ATTEMPT IS NOT ALWAYS AN `acceptance`. An acceptance is BOUND to a confirmed
        // requirement (ADR-025) and the intake's attempt runs BEFORE anything is confirmed, so requiring
        // one there is unsatisfiable by construction: the first version of the intake repair round failed
        // with "no confirmed requirement is on record for this run" without ever running its gate
        // (docs/bugs-fixed.md #72). A `quality_gate` reports the same TAP failures and is the right verdict
        // for an attempt whose subject is the document itself.
        if (!sub.steps.some((s) => s.type === 'acceptance' || s.type === 'quality_gate')) {
          failStep(
            `the repair sub-workflow "${repairRef}" declares neither an acceptance nor a quality gate step: a repair loop with nothing to judge it cannot know when to stop`,
          );
          done.add(stepId);
          continue;
        }

        const roundSummaries: string[] = [];
        const subArtifacts: string[] = [];
        const subTests: WorkflowStepResult['tests'] = [];
        let failures = '';
        let accepted = false;
        let spent = 0;
        let abort: string | undefined;
        for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
          spent = attempt;
          const lastRound = attempt === maxRounds;
          const label = attempt === 1 ? `attempt 1 of ${maxRounds}` : `repair round ${attempt} of ${maxRounds}`;
          vars['repairRound'] = `${attempt} of ${maxRounds}`;
          vars['repairFailures'] = failures;
          ctx.onEvent?.(
            stepId,
            attempt === 1
              ? `delivery ${label}`
              : `${label}: the previous attempt was refused, so this one is told exactly which checks failed${lastRound ? ' — this is the last round, and its failure is the one that comes back to the document' : ''}`,
          );
          let res: WorkflowRunResult;
          try {
            res = await executeWorkflow(sub, { ...ctx, withholdAcceptanceFeedback: !lastRound }, vars);
          } catch (e) {
            abort = `delivery ${label} could not be run (${e instanceof Error ? e.message : String(e)})`;
            break;
          }
          // The attempt's verdict: an `acceptance` OR a `quality_gate` (see the guard above). Both end in
          // TAP and both name their failing checks, which is what a repair round needs and all it needs.
          const verdictType = (id: string): string | undefined => sub.steps.find((d) => d.id === id)?.type;
          // WHICH STEP IS THE ATTEMPT'S VERDICT, WHEN IT DECLARES BOTH (ledger #86). The delivery attempt
          // has a `quality_gate` over the delivered project's OWN tests AND the forged `acceptance`, and the
          // acceptance is the authority: it is the check the DOCUMENT declared, while in a scenario-judged
          // delivery the gate passes by construction (the implementer wrote those tests). Taking the first
          // match made the gate the verdict, so an attempt its JUDGE refused was briefed to the next round
          // as "quality_gate PASSED: 0 failing over 592 tests" — nothing to repair. Measured 2026-10-13:
          // the repair round then spent 30 minutes and timed out, and the run record showed the passing gate
          // where the judge's verdict belonged, so the judge's reason was nowhere to be found afterwards.
          // The intake's attempt declares NO acceptance (ADR-057), so its shape gate stays its verdict.
          const pickVerdict = (kind: string) => res.steps.find((s) => verdictType(s.stepId) === kind);
          const acceptance = pickVerdict('acceptance') ?? pickVerdict('quality_gate');
          // THE BRIEF COMES FROM THE STEP THAT FAILED, when the acceptance never ran. The acceptance is
          // SKIPPED while any step it depends on fails, so on the round after an upstream refusal its
          // summary is empty and the next attempt would be handed "a judge which reported nothing has told
          // you nothing" while the run log named the check that refused. Observed 2026-10-12 in the third
          // unattended chain: a `judge_forge` refusal reached the next attempt as that sentence, and the
          // implementer — told to repair a failure it could not touch — left the delivery worktree and
          // edited this repository instead (docs/bugs-fixed.md #68).
          const lastFailed = res.steps.filter((s) => s.status === 'failed').pop();
          const brief =
            acceptance?.status === 'completed'
              ? (acceptance.summary ?? '')
              : (lastFailed?.summary ?? acceptance?.summary ?? '');
          for (const s of res.steps) {
            subArtifacts.push(...s.artifacts);
            subTests.push(...s.tests);
          }
          const passed = res.status === 'completed' && acceptance?.status === 'completed';
          roundSummaries.push(
            `--- ${label}: ${passed ? 'accepted' : 'refused'} ---\n${acceptance?.summary ?? '(the acceptance step did not run)'}`,
          );
          if (passed) {
            accepted = true;
            // The head the sub-run's acceptance JUDGED is carried up into this run's vars (ADR-040): a
            // `merge` in the workflow that invoked this repair must land that commit, and it can only name
            // it if the fact crosses the sub-run boundary. The repair loop is the one place a sub-workflow's
            // facts reach the run that started it.
            if (res.vars['acceptedHead'] !== undefined) vars['acceptedHead'] = res.vars['acceptedHead'];
            break;
          }
          // A FAILURE NO IMPLEMENTATION CAN REPAIR ENDS THE LOOP. `judge_forge` derives the judge from
          // the CONFIRMED DOCUMENT, not from the delivery, and a document does not change between
          // attempts: another round can only spend. (Measured: the round after a `judge_forge` refusal
          // re-paid 1 047 s to fail identically — docs/bugs-fixed.md #68.) The document is the operator's,
          // so the run stops here and names the step and its reason rather than burning the last round.
          const documentLevel = res.steps.find(
            (s) => s.status === 'failed' && sub.steps.find((d) => d.id === s.stepId)?.type === 'judge_forge',
          );
          if (documentLevel !== undefined) {
            abort = `the judge could not be forged from the confirmed document (${documentLevel.stepId}), and no implementation can change it: the remaining round(s) were not spent\n${documentLevel.summary ?? ''}`;
            run.stepStatus[stepId] = 'failed';
            break;
          }
          failures = failureLinesOf(brief);
        }

        const summary = [
          accepted
            ? `delivery accepted on ${spent === 1 ? 'the first attempt' : `attempt ${spent} of ${maxRounds}`}`
            : abort !== undefined
              ? `delivery reached no verdict: ${abort}`
              : `delivery refused after ${spent} of ${maxRounds} attempt(s): the last failure was written back to the requirement document`,
          ...roundSummaries,
        ].join('\n');
        run.stepStatus[stepId] = accepted ? 'completed' : 'failed';
        if (!accepted) run.status = 'failed';
        if (!accepted) failedIds.add(stepId);
        pushStep({
          stepId,
          status: accepted ? 'completed' : 'failed',
          summary,
          artifacts: subArtifacts,
          tests: subTests,
        });
        ctx.onEvent?.(
          stepId,
          accepted
            ? `delivery accepted after ${spent} attempt(s)`
            : `delivery refused after ${spent} attempt(s) — the delivery step is skipped`,
        );
        done.add(stepId);
        continue;
      }

      // Rule Review step: the DETERMINISTIC reviewer (ADR-013) over the real
      // change set. It resolves the frozen base and the delivered head to SHAs
      // through the injected GitRunner (never by spawning git here), collects
      // the change set, lets the pure rules judge it, and fails closed on a
      // block finding, on a human decision, and on a review that could not run.
      if (step.type === 'rule_review') {
        run.stepStatus[stepId] = 'running';
        const git = ctx.git ?? createGitRunner();
        const kind = step.id.split('_')[0] ?? 'review';
        const baseRef = step.baseRef?.trim() ?? '';
        const headRef = step.headRef?.trim() || 'HEAD';

        const writeFindingsArtifact = async (verdictLine: string, details: string): Promise<string | null> => {
          try {
            const artifact = await ctx.artifacts.write({
              taskId: `${runId}:${stepId}`,
              kind,
              fileName: `${stepId}.md`,
              content: `# ${stepId} (rule_review)\n\nbase: ${baseRef || '(none)'}  |  head: ${headRef}\n\n${verdictLine}\n\n${details}\n`,
              contentType: 'text/markdown',
              trace: taskTraceFor(step, vars),
            });
            return artifact.path;
          } catch (e) {
            ctx.onEvent?.(stepId, `artifact persist failed: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          }
        };

        const failRuleReview = async (summary: string, findings: readonly ReviewFinding[] = []): Promise<void> => {
          const artifactPath = await writeFindingsArtifact(`verdict: FAILED`, `${summary}\n\n${renderFindingsLines(findings)}`);
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({
            stepId,
            status: 'failed',
            summary: artifactPath === null ? summary : `${summary}\nrule_review artifact: ${artifactPath}`,
            artifacts: artifactPath === null ? [] : [artifactPath],
            tests: [],
          });
          ctx.onEvent?.(stepId, `rule review FAILED: ${summary.split('\n')[0]}`);
        };

        /**
         * The repository the change set lives in. With a delivery worktree that is the WORKTREE, not
         * the project: the two are separate repositories with no shared objects, so resolving `HEAD`
         * in the project repo and diffing it in the worktree exits 128 ("bad object") — a review that
         * could not run, for a change set that was right there (docs/bugs-fixed.md, 35).
         */
        const reviewCwd = ctx.worktree ?? ctx.cwd;

        /** Resolve a ref to a commit sha through the git seam; undefined = could not. */
        const resolveSha = async (ref: string): Promise<string | undefined> => {
          try {
            const resolved = await git.run(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: reviewCwd });
            if (resolved.exitCode !== 0) return undefined;
            const sha = resolved.stdout.trim().split('\n')[0]?.trim() ?? '';
            return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
          } catch {
            return undefined;
          }
        };

        /**
         * `baseRef: root` is the root commit of the repository under review — the point the delivery
         * started from. `HEAD~1` is the wrong question for a delivery worktree: it names the parent of
         * whatever happens to be on top, so a delivery with two commits (implementation, then tests)
         * silently reviews only the last one. Reviewing everything the delivery added is what the
         * step claims to do, so it is said as `root` rather than inferred from a distance.
         */
        const rootOf = async (sha: string): Promise<string | undefined> => {
          try {
            const listed = await git.run(['rev-list', '--max-parents=0', sha], { cwd: reviewCwd });
            if (listed.exitCode !== 0) return undefined;
            const sha0 = listed.stdout.trim().split('\n').pop()?.trim() ?? '';
            return /^[0-9a-f]{40}$/i.test(sha0) ? sha0 : undefined;
          } catch {
            return undefined;
          }
        };

        if (baseRef.length === 0) {
          await failRuleReview(
            'rule_review precondition failed: the step has no baseRef to judge (a review with no base is not a review)',
          );
          done.add(stepId);
          continue;
        }
        const headSha = await resolveSha(headRef);
        if (headSha === undefined) {
          await failRuleReview(
            `rule_review precondition failed: headRef "${headRef}" could not be resolved to a commit in ${reviewCwd}`,
          );
          done.add(stepId);
          continue;
        }
        const baseSha = baseRef === 'root' ? await rootOf(headSha) : await resolveSha(baseRef);
        if (baseSha === undefined) {
          await failRuleReview(
            `rule_review precondition failed: baseRef "${baseRef}" could not be resolved to a commit in ${reviewCwd}`,
          );
          done.add(stepId);
          continue;
        }
        // Fail closed on a range that is not a change set of this repository. Resolving the two refs
        // in one repository and diffing them in another used to be possible; so was a base that is
        // not an ancestor of the head, which `git diff` happily renders as a change set.
        const ancestry = await git.run(['merge-base', '--is-ancestor', baseSha, headSha], { cwd: reviewCwd });
        if (ancestry.exitCode !== 0) {
          await failRuleReview(
            `rule_review precondition failed: base ${baseSha.slice(0, 12)} is not an ancestor of head ${headSha.slice(0, 12)} in ${reviewCwd}, so ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)} is not a change set of the repository under review`,
          );
          done.add(stepId);
          continue;
        }

        let findings: ReviewFinding[] = [];
        try {
          const input = await collectReviewInput(git, {
            worktree: ctx.worktree ?? ctx.cwd,
            baseSha,
            headSha,
            // Only test files need their CONTENT read; the rules that judge
            // everything else work from the change list.
            contentFor: (path) => isTestPath(path, step.rules?.testPathPatterns ?? []),
          });
          findings = runReviewRules(input, step.rules);
        } catch (e) {
          const message = e instanceof ProviderError ? e.message : e instanceof Error ? e.message : String(e);
          await failRuleReview(
            `rule_review precondition failed: the change set ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)} could not be reviewed: ${message}`,
          );
          done.add(stepId);
          continue;
        }

        const notes = findings.filter((finding) => finding.severity === 'note');
        const outcome = verdictFromFindings(findings, notes);
        if (outcome.verdict === 'findings') {
          const blocking = findings.filter((finding) => finding.severity === 'block');
          await failRuleReview(
            `rule_review FAILED: blocking findings (${blocking.map((finding) => finding.rule).join(', ')})\n${outcome.note ?? describeFindings(blocking)}`,
            blocking,
          );
          done.add(stepId);
          continue;
        }
        if (outcome.verdict === 'awaiting-human') {
          const human = findings.filter((finding) => finding.severity === 'human');
          await failRuleReview(
            `rule_review FAILED: a human must decide this — a machine may not decide it, and the automation must not continue\n${outcome.note ?? describeFindings(human)}`,
            human,
          );
          done.add(stepId);
          continue;
        }

        // Clean: no block and no human finding. Notes gate nothing and are
        // rendered one per line so an observation still reaches the reader.
        const summary =
          notes.length === 0
            ? `rule_review PASSED: no findings in ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}`
            : `rule_review PASSED: ${notes.length} note(s) in ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)}\n${renderFindingsLines(notes)}`;
        const artifactPath = await writeFindingsArtifact('verdict: PASSED', `${summary}\n\n${renderFindingsLines(findings)}`);
        run.stepStatus[stepId] = 'completed';
        pushStep({
          stepId,
          status: 'completed',
          summary: artifactPath === null ? summary : `${summary}\nrule_review artifact: ${artifactPath}`,
          artifacts: artifactPath === null ? [] : [artifactPath],
          tests: [],
        });
        ctx.onEvent?.(stepId, `rule review passed (${notes.length} note(s))`);
        done.add(stepId);
        continue;
      }

      // Independent Review step: a quality gate on top of review. Runs in an
      // ISOLATED runtime context (separate cwd → separate Pi session) so the
      // reviewer sees the code cold, untainted by the implementation session.
      // Its prompt uses the independent_review skill; the verdict is read from
      // the STRUCTURED REVIEW_VERDICT marker and persisted as an artifact. The
      // prose decides nothing: a missing or ambiguous marker fails closed.
      if (step.type === 'independent_review') {
        run.stepStatus[stepId] = 'running';
        const fsx2 = await import('node:fs/promises');
        const path2 = await import('node:path');
        const reviewDir = path2.join(ctx.cwd, '.takumi', 'review');
        await fsx2.mkdir(reviewDir, { recursive: true });
        // The reviewer works in the isolated dir but must READ the implementation,
        // so give it the real project path in the prompt context.
        const reviewPrompt = renderPrompt(
          step.prompt ?? `独立レビューを実施せよ。対象プロジェクト: ${ctx.cwd}。実装が設計・品質基準を満たすか判断し、重大な欠陥（Critical/High）があれば指摘せよ。`,
          { ...vars, projectDir: ctx.cwd },
        );
        const reviewTask: AgentTask = {
          id: `${runId}:${stepId}`,
          prompt: reviewPrompt,
          cwd: reviewDir, // isolated session context
          trace: vars['trace.ids'] ? vars['trace.ids'].split(',') : [],
          context: { workflowStep: stepId, workflow: workflow.name, independentReview: true },
        };
        const res2 = await runTaskAndCollect(ctx.runtime, reviewTask);
        collectUsage(res2.usage);
        const parsed = parseReviewVerdict(res2.summary);
        const passed = parsed.verdict === 'pass';
        const kind = step.id.split('_')[0] ?? 'review';
        const artifact = await ctx.artifacts.write({
          taskId: reviewTask.id,
          kind,
          fileName: `${stepId}.md`,
          content: res2.summary,
          contentType: 'text/markdown',
          trace: taskTraceFor(step, vars),
        });
        const verdictLine =
          parsed.verdict !== undefined
            ? `REVIEW_VERDICT: ${parsed.verdict}`
            : `REVIEW_VERDICT: (none — ${parsed.error ?? 'unparseable'})`;
        const summary = passed
          ? `independent review passed (${verdictLine})\n${res2.summary.slice(0, 800)}\nreview artifact: ${artifact.path}`
          : `independent review FAILED (${verdictLine}): ${parsed.error ?? 'the reviewer reported findings'}\n${res2.summary.slice(0, 1500)}\nreview artifact: ${artifact.path}`;
        pushStep({
          stepId,
          status: passed ? 'completed' : 'failed',
          summary,
          artifacts: [artifact.path],
          tests: [],
        });
        run.stepStatus[stepId] = passed ? 'completed' : 'failed';
        if (!passed) {
          run.status = 'failed';
          failedIds.add(stepId);
          ctx.onEvent?.(stepId, `independent review FAILED (${verdictLine}) — workflow aborted`);
        } else {
          ctx.onEvent?.(stepId, `independent review passed`);
        }
        done.add(stepId);
        continue;
      }

      // Judge forge (ADR-026): produce the judge for this run OUTSIDE the implementation worktree and
      // OUT OF the implementer's context, from the requirement document rather than from the
      // implementation. The generator gets the requirement's ref and digest and the worktree path —
      // it must not need the implementation to describe how the requirement could be checked.
      //
      // Fail-closed like every other evidence step: no generator, no readable requirement, no
      // `JUDGE_FORGE: ok` marker, no `JUDGE_PATH`, a path outside the judge directory, a stale judge
      // from a previous run, or no judge file at all all fail the step — and the acceptance behind it
      // is then skipped, so an unverifiable delivery produces no ACCEPT artifact.
      if (step.type === 'judge_forge') {
        run.stepStatus[stepId] = 'running';
        const resolved = requirementRefOf(step.requirementRef);
        const requirementRef = resolved.ref;
        const forgeRef = step.forgeRef?.trim() ?? '';
        if (resolved.error !== undefined) {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary: resolved.error, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `judge forge FAILED: ${resolved.error}`);
          done.add(stepId);
          continue;
        }
        const reject = (message: string): void => {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary: message, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `judge forge FAILED: ${message.split('\n')[0] ?? message}`);
        };
        if (requirementRef.length === 0 || forgeRef.length === 0) {
          reject(`a judge_forge requires a requirementRef and a forgeRef (got "${requirementRef}" / "${forgeRef}")`);
          done.add(stepId);
          continue;
        }
        const path = await import('node:path');
        const fsPromises = await import('node:fs/promises');
        const fsMod = await import('node:fs');
        const worktreePath = path.resolve(ctx.worktree ?? ctx.cwd);
        let requirementText: string;
        try {
          requirementText = fsMod.readFileSync(path.join(ctx.cwd, requirementRef), 'utf8');
        } catch (e) {
          reject(`the requirement document "${requirementRef}" could not be read (${e instanceof Error ? e.message : String(e)})`);
          done.add(stepId);
          continue;
        }
        const reqDigest = requirementDigest(requirementText);
        // The judge directory is RUN-scoped and recreated, so a judge from an earlier run can never be
        // reused as this run's evidence — and two runs on one project can never overwrite each other's
        // judge (ADR-052). `<project>/.takumi/acceptance/<runId>/<stepId>/` keeps the judge outside the
        // implementation worktree (ADR-026) while giving every run its own copy of it: with a fixed
        // `<stepId>` path, the second run's `rm -rf` destroyed the judge the first run was being judged
        // by, which is why the run directory had to be cleaned by hand between runs.
        const judgeDir = path.join(ctx.cwd, '.takumi', 'acceptance', runId, stepId);
        try {
          await fsPromises.rm(judgeDir, { recursive: true, force: true });
          await fsPromises.mkdir(judgeDir, { recursive: true });
        } catch (e) {
          reject(`the judge directory ${judgeDir} could not be prepared (${e instanceof Error ? e.message : String(e)})`);
          done.add(stepId);
          continue;
        }
        let out = '';
        let exitOk = true;
        try {
          const r = await runStepCommand(ctx, {
            argv: ['bash', path.resolve(ctx.cwd, forgeRef)],
            cwd: judgeDir,
            timeoutMs: step.timeoutMs ?? 300000,
            env: {
              TAKUMI_REQUIREMENT: requirementRef,
              TAKUMI_REQUIREMENT_DIGEST: `sha256:${reqDigest}`,
              TAKUMI_WORKTREE: worktreePath,
              TAKUMI_PROJECT: ctx.cwd,
              TAKUMI_JUDGE_DIR: judgeDir,
            },
          });
          out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        } catch (e) {
          exitOk = false;
          const shell = e as { stdout?: string; stderr?: string };
          out = `${shell.stdout ?? ''}${shell.stderr ?? ''}` || (e instanceof Error ? e.message : String(e));
        }
        const forged = /^\s*JUDGE_FORGE\s*[:=]\s*ok\s*$/im.test(out);
        const declared = /^\s*JUDGE_PATH\s*[:=]\s*(.+?)\s*$/im.exec(out)?.[1]?.replace(/^[*`"']|[*`"']$/g, '');
        const summaryLines = [`judge forge for ${requirementRef} sha256:${shortDigest(reqDigest)}`, `generator: ${forgeRef}`, `exit: ${exitOk ? 0 : '!0'}`, `judge dir: ${judgeDir}`, out.slice(0, 1200)].join('\n');
        if (!exitOk || !forged) {
          reject(`the judge forge did not report success (${forged ? 'non-zero exit' : 'no "JUDGE_FORGE: ok" marker'})\n${summaryLines}`);
          done.add(stepId);
          continue;
        }
        if (declared === undefined || declared.length === 0) {
          reject(`the judge forge reported ok but declared no JUDGE_PATH\n${summaryLines}`);
          done.add(stepId);
          continue;
        }
        // The judge must be a file the generator wrote INSIDE its own directory: a generator that
        // points somewhere else (the worktree, a source file) is pointing at the implementation.
        const judgePath = path.resolve(judgeDir, declared);
        const inDir = judgePath === judgeDir || judgePath.startsWith(`${judgeDir}${path.sep}`);
        if (!inDir) {
          reject(`the forged judge "${declared}" resolves to ${judgePath}, which is outside the judge directory ${judgeDir}: the judge is produced here and nowhere else\n${summaryLines}`);
          done.add(stepId);
          continue;
        }
        if (judgePath.startsWith(`${worktreePath}${path.sep}`) && worktreePath !== path.resolve(ctx.cwd)) {
          reject(`the forged judge ${judgePath} is inside the implementation worktree ${worktreePath}: the implementer could read it, and a judge the implementer can read is a judge the implementer can fit\n${summaryLines}`);
          done.add(stepId);
          continue;
        }
        let judgeText = '';
        try {
          judgeText = fsMod.readFileSync(judgePath, 'utf8');
        } catch (e) {
          reject(`the judge forge declared "${declared}" but that file could not be read (${e instanceof Error ? e.message : String(e)})\n${summaryLines}`);
          done.add(stepId);
          continue;
        }
        const judgeDigest = requirementDigest(judgeText);
        vars['judgePath'] = judgePath;
        vars['judgeDigest'] = judgeDigest;
        vars['judgeDir'] = judgeDir;
        const forgeSummary = `judge forged: ${judgePath} sha256:${shortDigest(judgeDigest)} (outside ${worktreePath})\n${summaryLines}`;
        run.stepStatus[stepId] = 'completed';
        pushStep({ stepId, status: 'completed', summary: forgeSummary, artifacts: [], tests: [] });
        done.add(stepId);
        ctx.onEvent?.(stepId, `judge forged: ${judgePath} sha256:${shortDigest(judgeDigest)}`);
        continue;
      }

      // Acceptance step (ADR-025): a verdict about ONE confirmed requirement document, produced by a
      // harness that is NOT the implementation's own test.
      //
      // Three things make the verdict mean something, and each has its own refusal: the document at
      // `requirementRef` must hash to the digest a human confirmed (an edited requirement fails by
      // name), the harness must report a structured `ACCEPT_VERDICT` marker (prose decides nothing,
      // and a missing marker fails), and the harness file is executed without a shell. Only a
      // passing verdict writes an ACCEPT artifact — a failure writes none, so an artifact named
      // ACCEPT cannot exist for a run that was not accepted.
      if (step.type === 'acceptance') {
        run.stepStatus[stepId] = 'running';
        const resolvedRef = requirementRefOf(step.requirementRef);
        const requirementRef = resolvedRef.ref;
        // A forged judge arrives as {judgePath}; a literal path is still allowed (a workflow without a
        // forge), but when this run forged a judge the acceptance MUST use it — checked below.
        const acceptanceRef = renderPrompt(step.acceptanceRef ?? '', vars).trim();
        const forgedJudgePath = vars['judgePath'];
        const forgedJudgeDigest = vars['judgeDigest'] ?? '';
        const reject = (message: string): void => {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary: message, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `acceptance FAILED: ${message.split('\n')[0] ?? message}`);
        };

        if (resolvedRef.error !== undefined) {
          reject(resolvedRef.error);
          done.add(stepId);
          continue;
        }
        // Defence in depth: the manifest validator already refuses both absences at load time.
        if (requirementRef.length === 0 || acceptanceRef.length === 0) {
          reject(`an acceptance requires a requirementRef and an acceptanceRef (got "${requirementRef}" / "${acceptanceRef}")`);
          done.add(stepId);
          continue;
        }
        if (acceptanceRef.includes('{')) {
          reject(
            `the acceptance harness reference "${step.acceptanceRef ?? ''}" did not resolve to a path: {judgePath} needs a judge_forge step that ran before this one`,
          );
          done.add(stepId);
          continue;
        }
        if (forgedJudgePath !== undefined && acceptanceRef !== forgedJudgePath) {
          reject(
            `this run forged its judge at "${forgedJudgePath}" and this acceptance would run "${acceptanceRef}": a workflow that forges a judge must accept with that judge, not with a harness of its own choosing`,
          );
          done.add(stepId);
          continue;
        }

        const path = await import('node:path');
        const fsMod = await import('node:fs');
        let requirementText: string;
        try {
          requirementText = fsMod.readFileSync(path.join(ctx.cwd, requirementRef), 'utf8');
        } catch (e) {
          reject(
            `the requirement document "${requirementRef}" could not be read (${e instanceof Error ? e.message : String(e)})`,
          );
          done.add(stepId);
          continue;
        }
        const digest = requirementDigest(requirementText);
        if (ctx.confirmedRequirement === undefined) {
          reject(
            `no confirmed requirement is on record for this run, so this acceptance cannot be bound to one (the document at "${requirementRef}" hashes to ${shortDigest(digest)})`,
          );
          done.add(stepId);
          continue;
        }
        if (ctx.confirmedRequirement.digest !== digest) {
          reject(
            `the requirement document "${requirementRef}" is not the one that was confirmed (confirmed ${shortDigest(ctx.confirmedRequirement.digest)} at "${ctx.confirmedRequirement.ref}", the document now hashes to ${shortDigest(digest)}): re-confirm the edited document before it can be accepted`,
          );
          done.add(stepId);
          continue;
        }

        // The judge runs from its OWN directory (its forged home), never from the implementation
        // worktree: the cwd it gets is a fact of the run, and the ACCEPT artifact records it. A real
        // judge reaches the artefact through TAKUMI_WORKTREE rather than by living inside it.
        // Resolved, not passed through: the judge runs from ITS OWN directory, so a relative
        // --worktree would have it `cd` to a path that does not exist there.
        const worktreePath = (await import('node:path')).resolve(ctx.worktree ?? ctx.cwd);
        const harnessCwd = forgedJudgePath === undefined ? ctx.cwd : (await import('node:path')).dirname(forgedJudgePath);
        let out = '';
        let exitOk = true;
        // Set when OUR OWN bound killed the harness. A kill produces "no verdict", which is NOT
        // the same fact as "the harness ran and printed nothing"; reporting them alike blames the
        // judge for the workflow's clock (ledger #77).
        let killedByBoundMs: number | undefined;
        try {
          const r = await runStepCommand(ctx, {
            argv: ['bash', acceptanceRef],
            cwd: harnessCwd,
            timeoutMs: step.timeoutMs ?? 300000,
            // The harness is the PLATFORM'S, but its subject is the DELIVERED project: ask for the
            // boundary that mirrors the platform read-only so the deliverable is contained too
            // (ledger #79's open item; #68 is why the containing matters).
            boundary: 'platformReadOnly',
            env: {
              TAKUMI_WORKTREE: worktreePath,
              TAKUMI_PROJECT: ctx.cwd,
              ...(forgedJudgePath === undefined ? {} : { TAKUMI_JUDGE_DIR: harnessCwd }),
            },
          });
          out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        } catch (e) {
          exitOk = false;
          const shell = e as { stdout?: string; stderr?: string; killed?: boolean; timedOut?: boolean };
          // Two shapes depending on which seam ran it: node's exec error reports `killed`/SIGTERM,
          // the boundary form reports `timedOut`. Both mean the STEP's bound ended the harness.
          if (shell.killed === true || shell.timedOut === true) killedByBoundMs = step.timeoutMs ?? 300000;
          out = `${shell.stdout ?? ''}${shell.stderr ?? ''}` || (e instanceof Error ? e.message : String(e));
        }
        const verdict = parseAcceptVerdict(out);
        const checks = [...out.matchAll(/^(ok|not ok)\s+\d+\s*-\s*(.+)$/gm)].map((m) => ({
          result: m[1] === 'ok' ? 'pass' : 'fail',
          check: (m[2] ?? '').trim(),
        }));
        // The bound is the WORKFLOW's choice, so the engine must not report its own kill as the
        // judge's silence (ledger #77). The VERDICT is unchanged — a killed harness still fails,
        // fail-closed — but the reason names the clock instead of implying a broken harness.
        const failureReason =
          killedByBoundMs === undefined
            ? (verdict.error ?? 'the harness reported a failing verdict')
            : `the acceptance harness was KILLED at its ${killedByBoundMs}ms bound after ${checks.length} check(s) had reported, so no verdict was ever reached — this is "we do not know", not "it failed": raise this step's timeoutMs, or have the judge run less inside one step`;
        // The verdict is about a COMMIT: the head of the repository the acceptance is about — the
        // delivery worktree when there is one, else the project. Resolving it in the project repo recorded
        // the wrong commit on a black-box run (the ACCEPT artifact named the project's HEAD, not the
        // delivered tree it had just judged) — the same wrong-repository family as ledger #35.
        const head = await (async (): Promise<string | undefined> => {
          try {
            const g = ctx.git ?? createGitRunner();
            const r = await g.run(['rev-parse', 'HEAD'], { cwd: ctx.worktree ?? ctx.cwd });
            return r.exitCode === 0 ? r.stdout.trim() : undefined;
          } catch {
            return undefined;
          }
        })();
        const accepted = exitOk && verdict.verdict === 'pass';
        const id = acceptanceIds.get(stepId) ?? 'ACCEPT-001';
        const requirements = extractTraceIds(requirementText).filter((t) => t.startsWith('REQ-'));
        const summary = [
          `acceptance ${accepted ? 'PASSED' : 'FAILED'}: ${accepted ? 'the confirmed requirement is satisfied' : failureReason}`,
          `harness: ${acceptanceRef}`,
          `judge: ${forgedJudgePath === undefined ? '(none forged; a literal harness)' : `${forgedJudgePath} sha256:${shortDigest(forgedJudgeDigest)}`}`,
          `harness cwd: ${harnessCwd}`,
          `boundary: ${
            ctx.sandboxPlatform === undefined
              ? 'none (this run has no boundary)'
              : `platform read-only (${ctx.sandboxPlatform.id}); the worktree and the judge dir stay read-write`
          }`,
          `worktree: ${worktreePath}`,
          `accepted head: ${head ?? '(unknown — the judged repository had no resolvable HEAD)'}`,
          `requirement: ${requirementRef} sha256:${shortDigest(digest)}`,
          `confirmed: ${ctx.confirmedRequirement.ref} sha256:${shortDigest(ctx.confirmedRequirement.digest)}`,
          `verdict: ${verdict.verdict ?? '(none)'}`,
          `checks: ${checks.filter((c) => c.result === 'pass').length}/${checks.length} ok`,
          `exit: ${exitOk ? 0 : '!0'}`,
          out.slice(0, 1200),
        ].join('\n');

        if (accepted) {
          // The head the judge ACCEPTED is the only head a later `merge` may land (ADR-040). It travels in
          // the run's vars, exactly as `publish` records `deliveryRef`: the acceptance result is where "what
          // was reviewed" is decided, and a merge that cannot name this commit is not a merge this project
          // performs. Absent means the judged repository had no resolvable HEAD, and a later merge then
          // refuses rather than merging a head it cannot name.
          if (head !== undefined && head.length > 0) vars['acceptedHead'] = head;
          const artifact = [
            `# ${id}`,
            '',
            '```yaml',
            `id: ${id}`,
            'kind: acceptance',
            'requirement:',
            `  ref: ${requirementRef}`,
            `  digest: sha256:${digest}`,
            `  requirements: [${requirements.join(', ')}]`,
            'artifact:',
            `  head: ${head ?? 'unknown'}`,
            `  worktree: ${worktreePath}`,
            'acceptance:',
            `  harness: ${acceptanceRef}`,
            `  cwd: ${harnessCwd}`,
            ...(forgedJudgePath === undefined
              ? ['  judge: none']
              : [`  judge: ${forgedJudgePath}`, `  judgeDigest: sha256:${forgedJudgeDigest}`]),
            '  verdict: pass',
            `  verdictMarker: "ACCEPT_VERDICT: ${verdict.verdict}"`,
            ...(checks.length === 0 ? ['  checks: []'] : ['  checks:', ...checks.map((c) => `    - "${c.result}: ${c.check.replace(/"/g, "'")}"`)]),
            'confirmed:',
            `  ref: ${ctx.confirmedRequirement.ref}`,
            `  digest: sha256:${ctx.confirmedRequirement.digest}`,
            'invalidatedBy:',
            '  - requirement-digest-change',
            '  - head-move',
            '```',
            '',
          ].join('\n');
          let artifactPath: string | undefined;
          try {
            const art = await ctx.artifacts.write({
              taskId: `${runId}:${stepId}`,
              kind: 'acceptance',
              fileName: `${id}.md`,
              content: artifact,
              contentType: 'text/markdown',
              trace: requirements,
            });
            artifactPath = art.path;
          } catch (e) {
            ctx.onEvent?.(stepId, `artifact persist failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          run.stepStatus[stepId] = 'completed';
          pushStep({
            stepId,
            status: 'completed',
            summary,
            artifacts: artifactPath === undefined ? [] : [artifactPath],
            tests: [],
          });
          ctx.onEvent?.(stepId, `acceptance PASSED (${checks.length} check(s) ok) — ${id} written`);
        } else {
          // A FAILED acceptance is written back (ADR-029). Two things have to leave the run:
          //
          //   1. A REJECT artifact, because a failure that exists only in a terminal is a failure
          //      nobody can cite. It records what was judged, by which judge, and which checks failed.
          //   2. A `feedback:` entry in the requirement document itself, which changes the document's
          //      digest — so the confirmation this run was made with no longer matches the document,
          //      and the next run needs a re-confirmation in which the human answers the failure.
          //
          // Only a rejection the JUDGE PRODUCED is recorded: a refusal (a stale confirmation, a judge
          // that could not be forged, an unreadable document) means the acceptance could not be made,
          // and writing feedback for it would edit the human's document because of a run-configuration
          // mistake.
          const failing = checks.filter((c) => c.result === 'fail');
          const notes: string[] = [];
          if (checks.length === 0 || failing.length === 0) {
            notes.push('reject: not recorded — no failing check came out of a judge that ran');
          } else {
            const rejectId = `REJECT-${String((rejectSeq += 1)).padStart(3, '0')}`;
            let feedbackLine = 'feedback: not recorded';
            let digestAfter = digest;
            const feedbackInput = {
              at: new Date().toISOString(),
              run: runId,
              requirementDigest: digest,
              judgeDigest: `sha256:${forgedJudgeDigest}`,
              checks: failing.map((c) => c.check),
            };
            let appended: { id: string; duplicate: boolean } | undefined;
            let appendError: string | undefined;
            // A round that is going to be RETRIED must not edit the human's document (ADR-034): a run
            // writes exactly one failure back, and only the attempt that is not followed by another
            // writes it. Intermediate rounds therefore leave the document — and its digest — untouched.
            const withholdFeedback = ctx.withholdAcceptanceFeedback === true;
            if (withholdFeedback) {
              feedbackLine = 'feedback: withheld — this failure is being repaired, so only the last round writes it back (ADR-034)';
            } else {
              try {
                const res = appendFeedback(requirementText, feedbackInput);
                if (res.duplicate) {
                  appended = { id: res.id, duplicate: true };
                } else {
                  parseYamlText(res.text);
                  fsMod.writeFileSync(path.join(ctx.cwd, requirementRef), res.text, 'utf8');
                  digestAfter = requirementDigest(res.text);
                  appended = { id: res.id, duplicate: false };
                }
              } catch (e) {
                appendError = e instanceof Error ? e.message : String(e);
              }
            }
            if (withholdFeedback) {
              // `feedbackLine` already says the write-back is withheld. Nothing was attempted, so the
              // "could not be recorded" branch below must not claim a failure that never happened.
            } else if (appended === undefined) {
              feedbackLine = `feedback: COULD NOT be recorded in ${requirementRef} (${appendError ?? 'unknown error'}) — the rejection is recorded but the loop is not closed`;
            } else if (appended.duplicate) {
              feedbackLine = `feedback: ${appended.id} already records this run at ${shortDigest(digest)}`;
            } else {
              feedbackLine = `feedback: ${appended.id} written into ${requirementRef} (open) — the document now hashes to ${shortDigest(digestAfter)}, so its confirmation no longer matches it and the next run needs a re-confirmation`;
            }
            const open = parseFeedback(
              (() => {
                try {
                  return fsMod.readFileSync(path.join(ctx.cwd, requirementRef), 'utf8');
                } catch {
                  return requirementText;
                }
              })(),
            ).filter((e) => e.status === 'open');

            const artifact = [
              `# ${rejectId}`,
              '',
              '```yaml',
              `id: ${rejectId}`,
              'kind: acceptance-reject',
              'requirement:',
              `  ref: ${requirementRef}`,
              `  digest: sha256:${digest}`,
              `  digestAfterFeedback: sha256:${digestAfter}`,
              `  requirements: [${requirements.join(', ')}]`,
              'artifact:',
              `  head: ${head ?? 'unknown'}`,
              `  worktree: ${worktreePath}`,
              'acceptance:',
              `  harness: ${acceptanceRef}`,
              `  cwd: ${harnessCwd}`,
              ...(forgedJudgePath === undefined
                ? ['  judge: none']
                : [`  judge: ${forgedJudgePath}`, `  judgeDigest: sha256:${forgedJudgeDigest}`]),
              `  verdict: ${verdict.verdict ?? 'none'}`,
              `  verdictMarker: ${verdict.verdict === undefined ? 'none' : `"ACCEPT_VERDICT: ${verdict.verdict}"`}`,
              ...(checks.length === 0 ? ['  checks: []'] : ['  checks:', ...checks.map((c) => `    - "${c.result}: ${c.check.replace(/"/g, "'")}"`)]),
              'rejected:',
              `  failing: [${failing.map((c) => `"${c.check.replace(/"/g, "'")}"`).join(', ')}]`,
              `  feedback: ${appended === undefined ? (withholdFeedback ? 'withheld (this failure is being repaired)' : 'none') : appended.id}`,
              `  feedbackOpen: [${open.map((e) => e.id).join(', ')}]`,
              `  documentChanged: ${digestAfter === digest ? 'false' : 'true'}`,
              'confirmed:',
              `  ref: ${ctx.confirmedRequirement.ref}`,
              `  digest: sha256:${ctx.confirmedRequirement.digest}`,
              // The judge's own words, so the rejection can be argued with rather than taken on trust.
              'output: |',
              ...out.slice(0, 1200).split('\n').map((line) => `  ${line}`),
              '```',
              '',
            ].join('\n');
            try {
              const art = await ctx.artifacts.write({
                taskId: `${runId}:${stepId}`,
                kind: 'acceptance',
                fileName: `${rejectId}.md`,
                content: artifact,
                contentType: 'text/markdown',
                trace: requirements,
              });
              notes.push(`rejection: ${rejectId} written (${art.path})`);
            } catch (e) {
              notes.push(`rejection: ${rejectId} could not be persisted (${e instanceof Error ? e.message : String(e)})`);
            }
            notes.push(feedbackLine);
            notes.push(`failing checks: ${failing.map((c) => c.check.split(' ')[0]).join(', ')}`);
          }
          reject([summary, ...notes].join('\n'));
        }
        done.add(stepId);
        continue;
      }

      // CI config step (ADR-037): write the host's pipeline into the delivery, derived from the
      // requirement document's `deliverable.run` and the delivered project's own test command. Refused
      // when the step declares no test command, and refused when the named document cannot be read.
      if (step.type === 'ci_config') {
        run.stepStatus[stepId] = 'running';
        const resolvedRef = requirementRefOf(step.requirementRef);
        const ciWorktree = (await import('node:path')).resolve(ctx.worktree ?? ctx.cwd);
        // The dialect the step does NOT declare is DERIVED from the delivery provider's host id
        // (docs/bugs-fixed.md #48): the provider names its host, and the host is what decides which
        // pipeline file it runs, so a `provider: github` run must write `.github/workflows/ci.yml`.
        // `metadata()` is the provider's own description of itself; a provider whose metadata throws
        // derives nothing and the step's historical `forgejo` default stands.
        const deliveryProviderId = (() => {
          try {
            return ctx.delivery?.metadata().id;
          } catch {
            return undefined;
          }
        })();
        const ciResult = await executeCiConfigStep({
          stepId,
          runId,
          projectDir: ctx.cwd,
          worktree: ciWorktree,
          ...(step.testCommand === undefined ? {} : { testCommand: step.testCommand }),
          ...(step.dialect === undefined ? {} : { dialect: step.dialect }),
          ...(deliveryProviderId === undefined ? {} : { deliveryProviderId }),
          ...(resolvedRef.ref.length === 0 ? {} : { requirementRef: resolvedRef.ref }),
          artifacts: ctx.artifacts,
          trace: taskTraceFor(step, vars),
        });
        run.stepStatus[stepId] = ciResult.status;
        if (ciResult.status === 'failed') {
          run.status = 'failed';
          failedIds.add(stepId);
        }
        pushStep({ stepId, status: ciResult.status, summary: ciResult.summary, artifacts: ciResult.artifacts, tests: [] });
        ctx.onEvent?.(stepId, ciResult.summary.split('\n')[0] ?? ciResult.summary);
        done.add(stepId);
        continue;
      }

      // Await checks step (ADR-037): wait for the host's pipeline on the delivered head. `success` for
      // every check is the only pass; a missing provider, a host without the checks capability, a host
      // that throws, a host that reports nothing, a red check and a pending check at the timeout all fail
      // the run CLOSED — the step never reports a green pipeline it did not actually read.
      if (step.type === 'await_checks') {
        run.stepStatus[stepId] = 'running';
        const declaredRef = ((step as WorkflowStep & { ref?: string }).ref ?? vars['deliveryRef'] ?? '').trim();
        let checksRef: PullRequestRef | undefined;
        if (declaredRef.length > 0) {
          checksRef = { number: declaredRef, url: /^https?:/i.test(declaredRef) ? declaredRef : '', headSha: '', baseSha: '' };
        } else if (ctx.worktree !== undefined) {
          const git = ctx.git ?? createGitRunner();
          const branchRun = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ctx.worktree });
          const headRun = await git.run(['rev-parse', 'HEAD'], { cwd: ctx.worktree });
          const branch = branchRun.stdout.trim();
          const head = headRun.stdout.trim();
          if (branchRun.exitCode === 0 && branch.length > 0 && branch !== 'HEAD' && head.length > 0) {
            checksRef = { number: branch, url: '', headSha: head, baseSha: '' };
          }
        }
        const awaitResult = await executeAwaitChecksStep({
          stepId,
          ...(ctx.delivery === undefined ? {} : { delivery: ctx.delivery }),
          ...(checksRef === undefined ? {} : { ref: checksRef }),
          ...(step.waitSeconds === undefined ? {} : { waitSeconds: step.waitSeconds }),
          onEvent: (message) => ctx.onEvent?.(stepId, message),
        });
        run.stepStatus[stepId] = awaitResult.status;
        if (awaitResult.status === 'failed') {
          run.status = 'failed';
          failedIds.add(stepId);
        }
        let awaitSummary = awaitResult.summary;
        // REPORT a GENUINE pipeline failure to the host (ADR-037). "Genuine" is decided by one fact:
        // the host actually REPORTED checks. Every case with nothing to report — no provider, a host
        // without the checks capability, a checks() that threw, a host that reported nothing — leaves
        // `checks` empty, so none of those is ever reported. Reporting also needs a published
        // reference (`vars.deliveryRef`, set by the `publish` step): with no pull request there is no
        // host surface to carry the failure, and an issue about nothing is worse than no issue.
        if (awaitResult.status === 'failed' && awaitResult.checks.length > 0) {
          const deliveryRef = (vars['deliveryRef'] ?? '').trim();
          const reporter = ctx.delivery;
          if (
            deliveryRef.length > 0 &&
            reporter !== undefined &&
            (reporter.openIssue !== undefined || reporter.commentOnPullRequest !== undefined)
          ) {
            const notGreen = renderNotGreenChecks(awaitResult.checks);
            const reportBody = [
              `Pipeline not green on pull request ${deliveryRef} (run ${runId}, workflow ${workflow.name}).`,
              '',
              'Checks that are not green:',
              ...notGreen,
              '',
              awaitResult.summary,
            ].join('\n');
            const reportTitle = `Pipeline not green on pull request ${deliveryRef}: ${notGreen.length} check(s)`;
            const reportNotes: string[] = [];
            // The comment goes on the pull request FIRST: that is the surface the reviewer reads, and
            // the failure is ABOUT this pull request. A failure to comment is loud and never changes
            // the run's outcome.
            if (reporter.commentOnPullRequest !== undefined) {
              try {
                await reporter.commentOnPullRequest({ number: deliveryRef, url: '', headSha: '', baseSha: '' }, reportBody);
                reportNotes.push(`commented on pull request ${deliveryRef}`);
              } catch (e) {
                reportNotes.push(
                  `COULD NOT comment on pull request ${deliveryRef} (${e instanceof Error ? e.message : String(e)}): the failure is still named in this summary`,
                );
              }
            }
            // Exactly ONE issue per run. A failure to open it is LOUD, and it NEVER turns an
            // already-red run into a different kind of failure: the run was failed by the pipeline,
            // and it stays failed by the pipeline.
            if (reporter.openIssue !== undefined && !pipelineIssueFiled) {
              pipelineIssueFiled = true;
              try {
                const issue = await reporter.openIssue({ title: reportTitle, body: reportBody });
                reportNotes.push(`issue ${issue.number} opened (${issue.url})`);
              } catch (e) {
                reportNotes.push(
                  `issue COULD NOT be opened (${e instanceof Error ? e.message : String(e)}) — the pull request exists; the failure record does not`,
                );
              }
            } else if (reporter.openIssue !== undefined) {
              reportNotes.push('issue not opened (one pipeline-failure issue per run was already filed)');
            }
            awaitSummary = [awaitSummary, '', 'host report:', ...reportNotes.map((n) => `- ${n}`)].join('\n');
            ctx.onEvent?.(stepId, `pipeline failure reported: ${reportNotes.join('; ')}`);
          }
        }
        // The board row follows the pipeline verdict (ADR-044): `pr_open` when every check went green
        // (+ `takumi-approved`), `fix_needed` when one failed or timed out (+ `takumi-blocked`). This is
        // the state a human triaging the board needs — the row says whether the delivery can land.
        const boardLine = await projectBoard({
          state: awaitResult.status === 'completed' ? DELIVERY_BOARD_STEP_STATES.green : DELIVERY_BOARD_STEP_STATES.red,
          labels: [awaitResult.status === 'completed' ? DELIVERY_BOARD_LABELS.approved : DELIVERY_BOARD_LABELS.blocked],
          detail: awaitSummary.split('\n')[0] ?? awaitSummary,
        });
        if (boardLine !== null) awaitSummary = `${awaitSummary}\n${boardLine}`;
        pushStep({ stepId, status: awaitResult.status, summary: awaitSummary, artifacts: [], tests: [] });
        ctx.onEvent?.(stepId, awaitSummary.split('\n')[0] ?? awaitSummary);
        done.add(stepId);
        continue;
      }

      // Delivery step: package the run's artifacts into a delivery bundle.
      // Produces a delivery manifest + a ZIP-able summary of all artifacts.
      // Publish step (ADR-037): the host-side half of a delivery. Everything up to here happened in a
      // worktree nobody else can see; this is the one place a run is allowed to write to a code host, and it
      // is deliberately narrow: push the committed branch (never a force), open EXACTLY ONE pull request
      // whose body carries the confirmed requirement and its digest, and — when the host can record one —
      // an issue that says what was asked for. A host that cannot do the first part fails the run.
      if (step.type === 'publish') {
        run.stepStatus[stepId] = 'running';
        const failPublish = (summary: string): void => {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `publish FAILED: ${summary.split('\n')[0]}`);
        };
        const provider = ctx.delivery;
        const worktree = ctx.worktree;
        if (provider === undefined) {
          failPublish('this run has no delivery provider (ctx.delivery), so there is no host to publish to: a local bundle is not a delivery');
          done.add(stepId);
          continue;
        }
        if (worktree === undefined) {
          failPublish('a publish step needs a delivery worktree (--worktree): there is nothing to push');
          done.add(stepId);
          continue;
        }
        const git = ctx.git ?? createGitRunner();
        const branchRun = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktree });
        const branch = branchRun.stdout.trim();
        const baseBranch = step.baseBranch ?? ctx.deliveryDefaults?.baseBranch ?? 'main';
        const remote = step.remote ?? ctx.deliveryDefaults?.remote ?? 'origin';
        if (branchRun.exitCode !== 0 || branch.length === 0 || branch === 'HEAD') {
          failPublish(`the delivery worktree is not on a branch (git said "${branch}"): a detached head cannot be published`);
          done.add(stepId);
          continue;
        }
        const baseRun = await git.run(['rev-parse', '--verify', `${remote}/${baseBranch}^{commit}`], { cwd: worktree });
        const baseSha = baseRun.exitCode === 0 ? baseRun.stdout.trim() : '';
        const headRun = await git.run(['rev-parse', 'HEAD'], { cwd: worktree });
        const headSha = headRun.stdout.trim();
        if (baseSha.length === 0) {
          failPublish(`the base branch ${remote}/${baseBranch} could not be resolved in the delivery worktree: a pull request with no base is not a pull request`);
          done.add(stepId);
          continue;
        }
        const confirmed = ctx.confirmedRequirement;
        const itemId = confirmed?.ref ?? workflow.name;
        const requirementLine =
          confirmed === undefined
            ? 'Requirement: (this run was not bound to a confirmed requirement)'
            : `Requirement: \`${confirmed.ref}\` at \`sha256:${confirmed.digest}\``;
        const body = [
          `Run: ${runId}`,
          requirementLine,
          `Item: ${itemId}`,
          '',
          'This pull request was produced by a black-box delivery run: the requirement above is the document a',
          'human confirmed, the acceptance artifact records the judge that accepted this commit, and the',
          'commit boundary is the implementer\'s own.',
        ].join('\n');
        try {
          const outcome = await provider.deliver(
            {
              worktree,
              branch,
              baseBranch,
              remote,
              itemId,
              runId,
              ...(step.prTitle === undefined ? {} : { title: step.prTitle }),
              body,
            },
            { baseSha },
          );
          // `pr` is optional in the port: a bare git remote has a pushed branch and nothing to review. That
          // is reported as what it is — never as a pull request that does not exist.
          const pr = outcome.pr;
          // Record what was published as DATA, not only as prose: the run record needs the
          // pull request and the issue as fields a program can read.
          publishedPr = pr === undefined ? null : { number: pr.number, url: pr.url };
          const lines = [
            pr === undefined
              ? `published ${branch} -> ${baseBranch}: the branch is pushed and this host has no review surface`
              : `published ${branch} -> ${baseBranch} as pull request ${pr.number}`,
            ...(pr === undefined ? [] : [`  url: ${pr.url}`, `  head: ${pr.headSha}`, `  base: ${pr.baseSha} (${baseSha})`]),
            `  push: ${outcome.push.mode} (${outcome.push.branch} at ${outcome.push.head})`,
            `  ${requirementLine}`,
            ...outcome.notes.map((note) => `  note: ${note}`),
          ];
          if (outcome.push.mode === 'force') {
            // The port says a forced push is a contract violation; a provider that reports one has broken the
            // boundary this layer exists to keep, so the run refuses to treat the delivery as published.
            failPublish([`the provider pushed with a FORCE, which the port forbids: the reviewed history is gone`, ...lines].join('\n'));
            done.add(stepId);
            continue;
          }
          // The issue is a RECORD, not a gate: a host that cannot record one is reported, never silent, and
          // never allowed to undo a pull request that already exists (the same rule the board mirror keeps).
          let issueLine = 'issue: not opened (the provider cannot record issues)';
          if (provider.openIssue !== undefined) {
            try {
              const issue = await provider.openIssue({
                title: step.issueTitle ?? `${itemId}: ${branch}`,
                body: [
                  requirementLine,
                  ...(pr === undefined ? [`Branch: \`${branch}\``] : [`Pull request: ${pr.url}`]),
                  '',
                  'Opened by a black-box delivery run as the record of this work.',
                ].join('\n'),
              });
              issueLine = `issue: ${issue.number} opened (${issue.url})`;
              publishedIssue = { number: issue.number };
            } catch (e) {
              issueLine = `issue: COULD NOT be opened (${e instanceof Error ? e.message : String(e)}) — the pull request exists; the record does not`;
            }
          }
          lines.push(`  ${issueLine}`);
          // The board row for this delivery (ADR-044): ONE row per run, keyed by the run id, moved to
          // `claimed` — a run owns this delivery, the pull request is open, and no pipeline has been
          // read yet. A board failure is loud (the line below) and never undoes the pull request.
          const boardLine = await projectBoard({
            state: DELIVERY_BOARD_STEP_STATES.publish,
            detail:
              pr === undefined
                ? `publish: ${branch} pushed to ${baseBranch} (this host has no review surface)`
                : `publish: pull request ${pr.number} opened (${pr.url})`,
          });
          if (boardLine !== null) lines.push(`  ${boardLine}`);
          run.stepStatus[stepId] = 'completed';
          pushStep({ stepId, status: 'completed', summary: lines.join('\n'), artifacts: [], tests: [] });
          // The pipeline step judges the head the HOST has, so the reference travels with the run: a later
          // `await_checks` reads the checks of the pull request this step opened rather than guessing.
          if (pr !== undefined) vars['deliveryRef'] = pr.number;
          ctx.onEvent?.(
            stepId,
            pr === undefined
              ? `publish: ${branch} pushed (this host has no review surface)`
              : `publish: pull request ${pr.number} opened (${pr.url})`,
          );
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          failPublish(`the host refused the delivery: ${detail}`);
        }
        done.add(stepId);
        continue;
      }

      // Merge step (ADR-040): the LAST MILE. Everything up to here produced an OPEN pull request; this is the
      // one step that LANDS it, and it lands EXACTLY the commit the acceptance judged. Two independent
      // guards, both required:
      //
      //   1. the reviewed head is passed to the port as `expectedHeadSha`, so the HOST refuses a moved head
      //      (the port's own rule, proven live against a real Forgejo: a stale head got `409 head out of
      //      date` — a guard a client bug cannot bypass);
      //   2. the pull request's CURRENT head is read from `status(ref)` and compared to the reviewed head
      //      BEFORE any merge is attempted, naming both SHAs when they differ — because a green pipeline on
      //      one commit says nothing about another, and a merge of a different head is exactly the failure
      //      this whole layer exists to prevent.
      //
      // The reference and the head are NOT manifest fields (ADR-040): the pull request is the one this run
      // published (`vars.deliveryRef`) and the commit is the one the acceptance judged (`vars.acceptedHead`).
      if (step.type === 'merge') {
        run.stepStatus[stepId] = 'running';
        const failMerge = (summary: string): void => {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          pushStep({ stepId, status: 'failed', summary, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `merge FAILED: ${summary.split('\n')[0] ?? summary}`);
        };
        const provider = ctx.delivery;
        if (provider === undefined) {
          failMerge('this run has no delivery provider (ctx.delivery), so there is no host to merge on: an open pull request is not a landed delivery');
          done.add(stepId);
          continue;
        }
        // The reference is the run's OWN published pull request, never a manifest-named one: landing a pull
        // request this run did not publish is not this run's delivery.
        const deliveryRef = (vars['deliveryRef'] ?? '').trim();
        if (deliveryRef.length === 0) {
          failMerge('the run has no published reference (vars.deliveryRef, set by a publish step), so there is no pull request to land');
          done.add(stepId);
          continue;
        }
        // The REVIEWED head — the commit the acceptance judged — is the only head this step may merge.
        const reviewedHead = (vars['acceptedHead'] ?? '').trim();
        if (reviewedHead.length === 0) {
          failMerge('the reviewed head could not be determined (no acceptance recorded the head it judged, vars.acceptedHead), so this merge cannot say which commit it is landing: refusing');
          done.add(stepId);
          continue;
        }
        const ref: PullRequestRef = {
          number: deliveryRef,
          url: /^https?:/i.test(deliveryRef) ? deliveryRef : '',
          headSha: '',
          baseSha: '',
        };
        // Guard 2: read the CURRENT head and refuse BEFORE calling merge when it differs from the reviewed
        // head. Naming both SHAs is the point: a reader must be able to see which commit was judged and which
        // one the pull request now points at.
        let current: PullRequestStatus;
        try {
          current = await provider.status(ref);
        } catch (e) {
          failMerge(`the host could not report the state of pull request ${deliveryRef} (${e instanceof Error ? e.message : String(e)}), so the head that would be merged could not be read`);
          done.add(stepId);
          continue;
        }
        const currentHead = (current.headSha ?? '').trim();
        if (currentHead !== reviewedHead) {
          failMerge(`pull request ${deliveryRef} now points at ${currentHead.length > 0 ? currentHead : '(unknown)'}, but the reviewed and accepted head is ${reviewedHead}: refusing to merge a head that was not the one judged (a green pipeline on one commit says nothing about another)`);
          done.add(stepId);
          continue;
        }
        const method: DeliveryMergeMethod = step.mergeMethod ?? 'merge';
        // Guard 1: hand the reviewed head to the port. The HOST refuses a moved head.
        let outcome: MergeOutcome;
        try {
          outcome = await provider.merge(ref, { expectedHeadSha: reviewedHead, method });
        } catch (e) {
          failMerge(`the host refused the merge of ${reviewedHead} on pull request ${deliveryRef}: ${e instanceof Error ? e.message : String(e)}`);
          done.add(stepId);
          continue;
        }
        // `merged: false` is a FAILURE, never a note: a merge that did not happen is not a landed delivery.
        if (outcome.merged !== true) {
          failMerge(`the host reported merged=${String(outcome.merged)} for pull request ${deliveryRef} (head ${reviewedHead}): a merge that did not happen is not a landed delivery`);
          done.add(stepId);
          continue;
        }
        // The port requires the merged commit to BE the reviewed head; a provider that reports another one
        // has broken the boundary this layer keeps.
        if (outcome.headSha !== reviewedHead) {
          failMerge(`the host reported it merged ${outcome.headSha}, but the reviewed and accepted head is ${reviewedHead}: the port requires the merged commit to be the reviewed head`);
          done.add(stepId);
          continue;
        }
        const summaryLines = [
          `merged pull request ${deliveryRef}: method ${outcome.method}, head ${outcome.headSha}, url ${outcome.url}`,
          `  reviewed head: ${reviewedHead} (the commit the acceptance judged)`,
          `  host head before merge: ${currentHead} (${current.state})`,
        ];
        const artifactPaths: string[] = [];
        try {
          const art = await ctx.artifacts.write({
            taskId: `${runId}:${stepId}`,
            kind: 'merge',
            fileName: `${stepId}.md`,
            content: [
              `# ${stepId} (merge)`,
              '',
              'merged: true',
              `pull request: ${deliveryRef}`,
              `method: ${outcome.method}`,
              `head: ${outcome.headSha}`,
              `url: ${outcome.url}`,
              `reviewedHead: ${reviewedHead}`,
              '',
            ].join('\n'),
            contentType: 'text/markdown',
            trace: taskTraceFor(step, vars),
          });
          artifactPaths.push(art.path);
        } catch (e) {
          summaryLines.push(`  note: the merge artifact could not be persisted (${e instanceof Error ? e.message : String(e)}) — the merge happened and is named here`);
        }
        // The row LANDS (ADR-044): `merged` (+ `takumi-merged`), with the merged commit in the detail so
        // the landed SHA is auditable from the board itself, not only from the run's artifacts.
        const boardLine = await projectBoard({
          state: DELIVERY_BOARD_STEP_STATES.merged,
          labels: [DELIVERY_BOARD_LABELS.merged],
          detail: `merge: pull request ${deliveryRef} merged (${outcome.method}, head ${outcome.headSha})`,
        });
        if (boardLine !== null) summaryLines.push(`  ${boardLine}`);
        run.stepStatus[stepId] = 'completed';
        pushStep({ stepId, status: 'completed', summary: summaryLines.join('\n'), artifacts: artifactPaths, tests: [] });
        // What a later step needs to know the delivery LANDED: the flag, the commit that landed and the
        // reference it landed on. A step after this one must not have to infer a merge from prose.
        vars['deliveryMerged'] = 'true';
        vars['mergedHead'] = outcome.headSha;
        vars['mergedRef'] = deliveryRef;
        ctx.onEvent?.(stepId, `merge: pull request ${deliveryRef} merged (method ${outcome.method}, head ${outcome.headSha})`);
        done.add(stepId);
        continue;
      }

      if (step.type === 'delivery') {
        run.stepStatus[stepId] = 'running';
        const fsx3 = await import('node:fs/promises');
        const path3 = await import('node:path');
        // The bundle is THIS RUN's artifacts, taken from the step results that produced them, not
        // everything the store happens to hold: listing the store shipped a stale `REJECT-001.md` from an
        // earlier, refused run inside the manifest of a delivery that had passed (docs/bugs-fixed.md #38).
        const mine = new Set(stepResults.flatMap((s) => s.artifacts));
        const all = await ctx.artifacts.list();
        const runArtifacts = all.filter((a) => mine.has(a.path));
        const lines = [
          `# Delivery Manifest`,
          `workflow: ${workflow.name}  |  run: ${runId}`,
          `generated: ${new Date().toISOString()}`,
          ``,
          `## artifacts (${runArtifacts.length})`,
        ];
        for (const a of runArtifacts) lines.push(`- ${a.path}  (kind=${a.kind}, trace=[${(a.trace ?? []).join(', ')}])`);
        if (all.length > runArtifacts.length) {
          lines.push(
            ``,
            `${all.length - runArtifacts.length} artifact(s) in the store belong to OTHER runs and are not part`,
            `of this delivery: a bundle that cannot say which run it is from is a bundle nobody can trust.`,
          );
        }
        const manifest = lines.join('\n');
        const deliveryArtifact = await ctx.artifacts.write({
          taskId: `${runId}:${stepId}`,
          kind: 'delivery',
          fileName: 'delivery-manifest.md',
          content: manifest,
          contentType: 'text/markdown',
          trace: vars['trace.ids'] ? vars['trace.ids'].split(',') : [],
        });
        pushStep({ stepId, status: 'completed', summary: `delivery bundle ready (${runArtifacts.length} artifacts)`, artifacts: [deliveryArtifact.path], tests: [] });
        run.stepStatus[stepId] = 'completed';
        ctx.onEvent?.(stepId, `delivery manifest written (${runArtifacts.length} artifacts)`);
        done.add(stepId);
        continue;
      }

      // agent / tool step
      const maxAttempts = step.retry?.maxAttempts ?? ctx.defaultMaxAttempts ?? 1;
      run.stepStatus[stepId] = 'running';
      /**
       * A step that DECLARES what it produces is held to it (ADR-053): each declared output is
       * snapshotted BEFORE the step runs, so "written by this step" is decided by the file CHANGING,
       * never by the file existing. A file that was already there is not this step's output — which is
       * exactly how a run that produced nothing passed a gate that read a document from six hours
       * earlier (wf-5beb034f). Only `agent` steps may declare outputs (refused by name otherwise), so
       * this is the only place the check is needed.
       */
      const declaredOutputs = (step.produces ?? []).map((rel) => {
        const abs = joinPath(ctx.worktree ?? ctx.cwd, rel);
        let before: number | null = null;
        try {
          before = statFileSync(abs).mtimeMs;
        } catch {
          before = null; // absent before the step: anything at this path is this step's output
        }
        return { rel, abs, before };
      });
      const unwrittenOutputs = (): string[] =>
        declaredOutputs
          .filter((o) => {
            let now: number | null = null;
            try {
              now = statFileSync(o.abs).mtimeMs;
            } catch {
              now = null;
            }
            if (now === null) return true; // nothing there at all: nothing was produced
            return o.before !== null && now === o.before; // untouched since before the step
          })
          .map((o) => o.rel);
      let stepOutcome: WorkflowStepResult | undefined;
      let lastError = '';
      let attempt = 0;

      while (attempt < maxAttempts && !stepOutcome) {
        attempt++;
        ctx.onEvent?.(stepId, `attempt ${attempt}/${maxAttempts}`);
        const task: AgentTask = {
          id: `${runId}:${stepId}:${attempt}`,
          // Resolve the prompt from the step's skill template when configured,
          // else the in-workflow prompt (acceptance Gate 8: skills drive behavior).
          prompt: await resolveStepPrompt(step, ctx.skillsRoot, vars),
          cwd: ctx.worktree ?? ctx.cwd,
          trace: vars['trace.ids'] ? vars['trace.ids'].split(',') : [],
          context: { workflowStep: stepId, workflow: workflow.name, ...vars },
          options: {
            ...(ctx.sandbox === undefined ? {} : { sandbox: ctx.sandbox }),
            ...(ctx.sandboxRoots === undefined ? {} : { sandboxRoots: ctx.sandboxRoots }),
          },
        };
        try {
          const res = await runStepWithTimeout(ctx.runtime, task, step.timeoutMs);
          collectUsage(res.usage);
          // A cancelled task (user abort / hard timeout cancel) should NOT be
          // retried as a failure, and remaining work should stop: cancellation
          // is an explicit control signal, not a transient error (High fix).
          if (res.status === 'cancelled') {
            run.stepStatus[stepId] = 'cancelled';
            run.status = 'cancelled';
            lastError = res.error ?? 'cancelled';
            ctx.onEvent?.(stepId, `cancelled: ${lastError}`);
            stepOutcome = { stepId, status: 'cancelled', summary: lastError, artifacts: [], tests: res.tests };
            break;
          }
          if (res.status === 'failed') {
            lastError = res.error ?? res.summary;
            ctx.onEvent?.(stepId, `attempt ${attempt} failed: ${lastError}`);
            if (attempt >= maxAttempts) {
              run.stepStatus[stepId] = 'failed';
              failedIds.add(stepId);
              stepOutcome = { stepId, status: 'failed', summary: lastError, artifacts: [], tests: res.tests };
              break;
            }
            // backoff before retry
            const backoff = step.retry?.backoffSeconds ?? 1;
            await new Promise((r) => setTimeout(r, backoff * 1000 * attempt));
            continue;
          }
          // The step reported success. If it declared outputs, that success is checked against the
          // filesystem before it is believed: an agent turn that ends without writing its declared
          // output is not a completed step, it is a step that produced nothing.
          const missing = unwrittenOutputs();
          if (missing.length > 0) {
            lastError = `the step declares it produces ${missing.join(', ')} and that was not written during this step: a file that was already there is not this step's output, so the step produced nothing (a run that produces nothing must not be graded on what it found)`;
            ctx.onEvent?.(stepId, `attempt ${attempt} produced nothing: ${missing.join(', ')}`);
            if (attempt >= maxAttempts) {
              run.stepStatus[stepId] = 'failed';
              failedIds.add(stepId);
              stepOutcome = { stepId, status: 'failed', summary: lastError, artifacts: [], tests: res.tests };
              break;
            }
            const backoffMs = (step.retry?.backoffSeconds ?? 1) * 1000 * attempt;
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          stepOutcome = {
            stepId,
            status: 'completed',
            summary: res.summary,
            artifacts: res.artifacts.map((a) => a.path),
            tests: res.tests,
          };
          // Persist the step's output as an artifact (kind from skill or step id),
          // carrying trace links so Requirement → Design → Test → Evidence
          // traceability can be rendered.
          if (stepOutcome.status === 'completed' && res.summary && res.summary !== 'processed: undefined') {
            const kind = stepArtifactKind(step, stepId.split('_')[0] ?? 'output');
            const stepTrace = task.trace ?? [];
            try {
              const art = await ctx.artifacts.write({
                taskId: task.id,
                kind,
                fileName: `${stepId}.md`,
                content: `# ${stepId}\n\n${res.summary}\n`,
                contentType: 'text/markdown',
                trace: stepTrace,
              });
              stepOutcome.artifacts = [...stepOutcome.artifacts, art.path];
            } catch (e) {
              ctx.onEvent?.(stepId, `artifact persist failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          ctx.onEvent?.(stepId, `attempt ${attempt} error: ${lastError}`);
          if (attempt >= maxAttempts) {
            run.stepStatus[stepId] = 'failed';
            failedIds.add(stepId);
            stepOutcome = { stepId, status: 'failed', summary: lastError, artifacts: [], tests: [] };
          }
        }
      }

      if (stepOutcome) {
        run.stepStatus[stepId] = stepOutcome.status === 'completed' ? 'completed' : 'failed';
        run.stepResults[stepId] = stepOutcome.summary;
        pushStep(stepOutcome);
        if (stepOutcome.status === 'completed') done.add(stepId);
        // Expose step summary to later steps via {step.<id>} var.
        vars[`step.${stepId}`] = stepOutcome.summary;

        // Trace propagation: extract REQ-xxx / DESIGN-xxx ids from the step
        // output and make them available to downstream steps + artifacts.
        const ids = extractTraceIds(stepOutcome.summary);
        if (ids.length > 0) {
          const known = new Set(vars['trace.ids'] ? vars['trace.ids'].split(',') : []);
          for (const id of ids) known.add(id);
          vars['trace.ids'] = [...known].join(',');
        }
      }
    }

    run.status = failedIds.size > 0 ? 'failed' : 'completed';
    run.finishedAt = Date.now();
    writeRecord(run.status);
    return { run, steps: stepResults, status: run.status, vars };
  } catch (e) {
    run.status = 'failed';
    run.finishedAt = Date.now();
    if (e instanceof Error) {
      pushStep({ stepId: 'workflow', status: 'failed', summary: e.message, artifacts: [], tests: [] });
    }
    // A run that threw still happened: record it before the error leaves the engine.
    writeRecord('failed');
    throw e;
  }
}