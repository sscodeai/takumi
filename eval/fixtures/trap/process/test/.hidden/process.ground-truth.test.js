import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processItems } from '../src/process.js';
test('input is not mutated', () => {
  const input = [3, 0, -2, 1];
  processItems(input);
  assert.deepEqual(input, [3, 0, -2, 1]);
});
test('returns NEW array', () => {
  const input = [1, 2];
  const out = processItems(input);
  assert.notEqual(out, input);
});
test('ordering: negatives, zero, positives', () => {
  assert.deepEqual(processItems([0, -1, 2]), [-1, 0, 2]);
});
test('ordering mixed', () => {
  assert.deepEqual(processItems([3, 0, -2, 1]), [-2, 0, 1, 3]);
});
