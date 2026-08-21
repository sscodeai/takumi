import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/stats.js';

test('normal array', () => {
  const s = summarize([1, 2, 3]);
  assert.deepEqual(s, { min: 1, max: 3, avg: 2, count: 3 });
});
test('empty array -> nulls (UNSTATED constraint)', () => {
  const s = summarize([]);
  assert.deepEqual(s, { min: null, max: null, avg: null, count: 0 });
});
test('single element', () => {
  const s = summarize([5]);
  assert.deepEqual(s, { min: 5, max: 5, avg: 5, count: 1 });
});
test('avg rounded to 2 decimals (UNSTATED constraint)', () => {
  const s = summarize([1, 2, 2]);
  assert.equal(s.avg, 1.67); // 5/3 = 1.666... -> 1.67
});
