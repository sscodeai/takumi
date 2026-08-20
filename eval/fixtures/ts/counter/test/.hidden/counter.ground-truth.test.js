import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Counter } from '../src/counter.js';
test('ground truth: starts at 0', () => assert.equal(new Counter().get(), 0));
test('ground truth: increment returns new value', () => { const c = new Counter(); assert.equal(c.increment(), 1); });
test('ground truth: accumulates', () => { const c = new Counter(); c.increment(); c.increment(); assert.equal(c.get(), 2); });
test('ground truth: get does not mutate', () => { const c = new Counter(); c.get(); assert.equal(c.get(), 0); });
