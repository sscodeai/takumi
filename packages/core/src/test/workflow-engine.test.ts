import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, renderPrompt, WorkflowDefinition } from '../index.js';
import { FakeRuntime } from '@takumi/runtime-fake';

function ctx(overrides: { approvals?: string[]; onApproval?: (stepId: string) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-wf-'));
  const approvalIds = overrides.approvals ?? [];
  return {
    dir,
    exec: {
      cwd: dir,
      runtime: new FakeRuntime((task) => `done(${task.prompt})`),
      artifacts: new ArtifactStore(join(dir, 'artifacts')),
      onApproval: (req: { stepId: string }) => (overrides.onApproval ? overrides.onApproval(req.stepId) : approvalIds.includes(req.stepId)),
      onEvent: () => {},
    },
  };
}

test('workflow: sequential agent steps run in order', async () => {
  const c = ctx();
  try {
    const wf: WorkflowDefinition = {
      name: 'seq',
      version: '0.1.0',
      description: 'sequential',
      steps: [
        { id: 'a', type: 'agent', prompt: 'step A' },
        { id: 'b', type: 'agent', prompt: 'step B' },
      ],
    };
    const res = await executeWorkflow(wf, c.exec);
    assert.equal(res.status, 'completed');
    assert.deepEqual(res.steps.map((s) => s.stepId), ['a', 'b']);
    assert.ok(res.steps.every((s) => s.status === 'completed'));
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('workflow: approval step requires onApproval and blocks on reject', async () => {
  const c = ctx({ onApproval: () => false });
  try {
    const wf: WorkflowDefinition = {
      name: 'approve-reject',
      version: '0.1.0',
      description: 'approval reject',
      steps: [
        { id: 'design', type: 'agent', prompt: 'design' },
        { id: 'design_approval', type: 'approval', prompt: 'approve design?' },
        { id: 'impl', type: 'agent', prompt: 'implement', dependsOn: ['design_approval'] },
      ],
    };
    const res = await executeWorkflow(wf, c.exec);
    assert.equal(res.status, 'cancelled');
    assert.equal(res.steps.find((s) => s.stepId === 'design_approval')?.status, 'failed');
    // impl never ran
    assert.ok(!res.steps.some((s) => s.stepId === 'impl'));
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('workflow: approval approved continues to dependent steps', async () => {
  const c = ctx({ onApproval: () => true });
  try {
    const wf: WorkflowDefinition = {
      name: 'approve-ok',
      version: '0.1.0',
      description: 'approval ok',
      steps: [
        { id: 'design', type: 'agent', prompt: 'design' },
        { id: 'design_approval', type: 'approval', prompt: 'approve?' },
        { id: 'impl', type: 'agent', prompt: 'implement', dependsOn: ['design_approval'] },
      ],
    };
    const res = await executeWorkflow(wf, c.exec);
    assert.equal(res.status, 'completed');
    assert.equal(res.steps.filter((s) => s.stepId === 'impl').length, 1);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('workflow: retry policy retries failing agent step', async () => {
  const c = ctx();
  try {
    let calls = 0;
    const flaky = new FakeRuntime(() => {
      calls++;
      if (calls < 2) throw new Error('flaky failure');
      return 'stable';
    });
    const wf: WorkflowDefinition = {
      name: 'retry',
      version: '0.1.0',
      description: 'retry',
      steps: [{ id: 'a', type: 'agent', prompt: 'retry me', retry: { maxAttempts: 3, backoffSeconds: 0 } }],
    };
    const res = await executeWorkflow(
      wf,
      { cwd: c.dir, runtime: flaky, artifacts: c.exec.artifacts, onApproval: () => true },
    );
    assert.equal(res.status, 'completed');
    assert.ok(calls >= 2, `expected retry, calls=${calls}`);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('workflow: capability validation fails before execution', async () => {
  const c = ctx();
  try {
    const wf: WorkflowDefinition = {
      name: 'need-sandbox',
      version: '0.1.0',
      description: 'sandbox need',
      requires: ['sandbox'],
      steps: [{ id: 'a', type: 'agent', prompt: 'x' }],
    };
    await assert.rejects(() => executeWorkflow(wf, c.exec), /sandbox/);
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('workflow: failed dependency skips dependents', async () => {
  const c = ctx();
  try {
    const failing = new FakeRuntime(() => {
      throw new Error('hard fail');
    });
    const wf: WorkflowDefinition = {
      name: 'dep-fail',
      version: '0.1.0',
      description: 'dep fail',
      steps: [
        { id: 'a', type: 'agent', prompt: 'a' },
        { id: 'b', type: 'agent', prompt: 'b', dependsOn: ['a'] },
      ],
    };
    const res = await executeWorkflow(wf, { cwd: c.dir, runtime: failing, artifacts: c.exec.artifacts, onApproval: () => true });
    assert.equal(res.status, 'failed');
    const b = res.steps.find((s) => s.stepId === 'b');
    assert.equal(b?.status, 'skipped');
  } finally {
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('renderPrompt: substitutes {vars} and leaves unknown intact', () => {
  assert.equal(renderPrompt('hello {name}', { name: 'takumi' }), 'hello takumi');
  assert.equal(renderPrompt('keep {unknown}', {}), 'keep {unknown}');
});