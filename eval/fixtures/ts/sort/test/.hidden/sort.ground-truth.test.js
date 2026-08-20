import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortDesc } from '../src/sort.js';
test('ground truth: desc order', () => assert.deepEqual(sortDesc([3, 1, 2]), [3, 2, 1]));
test('ground truth: negatives', () => assert.deepEqual(sortDesc([-1, 5, -3]), [5, -1, -3]));
test('ground truth: equal stays', () => assert.deepEqual(sortDesc([2, 2, 1]), [2, 2, 1]));
