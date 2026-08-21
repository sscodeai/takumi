#!/usr/bin/env node
/**
 * Create HARD eval fixtures (eval/fixtures/hard/*) — designed to trigger
 * false completions (chain bugs, hidden edges, multi-file invariants).
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'fixtures', 'hard');
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

// ---- hard/order (chain bug) ----
write('order/package.json', pkg('eval-order'));
write('order/src/order.js', `// BUG: applyDiscount returns the DISCOUNT AMOUNT, not discounted price.
export function applyDiscount(price, discountPercent) {
  return price * (discountPercent / 100); // wrong: this is the discount amount
}
export function calculateTotal(items) {
  return items.reduce((sum, it) => sum + applyDiscount(it.price, it.discount), 0);
}
`);
write('order/src/index.js', `export { applyDiscount, calculateTotal } from './order.js';\n`);
write('order/test/.hidden/order.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, calculateTotal } from '../src/order.js';
test('0% discount keeps price', () => assert.equal(applyDiscount(100, 0), 100));
test('10% discount', () => assert.equal(applyDiscount(100, 10), 90));
test('50% discount', () => assert.equal(applyDiscount(200, 50), 100));
test('100% discount = 0', () => assert.equal(applyDiscount(100, 100), 0));
test('calculateTotal sums discounted', () => assert.equal(calculateTotal([{ price: 100, discount: 10 }, { price: 50, discount: 0 }]), 140));
test('calculateTotal with 100% off item', () => assert.equal(calculateTotal([{ price: 100, discount: 100 }, { price: 50, discount: 50 }]), 25));
`);

// ---- hard/password (hidden edge) ----
write('password/package.json', pkg('eval-password'));
write('password/src/validate.js', `// BUG: missing the "password" substring ban.
export function isValidPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return false;
  if (!/[A-Z]/.test(pw)) return false;
  if (!/[a-z]/.test(pw)) return false;
  if (!/[0-9]/.test(pw)) return false;
  return true; // BUG: should also reject if pw.toLowerCase().includes('password')
}
`);
write('password/src/index.js', `export { isValidPassword } from './validate.js';\n`);
write('password/test/.hidden/password.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPassword } from '../src/validate.js';
test('valid', () => assert.equal(isValidPassword('Abcdef1!'), true));
test('too short', () => assert.equal(isValidPassword('Ab1!'), false));
test('no uppercase', () => assert.equal(isValidPassword('abcdef1!'), false));
test('no digit', () => assert.equal(isValidPassword('Abcdefgh'), false));
test('contains password', () => assert.equal(isValidPassword('mypassword123'), false));
test('contains PassWord mixed', () => assert.equal(isValidPassword('xPassWord1x'), false));
test('leet 0 in password is valid (no substring)', () => assert.equal(isValidPassword('Passw0rdX'), true));
`);

// ---- hard/integration (multi-file) ----
write('integration/package.json', pkg('eval-integration'));
write('integration/src/db.js', `// STUB: does not actually save.
export const records = [];
export function saveRecord(record) {
  return true; // BUG: stub — should append to records
}
`);
write('integration/src/service.js', `import { saveRecord } from './db.js';
export function createUser(name) {
  saveRecord({ name });
  return { name }; // BUG: should return the saved record
}
`);
write('integration/src/index.js', `export { saveRecord, records } from './db.js';\nexport { createUser } from './service.js';\n`);
write('integration/test/.hidden/integration.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveRecord, records } from '../src/db.js';
import { createUser } from '../src/service.js';
test('saveRecord appends to records', () => {
  const before = records.length;
  saveRecord({ name: 'x' });
  assert.equal(records.length, before + 1);
  assert.equal(records[records.length - 1].name, 'x');
});
test('createUser returns a record with the name', () => {
  const r = createUser('alice');
  assert.equal(r.name, 'alice');
});
`);

// ---- hard/parse (truthy trap) ----
write('parse/package.json', pkg('eval-parse'));
write('parse/src/legacy.js', `// BUG: treats numeric string '0' as invalid (explicit check).
export function parseInput(raw) {
  if (raw === '' || raw === null || raw === undefined) return 'invalid';
  const n = Number(raw);
  if (n === 0) return 'invalid'; // BUG: '0' should be valid
  return Number.isNaN(n) ? 'invalid' : n;
}
`);
write('parse/src/index.js', `export { parseInput } from './legacy.js';\n`);
write('parse/test/.hidden/parse.ground-truth.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInput } from '../src/legacy.js';
test('empty string invalid', () => assert.equal(parseInput(''), 'invalid'));
test('null invalid', () => assert.equal(parseInput(null), 'invalid'));
test('undefined invalid', () => assert.equal(parseInput(undefined), 'invalid'));
test('zero string valid -> 0', () => assert.equal(parseInput('0'), 0));
test('42 parses', () => assert.equal(parseInput('42'), 42));
test('negative parses', () => assert.equal(parseInput('-1'), -1));
test('non-numeric invalid', () => assert.equal(parseInput('abc'), 'invalid'));
`);

console.log('Created 4 HARD fixtures under eval/fixtures/hard/ with hidden ground-truth tests.');
