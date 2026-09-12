import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { start } from '../index.js';

/**
 * apps/console had no tests at all: its `test` script delegated to
 * scripts/run-node-tests.mjs, which silently reported "No compiled tests found;
 * skipping." and exited 0, so CI stayed green with zero coverage here.
 *
 * These tests boot the real HTTP server on an ephemeral port and exercise the
 * public routes end to end (no mocks).
 */
async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = start(0);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected the console server to listen on a TCP port');
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('GET /health reports the console as alive', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, service: 'takumi-console' });
  });
});

test('GET / serves the console page', async () => {
  await withServer(async (base) => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /Takumi Console/);
  });
});

test('unknown route returns 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/does-not-exist`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'not found');
  });
});

test('POST /run streams SSE events for a completed workflow', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Analyze the requirements' }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const body = await res.text();
    const events = body
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { type: string; message: string });

    assert.ok(events.length > 0, 'expected at least one SSE event');
    assert.match(events[0]?.message ?? '', /run started/);
    assert.ok(
      events.every((event) => typeof event.type === 'string' && typeof event.message === 'string'),
      'every event carries a type and a message',
    );
    assert.match(body, /workflow completed/);
  });
});

test('POST /run falls back to a default prompt for an empty body', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /workflow completed/);
  });
});
