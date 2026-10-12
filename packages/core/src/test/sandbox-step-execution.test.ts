import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtifactStore,
  executeWorkflow,
  runStepCommand,
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

test('step seam: a tool step runs its command through the boundary', async () => {
  const { dir, ctx, cleanup } = baseCtx();
  try {
    const sandbox = new RecordingSandbox((req) => ok(`ran ${req.shell}`));
    const wf: WorkflowDefinition = {
      name: 'tool-route',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'tool_step', type: 'tool', prompt: 'echo hi' }],
    };
    const res = await executeWorkflow(wf, { ...ctx, sandbox });
    assert.equal(res.status, 'completed');
    assert.equal(sandbox.requests.length, 1, 'exactly one boundary request');
    assert.equal(sandbox.requests[0]?.shell, 'echo hi');
    assert.equal(sandbox.requests[0]?.cwd, dir);
    assert.ok(res.steps[0]?.summary.includes('ran echo hi'));
  } finally {
    cleanup();
  }
});

test('step seam: a quality_gate step runs its command through the boundary', async () => {
  const { ctx, cleanup } = baseCtx();
  try {
    const sandbox = new RecordingSandbox(() => ok('==================== 2 passed in 0.42s ====================\n'));
    const wf: WorkflowDefinition = {
      name: 'gate-route',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'gate', type: 'quality_gate', prompt: 'pnpm test' }],
    };
    const res = await executeWorkflow(wf, { ...ctx, sandbox });
    assert.equal(res.status, 'completed', JSON.stringify(res.steps));
    assert.equal(sandbox.requests[0]?.shell, 'pnpm test');
  } finally {
    cleanup();
  }
});

test('step seam: a boundary refusal fails the step instead of running unconfined', async () => {
  const { dir, ctx, cleanup } = baseCtx();
  try {
    const sandbox = new RecordingSandbox(() => ({
      stdout: '',
      stderr: 'SANDBOX_REFUSED: the boundary failed its self-test: tool:node (not_resolvable)',
      code: 126,
      timedOut: false,
    }));
    const wf: WorkflowDefinition = {
      name: 'tool-refused',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'tool_step', type: 'tool', prompt: 'touch should-not-run' }],
    };
    const res = await executeWorkflow(wf, { ...ctx, sandbox });
    assert.equal(res.steps[0]?.status, 'failed');
    assert.match(res.steps[0]?.summary ?? '', /tool failed/);
    assert.equal(sandbox.requests.length, 1);
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

test('step seam: runStepCommand forwards argv/env/timeout and surfaces a refusal', async () => {
  const { dir, ctx, cleanup } = baseCtx();
  try {
    const sandbox = new RecordingSandbox(() => ({
      stdout: '',
      stderr: 'SANDBOX_REFUSED: no boundary',
      code: 126,
      timedOut: false,
    }));
    await assert.rejects(
      () =>
        runStepCommand(
          { ...ctx, sandbox },
          { argv: ['bash', '/x/forge.sh'], cwd: dir, env: { TAKUMI_PROJECT: dir }, timeoutMs: 1234 },
        ),
      (error: unknown) => {
        const e = error as { code?: number; stderr?: string };
        return e.code === 126 && (e.stderr ?? '').includes('SANDBOX_REFUSED');
      },
    );
    assert.deepEqual(sandbox.requests[0]?.argv, ['bash', '/x/forge.sh']);
    assert.deepEqual(sandbox.requests[0]?.env, { TAKUMI_PROJECT: dir });
    assert.equal(sandbox.requests[0]?.timeoutMs, 1234);
  } finally {
    cleanup();
  }
});
