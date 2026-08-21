import { test } from 'node:test';
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
