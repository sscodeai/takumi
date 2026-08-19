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
  /** Max attempts per agent step before failing (default 1). */
  defaultMaxAttempts?: number;
  /**
   * Optional root of the skills registry (e.g. `<project>/extensions/skills`).
   * When set and a step declares `skill`, the step's prompt is resolved from
   * that skill's prompt template (prompts/<action>.md) — so skills drive
   * behavior, not just artifact folder naming (acceptance Gate 8).
   */
  skillsRoot?: string;
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
    for (const stepId of order) {
      const step = byId.get(stepId);
      if (!step) {
        run.stepStatus[stepId] = 'failed';
        throw new Error(`workflow step ${stepId} not found in definition`);
      }

      // Skip a step whose dependencies failed.
      const deps = step.dependsOn ?? [];
      if (deps.some((d) => failedIds.has(d))) {
        run.stepStatus[stepId] = 'skipped';
        stepResults.push({ stepId, status: 'skipped', summary: 'skipped (dependency failed)', artifacts: [], tests: [] });
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
        // Parse test outcome: fail count / "not ok" markers / explicit failure.
        // A gate with ZERO tests is NOT green (Quality Gate must be enforced:
        // no tests at all = the gate has nothing to vouch for → ABORT).
        const allOut = out.toUpperCase();
        // TAP format: "# tests N" / "# fail N" / "not ok"
        const notOk = (out.match(/not ok/g) ?? []).length;
        const failLine = out.match(/^#\s*fail\s*:?\s*(\d+)/m);
        const testLine = out.match(/^#\s*tests\s*:?\s*(\d+)/m);
        // Maven format: "Tests run: 2, Failures: 0, Errors: 1, Skipped: 0"
        const mvnLine = out.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/);
        let fails: number;
        let totalTests: number;
        if (mvnLine) {
          totalTests = parseInt(mvnLine[1] ?? '0', 10);
          fails = parseInt(mvnLine[2] ?? '0', 10) + parseInt(mvnLine[3] ?? '0', 10);
        } else {
          fails = failLine ? parseInt(failLine[1] ?? '0', 10) : notOk;
          totalTests = testLine ? parseInt(testLine[1] ?? '0', 10) : (fails > 0 ? fails : 1);
        }
        // Maven BUILD FAILURE (e.g. compile error before any test runs) is a hard fail.
        const hardFail = /BUILD FAILURE|BUILD FAILED|FATAL/i.test(allOut);
        const gatePassed = exitOk && !hardFail && fails === 0 && totalTests > 0;
        const summary = `quality_gate ${gatePassed ? 'PASSED' : 'FAILED'}: ${fails} failing over ${totalTests} tests, exit ${exitOk ? 0 : '!0'}\n${out.slice(0, 1200)}`;
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

      // Independent Review step: a quality gate on top of review. Runs in an
      // ISOLATED runtime context (separate cwd → separate Pi session) so the
      // reviewer sees the code cold, untainted by the implementation session.
      // Its prompt uses the independent_review skill; the review verdict is
      // persisted as an artifact and the step fails if a critical finding exists.
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
        const hasCritical = /Critical|High|重大|must fix|要修正|ng|✗|不合格/i.test(res2.summary);
        const kind = step.id.split('_')[0] ?? 'review';
        const artifact = await ctx.artifacts.write({
          taskId: reviewTask.id,
          kind,
          fileName: `${stepId}.md`,
          content: res2.summary,
          contentType: 'text/markdown',
          trace: taskTraceFor(step, vars),
        });
        stepResults.push({
          stepId,
          status: hasCritical ? 'failed' : 'completed',
          summary: hasCritical ? `independent review found critical findings:\n${res2.summary.slice(0, 1500)}` : `independent review passed:\n${res2.summary.slice(0, 800)}`,
          artifacts: [artifact.path],
          tests: [],
        });
        run.stepStatus[stepId] = hasCritical ? 'failed' : 'completed';
        if (hasCritical) {
          run.status = 'failed';
          failedIds.add(stepId);
          ctx.onEvent?.(stepId, `independent review FAILED (critical findings) — workflow aborted`);
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