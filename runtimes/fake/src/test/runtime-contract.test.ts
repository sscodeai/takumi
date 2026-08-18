import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTaskAndCollect, validateCapabilities } from '@takumi/core';
import { FakeRuntime } from '../index.js';

test('runTaskAndCollect: FakeRuntime full chain Core→Runtime→Event→Result', async () => {
  const runtime = new FakeRuntime((task: { prompt: string }) => `analyzed: ${task.prompt}`);
  const events: string[] = [];
  const result = await runTaskAndCollect(
    runtime,
    { id: 't1', prompt: 'Implement user login API', cwd: '/tmp' },
    (ev: { type: string }) => events.push(ev.type),
  );

  // event stream shape
  assert.ok(events.includes('task.started'));
  assert.ok(events.includes('agent.message'));
  assert.ok(events.includes('command.completed'));
  assert.ok(events.includes('test.completed'));
  assert.ok(events.includes('task.completed'));
  assert.equal(events[0], 'task.started');
  assert.equal(events.at(-1), 'task.completed');

  // result contract
  assert.equal(result.status, 'completed');
  assert.ok(result.summary.includes('analyzed: Implement user login API'));
  assert.equal(result.taskId, 't1');
  assert.equal(result.usage.runtimeId, 'fake');

  // runtime queries
  assert.equal(await runtime.getStatus('t1'), 'completed');
  const usage = await runtime.getUsage('t1');
  assert.equal(usage.totalTokens, 0);
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