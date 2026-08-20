import { test } from 'node:test';
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
