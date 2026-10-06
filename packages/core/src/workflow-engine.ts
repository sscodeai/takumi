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
import { parse as parseYamlText } from 'yaml';
const execAsync = promisify(exec);
/** Runs a harness FILE without a shell, so a path in a manifest is never a shell string. */
const execFileAsync = promisify(execFile);

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
    setTimeout(() => {
      // Best-effort cancel; the in-flight run settles in the background. We
      // resolve FAILED immediately — never hang the workflow on a stuck runtime.
      void runtime.cancel(task.id);
      resolve(timeoutResult);
    }, timeoutMs);
  });
  try {
    return await Promise.race([runPromise, timer]);
  } finally {
    // no-op; timer already resolved
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
  const runId = `wf-${randomUUID().slice(0, 8)}`;
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

  /**
   * A step may say `requirementRef: "{requirement}"`: the document THIS RUN was confirmed against
   * (ADR-031). It is the difference between a workflow that can only ever run on one file and one that
   * runs on whatever a human confirmed — and it fails closed when there is no confirmation to point at,
   * rather than resolving to a path nobody confirmed.
   */
  const requirementRefOf = (raw: string | undefined): { ref: string; error?: string } => {
    const ref = renderPrompt(raw ?? '', { ...vars, requirement: ctx.confirmedRequirement?.ref ?? '' }).trim();
    if (raw !== undefined && raw.includes('{requirement}') && (ctx.confirmedRequirement?.ref ?? '').length === 0) {
      return {
        ref,
        error:
          'this workflow points at {requirement} — the document the run was confirmed against — but this run has no confirmed requirement on record (pass --requirement and --confirmed-requirement)',
      };
    }
    return { ref };
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
          };
          try {
            const res = await runStepWithTimeout(ctx.runtime, task, step.timeoutMs);
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
        const results = await Promise.all(lvl0.map(runOne));
        for (const r of results) {
          preRun.set(r.stepId, r);
          vars[`step.${r.stepId}`] = r.summary;
        }
      }
    }
    for (const stepId of order) {
      const step = byId.get(stepId);
      if (!step) {
        run.stepStatus[stepId] = 'failed';
        throw new Error(`workflow step ${stepId} not found in definition`);
      }

      // Replay a concurrently pre-executed level-0 agent step.
      const pre = preRun.get(stepId);
      if (pre) {
        run.stepStatus[stepId] = pre.status;
        stepResults.push(pre);
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
        stepResults.push({ stepId, status: 'skipped', summary: `skipped (${because}: ${unmet.join(', ')})`, artifacts: [], tests: [] });
        continue;
      }

      // Durable resume: replay a previously-completed step from history
      // instead of re-executing it (P2). Its recorded result is reused as-is.
      const resumed = ctx.resume?.completed.get(stepId);
      if (resumed) {
        run.stepStatus[stepId] = 'completed';
        stepResults.push(resumed);
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
          stepResults.push({ stepId, status: 'failed', summary: 'rejected by approver', artifacts: [], tests: [] });
          return { run, steps: stepResults, status: 'cancelled' };
        }
        run.stepStatus[stepId] = 'completed';
        stepResults.push({ stepId, status: 'completed', summary: 'approved', artifacts: [], tests: [] });
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
          const { stdout, stderr } = await execAsync(cmd, { cwd: ctx.worktree ?? ctx.cwd, timeout: step.timeoutMs ?? 120000 });
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
          stepResults.push({ stepId, status: 'completed', summary: out, artifacts: [artifact.path], tests: [] });
          ctx.onEvent?.(stepId, `tool completed (${artifact.path})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          run.stepStatus[stepId] = 'failed';
          failedIds.add(stepId);
          stepResults.push({ stepId, status: 'failed', summary: `tool failed: ${msg}`, artifacts: [], tests: [] });
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
          const r = await execAsync(cmd, { cwd: ctx.worktree ?? ctx.cwd, timeout: step.timeoutMs ?? 300000 });
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
          stepResults.push({ stepId, status: 'completed', summary, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `quality gate PASSED (${fails} failing)`);
        } else {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          stepResults.push({ stepId, status: 'failed', summary, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `quality gate FAILED (${fails} failing) — workflow aborted`);
        }
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
          stepResults.push({
            stepId,
            status: 'failed',
            summary: artifactPath === null ? summary : `${summary}\nrule_review artifact: ${artifactPath}`,
            artifacts: artifactPath === null ? [] : [artifactPath],
            tests: [],
          });
          ctx.onEvent?.(stepId, `rule review FAILED: ${summary.split('\n')[0]}`);
        };

        /** Resolve a ref to a commit sha through the git seam; undefined = could not. */
        const resolveSha = async (ref: string): Promise<string | undefined> => {
          try {
            const resolved = await git.run(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ctx.cwd });
            if (resolved.exitCode !== 0) return undefined;
            const sha = resolved.stdout.trim().split('\n')[0]?.trim() ?? '';
            return /^[0-9a-f]{40}$/i.test(sha) ? sha : undefined;
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
        const baseSha = await resolveSha(baseRef);
        if (baseSha === undefined) {
          await failRuleReview(
            `rule_review precondition failed: baseRef "${baseRef}" could not be resolved to a commit in ${ctx.cwd}`,
          );
          done.add(stepId);
          continue;
        }
        const headSha = await resolveSha(headRef);
        if (headSha === undefined) {
          await failRuleReview(
            `rule_review precondition failed: headRef "${headRef}" could not be resolved to a commit in ${ctx.cwd}`,
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
        stepResults.push({
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
        stepResults.push({
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
          stepResults.push({ stepId, status: 'failed', summary: resolved.error, artifacts: [], tests: [] });
          ctx.onEvent?.(stepId, `judge forge FAILED: ${resolved.error}`);
          done.add(stepId);
          continue;
        }
        const reject = (message: string): void => {
          run.stepStatus[stepId] = 'failed';
          run.status = 'failed';
          failedIds.add(stepId);
          stepResults.push({ stepId, status: 'failed', summary: message, artifacts: [], tests: [] });
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
        // The judge directory is run-scoped and recreated, so a judge from an earlier run can never be
        // reused as this run's evidence.
        const judgeDir = path.join(ctx.cwd, '.takumi', 'acceptance', stepId);
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
          const r = await execFileAsync('bash', [path.resolve(ctx.cwd, forgeRef)], {
            cwd: judgeDir,
            timeout: step.timeoutMs ?? 300000,
            env: {
              ...process.env,
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
        stepResults.push({ stepId, status: 'completed', summary: forgeSummary, artifacts: [], tests: [] });
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
          stepResults.push({ stepId, status: 'failed', summary: message, artifacts: [], tests: [] });
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
        try {
          const r = await execFileAsync('bash', [acceptanceRef], {
            cwd: harnessCwd,
            timeout: step.timeoutMs ?? 300000,
            env: {
              ...process.env,
              TAKUMI_WORKTREE: worktreePath,
              TAKUMI_PROJECT: ctx.cwd,
              ...(forgedJudgePath === undefined ? {} : { TAKUMI_JUDGE_DIR: harnessCwd }),
            },
          });
          out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        } catch (e) {
          exitOk = false;
          const shell = e as { stdout?: string; stderr?: string };
          out = `${shell.stdout ?? ''}${shell.stderr ?? ''}` || (e instanceof Error ? e.message : String(e));
        }
        const verdict = parseAcceptVerdict(out);
        const checks = [...out.matchAll(/^(ok|not ok)\s+\d+\s*-\s*(.+)$/gm)].map((m) => ({
          result: m[1] === 'ok' ? 'pass' : 'fail',
          check: (m[2] ?? '').trim(),
        }));
        const head = await (async (): Promise<string | undefined> => {
          try {
            const g = ctx.git ?? createGitRunner();
            const r = await g.run(['rev-parse', 'HEAD']);
            return r.exitCode === 0 ? r.stdout.trim() : undefined;
          } catch {
            return undefined;
          }
        })();
        const accepted = exitOk && verdict.verdict === 'pass';
        const id = acceptanceIds.get(stepId) ?? 'ACCEPT-001';
        const requirements = extractTraceIds(requirementText).filter((t) => t.startsWith('REQ-'));
        const summary = [
          `acceptance ${accepted ? 'PASSED' : 'FAILED'}: ${accepted ? 'the confirmed requirement is satisfied' : (verdict.error ?? 'the harness reported a failing verdict')}`,
          `harness: ${acceptanceRef}`,
          `judge: ${forgedJudgePath === undefined ? '(none forged; a literal harness)' : `${forgedJudgePath} sha256:${shortDigest(forgedJudgeDigest)}`}`,
          `harness cwd: ${harnessCwd}`,
          `worktree: ${worktreePath}`,
          `requirement: ${requirementRef} sha256:${shortDigest(digest)}`,
          `confirmed: ${ctx.confirmedRequirement.ref} sha256:${shortDigest(ctx.confirmedRequirement.digest)}`,
          `verdict: ${verdict.verdict ?? '(none)'}`,
          `checks: ${checks.filter((c) => c.result === 'pass').length}/${checks.length} ok`,
          `exit: ${exitOk ? 0 : '!0'}`,
          out.slice(0, 1200),
        ].join('\n');

        if (accepted) {
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
          stepResults.push({
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
            if (appended === undefined) {
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
              `  feedback: ${appended === undefined ? 'none' : appended.id}`,
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

      // Delivery step: package the run's artifacts into a delivery bundle.
      // Produces a delivery manifest + a ZIP-able summary of all artifacts.
      if (step.type === 'delivery') {
        run.stepStatus[stepId] = 'running';
        const fsx3 = await import('node:fs/promises');
        const path3 = await import('node:path');
        const all = await ctx.artifacts.list();
        const lines = [
          `# 納品物一覧 (Delivery Manifest)`,
          `workflow: ${workflow.name}  |  run: ${runId}`,
          `generated: ${new Date().toISOString()}`,
          ``,
          `## artifacts (${all.length})`,
        ];
        for (const a of all) lines.push(`- ${a.path}  (kind=${a.kind}, trace=[${(a.trace ?? []).join(', ')}])`);
        const manifest = lines.join('\n');
        const deliveryArtifact = await ctx.artifacts.write({
          taskId: `${runId}:${stepId}`,
          kind: 'delivery',
          fileName: 'delivery-manifest.md',
          content: manifest,
          contentType: 'text/markdown',
          trace: vars['trace.ids'] ? vars['trace.ids'].split(',') : [],
        });
        stepResults.push({ stepId, status: 'completed', summary: `delivery bundle ready (${all.length} artifacts)`, artifacts: [deliveryArtifact.path], tests: [] });
        run.stepStatus[stepId] = 'completed';
        ctx.onEvent?.(stepId, `delivery manifest written (${all.length} artifacts)`);
        done.add(stepId);
        continue;
      }

      // agent / tool step
      const maxAttempts = step.retry?.maxAttempts ?? ctx.defaultMaxAttempts ?? 1;
      run.stepStatus[stepId] = 'running';
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
        };
        try {
          const res = await runStepWithTimeout(ctx.runtime, task, step.timeoutMs);
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
        stepResults.push(stepOutcome);
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
    return { run, steps: stepResults, status: run.status };
  } catch (e) {
    run.status = 'failed';
    run.finishedAt = Date.now();
    if (e instanceof Error) {
      stepResults.push({ stepId: 'workflow', status: 'failed', summary: e.message, artifacts: [], tests: [] });
    }
    throw e;
  }
}