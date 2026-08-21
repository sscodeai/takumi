import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processAll } from '../src/queue.js';

test('results in input order', async () => {
  const jobs = [
    () => new Promise((r) => setTimeout(() => r('first'), 30)),
    () => new Promise((r) => setTimeout(() => r('second'), 5)),
    () => new Promise((r) => setTimeout(() => r('third'), 10)),
  ];
  const res = await processAll(jobs);
  assert.deepEqual(res.map((r) => r.value), ['first', 'second', 'third']);
});
test('runs concurrently (not sequential)', async () => {
  let active = 0, maxActive = 0;
  const jobs = [1, 2, 3].map(() => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return 'x';
  });
  await processAll(jobs);
  assert.ok(maxActive >= 2, 'jobs should overlap (concurrent), maxActive=' + maxActive);
});
test('single failure absorbed, others processed', async () => {
  const res = await processAll([
    () => { throw new Error('boom'); },
    async () => 'ok',
  ]);
  assert.equal(res.length, 2);
  assert.ok(res[0].error);
  assert.equal(res[1].value, 'ok');
});
