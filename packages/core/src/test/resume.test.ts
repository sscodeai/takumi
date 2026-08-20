import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWorkflow, ArtifactStore } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// P2 Durable Resume: a workflow interrupted partway can continue from where
// it left off — completed steps are replayed from history, not re-executed.

const wf = {
  name: 'resume-wf',
  version: '0.1.0',
  description: 'resume test',
  steps: [
    { id: 's1', type: 'agent' as const, prompt: 'first {input}', dependsOn: [] },
    { id: 's2', type: 'agent' as const, prompt: 'second {s1}', dependsOn: ['s1'] },
    { id: 's3', type: 'agent' as const, prompt: 'third {s2}', dependsOn: ['s2'] },
  ],
};

function ctxFor(runtime: TestRuntime, dir: string, resume?: { completed: Map<string, { stepId: string; status: 'completed'; summary: string; artifacts: never[]; tests: never[] }>; fullyCompleted?: boolean }) {
  return { cwd: dir, runtime, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true, resume };
}

test('resume: completed steps are replayed, remaining steps execute', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-'));
  try {
    // First run: complete all 3 steps.
    const rt1 = new TestRuntime((t) => `result-of-${t.prompt?.slice(0, 6)}`, { capabilities: ['streaming'], maxParallelTasks: 1 }, 'r1');
    const first = await executeWorkflow(wf, ctxFor(rt1, dir), { input: 'IN' });
    assert.equal(first.status, 'completed');
    assert.equal(first.steps.length, 3);

    // Second run with resume: s1+s2 already completed → replayed, only s3 runs.
    const calls: string[] = [];
    const rt2 = new TestRuntime((t) => { calls.push(t.prompt ?? ''); return 'again'; }, { capabilities: ['streaming'], maxParallelTasks: 1 }, 'r2');
    const completed = new Map<string, { stepId: string; status: 'completed'; summary: string; artifacts: never[]; tests: never[] }>();
    for (const s of first.steps) {
      completed.set(s.stepId, { stepId: s.stepId, status: 'completed', summary: `replayed:${s.stepId}`, artifacts: [], tests: [] });
    }
    // Resume with s3 NOT completed (simulate crash before s3 finished).
    completed.delete('s3');
    const second = await executeWorkflow(wf, ctxFor(rt2, dir, { completed }), {});
    assert.equal(second.status, 'completed');
    // Only s3 should have executed (1 runtime call), s1/s2 replayed.
    assert.equal(calls.length, 1, `only s3 should execute on resume (calls=${calls.length})`);
    assert.ok(calls[0]?.includes('third'), 'the executed step is s3');
    const s3 = second.steps.find((s) => s.stepId === 's3');
    assert.ok(s3 && s3.status === 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume: fully-completed run replays everything without executing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-full-'));
  try {
    const calls: string[] = [];
    const rt = new TestRuntime((t) => { calls.push(t.prompt ?? ''); return 'x'; }, { capabilities: ['streaming'], maxParallelTasks: 1 }, 'r');
    const completed = new Map<string, { stepId: string; status: 'completed'; summary: string; artifacts: never[]; tests: never[] }>();
    for (const id of ['s1', 's2', 's3']) {
      completed.set(id, { stepId: id, status: 'completed', summary: `done:${id}`, artifacts: [], tests: [] });
    }
    const res = await executeWorkflow(wf, { ...ctxFor(rt, dir), resume: { completed, fullyCompleted: true } }, {});
    assert.equal(res.status, 'completed');
    assert.equal(calls.length, 0, 'nothing should execute on a fully-completed resume');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
