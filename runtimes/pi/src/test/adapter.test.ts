import { test } from 'node:test';
import assert from 'node:assert/strict';

// Contract-level unit tests for PiRuntimeAdapter metadata/capabilities.
// (Real integration requires OPENCODE_GO_API_KEY — gated, not faked.)
test('PiRuntimeAdapter: metadata and capabilities contract', async () => {
  const { PiRuntimeAdapter } = await import('../index.js');
  const r = new PiRuntimeAdapter();
  const meta = r.metadata();
  assert.equal(meta.id, 'pi');
  assert.ok(meta.version);
  assert.equal(r.capabilities().capabilities.includes('shell'), true);
  assert.ok(r.capabilities().maxParallelTasks >= 1);
});

test('PiRuntimeAdapter: run without API key fails honestly (no fake completion)', async () => {
  const { PiRuntimeAdapter } = await import('../index.js');
  const r = new PiRuntimeAdapter();
  // Ensure no key is present in this test environment regardless of host env.
  const saved = process.env.OPENCODE_GO_API_KEY;
  delete process.env.OPENCODE_GO_API_KEY;
  try {
    const events: string[] = [];
    for await (const ev of r.run({ id: 'no-key', prompt: 'x', cwd: '/tmp' })) {
      events.push(ev.type);
    }
    assert.ok(events.includes('task.failed'), 'expected honest task.failed without key');
    const status = await r.getStatus('no-key');
    assert.equal(status, 'failed');
  } finally {
    if (saved !== undefined) process.env.OPENCODE_GO_API_KEY = saved;
  }
});

test('PiRuntimeAdapter: session pooling — reuseSession toggles pool, close is safe', async () => {
  const { PiRuntimeAdapter } = await import('../index.js');
  // Default: reuseSession true (pooled). Metadata advertises pooled sessions.
  const pooled = new PiRuntimeAdapter();
  assert.ok(pooled.metadata().description.includes('pooled'));
  // close() on empty pool must not throw.
  pooled.close();

  // reuseSession:false — still a valid adapter, close() safe.
  const unpooled = new PiRuntimeAdapter({ reuseSession: false });
  unpooled.close();

  // cancel on unknown task id must not throw.
  await unpooled.cancel('does-not-exist');
});

// PiRuntime runs the SAME shared Runtime Contract Suite as FakeRuntime (Gate 3).
// With OPENCODE_GO_API_KEY it does a real Pi run; without (CI) it reports
// NOT_RUN rather than faking a pass — we never call a fake "Pi success".
test('PiRuntimeAdapter: shared runtime contract suite (real Pi, gated on key)', async () => {
  const { PiRuntimeAdapter } = await import('../index.js');
  const { runRuntimeContractSuite } = await import('@takumi/core');
  const hasKey = !!process.env.OPENCODE_GO_API_KEY;
  const runtime = new PiRuntimeAdapter();
  try {
    const out = await runRuntimeContractSuite(runtime, {
      id: 'pi',
      prompt: 'Reply with exactly: CONTRACT_OK',
      cwd: '/tmp',
      skipRealRun: !hasKey,
    });
    // When no key, we assert we honestly did NOT run (NOT_RUN), never a fake pass.
    if (!hasKey) {
      assert.equal(out.result, 'PASS_WITH_NOT_RUN');
    } else {
      assert.equal(out.result, 'PASS');
    }
  } finally {
    runtime.close();
  }
});