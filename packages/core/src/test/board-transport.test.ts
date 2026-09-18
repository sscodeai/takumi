import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertBoardHttpOk,
  boardErrorFromResponse,
  BoardError,
  classifyBoardHttpStatus,
  createCurlRequestFn,
  parseBoardJson,
  requestBoardJson,
  unconfiguredRequestFn,
} from '../index.js';

// The transport seam is shared by every network-backed adapter, so it is tested
// once here — against a REAL local HTTP server (no external network, no token)
// rather than a mock, which is also how we know curl is invoked correctly.

test('classifyBoardHttpStatus: the taxonomy maps statuses onto retryability', () => {
  assert.equal(classifyBoardHttpStatus(401), 'auth');
  assert.equal(classifyBoardHttpStatus(403), 'auth');
  assert.equal(classifyBoardHttpStatus(404), 'not_found');
  assert.equal(classifyBoardHttpStatus(405), 'unsupported');
  assert.equal(classifyBoardHttpStatus(400), 'precondition');
  assert.equal(classifyBoardHttpStatus(409), 'precondition');
  assert.equal(classifyBoardHttpStatus(412), 'precondition');
  assert.equal(classifyBoardHttpStatus(422), 'precondition');
  assert.equal(classifyBoardHttpStatus(429), 'transport');
  assert.equal(classifyBoardHttpStatus(500), 'transport');
  assert.equal(classifyBoardHttpStatus(503), 'transport');
  assert.equal(new BoardError(classifyBoardHttpStatus(429), 'x').retriable, true);
  assert.equal(new BoardError(classifyBoardHttpStatus(403), 'x').retriable, false);
});

test('boardErrorFromResponse / assertBoardHttpOk: non-2xx is classified and truncated', () => {
  const err = boardErrorFromResponse({ status: 404, body: 'not\nfound   here' }, 'getWork', 'T-1');
  assert.equal(err.kind, 'not_found');
  assert.equal(err.item, 'T-1');
  assert.match(err.message, /getWork failed with HTTP 404: not found here/);

  assert.doesNotThrow(() => assertBoardHttpOk({ status: 204, body: '' }, 'x'));
  assert.throws(() => assertBoardHttpOk({ status: 500, body: 'boom' }, 'x'), /HTTP 500/);
});

test('parseBoardJson: a non-JSON body is a transport failure, not a crash', () => {
  assert.deepEqual(parseBoardJson<{ a: number }>({ status: 200, body: '{"a":1}' }, 'x'), { a: 1 });
  assert.throws(() => parseBoardJson({ status: 200, body: '<html>' }, 'x'), (e: unknown) => e instanceof BoardError && e.kind === 'transport');
});

test('requestBoardJson: requires 2xx before parsing', async () => {
  const ok = await requestBoardJson<{ id: string }>(
    async () => ({ status: 200, body: '{"id":"T-1"}' }),
    { method: 'GET', url: 'https://board.example/T-1' },
    'getWork',
  );
  assert.equal(ok.id, 'T-1');
  await assert.rejects(
    () => requestBoardJson(async () => ({ status: 403, body: '{}' }), { method: 'GET', url: 'u' }, 'getWork'),
    (e: unknown) => e instanceof BoardError && e.kind === 'auth',
  );
});

test('unconfiguredRequestFn: fails closed instead of calling out', async () => {
  await assert.rejects(
    () => unconfiguredRequestFn('github')({ method: 'GET', url: 'https://api.github.com/x' }),
    /github: no request transport configured/,
  );
});

test('createCurlRequestFn: real request against a local server (method, headers, body, status)', async () => {
  const seen: Array<{ method?: string; url?: string; token?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, token: req.headers['x-test-token'] as string | undefined, body });
      if (req.url === '/fail') {
        res.statusCode = 404;
        res.end('nope');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const request = createCurlRequestFn({ headers: () => ({ 'X-Test-Token': 'sekret' }), timeoutSeconds: 10 });

  try {
    const created = await request({
      method: 'POST',
      url: `http://127.0.0.1:${port}/items`,
      body: { title: 'from the contract' },
    });
    assert.equal(created.status, 200);
    assert.deepEqual(JSON.parse(created.body), { ok: true, method: 'POST' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.token, 'sekret');
    assert.equal(seen[0]?.body, JSON.stringify({ title: 'from the contract' }));

    const failed = await request({ method: 'GET', url: `http://127.0.0.1:${port}/fail` });
    assert.equal(failed.status, 404);
    assert.equal(failed.body, 'nope');
    assert.equal(boardErrorFromResponse(failed, 'getWork').kind, 'not_found');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('createCurlRequestFn: an unreachable endpoint is a transport error, never a hang', async () => {
  const request = createCurlRequestFn({ timeoutSeconds: 2 });
  await assert.rejects(
    // Port 1 on loopback refuses immediately.
    () => request({ method: 'GET', url: 'http://127.0.0.1:1/x' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'transport',
  );
});
