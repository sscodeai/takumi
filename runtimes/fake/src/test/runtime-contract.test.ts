import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRuntimeContractSuite } from '@takumi/core';
import { validateCapabilities } from '@takumi/core';
import { FakeRuntime } from '../index.js';

// FakeRuntime runs the SHARED Runtime Contract Suite (Gate 3).
// The same suite is executed against PiRuntime — proving the Core↔Runtime
// contract is identical and Core never depends on a real harness.
test('FakeRuntime: shared runtime contract suite', async () => {
  const runtime = new FakeRuntime((task: { prompt: string }) => `analyzed: ${task.prompt}`);
  const out = await runRuntimeContractSuite(runtime, {
    id: 'fake',
    prompt: 'Implement user login API',
    cwd: '/tmp',
  });
  assert.equal(out.result, 'PASS');
});

// Extra: failure simulation (contract suite covers success; this covers retry/fail).
test('FakeRuntime: simulate failure when task throws', async () => {
  const flaky = new FakeRuntime(() => {
    throw new Error('boom');
  });
  const events: string[] = [];
  const { runTaskAndCollect } = await import('@takumi/core');
  const res = await runTaskAndCollect(flaky, { id: 'fail-1', prompt: 'x', cwd: '/tmp' }, (ev) => events.push(ev.type));
  assert.equal(res.status, 'failed');
  assert.ok(events.includes('task.failed'));
});

test('validateCapabilities: ok when satisfied, reports missing otherwise', () => {
  const runtime = new FakeRuntime();
  assert.deepEqual(validateCapabilities(runtime, ['shell', 'filesystem']), { ok: true });
  const missing = validateCapabilities(runtime, ['browser', 'sandbox']);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.deepEqual(missing.missing, ['browser', 'sandbox']);
  }
});

test('metadata + capabilities contract', () => {
  const runtime = new FakeRuntime();
  const meta = runtime.metadata();
  assert.equal(meta.id, 'fake');
  assert.ok(meta.version);
  const caps = runtime.capabilities();
  assert.ok(caps.capabilities.includes('streaming'));
  assert.ok(caps.maxParallelTasks >= 1);
});