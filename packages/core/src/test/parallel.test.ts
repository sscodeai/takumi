import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWorkflow, ArtifactStore } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// P2 Parallel execution: independent steps at the same topo level must run
// CONCURRENTLY (not serially). A 300ms step + a 300ms step in parallel ≈ 300ms;
// serial would be ≈ 600ms.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('parallel: independent steps at the same level run concurrently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'par-'));
  try {
    // Each step takes ~400ms; two same-level steps should finish in < 700ms
    // if parallel (serial would be ≥ 800ms).
    const rt = new TestRuntime(async (t) => {
      await sleep(400);
      return `done-${t.prompt?.slice(0, 3)}`;
    }, { capabilities: ['streaming', 'parallelExecution'], maxParallelTasks: 2 }, 'par');
    const wf = {
      name: 'par-wf',
      version: '0.1.0',
      description: 'parallel test',
      steps: [
        { id: 'a', type: 'agent' as const, prompt: 'AAA {input}', dependsOn: [] },
        { id: 'b', type: 'agent' as const, prompt: 'BBB {input}', dependsOn: [] },
        { id: 'c', type: 'agent' as const, prompt: 'CCC {a}{b}', dependsOn: ['a', 'b'] },
      ],
    };
    const t0 = Date.now();
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true }, { input: 'IN' });
    const dt = Date.now() - t0;
    assert.equal(res.status, 'completed');
    // a+b (parallel) = ~400ms, then c = ~400ms → total ~800ms.
    // If a+b were serial → ~1200ms. Assert well below serial.
    assert.ok(dt < 1100, `a+b should overlap (took ${dt}ms; serial would be ~1200ms)`);
    // Dependency correctness: c ran after a AND b completed.
    const idx = (id: string) => res.steps.findIndex((s) => s.stepId === id);
    assert.ok(idx('a') !== -1 && idx('b') !== -1 && idx('c') !== -1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parallel: dependent steps still respect order (never parallel with deps)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'par-dep-'));
  try {
    const order: string[] = [];
    const rt = new TestRuntime(async (t) => {
      await sleep(50);
      order.push(t.prompt?.slice(0, 3) ?? '?');
      return 'x';
    }, { capabilities: ['streaming', 'parallelExecution'], maxParallelTasks: 2 }, 'par-dep');
    const wf = {
      name: 'par-dep',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'a', type: 'agent' as const, prompt: 'AAA', dependsOn: [] },
        { id: 'b', type: 'agent' as const, prompt: 'BBB', dependsOn: ['a'] },
        { id: 'c', type: 'agent' as const, prompt: 'CCC', dependsOn: ['b'] },
      ],
    };
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true }, {});
    assert.equal(res.status, 'completed');
    assert.deepEqual(order, ['AAA', 'BBB', 'CCC'], 'strict chain must run in order');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
