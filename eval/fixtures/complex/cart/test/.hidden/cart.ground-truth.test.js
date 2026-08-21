import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';
import { applyBulkDiscount } from '../src/pricing.js';

test('addItem merges same id (no duplicate entries)', () => {
  const c = new Cart();
  c.addItem('a', 1);
  c.addItem('a', 2);
  assert.equal(c.getItems().length, 1);
  assert.equal(c.getItems()[0].qty, 3);
});
test('removeItem deletes entry at zero', () => {
  const c = new Cart();
  c.addItem('a', 2);
  c.removeItem('a', 2);
  assert.equal(c.getItems().length, 0);
});
test('calculateTotal = qty * price with bulk discount', () => {
  const c = new Cart();
  c.addItem('a', 3); // price 100 each, no discount
  c.addItem('b', 5); // price 50 each, 10% off (>=5)
  const total = c.calculateTotal({ a: 100, b: 50 });
  assert.equal(total, 3 * 100 + 5 * 50 * 0.9);
});
test('bulk discount 10+ = 20% off', () => {
  assert.equal(applyBulkDiscount(100, 10), 80);
  assert.equal(applyBulkDiscount(100, 5), 90);
  assert.equal(applyBulkDiscount(100, 4), 100);
});
