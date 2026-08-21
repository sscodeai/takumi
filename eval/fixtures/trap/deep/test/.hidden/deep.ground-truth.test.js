import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deepEquals } from '../src/deep.js';
test('primitives', () => {
  assert.equal(deepEquals(1, 1), true);
  assert.equal(deepEquals(1, 2), false);
});
test('nested arrays', () => {
  assert.equal(deepEquals([1, [2, [3]]], [1, [2, [3]]]), true);
  assert.equal(deepEquals([1, [2]], [1, [3]]), false);
});
test('nested objects', () => {
  assert.equal(deepEquals({ a: { b: 1 } }, { a: { b: 1 } }), true);
  assert.equal(deepEquals({ a: { b: 1 } }, { a: { b: 2 } }), false);
});
test('different keys', () => {
  assert.equal(deepEquals({ a: 1 }, { b: 1 }), false);
});
test('null vs undefined', () => {
  assert.equal(deepEquals(null, undefined), false);
});
