import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobs, scheduleDaily } from '../src/scheduler.js';

test('single schedule -> one job', () => {
  jobs.length = 0;
  scheduleDaily(9, 30, () => {});
  assert.equal(jobs.length, 1);
});
test('duplicate schedule -> ONE job (dedupe)', () => {
  jobs.length = 0;
  const fn = () => {};
  scheduleDaily(9, 30, fn);
  scheduleDaily(9, 30, fn);
  assert.equal(jobs.length, 1);
});
test('different hours -> two jobs', () => {
  jobs.length = 0;
  scheduleDaily(9, 0, () => {});
  scheduleDaily(10, 0, () => {});
  assert.equal(jobs.length, 2);
});
test('jobs sorted by (hour, minute) ascending (UNSTATED constraint)', () => {
  jobs.length = 0;
  scheduleDaily(10, 0, () => {});
  scheduleDaily(9, 30, () => {});
  scheduleDaily(9, 0, () => {});
  assert.deepEqual(jobs.map((j) => [j.hour, j.minute]), [[9, 0], [9, 30], [10, 0]]);
});
