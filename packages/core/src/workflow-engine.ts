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
import { judgeGate, parseTestReport } from './quality-gate.js';
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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);

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

  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const failedIds = new Set<string>();

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
            cwd: ctx.cwd,
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
        else failedIds.add(stepId);
        ctx.onEvent?.(stepId, `parallel result: ${pre.status}`);
        continue;
      }

      // Skip a step whose dependencies failed.
      const deps = step.dependsOn ?? [];
      if (deps.some((d) => failedIds.has(d))) {
        run.stepStatus[stepId] = 'skipped';
        stepResults.push({ stepId, status: 'skipped', summary: 'skipped (dependency failed)', artifacts: [], tests: [] });
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
          const { stdout, stderr } = await execAsync(cmd, { cwd: ctx.cwd, timeout: step.timeoutMs ?? 120000 });
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
          const r = await execAsync(cmd, { cwd: ctx.cwd, timeout: step.timeoutMs ?? 300000 });
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
        const allOut = out.toUpperCase();
        const report = parseTestReport(out);
        // Maven BUILD FAILURE (e.g. compile error before any test runs) is a hard fail.
        const hardFail = /BUILD FAILURE|BUILD FAILED|FATAL/i.test(allOut);
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
            worktree: ctx.cwd,
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
          cwd: ctx.cwd,
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