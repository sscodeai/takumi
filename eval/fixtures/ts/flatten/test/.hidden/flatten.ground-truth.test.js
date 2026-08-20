import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten } from '../src/flatten.js';
test('ground truth: empty', () => assert.deepEqual(flatten([]), []));
test('ground truth: no nesting', () => assert.deepEqual(flatten([1, 2, 3]), [1, 2, 3]));
test('ground truth: one level', () => assert.deepEqual(flatten([1, [2, 3], 4]), [1, 2, 3, 4]));
test('ground truth: deep stays one level', () => assert.deepEqual(flatten([[1, [2]], 3]), [1, [2], 3]));
