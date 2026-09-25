/**
 * GitLabDeliveryProvider — the shared Delivery Contract Suite plus the adapter's
 * own guarantees, all OFFLINE: a recorded git runner and a recorded GitLab API
 * double, no token, no network, no real repository.
 *
 * The contract suite is the same one `FakeDeliveryProvider` runs (ADR-007), so a
 * real-host adapter cannot quietly weaken the three rules: the agent's boundary
 * is the commit, pushes are plain, and only the reviewed head is merged.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeliveryError,
  DeliveryUnsupportedError,
  parseBoardStateRecord,
  ProviderError,
  runDeliveryProviderContractSuite,
} from '@takumi/core';
import type { BoardRequestFn, DeliveryFixture, DeliveryRequest, GitRunner, PullRequestRef } from '@takumi/core';
import {
  createGitLabDeliveryProvider,
  createGitLabTransport,
  createGitRunner,
  GitLabDeliveryProvider,
  renderRunMarker as runMarker,
} from '../index.js';
import { FakeGitLabApi } from './fake-gitlab-api.js';
import { FakeGitRunner } from './fake-git-runner.js';

const PROJECT = 'group/project';
const API_BASE = 'https://gitlab.test/api/v4';
const REMOTE = 'origin';
const BRANCH = 'takumi/issue-7-abcdef12';
const BASE_BRANCH = 'main';
const BASE = 'a'.repeat(40);
const AHEAD = 'c'.repeat(40);
const ADVANCED = 'e'.repeat(40);
const MOVED = 'd'.repeat(40);

const fixture: DeliveryFixture = {
  worktree: '/tmp/takumi-gitlab-worktree',
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
  api: FakeGitLabApi;
  provider: GitLabDeliveryProvider;
}

/** A clean worktree on the task branch, one commit ahead of the frozen base. */
function harness(options: { head?: string; remoteBase?: string; mergeConflict?: boolean } = {}): Harness {
  const git = new FakeGitRunner({
    branch: BRANCH,
    head: options.head ?? AHEAD,
    frozenBase: BASE,
    remote: REMOTE,
    baseBranch: BASE_BRANCH,
    remoteBase: options.remoteBase ?? BASE,
    ...(options.mergeConflict === undefined ? {} : { mergeConflict: options.mergeConflict }),
  });
  const api = new FakeGitLabApi({
    project: PROJECT,
    apiBase: API_BASE,
    sourceBranch: BRANCH,
    // GitLab tracks the SOURCE BRANCH head — i.e. what the last push delivered.
    head: () => git.pushedHead() ?? git.currentHead(),
  });
  const provider = createGitLabDeliveryProvider({
    project: PROJECT,
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
  return { number, url: `https://gitlab.test/${PROJECT}/-/merge_requests/${number}`, headSha, baseSha: BASE_BRANCH };
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


/**
 * This provider OPENS merge requests, so its own tests may rely on the reference being there. The
 * port keeps `pr` optional — a bare remote has no review surface and must report none — which is
 * why the shared suite gates on `canOpenPullRequest` and this helper exists for the tests about
 * THIS provider.
 */
function prRefOf(out: { pr?: PullRequestRef }): PullRequestRef {
  if (out.pr === undefined) throw new Error('this delivery opens merge requests');
  return out.pr;
}

test('GitLabDeliveryProvider: shared delivery contract suite', async () => {
  const h = harness();
  const out = await runDeliveryProviderContractSuite(h.provider, {
    id: 'gitlab',
    fixture,
    // The three state hooks make every fail-closed branch reachable: a dirty
    // worktree, a head still equal to the frozen base, and a conflicting merge
    // request. `reset` restores a deliverable state between them.
    makeDirty: async () => {
      h.git.setDirty(true);
    },
    makeNoCommit: async () => {
      h.git.setHead(BASE);
    },
    makeUnmergeable: async () => {
      const iid = h.api.openMergeRequestIids()[0];
      assert.ok(iid !== undefined, 'the suite must have created a merge request by now');
      h.api.setMergeableStatus(iid, 'conflict');
    },
    reset: async () => {
      h.git.setDirty(false);
      h.git.setHead(h.git.pushedHead() ?? AHEAD);
      for (const iid of h.api.openMergeRequestIids()) h.api.setMergeableStatus(iid, 'mergeable');
    },
    inspect: async () => effects(h),
  });
  assert.equal(out.gate, 'delivery-contract');
  assert.equal(out.result, 'PASS');
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
    assert.equal(push.head, AHEAD, 'the push must carry the committed head');
  }
  assert.equal(h.api.createdCount(), 1, 'exactly one merge request may be created');
  assert.deepEqual(effects(h), { pushes: h.git.pushes().length, forcePushes: 0, prs: 1, merges: 1 });
});

// --- rule 1: the agent's boundary is the commit ----------------------------

test('GitLabDeliveryProvider: refuses a worktree that is not on the task branch', async () => {
  const h = harness();
  h.git.setBranch('some-other-branch');
  await assert.rejects(
    () => h.provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /not the task branch/.test(e.message),
  );
  assert.deepEqual(h.git.pushes(), [], 'nothing may be pushed from the wrong branch');
  assert.equal(h.api.createdCount(), 0);
});

test('GitLabDeliveryProvider: refuses a head that is not descended from the frozen base', async () => {
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

test('GitLabDeliveryProvider: a refused push is a precondition, and nothing is ever forced', async () => {
  const h = harness();
  h.git.setPushRefusal('! [rejected] takumi/issue-7-abcdef12 -> takumi/issue-7-abcdef12 (non-fast-forward)');
  await assert.rejects(
    () => h.provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /refused/.test(e.message),
  );
  assert.deepEqual(h.api.createdCount(), 0, 'a branch that never reached the host cannot have a merge request');
  assert.equal(h.git.forcePushes().length, 0);
  // The adapter must not reach for a force flag even to retry: no second push argv at all.
  assert.equal(h.git.argv().filter((args) => args[0] === 'push').length, 1);
});

// --- rule 2: plain push, plain base absorption -----------------------------

test('GitLabDeliveryProvider: the push argv is exactly `push <remote> <branch>`', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(out.push.mode, 'plain');
  assert.deepEqual(h.git.pushes().map((p) => p.argv), [['push', REMOTE, BRANCH]]);
  assert.equal(out.push.head, AHEAD);
  assert.equal(prRefOf(out).headSha, out.push.head);
  assert.equal(out.push.branch, BRANCH);
  assert.equal(out.created, true);
});

test('GitLabDeliveryProvider: an advanced base is absorbed with a plain merge of the remote base', async () => {
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
  const mergeCommit = h.git.currentHead();
  assert.notEqual(mergeCommit, AHEAD);
  assert.equal(out.push.mode, 'plain');
  assert.equal(out.push.head, mergeCommit);
  assert.equal(prRefOf(out).headSha, mergeCommit);
  assert.match(out.notes.join(' '), /absorbed the advanced base origin\/main with a plain merge/);
});

test('GitLabDeliveryProvider: a conflicting base absorption is aborted, not resolved', async () => {
  const h = harness({ remoteBase: ADVANCED, mergeConflict: true });
  await assert.rejects(
    () => h.provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /conflicted/.test(e.message),
  );
  assert.equal(h.git.mergeAborts(), 1, 'the half-done merge must be aborted');
  assert.deepEqual(h.git.pushes(), [], 'a conflicted worktree must never be pushed');
  assert.equal(h.api.createdCount(), 0);
});

// --- the merge request ------------------------------------------------------

test('GitLabDeliveryProvider: the body carries the run marker, the state record and the item reference', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(out.created, true);
  assert.equal(prRefOf(out).number, '1');
  assert.equal(prRefOf(out).url, `https://gitlab.test/${PROJECT}/-/merge_requests/1`);

  const create = h.api.requestsMatching('/merge_requests').find((req) => req.method === 'POST');
  assert.ok(create !== undefined, 'the merge request must be created with a POST');
  const body = create.body as Record<string, unknown>;
  const description = String(body['description']);

  assert.ok(description.includes(runMarker(fixture.runId)), 'the run marker must be in the description');
  assert.match(description, /Fixes #7/, 'GitLab needs its closing reference');
  assert.match(description, /Issue: 7/, 'the item id must also be stated in plain text');
  assert.ok(description.includes('Reviewed by a human.'), 'the caller body must be passed through');
  assert.equal(body['source_branch'], BRANCH);
  assert.equal(body['target_branch'], BASE_BRANCH);
  assert.equal(body['title'], 'Fix the thing');
  assert.ok(description.includes('Fix the thing'), 'the caller title is repeated in the description');

  // The marker is not a private format: core's own parser reads it back.
  const record = parseBoardStateRecord(description);
  assert.ok(record !== null, 'the description must carry a versioned state record');
  assert.equal(record.schema, 1);
  assert.equal(record.runId, fixture.runId);
  assert.equal(record.item, fixture.itemId);
  assert.equal(record.baseBranch, BASE_BRANCH);
});

test('GitLabDeliveryProvider: exactly one merge request, reused on every later delivery', async () => {
  const h = harness();
  const first = await h.provider.deliver(request(), { baseSha: BASE });
  const second = await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(second.created, false);
  assert.equal(prRefOf(second).number, prRefOf(first).number);
  assert.ok(second.notes.some((n) => n.includes(`reused the open merge request !${prRefOf(first).number}`)));
  assert.equal(h.api.requestsMatching('/merge_requests').filter((req) => req.method === 'POST').length, 1);
  assert.equal(h.api.createdCount(), 1);

  const lookups = h.api.calls().filter((call) => call.includes('source_branch='));
  assert.equal(lookups.length, 2, 'each delivery looks the open merge request up first');
  assert.ok(lookups[0]?.includes('state=opened'), 'only OPEN merge requests may be reused');
  assert.ok(lookups[0]?.includes('per_page=100'));
  assert.ok(lookups[0]?.includes(`source_branch=${encodeURIComponent(BRANCH)}`));
});

test('GitLabDeliveryProvider: a frozen-base delivery never merges the base', async () => {
  const h = harness();
  await h.provider.deliver(request(), { baseSha: BASE });
  assert.equal(h.git.baseMerges(), 0, 'the base has not advanced: there is nothing to absorb');
  assert.equal(h.git.fetchCount(), 1, 'the remote base is still fetched, so the test is about the real tip');
});

// --- status ----------------------------------------------------------------

test('GitLabDeliveryProvider: status maps the state, the head and the base branch', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  assert.deepEqual(await h.provider.status(prRefOf(out)), {
    state: 'open',
    mergeable: true,
    headSha: AHEAD,
    baseSha: BASE_BRANCH,
  });
});

test('GitLabDeliveryProvider: mergeability is tri-state and an unknown is never a yes', async () => {
  const h = harness();
  const iid = h.api.seedMergeRequest({ sha: AHEAD, detailedMergeStatus: 'mergeable' });
  const ref = refOf(String(iid));

  assert.equal((await h.provider.status(ref)).mergeable, true, 'mergeable → true');
  h.api.setMergeableStatus(iid, 'can_be_merged');
  assert.equal((await h.provider.status(ref)).mergeable, true, "GitLab's older 'can_be_merged' → true");
  h.api.setMergeableStatus(iid, 'conflict');
  assert.equal((await h.provider.status(ref)).mergeable, false, 'conflict → false');
  h.api.setMergeableStatus(iid, 'not_mergeable');
  assert.equal((await h.provider.status(ref)).mergeable, false, 'not_mergeable → false');
  h.api.setMergeableStatus(iid, 'checking');
  assert.equal((await h.provider.status(ref)).mergeable, null, 'checking → unknown, NEVER a yes');
  h.api.setMergeableStatus(iid, 'ci_must_pass');
  assert.equal((await h.provider.status(ref)).mergeable, null, 'a policy block the adapter does not model → unknown');
  h.api.setMergeableStatus(iid, null);
  assert.equal((await h.provider.status(ref)).mergeable, null, 'an absent field → unknown');
});

test('GitLabDeliveryProvider: status maps merged/closed and refuses an unknown state', async () => {
  const h = harness();
  const iid = h.api.seedMergeRequest({ sha: AHEAD, state: 'merged' });
  const ref = refOf(String(iid));
  assert.equal((await h.provider.status(ref)).state, 'merged');
  h.api.setState(iid, 'closed');
  assert.equal((await h.provider.status(ref)).state, 'closed');
  h.api.setState(iid, 'opened');
  assert.equal((await h.provider.status(ref)).state, 'open');
  h.api.setState(iid, 'locked');
  assert.equal((await h.provider.status(ref)).state, 'open', 'a locked discussion is still an open merge request');
  h.api.setState(iid, 'something-new');
  await assert.rejects(
    () => h.provider.status(ref),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /unknown state/.test(e.message),
  );
});

test('GitLabDeliveryProvider: an unknown merge request is not_found', async () => {
  const h = harness();
  await assert.rejects(
    () => h.provider.status(refOf('99')),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'not_found',
  );
});

// --- checks ----------------------------------------------------------------

test('GitLabDeliveryProvider: pipeline status → conclusion, and pending is never success', async () => {
  const h = harness();
  const iid = h.api.seedMergeRequest({
    sha: AHEAD,
    pipelines: [
      { id: 1, name: 'build', status: 'success' },
      { id: 2, name: 'tests', status: 'failed' },
      { id: 3, name: 'deploy', status: 'canceled' },
      { id: 4, name: 'e2e', status: 'running' },
      { id: 5, name: 'lint', status: 'pending' },
      { id: 6, name: 'scheduled', status: 'created' },
      { id: 7, name: 'docs', status: 'skipped' },
      { id: 8, name: 'release', status: 'manual' },
      { id: 9, name: 'mystery', status: 'something-new' },
    ],
  });
  const checks = await h.provider.checks(refOf(String(iid)));
  assert.deepEqual(
    checks.map((c) => [c.name, c.conclusion]),
    [
      ['build', 'success'],
      ['tests', 'failure'],
      ['deploy', 'failure'],
      ['e2e', 'pending'],
      ['lint', 'pending'],
      ['scheduled', 'pending'],
      ['docs', 'neutral'],
      ['release', 'neutral'],
      ['mystery', 'unknown'],
    ],
  );
  // The specific trap: a still-running pipeline must not read as green.
  assert.equal(checks.find((c) => c.name === 'e2e')?.conclusion, 'pending');
  assert.equal(checks.some((c) => c.name !== 'build' && c.conclusion === 'success'), false);
  assert.ok(h.api.calls().some((call) => call.endsWith(`/merge_requests/${iid}/pipelines`)));
});

test('GitLabDeliveryProvider: with no pipelines, the head commit statuses are read instead', async () => {
  const h = harness();
  const iid = h.api.seedMergeRequest({
    sha: AHEAD,
    pipelines: [],
    commitStatuses: [
      { name: 'ci/external', status: 'success' },
      { name: 'ci/other', status: 'waiting' },
    ],
  });
  const checks = await h.provider.checks(refOf(String(iid)));
  assert.deepEqual(
    checks.map((c) => [c.name, c.conclusion]),
    [
      ['ci/external', 'success'],
      // `waiting` is not a status the adapter models → unknown, never success.
      ['ci/other', 'unknown'],
    ],
  );
  assert.ok(
    h.api.calls().some((call) => call.includes(`/commits/${AHEAD}/statuses`)),
    'the fallback must read the HEAD commit statuses',
  );
});

test('GitLabDeliveryProvider: a pipeline GitLab does not name still becomes a check', async () => {
  const h = harness();
  // GitLab documents this endpoint as `{id, sha, ref, status}` — no name, and no
  // web_url in the documented shape. A nameless pipeline must still be a check.
  const iid = h.api.seedMergeRequest({
    sha: AHEAD,
    pipelines: [{ id: 77, status: 'success' }, { id: 78, name: 'named', status: 'failed', webUrl: 'https://gitlab.test/p/78' }],
  });
  const checks = await h.provider.checks(refOf(String(iid)));
  assert.deepEqual(checks, [
    { name: 'pipeline #77', conclusion: 'success' },
    { name: 'named', conclusion: 'failure', url: 'https://gitlab.test/p/78' },
  ]);
});

test("GitLabDeliveryProvider: reads the payload GitLab actually returns (merge_status / has_conflicts)", async () => {
  const git = new FakeGitRunner({ branch: BRANCH, head: AHEAD, frozenBase: BASE });
  // A hand-written payload in GitLab's documented shape: `merge_status` (the
  // field the API sends; `detailed_merge_status` is the modern replacement) and
  // `has_conflicts`. The delivery ADR's wording is `mergeable_status`, which is
  // also accepted — all three are read, newest first.
  function transportFor(payload: Record<string, unknown>): BoardRequestFn {
    return async (req) => {
      assert.ok(req.url.startsWith(`${API_BASE}/projects/group%2Fproject/merge_requests/`));
      return { status: 200, body: JSON.stringify(payload) };
    };
  }
  const shape = (extra: Record<string, unknown>): Record<string, unknown> => ({
    iid: 4,
    state: 'opened',
    sha: AHEAD,
    target_branch: BASE_BRANCH,
    web_url: 'https://gitlab.test/group/project/-/merge_requests/4',
    ...extra,
  });

  const merged = createGitLabDeliveryProvider({
    project: PROJECT,
    apiBase: API_BASE,
    git,
    request: transportFor(shape({ merge_status: 'can_be_merged' })),
  });
  assert.deepEqual(await merged.status(refOf('4')), {
    state: 'open',
    mergeable: true,
    headSha: AHEAD,
    baseSha: BASE_BRANCH,
  });

  const conflicting = createGitLabDeliveryProvider({
    project: PROJECT,
    apiBase: API_BASE,
    git,
    request: transportFor(shape({ has_conflicts: true })),
  });
  assert.equal((await conflicting.status(refOf('4'))).mergeable, false);

  // `detailed_merge_status` is authoritative when it is present.
  const detailed = createGitLabDeliveryProvider({
    project: PROJECT,
    apiBase: API_BASE,
    git,
    request: transportFor(shape({ detailed_merge_status: 'conflict', merge_status: 'can_be_merged' })),
  });
  assert.equal((await detailed.status(refOf('4'))).mergeable, false, 'the current field wins over the deprecated one');
});

// --- rule 3: merge exactly the reviewed head -------------------------------

test('GitLabDeliveryProvider: a moved head refuses the merge and names both shas', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  const reviewed = prRefOf(out).headSha;
  h.api.setSha(Number.parseInt(prRefOf(out).number, 10), MOVED);

  await assert.rejects(
    () => h.provider.merge(prRefOf(out), { expectedHeadSha: reviewed }),
    (e: unknown) =>
      e instanceof DeliveryError && e.kind === 'precondition' && e.message.includes(reviewed) && e.message.includes(MOVED),
  );
  assert.equal(h.api.mergedCount(), 0, 'a stale head must not merge anything');
  assert.equal(h.api.mergePutBodies().length, 0, 'no merge call may be sent at all');
  assert.equal((await h.provider.status(prRefOf(out))).state, 'open');
});

test('GitLabDeliveryProvider: merge sends the reviewed sha to GitLab, so GitLab refuses a moved head too', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  const merged = await h.provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha, method: 'squash' });
  assert.deepEqual(merged, { merged: true, method: 'squash', headSha: prRefOf(out).headSha, url: prRefOf(out).url });

  const bodies = h.api.mergePutBodies();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.['sha'], prRefOf(out).headSha, 'the sha parameter IS the server-side anti-swap guard');
  assert.equal(bodies[0]?.['should_remove_source_branch'], true);
  assert.equal(bodies[0]?.['squash'], true);
  assert.ok(
    h.api.calls().some((call) => call.endsWith(`/merge_requests/${prRefOf(out).number}/merge`)),
    'the merge call carries the merge-request iid',
  );
  assert.equal((await h.provider.status(prRefOf(out))).state, 'merged');

  // A plain merge asks for no squash.
  const plain = harness();
  const other = await plain.provider.deliver(request(), { baseSha: BASE });
  await plain.provider.merge(prRefOf(other), { expectedHeadSha: prRefOf(other).headSha });
  assert.equal(plain.api.mergePutBodies()[0]?.['squash'], false);
});

test('GitLabDeliveryProvider: 405/406/409 from GitLab are preconditions and never a success', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  h.api.failWhen((req) => req.method === 'PUT' && req.url.endsWith('/merge'), 405, '{"message":"405 Method Not Allowed"}');
  await assert.rejects(
    () => h.provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /HTTP 405/.test(e.message),
  );
  assert.equal(h.api.mergedCount(), 0, 'a refused merge is not a merge');
  assert.equal((await h.provider.status(prRefOf(out))).state, 'open');

  for (const status of [406, 409]) {
    const fresh = harness();
    const delivered = await fresh.provider.deliver(request(), { baseSha: BASE });
    fresh.api.failWhen((req) => req.method === 'PUT' && req.url.endsWith('/merge'), status);
    await assert.rejects(
      () => fresh.provider.merge(prRefOf(delivered), { expectedHeadSha: prRefOf(delivered).headSha }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && new RegExp(`HTTP ${status}`).test(e.message),
    );
    assert.equal(fresh.api.mergedCount(), 0);
  }
});

test('GitLabDeliveryProvider: an unmergeable merge request is not merged, and is not even asked', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  h.api.setMergeableStatus(Number.parseInt(prRefOf(out).number, 10), 'conflict');
  await assert.rejects(
    () => h.provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /not mergeable/.test(e.message),
  );
  assert.equal(h.api.mergedCount(), 0);
  assert.equal(h.api.mergePutBodies().length, 0);
});

test('GitLabDeliveryProvider: a 200 that did not merge the change is not reported as a merge', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  // GitLab answers 2xx while a merge is still queued (e.g. behind a pipeline).
  h.api.setMergePutsState(Number.parseInt(prRefOf(out).number, 10), 'opened');
  await assert.rejects(
    () => h.provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /did not happen/.test(e.message),
  );
  assert.equal(h.api.mergedCount(), 0);
});

test('GitLabDeliveryProvider: a closed merge request is not merged', async () => {
  const h = harness();
  const out = await h.provider.deliver(request(), { baseSha: BASE });
  h.api.setState(Number.parseInt(prRefOf(out).number, 10), 'closed');
  await assert.rejects(
    () => h.provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /not open/.test(e.message),
  );
  assert.equal(h.api.mergedCount(), 0);
});

// --- capabilities ----------------------------------------------------------

test('GitLabDeliveryProvider: capabilities are exactly the GitLab host capabilities', () => {
  const provider = harness().provider;
  assert.deepEqual(provider.capabilities(), {
    canPushBranch: true,
    canOpenPullRequest: true,
    canRunChecks: true,
    canMerge: true,
  });
  assert.equal(provider.metadata().id, 'gitlab');
  assert.equal(provider.metadata().name, 'GitLab Delivery');
  assert.ok(provider.metadata().version.length > 0);
});

test('GitLabDeliveryProvider: merge is gated before ANY request when canMerge is false', async () => {
  const git = new FakeGitRunner({ branch: BRANCH, head: AHEAD, frozenBase: BASE });
  const api = new FakeGitLabApi({ project: PROJECT, apiBase: API_BASE, sourceBranch: BRANCH, head: () => AHEAD });
  const provider = createGitLabDeliveryProvider({
    project: PROJECT,
    apiBase: API_BASE,
    request: api.request,
    git,
    capabilities: { canMerge: false },
  });
  assert.equal(provider.capabilities().canMerge, false);
  await assert.rejects(
    () => provider.merge(refOf('1'), { expectedHeadSha: AHEAD }),
    (e: unknown) => e instanceof DeliveryUnsupportedError && e.capability === 'canMerge' && e.kind === 'unsupported',
  );
  assert.deepEqual(api.requests(), [], 'the capability gate must fire before ANY request');
});

test('GitLabDeliveryProvider: pushing without a merge request to open is unsupported', async () => {
  const git = new FakeGitRunner({ branch: BRANCH, head: AHEAD, frozenBase: BASE });
  const api = new FakeGitLabApi({
    project: PROJECT,
    apiBase: API_BASE,
    sourceBranch: BRANCH,
    head: () => git.pushedHead() ?? AHEAD,
  });
  const provider = createGitLabDeliveryProvider({
    project: PROJECT,
    apiBase: API_BASE,
    request: api.request,
    git,
    capabilities: { canOpenPullRequest: false, canMerge: false },
  });
  await assert.rejects(
    () => provider.deliver(request(), { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryUnsupportedError && e.capability === 'canOpenPullRequest',
  );
  assert.equal(git.pushes().length, 1, 'the branch is pushed even when no merge request can be opened');
  assert.equal(api.createdCount(), 0);
});

// --- the transport seam: credentials and headers ---------------------------

test('GitLabDeliveryProvider: no token and no injected request fails closed with an auth error', async () => {
  const saved = process.env['GITLAB_TOKEN'];
  delete process.env['GITLAB_TOKEN'];
  try {
    const git = new FakeGitRunner({ branch: BRANCH, head: AHEAD, frozenBase: BASE });
    const provider = createGitLabDeliveryProvider({ project: PROJECT, git });
    await assert.rejects(
      () => provider.status(refOf('1')),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'auth' && /no request transport configured/.test(e.message),
    );
  } finally {
    if (saved === undefined) delete process.env['GITLAB_TOKEN'];
    else process.env['GITLAB_TOKEN'] = saved;
  }
});

test('GitLabDeliveryProvider: the default transport sends PRIVATE-TOKEN from the option and from the environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-gitlab-curl-'));
  const configPath = join(dir, 'request.cfg');
  const stub = join(dir, 'curl-stub');
  // The stub stands in for `curl`: it captures the config curl would have read on
  // stdin (`-K -`) and answers a body plus a status line, so the header
  // construction is proven with NO network and NO credentials.
  writeFileSync(stub, ['#!/bin/sh', `cat > ${JSON.stringify(configPath)}`, `printf '{"ok":true}\\n200'`, ''].join('\n'));
  chmodSync(stub, 0o755);
  const saved = process.env['GITLAB_TOKEN'];
  try {
    const explicit = createGitLabTransport({ token: 'explicit-token', curlBinary: stub });
    const first = await explicit({ method: 'GET', url: `${API_BASE}/projects/group%2Fproject/merge_requests/1` });
    assert.equal(first.status, 200);
    assert.deepEqual(JSON.parse(first.body), { ok: true });
    const firstConfig = readFileSync(configPath, 'utf8');
    assert.ok(firstConfig.includes('header = "PRIVATE-TOKEN: explicit-token"'), firstConfig);
    assert.ok(firstConfig.includes(`url = "${API_BASE}/projects/group%2Fproject/merge_requests/1"`), firstConfig);

    process.env['GITLAB_TOKEN'] = 'env-token';
    const fromEnv = createGitLabTransport({ curlBinary: stub });
    await fromEnv({ method: 'GET', url: `${API_BASE}/user` });
    assert.ok(readFileSync(configPath, 'utf8').includes('header = "PRIVATE-TOKEN: env-token"'), 'the token falls back to GITLAB_TOKEN');
  } finally {
    if (saved === undefined) delete process.env['GITLAB_TOKEN'];
    else process.env['GITLAB_TOKEN'] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the git seam -----------------------------------------------------------

// The git seam itself is CORE's since ADR-007 (one definition, so the GitHub and
// GitLab adapters cannot drift): a failing command is an exit code, while a git
// that cannot be run at all is a transport failure. What matters for THIS adapter
// is that the second case reaches the caller as a classified DeliveryError.

test('the git seam: a failing command is an exit code, a missing git is a transport failure', async () => {
  // `/bin/sh` stands in for git: it can write both streams and exit non-zero,
  // which is exactly the runner's contract — an ordinary failure is an exit code.
  const runner = createGitRunner({ gitBinary: '/bin/sh' });
  assert.deepEqual(await runner.run(['-c', 'printf hello; printf oops >&2; exit 3']), {
    stdout: 'hello',
    stderr: 'oops',
    exitCode: 3,
  });

  const missing = createGitRunner({ gitBinary: join(tmpdir(), 'takumi-no-such-git-binary') });
  await assert.rejects(
    () => missing.run(['rev-parse', 'HEAD']),
    (e: unknown) => e instanceof ProviderError && e.kind === 'transport' && /could not be started/.test(e.message),
  );
});

test('the git seam: a command that overflows the output cap is stopped instead of buffered', async () => {
  const runner = createGitRunner({ gitBinary: '/bin/sh', maxOutputBytes: 1024 });
  await assert.rejects(
    () => runner.run(['-c', 'i=0; while [ $i -lt 3000 ]; do printf x; i=$((i+1)); done']),
    (e: unknown) => e instanceof ProviderError && e.kind === 'transport' && /more than 1024 bytes/.test(e.message),
  );
});

test('deliver: a git that cannot be run at all surfaces as a classified DeliveryError', async () => {
  const api = new FakeGitLabApi({ project: PROJECT, apiBase: API_BASE, sourceBranch: BRANCH, head: () => AHEAD });
  const brokenGit: GitRunner = {
    run: async () => {
      throw new ProviderError('transport', 'git could not be started');
    },
  };
  const provider = createGitLabDeliveryProvider({ project: PROJECT, request: api.request, git: brokenGit });
  await assert.rejects(
    () =>
      provider.deliver(
        { worktree: '/tmp/takumi-no-git', branch: BRANCH, baseBranch: 'main', itemId: '7', runId: 'abcdef12' },
        { baseSha: BASE },
      ),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'transport' && /could not be started/.test(e.message),
  );
});

// --- construction -----------------------------------------------------------

test('GitLabDeliveryProvider: the project path is URL-encoded, the api base is configurable and the remote defaults', async () => {
  const git = new FakeGitRunner({ branch: BRANCH, head: AHEAD, frozenBase: BASE });
  const api = new FakeGitLabApi({
    project: PROJECT,
    apiBase: 'https://gitlab.internal/api/v4',
    sourceBranch: BRANCH,
    head: () => git.pushedHead() ?? AHEAD,
  });
  const provider = createGitLabDeliveryProvider({
    project: '/group/project/',
    apiBase: 'https://gitlab.internal/api/v4/',
    request: api.request,
    git,
  });
  const out = await provider.deliver(request({ remote: undefined }), { baseSha: BASE });
  assert.equal(out.created, true);
  assert.ok(api.calls().length > 0);
  for (const call of api.calls()) {
    assert.ok(call.includes('/projects/group%2Fproject/'), `the project must be one encoded segment: ${call}`);
    assert.ok(call.includes('https://gitlab.internal/api/v4/'), `the api base must be configurable: ${call}`);
  }
  // With no remote on the request the provider default (`origin`) is used.
  assert.deepEqual(git.pushes().map((p) => p.argv), [['push', 'origin', BRANCH]]);
});

test('GitLabDeliveryProvider: a blank project is a construction error', () => {
  assert.throws(() => createGitLabDeliveryProvider({ project: '  ' }), /project\D+is required/);
  assert.throws(() => createGitLabDeliveryProvider({ project: PROJECT, apiBase: '  ' }), /must not be empty/);
});

test('GitLabDeliveryProvider: a commit with no statuses is NOT an unknown commit', async () => {
  // The real behaviour, measured on gitlab.com: no pipelines, and the head commit exists but
  // has no statuses, so the statuses endpoint answers 404. Reading that as "not_found" blocked
  // a real delivery and left a mergeable merge request unmerged.
  const h = harness();
  const iid = h.api.seedMergeRequest({ sha: AHEAD, pipelines: [] });
  const checks = await h.provider.checks(refOf(String(iid)));
  assert.deepEqual(checks, [], 'no statuses published is "no checks reported", not a failure');
  assert.ok(
    h.api.calls().some((call) => call.includes(`/repository/commits/${AHEAD}`)),
    'the ambiguity must be resolved by asking the host about the commit itself',
  );
});

test('GitLabDeliveryProvider: a 404 for a commit the host does NOT know stays a not_found', async () => {
  // The other half of the same distinction: a commit the host cannot see is a real problem and
  // must never be swallowed as "a quiet project".
  const h = harness();
  const iid = h.api.seedMergeRequest({ sha: 'unknown'.padEnd(40, '0'), pipelines: [] });
  await assert.rejects(
    () => h.provider.checks(refOf(String(iid))),
    (e: unknown) => {
      assert.ok(e instanceof DeliveryError);
      assert.equal(e.kind, 'not_found');
      return true;
    },
  );
});
