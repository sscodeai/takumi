import { test } from 'node:test';
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
