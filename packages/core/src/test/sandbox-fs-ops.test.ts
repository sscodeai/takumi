import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  SandboxFsError,
  existsWithin,
  globWithin,
  mkdirWithin,
  readFileWithin,
  readdirWithin,
  resolveWithinRoots,
  writeFileWithin,
} from '../index.js';

// S5 (ADR-058): the in-process containment primitives. These are the only thing
// stopping a builtin read/write/edit/ls/find from touching the host, so the
// negative cases (an escape and a symlink pointing out of the root) are the
// point, not a formality.

const SCRATCH_ROOT = path.join(homedir(), '.cache', 'takumi-fsops-tests');

function scratch(): { root: string; outside: string; cleanup(): void } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const base = mkdtempSync(path.join(SCRATCH_ROOT, 'fsops-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'src/inside.txt'), 'inside\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('fs-ops: a path inside a root resolves, a path outside is refused', async () => {
  const s = scratch();
  try {
    assert.equal(await resolveWithinRoots([s.root], path.join(s.root, 'src/inside.txt')), path.join(s.root, 'src/inside.txt'));
    await assert.rejects(
      () => resolveWithinRoots([s.root], path.join(s.outside, 'secret.txt')),
      (e: unknown) => e instanceof SandboxFsError,
    );
    await assert.rejects(
      () => resolveWithinRoots([s.root], path.join(s.root, '..', 'outside', 'secret.txt')),
      (e: unknown) => e instanceof SandboxFsError,
    );
    await assert.rejects(() => resolveWithinRoots([s.root], 'relative/path'), (e: unknown) => e instanceof SandboxFsError);
  } finally {
    s.cleanup();
  }
});

test('fs-ops: a symlink pointing out of the root does not escape', async () => {
  const s = scratch();
  try {
    symlinkSync(s.outside, path.join(s.root, 'link'));
    await assert.rejects(
      () => resolveWithinRoots([s.root], path.join(s.root, 'link/secret.txt')),
      (e: unknown) => e instanceof SandboxFsError,
      'the real path is outside the root, so the symlink must be refused',
    );
    assert.equal(await readFileWithin([s.root], path.join(s.root, 'src/inside.txt')).then((b) => b.toString()), 'inside\n');
  } finally {
    s.cleanup();
  }
});

test('fs-ops: writes land inside the rw roots, create parents, and refuse outside', async () => {
  const s = scratch();
  try {
    const target = path.join(s.root, 'deep/new/file.txt');
    await writeFileWithin([s.root], target, 'written\n');
    assert.equal(await readFileWithin([s.root], target).then((b) => b.toString()), 'written\n');
    await assert.rejects(
      () => writeFileWithin([s.root], path.join(s.outside, 'evil.txt'), 'no\n'),
      (e: unknown) => e instanceof SandboxFsError,
    );
    assert.equal(existsSync(path.join(s.outside, 'evil.txt')), false);
    await assert.rejects(() => mkdirWithin([s.root], path.join(s.outside, 'evil-dir')), (e: unknown) => e instanceof SandboxFsError);
    assert.equal(existsSync(path.join(s.outside, 'evil-dir')), false);
  } finally {
    s.cleanup();
  }
});

test('fs-ops: existence and listing are contained', async () => {
  const s = scratch();
  try {
    assert.equal(await existsWithin([s.root], path.join(s.root, 'src/inside.txt')), true);
    assert.equal(await existsWithin([s.root], path.join(s.outside, 'secret.txt')), false);
    assert.deepEqual((await readdirWithin([s.root], path.join(s.root, 'src'))).sort(), ['inside.txt']);
    await assert.rejects(() => readdirWithin([s.root], s.outside), (e: unknown) => e instanceof SandboxFsError);
  } finally {
    s.cleanup();
  }
});

test('fs-ops: glob stays inside the root and skips node_modules', async () => {
  const s = scratch();
  try {
    writeFileSync(path.join(s.root, 'src/a.test.ts'), '');
    mkdirSync(path.join(s.root, 'node_modules/pkg'), { recursive: true });
    writeFileSync(path.join(s.root, 'node_modules/pkg/x.test.ts'), '');
    const found = (await globWithin([s.root], '**/*.test.ts', s.root)).sort();
    assert.deepEqual(found, ['src/a.test.ts']);
    await assert.rejects(() => globWithin([s.root], '*.ts', s.outside), (e: unknown) => e instanceof SandboxFsError);
  } finally {
    s.cleanup();
  }
});
