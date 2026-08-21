import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../src/inventory-service.js';
import { items, reset } from '../src/data.js';

test('register creates item with stock 0', () => {
  reset();
  const s = new InventoryService();
  const it = s.register({ name: 'apple', price: 100 });
  assert.ok(it.id);
  assert.equal(it.name, 'apple');
  assert.equal(it.stock, 0);
});
test('reserve decrements stock', () => {
  reset();
  const s = new InventoryService();
  const it = s.register({ name: 'apple', price: 100 });
  s.restock(it.id, 10);
  const ok = s.reserve(it.id, 3);
  assert.equal(ok, true);
  assert.equal(items.get(it.id).stock, 7);
});
test('reserve insufficient -> 400 style failure, stock unchanged', () => {
  reset();
  const s = new InventoryService();
  const it = s.register({ name: 'apple', price: 100 });
  s.restock(it.id, 2);
  const res = s.reserve(it.id, 5);
  assert.equal(res, false); // failure signal
  assert.equal(items.get(it.id).stock, 2); // ATOMIC: unchanged
});
test('restock adds stock', () => {
  reset();
  const s = new InventoryService();
  const it = s.register({ name: 'apple', price: 100 });
  s.restock(it.id, 5);
  s.restock(it.id, 3);
  assert.equal(items.get(it.id).stock, 8);
});
test('list returns all items', () => {
  reset();
  const s = new InventoryService();
  s.register({ name: 'a', price: 1 });
  s.register({ name: 'b', price: 2 });
  assert.equal(s.list().length, 2);
});
