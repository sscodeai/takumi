import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { UNSAFE_NO_SANDBOX_ENV, loadConfig, runTask } from '../commands.js';

/**
 * The delivery worktree (docs/bugs-fixed.md #43).
 *
 * These tests drive the REAL CLI run path: `loadConfig` reads an actual `takumi.yaml`, `runTask` is
 * the run the CLI performs, and every fixture is a REAL git repository — no mock of the thing under
 * test. A local bare repository stands in for the code host's remote, so the clone tests need no
 * network and no credential.
 *
 *   (C) With a `delivery:` section configured and no `--worktree`, the run creates its own worktree
 *       by CLONING the configured repo and branching from the base, so the publish ancestry rule
 *       holds by construction. A clone failure must fail the run loudly.
 *   (B) With `--worktree` supplied, the run refuses BEFORE it starts unless the checkout qualifies:
 *       a git repository, on a branch (not detached), clean, and descended from `<remote>/<base>`.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'takumi',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'takumi',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

/**
 * THE BOUNDARY CANNOT BE ESTABLISHED ON EVERY HOST, and this file does not test the boundary: it drives the
 * REAL run path (clone from apiBase, branch, publish) against a local bare repository. GitHub's hosted
 * runners refuse `unshare`'s uid map — `_write_failed_ /proc/self/uid_map: _Operation_not_permitted` — so
 * the fail-closed sandbox preflight refused every run here and CI went red while every local run passed
 * (docs/bugs-fixed.md #73). The boundary itself is verified by the sandbox tests, which SKIP where it
 * cannot be established (ADR-058).
 *
 * So this file uses the hatch an operator would use, and it is the RECORDED one: the run prints that it is
 * running WITHOUT a boundary and the run record carries `none (unsafe override)`. It is the same variable,
 * set the same way, and only where no boundary exists.
 */
process.env[UNSAFE_NO_SANDBOX_ENV] = '1';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

/** The exit code of a git command, for the assertions that are about an exit status. */
function gitExit(args: string[], cwd: string): number {
  return spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).status ?? -1;
}

interface Project {
  dir: string;
  /** The bare repository that stands in for the host's remote (the clone source). */
  bare: string;
  cleanup: () => void;
}

/**
 * A project whose `delivery:` section points at a REAL local bare repository.
 *
 * The apiBase is `<dir>/host/api/v1`, so the derived clone URL is `<dir>/host/dev/widget.git` — and
 * the bare repository is created EXACTLY there, which is how the test knows the clone URL was
 * derived from apiBase + repo (including the `/api/v1` → web-base mapping) rather than invented.
 */
function deliveryProject(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-delivery-wt-'));
  const host = join(dir, 'host');
  const bare = join(host, 'dev', 'widget.git');
  mkdirSync(dirname(bare), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: GIT_ENV });

  // Seed the base branch with one real commit.
  const seed = join(dir, 'seed');
  mkdirSync(seed, { recursive: true });
  git(['init', '-q', '-b', 'main'], seed);
  writeFileSync(join(seed, 'README.md'), 'the target repository\n');
  git(['add', '-A'], seed);
  git(['commit', '-q', '-m', 'the base commit'], seed);
  git(['remote', 'add', 'origin', bare], seed);
  git(['push', '-q', 'origin', 'HEAD:main'], seed);

  const yaml = [
    'runtime: fake',
    'registry:',
    '  skills: extensions/skills',
    '  tools: extensions/tools',
    '  workflows: extensions/workflows',
    '  runtimes: runtimes',
    'artifacts: .takumi/artifacts',
    'delivery:',
    '  provider: forgejo',
    '  repo: dev/widget',
    `  apiBase: ${join(host, 'api', 'v1')}`,
    '  baseBranch: main',
    '  remote: origin',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'takumi.yaml'), yaml);

  const wfDir = join(dir, 'extensions', 'workflows', 'publish-wf');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, 'workflow.yaml'),
    ['name: publish-wf', 'version: 0.0.1', 'description: a workflow whose only step is publish', 'steps:', '  - id: publish', '    type: publish', ''].join('\n'),
  );

  return { dir, bare, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run with no Forgejo token: the provider is built fail-closed, so no network and no credential. */
function withoutTokens<T>(fn: () => Promise<T>): Promise<T> {
  const previousForgejo = process.env['FORGEJO_TOKEN'];
  const previousGitea = process.env['GITEA_TOKEN'];
  delete process.env['FORGEJO_TOKEN'];
  delete process.env['GITEA_TOKEN'];
  return fn().finally(() => {
    if (previousForgejo !== undefined) process.env['FORGEJO_TOKEN'] = previousForgejo;
    if (previousGitea !== undefined) process.env['GITEA_TOKEN'] = previousGitea;
  });
}

/** A worktree on `task` with one commit beyond `origin/main`, plus its own bare `origin`. */
function qualifiedWorktree(project: Project): string {
  const worktree = join(project.dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  git(['init', '-q', '-b', 'task'], worktree);
  writeFileSync(join(worktree, 'base.txt'), 'the frozen base\n');
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', 'the base commit'], worktree);
  // Its OWN bare remote (the delivery repository's remote is the same host but this fixture must not
  // push a second, unrelated `main` into it).
  const remote = join(project.dir, 'worktree-origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: GIT_ENV });
  git(['remote', 'add', 'origin', remote], worktree);
  git(['push', '-q', 'origin', 'HEAD:main'], worktree);
  writeFileSync(join(worktree, 'feature.txt'), 'the delivered change\n');
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', 'the delivered commit'], worktree);
  return worktree;
}

// --- (C): a configured delivery creates the worktree itself ------------------------------------

test('run: a configured delivery with no --worktree CREATES a real clone on a branch descended from the base', async () => {
  const p = deliveryProject();
  try {
    await withoutTokens(async () => {
      const config = loadConfig(p.dir);
      const result = await runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config });
      const log = result.events.join('\n');

      const m = log.match(/worktree: created (\S+) \(branch (\S+), cloned from (\S+)\)/);
      assert.ok(m, `the run reports the worktree it created:\n${log}`);
      const path = m[1] ?? '';
      const branch = m[2] ?? '';
      const cloneUrl = m[3] ?? '';

      // The clone URL was derived from apiBase + repo (the apiBase's `/api/v1` maps to the web base).
      assert.equal(cloneUrl, p.bare);
      // A REAL clone: it carries the target repository's content and its remote is the configured repo.
      assert.equal(existsSync(join(path, 'README.md')), true, 'the clone carries the target repository content');
      assert.equal(git(['remote', 'get-url', 'origin'], path).trim(), p.bare);
      // On a task branch — not the base, not a detached HEAD.
      assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], path).trim(), branch);
      assert.match(branch, /^takumi\/run-\d{8}T\d{9}Z-[0-9a-f]{8}$/);
      assert.notEqual(branch, 'main');
      // HEAD is descended from the base, so the publish ancestry rule holds by construction.
      assert.equal(gitExit(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], path), 0);
      // The run PROCEEDED (it was not refused): the publish step ran and failed on the host, because
      // there is no commit beyond the base and no transport.
      assert.equal(result.status, 'failed', log);
      assert.ok(!log.includes('--worktree'), 'the run was not refused by a --worktree check');
      assert.match(log, /step publish: failed/);
    });
  } finally {
    p.cleanup();
  }
});

test('run: two consecutive created worktrees get DIFFERENT branch names, so two runs cannot collide', async () => {
  const p = deliveryProject();
  try {
    await withoutTokens(async () => {
      const branches: string[] = [];
      for (let i = 0; i < 2; i++) {
        const config = loadConfig(p.dir);
        const result = await runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config });
        const m = result.events.join('\n').match(/worktree: created (\S+) \(branch (\S+), cloned from (\S+)\)/);
        assert.ok(m, result.events.join('\n'));
        branches.push(m[2] ?? '');
        assert.equal(existsSync(m[1] ?? ''), true, 'the clone exists on disk');
      }
      assert.notEqual(branches[0], branches[1], 'two creations must not share a branch name');
    });
  } finally {
    p.cleanup();
  }
});

test('run: a clone failure FAILS the run loudly rather than continuing in a worktree it did not create', async () => {
  const p = deliveryProject();
  try {
    await withoutTokens(async () => {
      const config = loadConfig(p.dir);
      // Point the section at a host that has no repository there: the clone must fail.
      config.delivery!.apiBase = join(p.dir, 'missing-host', 'api', 'v1');
      await assert.rejects(
        () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config }),
        (e: unknown) => {
          assert.ok(e instanceof Error);
          assert.match(e.message, /could not clone/);
          assert.match(e.message, /missing-host/);
          assert.match(e.message, /it did not create/);
          return true;
        },
      );
    });
  } finally {
    p.cleanup();
  }
});

// --- (B): an explicit --worktree must qualify, refused BEFORE the run starts --------------------

test('--worktree: a non-repository path is refused before the run, naming the problem and the remedy', async () => {
  const p = deliveryProject();
  try {
    const notRepo = join(p.dir, 'not-a-repo');
    mkdirSync(notRepo, { recursive: true });
    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config, worktree: notRepo }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /is not a git repository/);
        assert.match(e.message, /Clone the target repository/);
        return true;
      },
    );
  } finally {
    p.cleanup();
  }
});

test('--worktree: a missing path is refused before the run', async () => {
  const p = deliveryProject();
  try {
    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config, worktree: join(p.dir, 'nope') }),
      /does not exist/,
    );
  } finally {
    p.cleanup();
  }
});

test('--worktree: a DETACHED HEAD is refused before the run', async () => {
  const p = deliveryProject();
  try {
    const worktree = join(p.dir, 'detached');
    mkdirSync(worktree, { recursive: true });
    git(['init', '-q', '-b', 'task'], worktree);
    writeFileSync(join(worktree, 'a.txt'), 'x\n');
    git(['add', '-A'], worktree);
    git(['commit', '-q', '-m', 'a commit'], worktree);
    git(['checkout', '-q', '--detach'], worktree);
    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config, worktree }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /DETACHED HEAD/);
        assert.match(e.message, /git switch <branch>/);
        return true;
      },
    );
  } finally {
    p.cleanup();
  }
});

test('--worktree: a DIRTY working tree is refused before the run', async () => {
  const p = deliveryProject();
  try {
    const worktree = join(p.dir, 'dirty');
    mkdirSync(worktree, { recursive: true });
    git(['init', '-q', '-b', 'task'], worktree);
    writeFileSync(join(worktree, 'base.txt'), 'the frozen base\n');
    git(['add', '-A'], worktree);
    git(['commit', '-q', '-m', 'the base commit'], worktree);
    // Its own bare remote, so the ONLY thing wrong with this checkout is the uncommitted edit.
    const remote = join(p.dir, 'dirty-origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { env: GIT_ENV });
    git(['remote', 'add', 'origin', remote], worktree);
    git(['push', '-q', 'origin', 'HEAD:main'], worktree);
    // Uncommitted work: the run must not start here.
    writeFileSync(join(worktree, 'base.txt'), 'an uncommitted edit\n');
    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config, worktree }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /uncommitted changes/);
        assert.match(e.message, /takumi never commits for you/);
        return true;
      },
    );
  } finally {
    p.cleanup();
  }
});

test('--worktree: a HEAD not descended from <remote>/<base> is refused, naming the ref it used', async () => {
  const p = deliveryProject();
  try {
    // A remote whose `main` is an UNRELATED history, fetched into the worktree so `origin/main` exists.
    const otherBare = join(p.dir, 'other.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', otherBare], { env: GIT_ENV });
    const otherSeed = join(p.dir, 'other-seed');
    mkdirSync(otherSeed, { recursive: true });
    git(['init', '-q', '-b', 'main'], otherSeed);
    writeFileSync(join(otherSeed, 'other.txt'), 'an unrelated history\n');
    git(['add', '-A'], otherSeed);
    git(['commit', '-q', '-m', 'an unrelated root'], otherSeed);
    git(['remote', 'add', 'origin', otherBare], otherSeed);
    git(['push', '-q', 'origin', 'HEAD:main'], otherSeed);

    const worktree = join(p.dir, 'unrelated');
    mkdirSync(worktree, { recursive: true });
    git(['init', '-q', '-b', 'task'], worktree);
    writeFileSync(join(worktree, 'mine.txt'), 'my own root\n');
    git(['add', '-A'], worktree);
    git(['commit', '-q', '-m', 'my own root commit'], worktree);
    git(['remote', 'add', 'origin', otherBare], worktree);
    git(['fetch', '-q', 'origin', 'main'], worktree);

    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config, worktree }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /not descended from origin\/main/);
        assert.match(e.message, /git merge-base --is-ancestor origin\/main HEAD/);
        return true;
      },
    );
  } finally {
    p.cleanup();
  }
});

test('--worktree: a qualifying checkout is accepted, and the run proceeds', async () => {
  const p = deliveryProject();
  try {
    await withoutTokens(async () => {
      const worktree = qualifiedWorktree(p);
      const config = loadConfig(p.dir);
      const result = await runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config, worktree });
      const log = result.events.join('\n');
      // It was NOT refused: the publish step ran and failed on the host's transport, which is how we
      // know the worktree checks passed and the run reached the delivery boundary.
      assert.ok(!/--worktree/.test(log), 'no --worktree refusal');
      assert.equal(result.status, 'failed', log);
      assert.match(log, /forgejo-delivery: no request transport configured/);
    });
  } finally {
    p.cleanup();
  }
});
