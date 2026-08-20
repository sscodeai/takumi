import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumEven } from '../src/even.js';
test('ground truth: empty -> 0', () => assert.equal(sumEven([]), 0));
test('ground truth: odd-only -> 0', () => assert.equal(sumEven([1, 3, 5]), 0));
test('ground truth: mixed -> sum of evens', () => assert.equal(sumEven([1, 2, 3, 4, 5]), 6));
test('ground truth: negatives', () => assert.equal(sumEven([-2, -1, 0, 1, 2]), 0));
