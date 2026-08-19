import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliRuntimeAdapter } from '../index.js';
import { runTaskAndCollect } from '@takumi/core';

// Contract tests for CliRuntimeAdapter using a trivial real command ("echo")
// as the external harness. This exercises the spawn→stream→result plumbing
// without pretending a real DeepSeek Harness ran. Achieves exit 0.
test('CliRuntimeAdapter: runs a real command and streams output as events', async () => {
  const r = new CliRuntimeAdapter({
    id: 'echo-harness',
    name: 'Echo Harness',
    command: 'echo',
  });
  const events: string[] = [];
  const res = await runTaskAndCollect(r, { id: 'c1', prompt: 'hello takumi', cwd: '/tmp' }, (ev) => events.push(ev.type));
  assert.equal(res.status, 'completed');
  assert.ok(events.includes('task.started'));
  assert.ok(events.includes('task.completed'));
  // echo prints the prompt → surfaced as agent.message, lands in summary
  assert.ok(res.summary.includes('hello takumi'), `summary=${res.summary}`);
});

test('CliRuntimeAdapter: nonzero exit fails honestly', async () => {
  const r = new CliRuntimeAdapter({
    id: 'failing-harness',
    name: 'Failing Harness',
    command: 'sh',
    args: ['-c', 'exit 3'],
  });
  const events: string[] = [];
  const res = await runTaskAndCollect(r, { id: 'c2', prompt: 'x', cwd: '/tmp' }, (ev) => events.push(ev.type));
  assert.equal(res.status, 'failed');
  assert.ok(events.includes('task.failed'));
});

test('CliRuntimeAdapter: missing binary fails honestly (no fake completion)', async () => {
  const r = new CliRuntimeAdapter({
    id: 'ghost',
    name: 'Ghost',
    command: '/nonexistent/never-exists',
  });
  const res = await runTaskAndCollect(r, { id: 'c3', prompt: 'x', cwd: '/tmp' });
  assert.equal(res.status, 'failed');
});

test('CliRuntimeAdapter: metadata + capabilities', () => {
  const r = new CliRuntimeAdapter({ id: 'x', name: 'X', command: 'echo' });
  assert.equal(r.metadata().id, 'x');
  assert.ok(r.capabilities().capabilities.includes('streaming'));
});