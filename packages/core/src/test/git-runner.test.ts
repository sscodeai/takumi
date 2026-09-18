import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner, gitFailure, ProviderError, unconfiguredGitRunner } from '../index.js';

/**
 * The git seam with a stub binary: no real repository, and — crucially — a
 * non-zero exit code is asserted to be a RESULT, not a thrown error. Delivery
 * adapters classify git's own failures; only "git could not run at all" is a
 * transport failure.
 */

function stubGit(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-git-stub-'));
  const path = join(dir, 'git-stub.mjs');
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

test('createGitRunner: a non-zero exit is a result, not an exception', async () => {
  const git = createGitRunner({
    gitBinary: stubGit(
      ['#!/usr/bin/env node', "process.stdout.write('partial output\\n');", "process.stderr.write('fatal: nope\\n');", 'process.exit(1);', ''].join('\n'),
    ),
  });
  const result = await git.run(['status', '--porcelain']);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, 'partial output\n');
  assert.match(result.stderr, /fatal: nope/);
});

test('createGitRunner: passes the argv and the cwd through, without a shell', async () => {
  const git = createGitRunner({
    gitBinary: stubGit(
      [
        '#!/usr/bin/env node',
        "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
        'process.exit(0);',
        '',
      ].join('\n'),
    ),
  });
  const dir = mkdtempSync(join(tmpdir(), 'takumi-git-cwd-'));
  const result = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  const parsed = JSON.parse(result.stdout) as { argv: string[]; cwd: string };
  assert.deepEqual(parsed.argv, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(parsed.cwd, dir);
});

test('createGitRunner: a missing binary is a transport error (never a silent empty result)', async () => {
  const git = createGitRunner({ gitBinary: '/nonexistent/git-binary' });
  await assert.rejects(
    () => git.run(['status']),
    (e: unknown) => e instanceof ProviderError && e.kind === 'transport' && /could not be started/.test(e.message),
  );
});

test('createGitRunner: a hanging git is killed and reported, never left to wedge a tick', async () => {
  const git = createGitRunner({
    gitBinary: stubGit(['#!/usr/bin/env node', 'setTimeout(() => process.exit(0), 30_000);', ''].join('\n')),
    timeoutSeconds: 1,
  });
  const started = Date.now();
  await assert.rejects(
    () => git.run(['push', 'origin', 'main']),
    (e: unknown) => e instanceof ProviderError && e.kind === 'transport' && /exceeded 1s/.test(e.message),
  );
  assert.ok(Date.now() - started < 10_000, 'the timeout must fire well before the stub would exit');
});

test('unconfiguredGitRunner: fails closed instead of touching the operator\'s repository', async () => {
  await assert.rejects(
    () => unconfiguredGitRunner().run(['push', 'origin', 'main']),
    (e: unknown) => e instanceof ProviderError && e.kind === 'unsupported' && /no git runner configured/.test(e.message),
  );
});

test('gitFailure: one readable line naming the command and git\'s own reason', () => {
  const message = gitFailure(['push', 'origin', 'main'], {
    stdout: '',
    stderr: '! [rejected] main -> main (non-fast-forward)\nmore noise\n',
    exitCode: 1,
  });
  assert.equal(message, 'git push origin main exited 1: ! [rejected] main -> main (non-fast-forward)');
});
