import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, runTaskAndCollect, WorkflowDefinition } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// Gate 23 — Performance Sanity: no memory leak, no O(n²) on event/artifact/
// step volume, no deadlock, no event loss.

test('Gate 23: 2000-event run — no event loss, bounded time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-'));
  try {
    const rt = new TestRuntime((t) => `done(${t.prompt})`, undefined, 'perf');
    // Emit 2000 agent.message events on top of the natural stream.
    const origRun = rt.run.bind(rt);
    rt.run = async function* (task: import('../types.js').AgentTask) {
      yield* origRun(task);
      for (let i = 0; i < 2000; i++) {
        yield { id: `${task.id}-n${i}`, taskId: task.id, type: 'agent.message' as const, timestamp: Date.now(), message: `ev${i}` };
      }
    };
    const events: string[] = [];
    const started = Date.now();
    const res = await runTaskAndCollect(rt, { id: 'p1', prompt: 'x', cwd: dir }, (ev) => events.push(ev.type));
    const elapsed = Date.now() - started;
    assert.equal(res.status, 'completed');
    assert.ok(events.length >= 2000, `should carry all synthetic events, got ${events.length}`);
    assert.ok(elapsed < 5000, `2000 events should process fast (elapsed=${elapsed}ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate 23: 100-artifact store — write+list no loss', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-art-'));
  try {
    const store = new ArtifactStore(join(dir, 'artifacts'));
    const started = Date.now();
    for (let i = 0; i < 100; i++) {
      await store.write({
        taskId: 't',
        kind: 'req',
        fileName: `r${i}.md`,
        content: `content ${i}`,
        contentType: 'text/markdown',
        trace: [`REQ-${i}`],
      });
    }
    const writeMs = Date.now() - started;
    const list = await store.list();
    assert.equal(list.length, 100, 'all 100 artifacts listed');
    assert.ok(writeMs < 5000, `100 artifact writes fast (${writeMs}ms)`);
    const first = list.find((a) => a.path === 'req/r0.md');
    assert.ok(first && first.trace[0] === 'REQ-0', 'trace preserved');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate 23: 20-step linear workflow completes (no deadlock, bounded time)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-wf-'));
  try {
    const rt = new TestRuntime((t) => `done(${t.prompt})`, undefined, 'perf20');
    const steps = Array.from({ length: 20 }, (_, i) => ({
      id: `s${i}`,
      type: 'agent' as const,
      prompt: `step ${i}`,
    }));
    const wf: WorkflowDefinition = { name: 'perf', version: '0.1.0', description: '', steps };
    const started = Date.now();
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 'completed');
    assert.equal(res.steps.length, 20);
    assert.equal(res.steps.filter((s) => s.status === 'completed').length, 20);
    assert.ok(elapsed < 10000, `20 steps should complete (elapsed=${elapsed}ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
