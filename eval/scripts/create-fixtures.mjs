#!/usr/bin/env node
/**
 * Create eval fixtures (eval/fixtures/ts/*) — initial repos with bugs/tasks
 * and HIDDEN ground-truth tests under test/.hidden/.
 *
 * Pure JS (node --test runs natively — no tsx/tsc needed, so ground truth is
 * deterministic and dependency-free).
 *
 * Run: node eval/scripts/create-fixtures.mjs
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'ts');
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

// ---- ts/even ----
write('even/package.json', pkg('eval-even'));
write('even/src/even.js', `// BUG: sums ALL numbers, should sum only EVEN numbers.
export function sumEven(numbers) {
  return numbers.reduce((acc, n) => acc + n, 0);
}
`);
write('even/src/index.js', `export { sumEven } from './even.js';\n`);
write('even/test/.hidden/even.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumEven } from '../src/even.js';
test('ground truth: empty -> 0', () => assert.equal(sumEven([]), 0));
test('ground truth: odd-only -> 0', () => assert.equal(sumEven([1, 3, 5]), 0));
test('ground truth: mixed -> sum of evens', () => assert.equal(sumEven([1, 2, 3, 4, 5]), 6));
test('ground truth: negatives', () => assert.equal(sumEven([-2, -1, 0, 1, 2]), 0));
`);

// ---- ts/money ----
write('money/package.json', pkg('eval-money'));
write('money/src/format.js', `// BUG: no thousands separators.
export function formatMoney(n) {
  return '$' + n.toFixed(2);
}
`);
write('money/src/index.js', `export { formatMoney } from './format.js';\n`);
write('money/test/.hidden/money.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney } from '../src/format.js';
test('ground truth: 1234.5 -> $1,234.50', () => assert.equal(formatMoney(1234.5), '$1,234.50'));
test('ground truth: 999 -> $999.00', () => assert.equal(formatMoney(999), '$999.00'));
test('ground truth: 1234567 -> $1,234,567.00', () => assert.equal(formatMoney(1234567), '$1,234,567.00'));
test('ground truth: 0 -> $0.00', () => assert.equal(formatMoney(0), '$0.00'));
`);

// ---- ts/flatten ----
write('flatten/package.json', pkg('eval-flatten'));
write('flatten/src/flatten.js', `// TODO: implement one-level flatten. Currently throws.
export function flatten(nested) {
  throw new Error('not implemented');
}
`);
write('flatten/src/index.js', `export { flatten } from './flatten.js';\n`);
write('flatten/test/.hidden/flatten.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten } from '../src/flatten.js';
test('ground truth: empty', () => assert.deepEqual(flatten([]), []));
test('ground truth: no nesting', () => assert.deepEqual(flatten([1, 2, 3]), [1, 2, 3]));
test('ground truth: one level', () => assert.deepEqual(flatten([1, [2, 3], 4]), [1, 2, 3, 4]));
test('ground truth: deep stays one level', () => assert.deepEqual(flatten([[1, [2]], 3]), [1, [2], 3]));
`);

// ---- ts/sort ----
write('sort/package.json', pkg('eval-sort'));
write('sort/src/sort.js', `// BUG: regressed to ascending; should be descending.
export function sortDesc(numbers) {
  return [...numbers].sort((a, b) => a - b);
}
`);
write('sort/src/index.js', `export { sortDesc } from './sort.js';\n`);
write('sort/test/.hidden/sort.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortDesc } from '../src/sort.js';
test('ground truth: desc order', () => assert.deepEqual(sortDesc([3, 1, 2]), [3, 2, 1]));
test('ground truth: negatives', () => assert.deepEqual(sortDesc([-1, 5, -3]), [5, -1, -3]));
test('ground truth: equal stays', () => assert.deepEqual(sortDesc([2, 2, 1]), [2, 2, 1]));
`);

// ---- ts/counter ----
write('counter/package.json', pkg('eval-counter'));
write('counter/src/counter.js', `export class Counter {
  constructor() { this.v = 0; }
  increment() { this.v += 1; return this.v; }
  get() { return this.v; }
}
`);
write('counter/src/index.js', `export { Counter } from './counter.js';\n`);
write('counter/test/.hidden/counter.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Counter } from '../src/counter.js';
test('ground truth: starts at 0', () => assert.equal(new Counter().get(), 0));
test('ground truth: increment returns new value', () => { const c = new Counter(); assert.equal(c.increment(), 1); });
test('ground truth: accumulates', () => { const c = new Counter(); c.increment(); c.increment(); assert.equal(c.get(), 2); });
test('ground truth: get does not mutate', () => { const c = new Counter(); c.get(); assert.equal(c.get(), 0); });
`);

// ---- ts/api ----
write('api/package.json', pkg('eval-api'));
write('api/src/api.js', `// BUG: returns undefined on 404; should throw Error('not found').
export async function getUser(id, fetchFn = fetch) {
  const res = await fetchFn('https://api.example.com/users/' + id);
  if (!res.ok) return undefined;
  return res.json();
}
`);
write('api/src/index.js', `export { getUser } from './api.js';\n`);
write('api/test/helpers.js', `export function mockFetch(status, body) {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
`);
write('api/test/.hidden/api.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getUser } from '../src/api.js';
import { mockFetch } from './helpers.js';
test('ground truth: 404 throws not found', async () => {
  await assert.rejects(() => getUser('nope', mockFetch(404, {})), /not found/);
});
test('ground truth: 200 returns user', async () => {
  const u = await getUser('1', mockFetch(200, { id: '1', name: 'a' }));
  assert.equal(u.id, '1');
});
`);

console.log('Created 6 JS fixtures under eval/fixtures/ts/ with hidden ground-truth tests.');
