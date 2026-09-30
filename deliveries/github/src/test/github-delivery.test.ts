import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeliveryError,
  DeliveryUnsupportedError,
  hasRunMarker,
  runDeliveryProviderContractSuite,
} from '@takumi/core';
import type {
  BoardHttpRequest,
  BoardHttpResponse,
  BoardRequestFn,
  DeliveryFixture,
  GitResult,
  GitRunner,
} from '@takumi/core';
import { createGitHubDeliveryProvider, GitHubDeliveryProvider, pullRequestBody } from '../index.js';
import type { PullRequestRef } from '@takumi/core';

/**
 * Two injected seams, no network and no real repository: a modelled git worktree
 * and a modelled GitHub. The git double records every argv, which is how the
 * "never force-push" rule is proven rather than trusted.
 */

const BASE = 'a'.repeat(40);
const AHEAD = `${'b'.repeat(12)}c0mmit000000`;
const REMOTE_BASE_ADVANCED = `${'c'.repeat(12)}newbase00000`;

class FakeGit implements GitRunner {
  branch = 'takumi/issue-7-abcdef12';
  head = AHEAD;
  dirty = false;
  /** What `origin/main` points at (differs from BASE when the base advanced). */
  remoteBase = BASE;
  baseAbsorbed = false;
  conflict = false;
  rejectPush = false;
  calls: string[][] = [];

  async run(args: string[]): Promise<GitResult> {
    this.calls.push([...args]);
    const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr: string): GitResult => ({ stdout: '', stderr, exitCode: 1 });

    switch (args[0]) {
      case 'rev-parse':
        return args[1] === '--abbrev-ref' ? ok(`${this.branch}\n`) : ok(`${this.head}\n`);
      case 'status':
        return ok(this.dirty ? ' M src/core/x.ts\n' : '');
      case 'fetch':
        return ok('');
      case 'merge-base': {
        // ['merge-base', '--is-ancestor', <ancestor>, 'HEAD']
        const ancestor = args[2] ?? '';
        const resolved = ancestor.startsWith('origin/') ? this.remoteBase : ancestor;
        const contained = resolved === BASE || this.baseAbsorbed;
        return { stdout: '', stderr: '', exitCode: contained ? 0 : 1 };
      }
      case 'merge': {
        if (args[1] === '--abort') return ok('');
        if (this.conflict) return fail('CONFLICT (content): merge conflict in src/core/x.ts');
        this.baseAbsorbed = true;
        return ok('Merge made by the ort strategy.\n');
      }
      case 'push':
        return this.rejectPush ? fail('! [rejected] takumi/issue-7 -> takumi/issue-7 (non-fast-forward)') : ok('');
      default:
        return fail(`unknown command: ${args.join(' ')}`);
    }
  }

  pushes(): string[][] {
    return this.calls.filter((c) => c[0] === 'push');
  }

  forcePushes(): string[][] {
    return this.calls.filter((c) => c.some((a) => a.startsWith('--force') || a === '-f'));
  }
}

interface SimPull {
  number: number;
  /** The source branch, echoed back in `head.ref` — this is what the adapter matches on. */
  headRef: string;
  url: string;
  state: 'open' | 'closed';
  mergedAt: string | null;
  mergeable: boolean | null;
  headSha: string;
  baseRef: string;
  body?: string;
}

function githubSimulator() {
  const pulls: SimPull[] = [];
  const requests: BoardHttpRequest[] = [];
  let seq = 41;

  const json = (payload: unknown, status = 200): BoardHttpResponse => ({ status, body: JSON.stringify(payload) });

  const request: BoardRequestFn = async (req) => {
    requests.push(req);
    const url = new URL(req.url);
    const path = url.pathname.replace('/repos/acme/widgets', '');
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'GET' && path === '/pulls') {
      const wanted = url.searchParams.get('head') ?? '';
      const branch = wanted.split(':')[1] ?? '';
      return json(
        pulls
          .filter((p) => p.state === 'open')
          .filter((p) => branch.length === 0 || p.headRef === branch)
          .map((p) => ({ number: p.number, html_url: p.url, state: p.state, head: { ref: p.headRef, sha: p.headSha }, base: { ref: p.baseRef } })),
      );
    }
    if (req.method === 'POST' && path === '/pulls') {
      seq += 1;
      const created: SimPull = {
        number: seq,
        headRef: String(body['head'] ?? ''),
        url: `https://github.com/acme/widgets/pull/${seq}`,
        state: 'open',
        mergedAt: null,
        mergeable: true,
        headSha: AHEAD,
        baseRef: String(body['base'] ?? 'main'),
        body: String(body['body'] ?? ''),
      };
      // Remember the head the branch currently points at, so status() reports it.
      created.url = `https://github.com/acme/widgets/pull/${seq}`;
      pulls.push(created);
      return json({ number: created.number, html_url: created.url, state: 'open', head: { ref: created.headRef, sha: created.headSha }, base: { ref: created.baseRef } }, 201);
    }
    const pullMatch = /^\/pulls\/(\d+)$/.exec(path);
    if (req.method === 'GET' && pullMatch) {
      const found = pulls.find((p) => String(p.number) === pullMatch[1]);
      if (!found) return json({ message: 'Not Found' }, 404);
      return json({
        number: found.number,
        html_url: found.url,
        state: found.state,
        merged_at: found.mergedAt,
        mergeable: found.mergeable,
        head: { ref: found.headRef, sha: found.headSha },
        base: { ref: found.baseRef },
      });
    }
    const mergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(path);
    if (req.method === 'PUT' && mergeMatch) {
      const found = pulls.find((p) => String(p.number) === mergeMatch[1]);
      if (!found) return json({ message: 'Not Found' }, 404);
      // GitHub's own guard: the sha in the body must still be the head.
      if (body['sha'] !== undefined && body['sha'] !== found.headSha) {
        return json({ message: 'Head branch was modified. Review and try the merge again.' }, 409);
      }
      if (found.mergeable !== true) return json({ message: 'Pull Request is not mergeable' }, 405);
      found.mergedAt = '2026-09-15T00:00:00Z';
      found.state = 'closed';
      return json({ merged: true, sha: found.headSha });
    }
    if (req.method === 'GET' && /^\/commits\/[^/]+\/check-runs$/.test(path)) {
      return json({
        check_runs: [
          { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://ci/build' },
          { name: 'e2e', status: 'in_progress', conclusion: null },
          { name: 'lint', status: 'completed', conclusion: 'skipped' },
        ],
      });
    }
    if (req.method === 'GET' && /^\/commits\/[^/]+\/status$/.test(path)) {
      return json({ state: 'pending', statuses: [{ context: 'ci/legacy', state: 'pending' }] });
    }
    return json({ message: 'Not Found' }, 404);
  };

  return { request, requests, pulls };
}

const fixture: DeliveryFixture = {
  worktree: '/tmp/takumi-gh-worktree',
  branch: 'takumi/issue-7-abcdef12',
  baseBranch: 'main',
  remote: 'origin',
  itemId: '7',
  runId: 'abcdef12',
  baseSha: BASE,
};

function makeProvider(git: FakeGit, sim: ReturnType<typeof githubSimulator>) {
  return createGitHubDeliveryProvider({ repo: 'acme/widgets', request: sim.request, git });
}


/**
 * This adapter OPENS pull requests, so its own tests may rely on the reference being there. The
 * port keeps `pr` optional (a bare remote has no review surface and reports none) — which is why
 * the shared suite gates on `canOpenPullRequest` and this helper exists for the tests that are
 * about THIS provider.
 */
function prRefOf(out: { pr?: PullRequestRef }): PullRequestRef {
  if (out.pr === undefined) throw new Error('this delivery opens pull requests');
  return out.pr;
}

test('GitHubDeliveryProvider: shared delivery contract suite', async () => {
  const git = new FakeGit();
  const sim = githubSimulator();
  const provider = makeProvider(git, sim);
  const out = await runDeliveryProviderContractSuite(provider, {
    id: 'github',
    fixture,
    makeDirty: async () => {
      git.dirty = true;
    },
    makeNoCommit: async () => {
      git.head = BASE;
    },
    makeUnmergeable: async () => {
      const pull = sim.pulls[0];
      if (pull !== undefined) pull.mergeable = false;
    },
    reset: async () => {
      git.dirty = false;
      git.head = AHEAD;
      const pull = sim.pulls[0];
      if (pull !== undefined) pull.mergeable = true;
    },
    inspect: async () => ({
      pushes: git.pushes().length,
      forcePushes: git.forcePushes().length,
      prs: sim.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/pulls')).length,
      merges: sim.requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/merge')).length,
    }),
  });
  assert.equal(out.gate, 'delivery-contract');
  // The git and GitHub doubles make every branch reachable, so nothing is skipped:
  // a PASS here means the plain-push and reviewed-head rules were actually executed.
  assert.equal(out.result, 'PASS', out.notes.join('\n'));
  assert.equal(git.forcePushes().length, 0);
  // Every push the suite triggered (the happy path and the second deliver that
  // reuses the PR) must be the same plain push of the task branch.
  assert.ok(git.pushes().length >= 1);
  for (const push of git.pushes()) {
    assert.deepEqual(push, ['push', 'origin', fixture.branch]);
  }
});

test('deliver: pushes the task branch plainly and never any force flag', async () => {
  const git = new FakeGit();
  const sim = githubSimulator();
  const out = await makeProvider(git, sim).deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  assert.equal(out.push.mode, 'plain');
  assert.equal(out.created, true);
  assert.deepEqual(git.pushes(), [['push', 'origin', fixture.branch]]);
  assert.deepEqual(git.forcePushes(), []);
});

test('deliver: the pull request body carries the item reference and the run marker', async () => {
  const git = new FakeGit();
  const sim = githubSimulator();
  const body = pullRequestBody({
    worktree: fixture.worktree,
    branch: fixture.branch,
    baseBranch: fixture.baseBranch,
    itemId: '7',
    runId: 'abcdef12',
    body: 'Please review.',
  });
  assert.match(body, /Please review\./);
  assert.match(body, /Fixes #7/);
  assert.match(body, /Item: 7/);
  assert.ok(hasRunMarker(body, 'abcdef12'), 'the PR must carry the machine-readable run marker');

  const provider = makeProvider(git, sim);
  await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12', title: 'Fix the thing' },
    { baseSha: BASE },
  );
  const create = sim.requests.find((r) => r.method === 'POST' && r.url.endsWith('/pulls'));
  const sent = create?.body as Record<string, unknown>;
  assert.equal(sent['title'], 'Fix the thing');
  assert.equal(sent['head'], fixture.branch);
  assert.equal(sent['base'], 'main');
  assert.ok(hasRunMarker(String(sent['body']), 'abcdef12'));
});

test('deliver: a non-numeric board id is still readable (no Fixes # for a Jira key)', () => {
  const body = pullRequestBody({
    worktree: fixture.worktree,
    branch: fixture.branch,
    baseBranch: fixture.baseBranch,
    itemId: 'ACME-1',
    runId: 'abcdef12',
  });
  assert.doesNotMatch(body, /Fixes #/);
  assert.match(body, /Item: ACME-1/);
});

test('deliver: an advanced base is absorbed with a plain merge and reported', async () => {
  const git = new FakeGit();
  git.remoteBase = REMOTE_BASE_ADVANCED;
  const sim = githubSimulator();
  const out = await makeProvider(git, sim).deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  const merge = git.calls.find((c) => c[0] === 'merge' && c[1] !== '--abort');
  assert.deepEqual(merge, ['merge', '--no-edit', 'origin/main']);
  assert.match(out.notes.join(' '), /absorbed advanced base/);
});

test('deliver: a conflicting base merge is aborted and handed to the review session', async () => {
  const git = new FakeGit();
  git.remoteBase = REMOTE_BASE_ADVANCED;
  git.conflict = true;
  const sim = githubSimulator();
  await assert.rejects(
    () =>
      makeProvider(git, sim).deliver(
        { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
        { baseSha: BASE },
      ),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /conflicted/.test(e.message),
  );
  assert.deepEqual(git.calls.filter((c) => c[0] === 'merge').at(-1), ['merge', '--abort']);
  assert.deepEqual(git.pushes(), [], 'nothing may be pushed after a failed base absorption');
});

test('deliver: a rejected push is a precondition, and no force push follows', async () => {
  const git = new FakeGit();
  git.rejectPush = true;
  const sim = githubSimulator();
  await assert.rejects(
    () =>
      makeProvider(git, sim).deliver(
        { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
        { baseSha: BASE },
      ),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /never force-pushes/.test(e.message),
  );
  assert.equal(git.forcePushes().length, 0);
});

test('merge: the host refuses a moved head (GitHub 409) and nothing is merged', async () => {
  const git = new FakeGit();
  const sim = githubSimulator();
  const provider = makeProvider(git, sim);
  const out = await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  const pull = sim.pulls[0];
  assert.ok(pull);
  pull!.headSha = `${'d'.repeat(12)}moved0000000`;
  await assert.rejects(
    () => provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /head moved/.test(e.message),
  );
  assert.equal(sim.requests.some((r) => r.method === 'PUT' && r.url.endsWith('/merge')), false, 'no merge request may be sent');
});

test('merge: an unknown mergeability is not a yes', async () => {
  const git = new FakeGit();
  const sim = githubSimulator();
  const provider = makeProvider(git, sim);
  const out = await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  const pull = sim.pulls[0];
  pull!.mergeable = null;
  await assert.rejects(
    () => provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /not known yet/.test(e.message),
  );
});

test('checks: pending stays pending, legacy commit statuses are included', async () => {
  const git = new FakeGit();
  const sim = githubSimulator();
  const provider = makeProvider(git, sim);
  const out = await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  const checks = await provider.checks(prRefOf(out));
  assert.deepEqual(checks.map((c) => `${c.name}:${c.conclusion}`), ['build:success', 'e2e:pending', 'lint:neutral', 'ci/legacy:pending']);
  assert.equal(checks.some((c) => c.name === 'e2e' && c.conclusion === 'success'), false);
});

test('capabilities: GitHub can do the whole delivery side', () => {
  const provider = new GitHubDeliveryProvider({ repo: 'acme/widgets', request: async () => ({ status: 200, body: '{}' }) });
  assert.deepEqual(provider.capabilities(), {
    canPushBranch: true,
    canOpenPullRequest: true,
    canRunChecks: true,
    canMerge: true,
  });
  assert.equal(provider.metadata().id, 'github');
});

test('fail closed: without a git seam or a token, nothing is touched', async () => {
  const previous = process.env['GITHUB_TOKEN'];
  delete process.env['GITHUB_TOKEN'];
  try {
    const provider = createGitHubDeliveryProvider({ repo: 'acme/widgets' });
    await assert.rejects(
      () =>
        provider.deliver(
          { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
          { baseSha: BASE },
        ),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'unsupported' && /no git runner configured/.test(e.message),
    );
  } finally {
    if (previous !== undefined) process.env['GITHUB_TOKEN'] = previous;
  }
});

test('options: a malformed repo is rejected at construction', () => {
  assert.throws(
    () => new GitHubDeliveryProvider({ repo: 'nope', request: async () => ({ status: 200, body: '{}' }) }),
    /owner\/name/,
  );
});

test('unused capability guard: merging without canMerge is gated (fake capability plumbing)', async () => {
  // The real adapter always declares canMerge; this pins the gate itself so a
  // future "capability negotiation" refactor cannot drop it silently.
  const provider = new GitHubDeliveryProvider({ repo: 'acme/widgets', request: async () => ({ status: 200, body: '{}' }) });
  const sabotaged = Object.create(provider) as GitHubDeliveryProvider;
  sabotaged.capabilities = () => ({ canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: false });
  await assert.rejects(
    () => sabotaged.merge({ number: '1', url: 'u', headSha: 'x', baseSha: 'main' }, { expectedHeadSha: 'x' }),
    DeliveryUnsupportedError,
  );
});
