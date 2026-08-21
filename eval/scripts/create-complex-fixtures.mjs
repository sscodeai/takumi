#!/usr/bin/env node
/**
 * Create HIGH-COMPLEXITY eval fixtures (eval/fixtures/complex/*).
 * Multi-file real-project-shaped fixtures with existing code, partial tests,
 * and cross-file invariants. Vague/Japanese/multi-step requirements.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'complex');
rmSync(ROOT, { recursive: true, force: true });

function write(rel, content) {
  const p = join(ROOT, rel);
  mkdirSync(p.split('/').slice(0, -1).join('/'), { recursive: true });
  writeFileSync(p, content);
}
const pkg = (name) => `{
  "name": "${name}",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test 'test/**/*.test.js'" }
}`;

// ================= inventory (Japanese, atomicity trap) =================
write('inventory/package.json', pkg('eval-inventory'));
write('inventory/src/data.js', `// Data layer — in-memory store.
export const items = new Map(); // id -> { id, name, price, stock }

let nextId = 1;
export function nextItemId() { return nextId++; }

export function reset() { items.clear(); nextId = 1; }
`);
write('inventory/src/inventory-service.js', `// Service layer — INCOMPLETE (to be implemented by agent).
import { items, nextItemId } from './data.js';

export class InventoryService {
  // TODO: implement register/reserve/restock/list
  register({ name, price }) {
    // stub
  }
  reserve(id, quantity) {
    // stub
  }
  restock(id, quantity) {
    // stub
  }
  list() {
    // stub
  }
}
`);
write('inventory/src/routes.js', `// HTTP layer — wire the service to handlers.
// TODO: implement route handlers using InventoryService.
`);
write('inventory/src/index.js', `export { InventoryService } from './inventory-service.js';\n`);
write('inventory/test/.hidden/inventory.ground-truth.test.js', `import { test } from 'node:test';
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
`);

// ================= cart (dedupe + bulk discount) =================
write('cart/package.json', pkg('eval-cart'));
write('cart/src/pricing.js', `// Pricing — applyBulkDiscount exists but tier logic may be wrong.
export function applyBulkDiscount(unitPrice, quantity) {
  if (quantity >= 10) return unitPrice * 0.8;
  if (quantity >= 5) return unitPrice * 0.9;
  return unitPrice;
}
`);
write('cart/src/cart.js', `// Cart — BUG: duplicates not merged.
export class Cart {
  constructor() { this._items = []; } // [{id, qty}]
  addItem(id, qty = 1) {
    this._items.push({ id, qty }); // BUG: no dedupe
  }
  removeItem(id, qty = 1) {
    const i = this._items.findIndex((it) => it.id === id);
    if (i >= 0) {
      this._items[i].qty -= qty;
      if (this._items[i].qty <= 0) this._items.splice(i, 1);
    }
  }
  getItems() { return this._items; }
  // calculateTotal needs pricing integration — TODO
  calculateTotal(prices) {
    return this._items.reduce((sum, it) => sum + (prices[it.id] ?? 0) * it.qty, 0);
  }
}
`);
write('cart/src/index.js', `export { Cart } from './cart.js';\nexport { applyBulkDiscount } from './pricing.js';\n`);
write('cart/test/.hidden/cart.ground-truth.test.js', `import { test } from 'node:test';
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
`);

// ================= migration (legacy → new API, shape compat) =================
write('migration/package.json', pkg('eval-migration'));
write('migration/src/legacy.js', `// LEGACY API — must not be used by consumer after migration.
export async function getUser(id) {
  const res = await fetch('https://api.legacy.example.com/users/' + id);
  const u = await res.json();
  return { id: u.id, name: u.name }; // legacy shape
}
`);
write('migration/src/newapi.js', `// NEW API — already implemented.
export async function fetchUser(id) {
  const res = await fetch('https://api.new.example.com/users/' + id);
  const u = await res.json();
  return { id: u.id, displayName: u.displayName }; // new shape
}
`);
write('migration/src/consumer.js', `// Consumer — currently calls legacy, must migrate to newapi.
import { getUser } from './legacy.js';
export async function getUserName(id) {
  const u = await getUser(id);
  return u.name;
}
`);
write('migration/src/index.js', `export { getUserName } from './consumer.js';\n`);
write('migration/test/.hidden/migration.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getUserName } from '../src/consumer.js';

test('consumer no longer imports legacy', () => {
  const src = readFileSync(join(import.meta.dirname, '../src/consumer.js'), 'utf8');
  assert.ok(!src.includes("legacy.js"), 'consumer must not import legacy');
  assert.ok(src.includes('newapi'), 'consumer must use newapi');
});
test('getUserName returns name shape (displayName mapped)', async () => {
  // mock global fetch for newapi
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ id: '1', displayName: 'Alice' }) });
  try {
    const name = await getUserName('1');
    assert.equal(name, 'Alice'); // consumer maps displayName → name
  } finally { globalThis.fetch = orig; }
});
`);

// ================= queue (concurrency, order preservation) =================
write('queue/package.json', pkg('eval-queue'));
write('queue/src/queue.js', `// BUG: results order does not match input order.
export async function processAll(jobs) {
  const results = [];
  await Promise.all(jobs.map(async (job) => {
    try {
      const r = await job();
      results.push({ value: r });
    } catch (e) {
      results.push({ error: e.message });
    }
  }));
  return results; // BUG: order is completion order, not input order
}
`);
write('queue/src/index.js', `export { processAll } from './queue.js';\n`);
write('queue/test/.hidden/queue.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processAll } from '../src/queue.js';

test('results in input order', async () => {
  const jobs = [
    () => new Promise((r) => setTimeout(() => r('first'), 30)),
    () => new Promise((r) => setTimeout(() => r('second'), 5)),
    () => new Promise((r) => setTimeout(() => r('third'), 10)),
  ];
  const res = await processAll(jobs);
  assert.deepEqual(res.map((r) => r.value), ['first', 'second', 'third']);
});
test('runs concurrently (not sequential)', async () => {
  let active = 0, maxActive = 0;
  const jobs = [1, 2, 3].map(() => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return 'x';
  });
  await processAll(jobs);
  assert.ok(maxActive >= 2, 'jobs should overlap (concurrent), maxActive=' + maxActive);
});
test('single failure absorbed, others processed', async () => {
  const res = await processAll([
    () => { throw new Error('boom'); },
    async () => 'ok',
  ]);
  assert.equal(res.length, 2);
  assert.ok(res[0].error);
  assert.equal(res[1].value, 'ok');
});
`);

// ================= search (substring, case-insensitive, price range) =================
write('search/package.json', pkg('eval-search'));
write('search/src/search.js', `// BUG: prefix-only, case-sensitive, no price filter.
export function search(products, { query = '', minPrice, maxPrice } = {}) {
  let out = products;
  if (query) {
    out = out.filter((p) => p.name.startsWith(query)); // BUG: prefix + case-sensitive
  }
  if (minPrice !== undefined) out = out.filter((p) => p.price >= minPrice);
  if (maxPrice !== undefined) out = out.filter((p) => p.price <= maxPrice);
  return out; // BUG: not sorted by price
}
`);
write('search/src/index.js', `export { search } from './search.js';\n`);
write('search/test/.hidden/search.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/search.js';

const PRODUCTS = [
  { name: 'Apple', price: 300 },
  { name: 'apple pie', price: 150 },
  { name: 'Banana', price: 100 },
  { name: 'APPLE juice', price: 200 },
];

test('substring match', () => {
  const res = search(PRODUCTS, { query: 'ppl' });
  assert.equal(res.length, 3); // Apple, apple pie, APPLE juice
});
test('case-insensitive', () => {
  const res = search(PRODUCTS, { query: 'apple' });
  assert.equal(res.length, 3);
});
test('price range filter', () => {
  const res = search(PRODUCTS, { query: 'apple', minPrice: 150, maxPrice: 200 });
  assert.equal(res.length, 2);
});
test('results sorted by price ascending', () => {
  const res = search(PRODUCTS, { query: 'apple' });
  const prices = res.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});
test('empty query returns all sorted by price', () => {
  const res = search(PRODUCTS);
  assert.equal(res.length, 4);
  const prices = res.map((p) => p.price);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
});
`);

console.log('Created 5 HIGH-COMPLEXITY fixtures under eval/fixtures/complex/ with hidden ground-truth tests.');
