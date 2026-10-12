import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  executeWorkflow,
  runStepCommand,
  type AgentTask,
  type SandboxResult,
  type StepSandbox,
  type StepSandboxRequest,
  type WorkflowDefinition,
  type WorkflowExecutionContext,
} from '../index.js';
import { TestRuntime } from '../test-utils.js';

// S2 (ADR-058): every step shell command is routed through the execution
// context's `sandbox` seam. These tests are the non-vacuous half of that: a
// recording boundary proves the command actually reached it, and a boundary
// that refuses proves the refusal surfaces as a failed step instead of the
// command running unconfined.

/** A boundary that records requests and answers with a canned result. */
class RecordingSandbox implements StepSandbox {
  readonly id = 'recording';
  readonly requests: StepSandboxRequest[] = [];
  constructor(private readonly reply: (req: StepSandboxRequest) => SandboxResult) {}
  async runStep(req: StepSandboxRequest): Promise<SandboxResult> {
    this.requests.push(req);
    return this.reply(req);
  }
  async close(): Promise<void> {}
}

function ok(stdout: string): SandboxResult {
  return { stdout, stderr: '', code: 0, timedOut: false };
}

function baseCtx(extra: Partial<WorkflowExecutionContext> = {}): {
  dir: string;
  ctx: WorkflowExecutionContext;
  cleanup(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-step-'));
  return {
    dir,
    ctx: {
      cwd: dir,
      runtime: new TestRuntime((task) => `done(${task.prompt})`),
      artifacts: new ArtifactStore(join(dir, 'artifacts')),
      onApproval: () => true,
      onEvent: () => {},
      ...extra,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// REWRITTEN, not deleted (ledger #79). This test used to assert the OPPOSITE — that a `tool`
// step's command travelled through the boundary — and that assertion was the category error
// written down: a `tool` step's command comes from the WORKFLOW DEFINITION, so it is the
// platform's own tooling, and the boundary makes the platform repository (where that tooling
// lives) invisible. The property worth pinning is the opposite one.
test('step seam: a platform tool step is NOT confined — the boundary would hide the repository the tool lives in', async () => {
  const { ctx, cleanup } = baseCtx();
  try {
    const sandbox = new RecordingSandbox(() => {
      throw new Error('the boundary must not be asked to run platform tooling (ledger #79)');
    });
    const wf: WorkflowDefinition = {
      name: 'tool-not-confined',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'tool_step', type: 'tool', prompt: 'echo hi' }],
    };
    const res = await executeWorkflow(wf, { ...ctx, sandbox });
    assert.equal(res.status, 'completed', JSON.stringify(res.steps));
    assert.equal(sandbox.requests.length, 0, 'a workflow-defined command does not travel through the boundary');
    assert.ok(res.steps[0]?.summary.includes('hi'), 'the command really ran');
  } finally {
    cleanup();
  }
});

// Same rewrite as the `tool` case above, for the same reason: the gate's command is written in
// the workflow, so it is the platform's own check and runs where it lives.
test('step seam: a quality_gate step runs its own command directly too (ledger #79)', async () => {
  const { ctx, cleanup } = baseCtx();
  try {
    const sandbox = new RecordingSandbox(() => {
      throw new Error('the boundary must not be asked to run platform tooling (ledger #79)');
    });
    const wf: WorkflowDefinition = {
      name: 'gate-not-confined',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'gate', type: 'quality_gate', prompt: 'echo "==================== 2 passed in 0.42s ===================="' }],
    };
    const res = await executeWorkflow(wf, { ...ctx, sandbox });
    assert.equal(res.status, 'completed', JSON.stringify(res.steps));
    assert.equal(sandbox.requests.length, 0);
  } finally {
    cleanup();
  }
});

// REWRITTEN for ledger #79. The property that must SURVIVE the rewrite is the fail-closed one:
// a step whose boundary could not be established must FAIL, never fall back to running open. The
// channel changed — the refusal now comes from the confined SESSION the runtime builds (runtimes/pi
// `confinementOf`), not from the shell seam — so this pins the engine half, and the refusal itself
// is pinned in runtimes/pi: 'confinement: bash routes through the kernel boundary' and
// 'confinement: a half-configured task is refused (fail closed)'.
test('step seam: a runtime whose confined session cannot be built fails the AGENT step, never runs open', async () => {
  const { dir, ctx, cleanup } = baseCtx();
  try {
    const runtime = new TestRuntime(() => {
      throw new Error('SANDBOX_REFUSED: the boundary failed its self-test: tool:node (not_resolvable)');
    });
    const sandbox = new RecordingSandbox(() => ok(''));
    const sandboxRoots = { rw: [dir], ro: [], cwd: dir };
    const wf: WorkflowDefinition = {
      name: 'agent-refused',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'impl', type: 'agent', prompt: 'do it' }],
    };
    const res = await executeWorkflow(wf, { ...ctx, runtime, sandbox, sandboxRoots });
    assert.equal(res.steps[0]?.status, 'failed', JSON.stringify(res.steps));
    assert.match(res.steps[0]?.summary ?? '', /SANDBOX_REFUSED/);
  } finally {
    cleanup();
  }
});

test('step seam: without a boundary a tool step keeps its existing behaviour (A9)', async () => {
  const { ctx, cleanup } = baseCtx();
  try {
    const wf: WorkflowDefinition = {
      name: 'tool-passthrough',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'tool_step', type: 'tool', prompt: 'echo passthrough-ok' }],
    };
    const res = await executeWorkflow(wf, ctx);
    assert.equal(res.status, 'completed');
    assert.ok(res.steps[0]?.summary.includes('passthrough-ok'));
  } finally {
    cleanup();
  }
});

// REWRITTEN for ledger #79: the argv/env/cwd/timeout contract is unchanged, but the command is no
// longer handed to a boundary, so the property is asserted against the REAL execution instead of
// against a recorded boundary request.
test('step seam: runStepCommand runs a workflow-defined command with the given cwd/env/timeout', async () => {
  const { dir, ctx, cleanup } = baseCtx();
  try {
    const sandbox = new RecordingSandbox(() => {
      throw new Error('platform tooling does not travel through the boundary (ledger #79)');
    });
    const r = await runStepCommand(
      { ...ctx, sandbox },
      { argv: ['bash', '-c', 'pwd; printf "%s" "$TAKUMI_PROJECT"'], cwd: dir, env: { TAKUMI_PROJECT: dir }, timeoutMs: 5000 },
    );
    assert.ok(r.stdout.includes(dir), `cwd and env were forwarded: ${JSON.stringify(r.stdout)}`);
    assert.equal(sandbox.requests.length, 0);
  } finally {
    cleanup();
  }
});

// The OTHER half of ledger #79, and the reason removing the boundary from the shell seam is safe
// rather than merely convenient: the boundary did not disappear, it belongs to the seam that
// contains the MODEL. An agent step must carry `sandbox` + `sandboxRoots` into its runtime task —
// otherwise the run is open, and nothing in the run record would say so.
test('step seam: an AGENT step still carries the boundary into its runtime session', async () => {
  const { dir, ctx, cleanup } = baseCtx();
  try {
    const seen: AgentTask[] = [];
    const runtime = new TestRuntime((task) => {
      seen.push(task);
      return 'ok';
    });
    const sandbox = new RecordingSandbox(() => ok(''));
    const sandboxRoots = { rw: [dir], ro: [], cwd: dir };
    const wf: WorkflowDefinition = {
      name: 'agent-confined',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'impl', type: 'agent', prompt: 'do it' }],
    };
    const res = await executeWorkflow(wf, { ...ctx, runtime, sandbox, sandboxRoots });
    assert.equal(res.status, 'completed', JSON.stringify(res.steps));
    assert.equal(seen.length, 1, 'the agent step ran once');
    assert.equal(seen[0]?.options?.sandbox, sandbox, 'the model session is built from the boundary');
    assert.equal(seen[0]?.options?.sandboxRoots, sandboxRoots, 'and from the containment roots');
  } finally {
    cleanup();
  }
});
