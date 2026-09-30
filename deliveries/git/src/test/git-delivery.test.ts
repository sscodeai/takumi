import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeliveryError,
  createGitRunner,
  runDeliveryProviderContractSuite,
  type DeliveryRequest,
  type GitRunner,
} from '@takumi/core';
import { GitDeliveryProvider } from '../index.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/** A recording GitRunner: the suite asks what the provider DID, not what it says it did. */
function recorder(): GitRunner & { argvs: string[][] } {
  const real = createGitRunner();
  const argvs: string[][] = [];
  return {
    argvs,
    run: async (args: string[], opts: { cwd: string }) => {
      argvs.push(args);
      return real.run(args, opts);
    },
  } as unknown as GitRunner & { argvs: string[][] };
}

function makeFixture(): {
  root: string;
  work: string;
  branch: string;
  baseSha: string;
  head: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'takumi-git-delivery-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  mkdirSync(origin);
  git(['init', '--bare', '--initial-branch=main'], origin);
  mkdirSync(work);
  git(['init', '--initial-branch=main'], work);
  writeFileSync(join(work, 'README.md'), '# fixture\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'chore: initial commit'], work);
  git(['remote', 'add', 'origin', origin], work);
  git(['push', '-u', 'origin', 'main'], work);
  const baseSha = git(['rev-parse', 'HEAD'], work).trim();

  const branch = 'takumi/7-abcdef12';
  git(['checkout', '-b', branch], work);
  writeFileSync(join(work, 'feature.txt'), 'the work\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'feat: the work'], work);
  const head = git(['rev-parse', 'HEAD'], work).trim();

  return { root, work, branch, baseSha, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function providerFor(fixture: ReturnType<typeof makeFixture>, gitRunner: GitRunner): GitDeliveryProvider {
  return new GitDeliveryProvider({ repo: fixture.work, baseBranch: 'main', git: gitRunner });
}

function requestFor(fixture: ReturnType<typeof makeFixture>): DeliveryRequest {
  return { worktree: fixture.work, branch: fixture.branch, baseBranch: 'main', itemId: '7', runId: 'abcdef12' };
}

// --- the shared Delivery Contract Suite (ADR-007), which every delivery provider must pass ----
// The capability-gated parts report PASS_WITH_NOT_RUN rather than being skipped: this provider
// declares no pull request and no checks, and the suite asserts exactly that honesty.
test('git delivery: the shared Delivery Contract Suite passes', async () => {
  const f = makeFixture();
  const gitRunner = recorder();
  try {
    const result = await runDeliveryProviderContractSuite(providerFor(f, gitRunner), {
      id: 'git',
      fixture: {
        worktree: f.work,
        branch: f.branch,
        baseBranch: 'main',
        remote: 'origin',
        itemId: '7',
        runId: 'abcdef12',
        baseSha: f.baseSha,
      },
      makeDirty: async () => {
        writeFileSync(join(f.work, 'README.md'), '# fixture (uncommitted edit)\n');
      },
      makeNoCommit: async () => {
        // Rewind the branch to the frozen base: HEAD equals it again, which is exactly the state
        // "the agent claimed success and committed nothing".
        git(['reset', '--hard', f.baseSha], f.work);
      },
      makeUnmergeable: async () => {
        // A base that moved on: a real divergence, so a fast-forward no longer exists.
        git(['checkout', 'main'], f.work);
        writeFileSync(join(f.work, 'conflict.txt'), 'base moved\n');
        git(['add', '.'], f.work);
        git(['commit', '-m', 'feat: base moves on'], f.work);
        git(['push', 'origin', 'main'], f.work);
        git(['checkout', f.branch], f.work);
      },
      reset: async () => {
        // Restoring the FIXTURE, not delivering: the fixture's own remote is its own to rewind.
        git(['checkout', '-f', f.branch], f.work);
        git(['reset', '--hard', f.head], f.work);
        git(['checkout', 'main'], f.work);
        git(['reset', '--hard', f.baseSha], f.work);
        git(['push', '--force', 'origin', 'main'], f.work);
        git(['checkout', f.branch], f.work);
      },
      inspect: async () => ({
        pushes: gitRunner.argvs.filter((a) => a[0] === 'push' && !a.some((x) => x.includes('refs/heads/main'))).length,
        forcePushes: gitRunner.argvs.filter((a) => a[0] === 'push' && a.some((x) => x === '--force' || x.startsWith('+'))).length,
        prs: 0,
        merges: gitRunner.argvs.filter((a) => a[0] === 'push' && a.some((x) => x.includes('refs/heads/main'))).length,
      }),
    });

    assert.equal(result.gate, 'delivery-contract');
    assert.ok(['PASS', 'PASS_WITH_NOT_RUN'].includes(result.result), result.notes.join(' | '));
    assert.ok(
      result.notes.some((n) => n.startsWith('deliver: PASS')),
      `the suite must have run the delivery steps: ${result.notes.join(' | ')}`,
    );
  } finally {
    f.cleanup();
  }
});

// --- what makes THIS provider different: the remote is read back, and the base moves forward ---

test('git delivery: the reported head is the head the REMOTE holds, not the one that was pushed', async () => {
  const f = makeFixture();
  try {
    const provider = providerFor(f, recorder());
    const outcome = await provider.deliver(requestFor(f), { baseSha: f.baseSha });
    assert.equal(outcome.push.head, f.head);
    assert.equal(outcome.push.mode, 'plain');
    assert.equal(outcome.created, true, 'the remote did not have this branch before');
    assert.equal(outcome.pr, undefined, 'no review surface here, so no pull request may be claimed');
    // The remote really holds it:
    const remoteHead = git(['ls-remote', '--heads', 'origin', `refs/heads/${f.branch}`], f.work).trim().split(/\s+/)[0];
    assert.equal(remoteHead, f.head);
    // And the second delivery of the same head is not a new creation.
    const again = await provider.deliver(requestFor(f), { baseSha: f.baseSha });
    assert.equal(again.created, false);
  } finally {
    f.cleanup();
  }
});

test('git delivery: a bare remote reports no checks and no review surface', async () => {
  const f = makeFixture();
  try {
    const provider = providerFor(f, recorder());
    assert.deepEqual(provider.capabilities(), {
      canPushBranch: true,
      canOpenPullRequest: false,
      canRunChecks: false,
      canMerge: true,
    });
    assert.deepEqual(await provider.checks(), [], 'nothing runs checks for a bare remote');
  } finally {
    f.cleanup();
  }
});

test('git delivery: merge moves the base branch forward, and only to the reviewed head', async () => {
  const f = makeFixture();
  try {
    const provider = providerFor(f, recorder());
    const outcome = await provider.deliver(requestFor(f), { baseSha: f.baseSha });
    const ref = { number: outcome.push.branch, url: '', headSha: outcome.push.head, baseSha: f.baseSha };

    const status = await provider.status(ref);
    assert.equal(status.state, 'open');
    assert.equal(status.mergeable, true, 'the base can move forward to this head');
    assert.equal(status.headSha, f.head);

    const merged = await provider.merge(ref, { expectedHeadSha: f.head });
    assert.equal(merged.merged, true);
    assert.equal(merged.headSha, f.head, 'the merged commit is the reviewed head');
    const mainOnRemote = git(['ls-remote', '--heads', 'origin', 'refs/heads/main'], f.work).trim().split(/\s+/)[0];
    assert.equal(mainOnRemote, f.head, 'the base branch on the remote moved to the reviewed head');
    assert.equal((await provider.status(ref)).state, 'merged');
  } finally {
    f.cleanup();
  }
});

test('git delivery: a head that moved is refused, and no force push is ever used', async () => {
  const f = makeFixture();
  try {
    const gitRunner = recorder();
    const provider = providerFor(f, gitRunner);
    const outcome = await provider.deliver(requestFor(f), { baseSha: f.baseSha });
    const ref = { number: outcome.push.branch, url: '', headSha: outcome.push.head, baseSha: f.baseSha };
    await assert.rejects(
      () => provider.merge(ref, { expectedHeadSha: `${'a'.repeat(12)}c0mmit000000` }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /head moved/.test(e.message),
    );
    assert.equal(
      gitRunner.argvs.some((a) => a[0] === 'push' && a.some((x) => x === '--force' || x.startsWith('+'))),
      false,
      'a force push must never appear in the argv',
    );
  } finally {
    f.cleanup();
  }
});

test('git delivery: a base that moved on is a refusal, not a rewritten history', async () => {
  const f = makeFixture();
  try {
    const provider = providerFor(f, recorder());
    const outcome = await provider.deliver(requestFor(f), { baseSha: f.baseSha });
    const ref = { number: outcome.push.branch, url: '', headSha: outcome.push.head, baseSha: f.baseSha };

    // The base moves on: main gets a commit the task branch does not have.
    git(['checkout', 'main'], f.work);
    writeFileSync(join(f.work, 'base.txt'), 'base moved\n');
    git(['add', '.'], f.work);
    git(['commit', '-m', 'feat: base moves on'], f.work);
    git(['push', 'origin', 'main'], f.work);

    assert.equal((await provider.status(ref)).mergeable, false, 'a fast-forward no longer exists');
    await assert.rejects(
      () => provider.merge(ref, { expectedHeadSha: f.head }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition',
    );
    // main did NOT move: the refusal left the base where it was.
    assert.notEqual(git(['ls-remote', '--heads', 'origin', 'refs/heads/main'], f.work).trim().split(/\s+/)[0], f.head);
  } finally {
    f.cleanup();
  }
});

test('git delivery: squash and rebase are refused instead of silently becoming a merge', async () => {
  const f = makeFixture();
  try {
    const provider = providerFor(f, recorder());
    const outcome = await provider.deliver(requestFor(f), { baseSha: f.baseSha });
    const ref = { number: outcome.push.branch, url: '', headSha: outcome.push.head, baseSha: f.baseSha };
    await assert.rejects(
      () => provider.merge(ref, { expectedHeadSha: f.head, method: 'squash' }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'unsupported' && /not available/.test(e.message),
    );
  } finally {
    f.cleanup();
  }
});

test('git delivery: a worktree the agent left dirty is refused, and nothing is pushed', async () => {
  const f = makeFixture();
  try {
    const gitRunner = recorder();
    const provider = providerFor(f, gitRunner);
    writeFileSync(join(f.work, 'README.md'), '# fixture (uncommitted edit)\n');
    await assert.rejects(
      () => provider.deliver(requestFor(f), { baseSha: f.baseSha }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /uncommitted changes/.test(e.message),
    );
    assert.equal(
      gitRunner.argvs.some((a) => a[0] === 'push'),
      false,
      'a dirty worktree means the work is not where it was said to be: nothing may be pushed',
    );
  } finally {
    f.cleanup();
  }
});

test('git delivery: HEAD still equal to the frozen base is "no commit", not an empty delivery', async () => {
  const f = makeFixture();
  try {
    const provider = providerFor(f, recorder());
    git(['reset', '--hard', f.baseSha], f.work);
    await assert.rejects(
      () => provider.deliver(requestFor(f), { baseSha: f.baseSha }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /no commit on/.test(e.message),
    );
  } finally {
    f.cleanup();
  }
});
