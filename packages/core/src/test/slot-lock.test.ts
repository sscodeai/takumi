import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { acquireSlot, isProcessAlive, ProviderError, slotLockPath, withSlot } from '../index.js';

/**
 * The slot lock is the safety rail that keeps two runners off the same work, so
 * these tests do not trust an in-process flag: the decisive one spawns a REAL
 * second process and asks it to hold the same lock.
 */

function stateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-slots-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function foreignAlivePid(): { pid: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  return { pid: child.pid ?? 0, kill: () => child.kill('SIGKILL') };
}

/** A pid that exists but is not this process (so the self-check does not mask a bug). */
const DEAD_PID = 999_999;

test('acquireSlot: the first caller wins and the second is told who holds it', () => {
  const { dir, cleanup } = stateDir();
  try {
    const first = acquireSlot({ dir, key: 'repo', owner: { runId: 'aaaaaaaa', itemId: '42' } });
    assert.equal(first.acquired, true);
    assert.ok(first.handle);
    const second = acquireSlot({ dir, key: 'repo', owner: { runId: 'bbbbbbbb' } });
    assert.equal(second.acquired, false);
    assert.equal(second.heldBy?.runId, 'aaaaaaaa');
    assert.equal(second.heldBy?.itemId, '42');
    assert.match(second.reason ?? '', /held by run aaaaaaaa \(item 42\)/);
    first.handle?.release();
  } finally {
    cleanup();
  }
});

test('acquireSlot: releasing frees the slot, and releasing twice is safe', () => {
  const { dir, cleanup } = stateDir();
  try {
    const first = acquireSlot({ dir, key: 'repo', owner: { runId: 'aaaaaaaa' } });
    first.handle?.release();
    first.handle?.release();
    const second = acquireSlot({ dir, key: 'repo', owner: { runId: 'bbbbbbbb' } });
    assert.equal(second.acquired, true);
    second.handle?.release();
  } finally {
    cleanup();
  }
});

test('acquireSlot: a slot is per key, so two items can run in parallel', () => {
  const { dir, cleanup } = stateDir();
  try {
    const a = acquireSlot({ dir, key: 'item-1', owner: { runId: 'aaaaaaaa' } });
    const b = acquireSlot({ dir, key: 'item-2', owner: { runId: 'bbbbbbbb' } });
    assert.equal(a.acquired, true);
    assert.equal(b.acquired, true, 'per-item slots must not serialise different items');
    assert.notEqual(a.path, b.path);
    a.handle?.release();
    b.handle?.release();
  } finally {
    cleanup();
  }
});

test('acquireSlot: takes over a lock whose owner is provably dead', () => {
  const { dir, cleanup } = stateDir();
  try {
    const path = slotLockPath(dir, 'repo');
    writeFileSync(
      path,
      `${JSON.stringify({ runId: 'deadbeef', pid: DEAD_PID, host: 'elsewhere', acquiredAt: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    const now = new Date();
    utimesSync(path, now, now); // fresh mtime: only the dead-owner rule can fire here
    assert.equal(isProcessAlive(DEAD_PID), false);

    const taken = acquireSlot({ dir, key: 'repo', owner: { runId: 'cccccccc' } });
    assert.equal(taken.acquired, true, 'a dead owner must not keep the slot');
    taken.handle?.release();
  } finally {
    cleanup();
  }
});

test('acquireSlot: refuses a live owner, and takes over once the lock goes stale', () => {
  const { dir, cleanup } = stateDir();
  const foreign = foreignAlivePid();
  try {
    const path = slotLockPath(dir, 'repo');
    writeFileSync(path, `${JSON.stringify({ runId: 'hung0000', pid: foreign.pid, host: 'elsewhere' })}\n`);

    // A live owner with a fresh lock is respected, even though it is not us.
    const refused = acquireSlot({ dir, key: 'repo', owner: { runId: 'dddddddd' }, staleAfterSeconds: 60 });
    assert.equal(refused.acquired, false);
    assert.equal(refused.heldBy?.pid, foreign.pid);

    // The same owner, but nobody has refreshed the lock: a HUNG runner must not
    // block the queue forever. This is the case a liveness check alone gets wrong.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(path, old, old);
    const taken = acquireSlot({ dir, key: 'repo', owner: { runId: 'eeeeeeee' }, staleAfterSeconds: 60 });
    assert.equal(taken.acquired, true);
    taken.handle?.release();
  } finally {
    foreign.kill();
    cleanup();
  }
});

test('slot handle: a heartbeat refreshes the lock so a healthy holder is never stolen', () => {
  const { dir, cleanup } = stateDir();
  try {
    const held = acquireSlot({ dir, key: 'repo', owner: { runId: 'ffffffff' }, staleAfterSeconds: 60 });
    const path = held.path;
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(path, old, old);

    assert.ok(Date.now() - statSync(path).mtimeMs > 60_000, 'the lock must start out older than the stale window');
    held.handle?.heartbeat();
    assert.ok(Date.now() - statSync(path).mtimeMs < 5_000, 'the heartbeat must refresh the lock');
    const refused = acquireSlot({ dir, key: 'repo', owner: { runId: '00000000' }, staleAfterSeconds: 60 });
    assert.equal(refused.acquired, false, 'a refreshed lock must not be taken over');
    held.handle?.release();
  } finally {
    cleanup();
  }
});

test('withSlot: runs under the lock, releases it, and reports busy instead of throwing', async () => {
  const { dir, cleanup } = stateDir();
  try {
    const ran = await withSlot({ dir, key: 'repo', owner: { runId: 'aaaaaaaa' } }, async () => 'done');
    assert.equal(ran.outcome, 'ran');
    assert.equal(ran.value, 'done');

    const held = acquireSlot({ dir, key: 'repo', owner: { runId: 'bbbbbbbb' } });
    const busy = await withSlot({ dir, key: 'repo', owner: { runId: 'cccccccc' } }, async () => 'never');
    assert.equal(busy.outcome, 'busy');
    assert.match(busy.reason ?? '', /held by run bbbbbbbb/);
    held.handle?.release();

    // A throwing body still releases the slot: a crashed delivery must not wedge it.
    await assert.rejects(
      () =>
        withSlot({ dir, key: 'repo', owner: { runId: 'dddddddd' } }, async () => {
          throw new Error('boom');
        }),
      /boom/,
    );
    const after = acquireSlot({ dir, key: 'repo', owner: { runId: 'eeeeeeee' } });
    assert.equal(after.acquired, true);
    after.handle?.release();
  } finally {
    cleanup();
  }
});

test('slotLockPath: a key cannot escape the slot directory', () => {
  const path = slotLockPath('/var/lib/takumi/slots', '../../etc/passwd');
  assert.ok(path.startsWith('/var/lib/takumi/slots/'), path);
  assert.equal(path.includes('..'), false);
  assert.ok(path.endsWith('.lock'));
});

test('acquireSlot: a missing key or a nonsense stale window is a precondition, not a silent default', () => {
  const { dir, cleanup } = stateDir();
  try {
    assert.throws(
      () => acquireSlot({ dir, key: '   ', owner: { runId: 'aaaaaaaa' } }),
      (e: unknown) => e instanceof ProviderError && e.kind === 'precondition',
    );
    assert.throws(
      () => acquireSlot({ dir, key: 'repo', owner: { runId: 'aaaaaaaa' }, staleAfterSeconds: 0 }),
      (e: unknown) => e instanceof ProviderError && e.kind === 'precondition',
    );
  } finally {
    cleanup();
  }
});

test('the lock really excludes a SECOND process, and a dead holder frees it', async () => {
  const { dir, cleanup } = stateDir();
  const holderScript = join(dir, 'holder.mjs');
  const coreEntry = fileURLToPath(new URL('../index.js', import.meta.url));
  writeFileSync(
    holderScript,
    [
      `import { acquireSlot } from ${JSON.stringify(coreEntry)};`,
      `const [dir, key] = process.argv.slice(2);`,
      `const held = acquireSlot({ dir, key, owner: { runId: 'child001', pid: process.pid } });`,
      `process.stdout.write(held.acquired ? 'acquired' : 'refused');`,
      // Hold it until the parent kills us: a real long-running runner.
      `await new Promise((resolve) => setTimeout(resolve, 30_000));`,
      '',
    ].join('\n'),
  );

  const child = spawn(process.execPath, [holderScript, dir, 'repo'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    const deadline = Date.now() + 10_000;
    while (!out.includes('acquired') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(out, 'acquired', 'the child process must have taken the slot');

    // THE point of the whole module: another process cannot take it.
    const blocked = acquireSlot({ dir, key: 'repo', owner: { runId: 'parent01' } });
    assert.equal(blocked.acquired, false, 'a second PROCESS must not be able to take a held slot');
    assert.equal(blocked.heldBy?.runId, 'child001');

    // And a killed runner frees it without waiting for the stale window: the
    // owner is provably gone, which is the rule the pid check exists for.
    const childPid = child.pid ?? 0;
    child.kill('SIGKILL');
    const waitDeadline = Date.now() + 10_000;
    while (isProcessAlive(childPid) && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(isProcessAlive(childPid), false);

    const taken = acquireSlot({ dir, key: 'repo', owner: { runId: 'parent01' }, staleAfterSeconds: 3600 });
    assert.equal(taken.acquired, true, 'a dead runner must free its slot immediately');
    taken.handle?.release();
  } finally {
    child.kill('SIGKILL');
    cleanup();
  }
});

test('the lock file records who holds it, for humans reading it at 3am', () => {
  const { dir, cleanup } = stateDir();
  try {
    const held = acquireSlot({ dir, key: 'repo', owner: { runId: 'aaaaaaaa', itemId: '42' } });
    const raw = JSON.parse(readFileSync(held.path, 'utf8')) as Record<string, unknown>;
    assert.equal(raw.runId, 'aaaaaaaa');
    assert.equal(raw.itemId, '42');
    assert.equal(raw.pid, process.pid);
    assert.equal(typeof raw.host, 'string');
    assert.match(String(raw.acquiredAt), /^\d{4}-\d{2}-\d{2}T/);
    held.handle?.release();
    assert.equal(existsSync(held.path), false, 'releasing removes the lock file');
  } finally {
    cleanup();
  }
});

test('execFileSync sanity: the built core exposes the lock', () => {
  const coreEntry = fileURLToPath(new URL('../index.js', import.meta.url));
  const out = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(`file://${coreEntry}`)}).then((m) => process.stdout.write(typeof m.acquireSlot))`], {
    encoding: 'utf8',
  });
  assert.equal(out, 'function');
});
