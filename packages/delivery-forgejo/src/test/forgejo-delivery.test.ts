/**
 * ForgejoDeliveryProvider — the shared Delivery Contract Suite plus the
 * adapter's own guarantees, all OFFLINE: a recorded git runner and a recorded
 * Forgejo API double, no token, no network, no real repository.
 *
 * The contract suite is the same one `FakeDeliveryProvider` runs (ADR-007), so a
 * real-host adapter cannot quietly weaken the three rules: the agent's boundary
 * is the commit, pushes are plain, and only the reviewed head is merged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeliveryError,
  DeliveryUnsupportedError,
  hasRunMarker,
  parseBoardStateRecord,
  runDeliveryProviderContractSuite,
} from '@takumi/core';
import type { DeliveryFixture, DeliveryRequest, PullRequestRef } from '@takumi/core';
import {
  createForgejoDeliveryProvider,
  ForgejoDeliveryProvider,
  renderPullRequestBody,
  renderRunMarker as runMarker,
} from '../index.js';
import { FakeGitRunner, MERGED_HEAD } from './fake-git-runner.js';
import { FakeForgejoApi } from './fake-forgejo-api.js';

const OWNER = 'dev';
const REPO = 'takumi-delivery-selftest';
const API_BASE = 'https://forgejo.test/api/v1';
const REMOTE = 'origin';
const BRANCH = 'takumi/issue-7-abcdef12';
const BASE_BRANCH = 'main';
const BASE = 'a'.repeat(40);
const AHEAD = 'c'.repeat(40);
const ADVANCED = 'e'.repeat(40);
const MOVED = 'd'.repeat(40);

const fixture: DeliveryFixture = {
  worktree: '/tmp/takumi-forgejo-worktree',
  branch: BRANCH,
  baseBranch: BASE_BRANCH,
  remote: REMOTE,
  itemId: '7',
  runId: 'abcdef12',
  baseSha: BASE,
  title: 'Fix the thing',
  body: 'Reviewed by a human.',
};

interface Harness {
  git: FakeGitRunner;
  api: FakeForgejoApi;
  provider: ForgejoDeliveryProvider;
}

/** A clean worktree on the task branch, one commit ahead of the frozen base. */
function harness(
  options: { head?: string; remoteBase?: string; mergeConflict?: boolean; mergeBusyAttempts?: number } = {},
): Harness {
  const git = new FakeGitRunner({
    branch: BRANCH,
    head: options.head ?? AHEAD,
    frozenBase: BASE,
    remote: REMOTE,
    baseBranch: BASE_BRANCH,
    remoteBase: options.remoteBase ?? BASE,
    ...(options.mergeConflict === undefined ? {} : { mergeConflict: options.mergeConflict }),
  });
  const api = new FakeForgejoApi({
    owner: OWNER,
    repo: REPO,
    apiBase: API_BASE,
    baseBranch: BASE_BRANCH,
    // Forgejo tracks the SOURCE BRANCH head — i.e. what the last push delivered.
    head: () => git.pushedHead() ?? git.currentHead(),
    ...(options.mergeBusyAttempts === undefined ? {} : { mergeBusyAttempts: options.mergeBusyAttempts }),
  });
  const provider = createForgejoDeliveryProvider({
    owner: OWNER,
    repo: REPO,
    apiBase: API_BASE,
    request: api.request,
    git,
    remote: REMOTE,
  });
  return { git, api, provider };
}

function request(overrides: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    worktree: fixture.worktree,
    branch: BRANCH,
    baseBranch: BASE_BRANCH,
    remote: REMOTE,
    itemId: fixture.itemId,
    runId: fixture.runId,
    title: fixture.title,
    body: fixture.body,
    ...overrides,
  };
}

function refOf(number: string, headSha = AHEAD): PullRequestRef {
  return { number, url: `https://forgejo.test/${OWNER}/${REPO}/pulls/${number}`, headSha, baseSha: BASE_BRANCH };
}

/**
 * This provider OPENS pull requests, so its own tests may rely on the reference
 * being there. The port keeps `pr` optional — a bare remote has no review surface
 * and must report none — which is why the shared suite gates on
 * `canOpenPullRequest` and this helper exists for the tests about THIS provider.
 */
function prRefOf(out: { pr?: PullRequestRef }): PullRequestRef {
  if (out.pr === undefined) throw new Error('this delivery opens pull requests');
  return out.pr;
}

/** The effect snapshot the contract suite asserts on — never a provider self-report. */
function effects(h: Harness): { pushes: number; forcePushes: number; prs: number; merges: number } {
  return {
    pushes: h.git.pushes().length,
    forcePushes: h.git.forcePushes().length,
    prs: h.api.createdCount(),
    merges: h.api.mergedCount(),
  };
}

// --- the shared contract suite ---------------------------------------------

test('ForgejoDeliveryProvider: shared delivery contract suite', async () => {
  const h = harness();
  const out = await runDeliveryProviderContractSuite(h.provider, {
    id: 'forgejo',
    fixture,
    // The three state hooks make every fail-closed branch reachable: a dirty
    // worktree, a head still equal to the frozen base, and an unmergeable pull
    // request. `reset` restores a deliverable state between them.
    makeDirty: async () => {
      h.git.setDirty(true);
    },
    makeNoCommit: async () => {
      h.git.setHead(BASE);
    },
    makeUnmergeable: async () => {
      const number = h.api.openPullNumbers()[0];
      assert.ok(number !== undefined, 'the suite must have created a pull request by now');
      h.api.setMergeable(number, false);
    },
    reset: async () => {
      h.git.setDirty(false);
      h.git.setHead(h.git.pushedHead() ?? AHEAD);
      for (const number of h.api.openPullNumbers()) h.api.setMergeable(number, true);
    },
    inspect: async () => effects(h),
  });
  assert.equal(out.gate, 'delivery-contract');
  assert.equal(out.result, 'PASS', out.notes.join('\n'));
  assert.ok(out.notes.some((n) => n.startsWith('dirtyWorktree: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('noCommit: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('mergeGuard: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('merge: PASS')));

  // The suite proved the effects; the recorder proves HOW they were produced.
  assert.deepEqual(h.git.unexpectedArgv(), [], 'the adapter issued a git command the fake does not model');
  assert.deepEqual(h.git.forcePushes(), [], 'a force push was issued');
  assert.ok(h.git.pushes().length >= 2, 'every delivery must push the task branch');
  for (const push of h.git.pushes()) {
    assert.deepEqual(push.argv, ['push', REMOTE, BRANCH]);
  }
  assert.equal(h.api.createdCount(), 1, 'exactly one pull request may be created');
});

// --- rule 1: the agent's boundary is the commit ----------------------------

test('ForgejoDeliveryProvider: refuses a worktree that is not on the task branch', async () => {
  const h = harness();
  h.git.setBranch('some-other-branch');
  await assert.rejects(
    () => h.provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /not the task branch/.test(e.message),
  );
  assert.deepEqual(h.git.pushes(), [], 'nothing may be pushed from the wrong branch');
  assert.equal(h.api.createdCount(), 0);
});

test('ForgejoDeliveryProvider: refuses a head that is not descended from the frozen base', async () => {
  const h = harness();
  // A rewritten branch: the worktree head no longer contains the frozen base.
  h.git.setAncestry([h.git.currentHead()]);
  await assert.rejects(
    () => h.provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) =>
      e instanceof DeliveryError && e.kind === 'precondition' && /not descended from the frozen base/.test(e.message),
  );
  assert.deepEqual(h.git.pushes(), []);
});

test('ForgejoDeliveryProvider: a refused push is a precondition, and nothing is ever forced', async () => {
  const h = harness();
  h.git.setPushRefusal(true);
  await assert.rejects(
    () => h.provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /never forced/.test(e.message),
  );
  assert.equal(h.api.createdCount(), 0, 'a branch that never reached the host cannot have a pull request');
  assert.equal(h.git.forcePushes().length, 0);
  // The adapter must not reach for a force flag even to retry: no second push argv.
  assert.equal(h.git.argv().filter((args) => args[0] === 'push').length, 1);
});

// --- rule 2: plain push, plain base absorption -----------------------------

test('ForgejoDeliveryProvider: the push argv is exactly `push <remote> <branch>`', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(out.push.mode, 'plain');
  assert.deepEqual(h.git.pushes().map((p) => p.argv), [['push', REMOTE, BRANCH]]);
  assert.equal(out.push.head, AHEAD);
  assert.equal(prRefOf(out).headSha, out.push.head);
  assert.equal(out.push.branch, BRANCH);
  assert.equal(out.created, true);
});

test('ForgejoDeliveryProvider: an advanced base is absorbed with a plain merge of the remote base', async () => {
  const h = harness({ remoteBase: ADVANCED });
  const out = await h.provider.deliver(request(), { baseSha: BASE });

  // The exact argv of the absorption: fetch the base, test the ancestry, then a
  // PLAIN merge of `<remote>/<baseBranch>` — never a rebase, never a force.
  assert.ok(h.git.commands().includes(`git fetch ${REMOTE} ${BASE_BRANCH}`));
  assert.ok(h.git.commands().includes(`git merge-base --is-ancestor ${REMOTE}/${BASE_BRANCH} HEAD`));
  assert.ok(h.git.commands().includes(`git merge --no-edit ${REMOTE}/${BASE_BRANCH}`));
  assert.equal(h.git.baseMerges(), 1);
  assert.equal(h.git.mergeAborts(), 0);
  assert.deepEqual(h.git.forcePushes(), []);

  // The delivered head is the merge commit the absorption created, not the old head.
  assert.notEqual(MERGED_HEAD, AHEAD);
  assert.equal(out.push.mode, 'plain');
  assert.equal(out.push.head, MERGED_HEAD);
  assert.equal(prRefOf(out).headSha, MERGED_HEAD);
  assert.match(out.notes.join(' '), /absorbed the advanced base origin\/main with a plain merge/);
});

test('ForgejoDeliveryProvider: a conflicting base absorption is aborted, not resolved', async () => {
  const h = harness({ remoteBase: ADVANCED, mergeConflict: true });
  await assert.rejects(
    () => h.provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /conflicted/.test(e.message),
  );
  assert.equal(h.git.mergeAborts(), 1, 'the half-done merge must be aborted');
  assert.deepEqual(h.git.pushes(), [], 'a conflicted worktree must never be pushed');
  assert.equal(h.api.createdCount(), 0);
});

// --- the pull request -------------------------------------------------------

test('ForgejoDeliveryProvider: the body carries the run marker, the state record and the item reference', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(out.created, true);
  assert.equal(prRefOf(out).number, '1');

  const create = h.api.requestsMatching('/pulls').find((req) => req.method === 'POST');
  assert.ok(create !== undefined, 'the pull request must be created with a POST');
  const body = create.body as Record<string, unknown>;
  const description = String(body['body']);

  assert.ok(description.includes(runMarker(fixture.runId)), 'the run marker must be in the body');
  assert.match(description, /Fixes #7/, 'Forgejo closes a numeric item natively');
  assert.match(description, /Item: 7/, 'the item id must also be stated in plain text');
  assert.ok(description.includes('Reviewed by a human.'), 'the caller body must be passed through');
  assert.equal(body['head'], BRANCH);
  assert.equal(body['base'], BASE_BRANCH);
  assert.equal(body['title'], 'Fix the thing');

  // The marker is not a private format: core's own parser reads it back.
  const record = parseBoardStateRecord(description);
  assert.ok(record !== null, 'the body must carry a versioned state record');
  assert.equal(record.schema, 1);
  assert.equal(record.runId, fixture.runId);
  assert.equal(record.item, fixture.itemId);
  assert.equal(record.baseBranch, BASE_BRANCH);
  assert.equal(record.branch, BRANCH);
});

test('ForgejoDeliveryProvider: a non-numeric item id is readable and gets no Fixes line', () => {
  const body = renderPullRequestBody(request({ itemId: 'ACME-1' }));
  assert.doesNotMatch(body, /Fixes #/);
  assert.match(body, /Item: ACME-1/);
  assert.ok(hasRunMarker(body, fixture.runId));
});

test('ForgejoDeliveryProvider: exactly one pull request, reused on every later delivery', async () => {
  const h = harness();
  const first = await h.provider.deliver(request(), { baseSha: BASE });
  const second = await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(second.created, false);
  assert.equal(prRefOf(second).number, prRefOf(first).number);
  assert.ok(second.notes.some((n) => n.includes(`reused the open pull request #${prRefOf(first).number}`)));
  assert.equal(h.api.requestsMatching('/pulls').filter((req) => req.method === 'POST').length, 1);
  assert.equal(h.api.createdCount(), 1);

  const lookups = h.api.calls().filter((call) => call.includes('state=open'));
  assert.equal(lookups.length, 2, 'each delivery looks the open pull request up first');
  assert.ok(lookups[0]?.includes('limit=50'));
});

test('ForgejoDeliveryProvider: a frozen-base delivery never merges the base', async () => {
  const h = harness();
  await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(h.git.baseMerges(), 0, 'the base has not advanced: there is nothing to absorb');
  assert.equal(h.git.fetchCount(), 1, 'the remote base is still fetched, so the test is about the real tip');
});

// --- status ----------------------------------------------------------------

test('ForgejoDeliveryProvider: status maps the state, the head and the base branch', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  assert.deepEqual(await h.provider.status(prRefOf(out)), {
    state: 'open',
    mergeable: true,
    headSha: AHEAD,
    baseSha: BASE_BRANCH,
  });
});

test('ForgejoDeliveryProvider: mergeability is tri-state and an unknown is never a yes', async () => {
  const h = harness();
  const number = h.api.seedPull({ headSha: AHEAD, mergeable: true });
  const ref = refOf(String(number));

  assert.equal((await h.provider.status(ref)).mergeable, true, 'mergeable → true');
  h.api.setMergeable(number, false);
  assert.equal((await h.provider.status(ref)).mergeable, false, 'not mergeable → false');
  h.api.setMergeable(number, null);
  assert.equal((await h.provider.status(ref)).mergeable, null, 'unknown → null, NEVER a yes');
});

test('ForgejoDeliveryProvider: status maps merged/closed and refuses an unknown state', async () => {
  const h = harness();
  const number = h.api.seedPull({ headSha: AHEAD, state: 'closed', merged: true });
  assert.equal((await h.provider.status(refOf(String(number)))).state, 'merged');
  const closed = h.api.seedPull({ headSha: AHEAD, state: 'closed' });
  assert.equal((await h.provider.status(refOf(String(closed)))).state, 'closed');
  const open = h.api.seedPull({ headSha: AHEAD, state: 'open' });
  assert.equal((await h.provider.status(refOf(String(open)))).state, 'open');

  // A state the adapter does not model is a refusal, not a guess.
  const bogus = h.api.pull(open);
  assert.ok(bogus !== undefined);
  bogus.state = 'something-new' as 'open';
  await assert.rejects(
    () => h.provider.status(refOf(String(open))),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /unknown state/.test(e.message),
  );
});

test('ForgejoDeliveryProvider: an unknown pull request is not_found', async () => {
  const h = harness();
  await assert.rejects(
    () => h.provider.status(refOf('99')),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'not_found',
  );
});

// --- checks ----------------------------------------------------------------

test('ForgejoDeliveryProvider: commit status → conclusion, and pending is never success', async () => {
  const h = harness();
  const number = h.api.seedPull({ headSha: AHEAD });
  // Seed the statuses for the head the pull request points at.
  const api = new FakeForgejoApi({
    owner: OWNER,
    repo: REPO,
    apiBase: API_BASE,
    baseBranch: BASE_BRANCH,
    head: () => AHEAD,
    statuses: {
      [AHEAD]: [
        { context: 'ci/build', status: 'success', target_url: 'https://ci/build/1' },
        { context: 'ci/tests', status: 'failure' },
        { context: 'ci/e2e', status: 'pending' },
        { context: 'ci/deploy', status: 'error' },
        { context: 'ci/mystery', status: 'something-new' },
      ],
    },
  });
  const provider = createForgejoDeliveryProvider({ owner: OWNER, repo: REPO, apiBase: API_BASE, request: api.request, git: h.git });
  const checks = await provider.checks(refOf(String(number)));
  assert.deepEqual(
    checks.map((c) => [c.name, c.conclusion]),
    [
      ['ci/build', 'success'],
      ['ci/tests', 'failure'],
      ['ci/e2e', 'pending'],
      ['ci/deploy', 'failure'],
      ['ci/mystery', 'unknown'],
    ],
  );
  // The specific trap: a still-running check must not read as green.
  assert.equal(checks.find((c) => c.name === 'ci/e2e')?.conclusion, 'pending');
  assert.equal(checks.find((c) => c.name === 'ci/e2e')?.url, undefined);
  assert.equal(checks.find((c) => c.name === 'ci/build')?.url, 'https://ci/build/1');
  assert.ok(api.calls().some((call) => call.includes(`/commits/${AHEAD}/status`)));
});

test('ForgejoDeliveryProvider: a repository with no CI reports no checks (never a green one)', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  assert.deepEqual(await h.provider.checks(prRefOf(out)), []);
});

// --- rule 3: merge exactly the reviewed head -------------------------------

test('ForgejoDeliveryProvider: the HOST refuses a moved head (409) and nothing is merged', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  const ref = prRefOf(out);
  // A racing push moves the pull request's head after the review.
  const number = Number.parseInt(ref.number, 10);
  const pull = h.api.pull(number);
  assert.ok(pull !== undefined);
  pull.headSha = MOVED;

  await assert.rejects(
    () => h.provider.merge(ref, { expectedHeadSha: ref.headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /HTTP 409/.test(e.message),
  );
  // The merge WAS sent — with head_commit_id — so the refusal came from the host's
  // exact-head requirement, not from a client-side comparison.
  const mergePosts = h.api.requestsMatching('/merge').filter((req) => req.method === 'POST');
  assert.equal(mergePosts.length, 1);
  assert.equal((mergePosts[0]?.body as Record<string, unknown>)['head_commit_id'], ref.headSha);
  assert.equal(h.api.mergedCount(), 0, 'a stale-head merge must not merge anything');
});

test('ForgejoDeliveryProvider: an unmergeable pull request is refused by the host (405)', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  const ref = prRefOf(out);
  h.api.setMergeable(Number.parseInt(ref.number, 10), false);
  await assert.rejects(
    () => h.provider.merge(ref, { expectedHeadSha: ref.headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /HTTP 405/.test(e.message),
  );
  assert.equal(h.api.mergedCount(), 0);
});

test('ForgejoDeliveryProvider: an already-merged pull request is refused', async () => {
  const h = harness();
  const number = h.api.seedPull({ headSha: AHEAD, state: 'closed', merged: true });
  await assert.rejects(
    () => h.provider.merge(refOf(String(number)), { expectedHeadSha: AHEAD }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /already merged/.test(e.message),
  );
});

test('ForgejoDeliveryProvider: a transient merge refusal is retried, not reported as a failure', async () => {
  // MEASURED live: Forgejo can answer `405 {"message":"Please try again later"}`
  // while it recomputes a pull request's mergeability. That is "not yet", not a
  // decision about the head, so it is retried.
  const h = harness({ mergeBusyAttempts: 1 });
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  const ref = prRefOf(out);
  const merged = await h.provider.merge(ref, { expectedHeadSha: ref.headSha });
  assert.equal(merged.merged, true);
  const posts = h.api.requestsMatching('/merge').filter((req) => req.method === 'POST');
  assert.equal(posts.length, 2, 'one transient 405, then the merge');
  assert.equal(h.api.mergedCount(), 1);
});

test('ForgejoDeliveryProvider: merge sends Do and head_commit_id, then confirms the merge', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  const ref = prRefOf(out);
  const merged = await h.provider.merge(ref, { expectedHeadSha: ref.headSha, method: 'squash' });
  assert.deepEqual(merged, { merged: true, method: 'squash', headSha: ref.headSha, url: ref.url });
  const post = h.api.requestsMatching('/merge').find((req) => req.method === 'POST');
  assert.deepEqual(post?.body, { Do: 'squash', head_commit_id: ref.headSha });
  assert.equal((await h.provider.status(ref)).state, 'merged');
});

// --- capabilities and fail-closed construction -----------------------------

test('capabilities: Forgejo can do the whole delivery side', () => {
  const provider = new ForgejoDeliveryProvider({ owner: OWNER, repo: REPO, request: async () => ({ status: 200, body: '{}' }) });
  assert.deepEqual(provider.capabilities(), {
    canPushBranch: true,
    canOpenPullRequest: true,
    canRunChecks: true,
    canMerge: true,
  });
  assert.equal(provider.metadata().id, 'forgejo');
  assert.ok(provider.metadata().version.length > 0);
});

test('fail closed: without a git seam or a token, nothing is touched', async () => {
  const previous = { a: process.env['FORGEJO_TOKEN'], b: process.env['GITEA_TOKEN'] };
  delete process.env['FORGEJO_TOKEN'];
  delete process.env['GITEA_TOKEN'];
  try {
    const provider = createForgejoDeliveryProvider({ owner: OWNER, repo: REPO, apiBase: API_BASE, git: undefined, request: undefined });
    await assert.rejects(
      () => provider.deliver(request(), { baseSha: BASE }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'unsupported' && /no git runner configured/.test(e.message),
    );
  } finally {
    if (previous.a !== undefined) process.env['FORGEJO_TOKEN'] = previous.a;
    if (previous.b !== undefined) process.env['GITEA_TOKEN'] = previous.b;
  }
});

test('options: a malformed owner or repo is rejected at construction', () => {
  assert.throws(() => new ForgejoDeliveryProvider({ owner: 'a/b', repo: REPO }), /single path segment/);
  assert.throws(() => new ForgejoDeliveryProvider({ owner: '', repo: REPO }), /`owner` is required/);
  assert.throws(() => new ForgejoDeliveryProvider({ owner: OWNER, repo: '' }), /`repo` is required/);
});

test('unused capability guard: merging without canMerge is gated', async () => {
  const provider = new ForgejoDeliveryProvider({ owner: OWNER, repo: REPO, request: async () => ({ status: 200, body: '{}' }) });
  const sabotaged = Object.create(provider) as ForgejoDeliveryProvider;
  sabotaged.capabilities = () => ({ canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: false });
  await assert.rejects(
    () => sabotaged.merge({ number: '1', url: 'u', headSha: 'x', baseSha: 'main' }, { expectedHeadSha: 'x' }),
    DeliveryUnsupportedError,
  );
});
