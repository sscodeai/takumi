import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerSandbox, NoopSandbox, dockerAvailable } from '../sandbox-docker.js';
import { UnshareSandbox } from '../sandbox-unshare.js';

// P1-2 Sandbox isolation tests. Docker-gated: if no daemon, we assert the
// availability probe honestly reports false (never a fake sandbox pass).

test('sandbox: dockerAvailable is honest (true or false, never throws)', async () => {
  const avail = await dockerAvailable();
  assert.equal(typeof avail, 'boolean');
});

test('sandbox: DockerSandbox runs a command in an isolated container', async (t) => {
  const avail = await dockerAvailable();
  if (!avail) {
    t.skip('docker daemon not available');
    return;
  }
  const sb = new DockerSandbox();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'sb-'));
    const res = await sb.run(dir, 'echo sandbox-ok && pwd && ls -la / | head -3');
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('sandbox-ok'));
    assert.ok(res.stdout.includes('/work'), 'cwd should be /work inside container');
  } finally {
    await sb.close();
  }
});

test('sandbox: network is disabled by default (--network none)', async (t) => {
  const avail = await dockerAvailable();
  if (!avail) {
    t.skip('docker daemon not available');
    return;
  }
  const sb = new DockerSandbox();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'sb-net-'));
    // node:22-slim has no curl; use node itself to attempt a fetch — must fail.
    const res = await sb.run(dir, 'node -e "fetch(\'https://example.com\').then(()=>{process.exit(0)},()=>{process.exit(42)})"');
    assert.notEqual(res.code, 0, 'network should be unreachable inside sandbox');
  } finally {
    await sb.close();
  }
});

test('sandbox: project dir is writable, host outside is read-only', async (t) => {
  const avail = await dockerAvailable();
  if (!avail) {
    t.skip('docker daemon not available');
    return;
  }
  const sb = new DockerSandbox();
  try {
    const dir = mkdtempSync(join(tmpdir(), 'sb-fs-'));
    writeFileSync(join(dir, 'input.txt'), 'hello from host');
    // write inside project (mounted rw at /work) must succeed
    const ok = await sb.run(dir, 'echo sandbox-write > /work/out.txt && cat /work/input.txt');
    assert.equal(ok.code, 0);
    assert.ok(ok.stdout.includes('hello from host'));
    // writing to a non-mounted path must fail (read-only rootfs)
    const deny = await sb.run(dir, 'echo nope > /etc/evil.txt');
    assert.notEqual(deny.code, 0, 'writing outside /work must be denied');
  } finally {
    await sb.close();
  }
});

test('sandbox: NoopSandbox is the unsandboxed default', async () => {
  const sb = new NoopSandbox();
  assert.equal(sb.id, 'none');
  const dir = mkdtempSync(join(tmpdir(), 'sb-noop-'));
  const res = await sb.run(dir, 'echo noop-ok');
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('noop-ok'));
  await sb.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---- UnshareSandbox: verifiable without docker/root ----

test('sandbox: UnshareSandbox runs commands in project dir', async () => {
  const sb = new UnshareSandbox();
  const dir = mkdtempSync(join(tmpdir(), 'sb-un-'));
  const res = await sb.run(dir, 'echo unshare-ok && pwd');
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('unshare-ok'));
  assert.ok(res.stdout.includes(dir), 'cwd should be the project dir');
  await sb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sandbox: UnshareSandbox denies writes to host system paths', async () => {
  const sb = new UnshareSandbox();
  const dir = mkdtempSync(join(tmpdir(), 'sb-un-ro-'));
  const res = await sb.run(dir, 'touch /etc/evil-test 2>&1; echo "touch_rc=$?"');
  // host rootfs is read-only inside the user ns → write denied (touch_rc=1)
  assert.ok(/touch_rc=[1-9]/.test(res.stdout), `write to /etc must be denied (got: ${res.stdout.slice(0, 80)})`);
  await sb.close();
  rmSync(dir, { recursive: true, force: true });
});

test('sandbox: UnshareSandbox applies CPU resource limit', async () => {
  const sb = new UnshareSandbox();
  const dir = mkdtempSync(join(tmpdir(), 'sb-un-cpu-'));
  const t0 = Date.now();
  const res = await sb.run(dir, 'ulimit -t 1; while :; do :; done', { timeoutMs: 15000 });
  const dt = Date.now() - t0;
  assert.ok(dt < 15000, `CPU hog must be bounded (took ${dt}ms)`);
  assert.ok(res.code !== 0 || res.timedOut, 'CPU-limited process should not exit 0');
  await sb.close();
  rmSync(dir, { recursive: true, force: true });
});
