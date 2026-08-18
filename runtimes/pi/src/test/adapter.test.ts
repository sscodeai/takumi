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