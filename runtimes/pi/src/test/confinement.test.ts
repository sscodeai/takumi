import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SandboxResult, StepSandbox, StepSandboxRequest } from '@takumi/core';
import { confinementOf, createConfinedTools } from '../confinement.js';

// S5 (ADR-058): the confined tool builder. The negative cases are the point —
// a read outside the roots and a symlink that points out of them must be
// refused, and `grep` must be dropped rather than offered with host access.

class RecordingSandbox implements StepSandbox {
  readonly id = 'recording';
  readonly requests: StepSandboxRequest[] = [];
  async runStep(req: StepSandboxRequest): Promise<SandboxResult> {
    this.requests.push(req);
    return { stdout: 'sandbox-output\n', stderr: '', code: 0, timedOut: false };
  }
  async close(): Promise<void> {}
}

const SCRATCH_ROOT = path.join(homedir(), '.cache', 'takumi-pi-confinement-tests');

function scratch(): { root: string; outside: string; cleanup(): void } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const base = mkdtempSync(path.join(SCRATCH_ROOT, 'pi-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'src/inside.txt'), 'inside\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  return { root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function toolsFor(root: string, sandbox: StepSandbox, drops: string[] = []) {
  const tools = createConfinedTools(
    root,
    { sandbox, roots: { rw: [root], ro: [], cwd: root } },
    (name, reason) => drops.push(`${name}:${reason}`),
  );
  return tools;
}

const ctx = {} as never;

test('confinement: a half-configured task is refused (fail closed)', () => {
  assert.throws(() => confinementOf({ sandbox: new RecordingSandbox() }), /both `sandbox` and `sandboxRoots`/);
  assert.throws(() => confinementOf({ sandboxRoots: { rw: [], ro: [], cwd: '/' } }), /both `sandbox` and `sandboxRoots`/);
  assert.equal(confinementOf(undefined), undefined);
});

test('confinement: grep is dropped by name and recorded', () => {
  const s = scratch();
  try {
    const drops: string[] = [];
    const tools = toolsFor(s.root, new RecordingSandbox(), drops);
    const names = tools.map((t) => t.name);
    assert.ok(!names.includes('grep'), 'grep must not be offered');
    assert.deepEqual(names.sort(), ['bash', 'edit', 'find', 'ls', 'read', 'write']);
    assert.equal(drops.length, 1);
    assert.match(drops[0] ?? '', /^grep:/);
  } finally {
    s.cleanup();
  }
});

test('confinement: read is contained — inside reads, outside and symlink escapes are refused', async () => {
  const s = scratch();
  try {
    const tools = toolsFor(s.root, new RecordingSandbox());
    const read = tools.find((t) => t.name === 'read');
    assert.ok(read !== undefined);

    const inside = await read.execute('c1', { path: path.join(s.root, 'src/inside.txt') } as never, undefined, undefined, ctx);
    assert.ok(JSON.stringify(inside).includes('inside'), 'the in-root file is readable');

    await assert.rejects(
      () => read.execute('c2', { path: path.join(s.outside, 'secret.txt') } as never, undefined, undefined, ctx),
      /outside the allowed roots/,
    );

    symlinkSync(s.outside, path.join(s.root, 'link'));
    await assert.rejects(
      () => read.execute('c3', { path: path.join(s.root, 'link/secret.txt') } as never, undefined, undefined, ctx),
      /outside the allowed roots/,
      'a symlink pointing out of the roots must be refused',
    );
  } finally {
    s.cleanup();
  }
});

test('confinement: write is contained — inside lands, outside is refused', async () => {
  const s = scratch();
  try {
    const tools = toolsFor(s.root, new RecordingSandbox());
    const write = tools.find((t) => t.name === 'write');
    assert.ok(write !== undefined);
    await write.execute('w1', { path: path.join(s.root, 'new/file.txt'), content: 'written\n' } as never, undefined, undefined, ctx);
    await assert.rejects(
      () => write.execute('w2', { path: path.join(s.outside, 'evil.txt'), content: 'no\n' } as never, undefined, undefined, ctx),
      /outside the allowed roots/,
    );
  } finally {
    s.cleanup();
  }
});

test('confinement: bash routes through the kernel boundary', async () => {
  const s = scratch();
  try {
    const sandbox = new RecordingSandbox();
    const tools = toolsFor(s.root, sandbox);
    const bash = tools.find((t) => t.name === 'bash');
    assert.ok(bash !== undefined);
    const result = await bash.execute('b1', { command: 'echo hi' } as never, undefined, undefined, undefined as never);
    assert.equal(sandbox.requests.length, 1);
    assert.equal(sandbox.requests[0]?.shell, 'echo hi');
    assert.ok(JSON.stringify(result).includes('sandbox-output'));
  } finally {
    s.cleanup();
  }
});
