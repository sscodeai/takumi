import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryError, DeliveryUnsupportedError, runDeliveryProviderContractSuite } from '@takumi/core';
import type { DeliveryFixture } from '@takumi/core';
import { FakeDeliveryProvider } from '../index.js';
import type { PullRequestRef } from '@takumi/core';

// FakeDeliveryProvider runs the SHARED Delivery Contract Suite (ADR-007), the
// same suite the GitHub/GitLab delivery adapters must pass.

const BASE = 'a'.repeat(40);
const AHEAD = `${'a'.repeat(12)}c0mmit000000`;

const fixture: DeliveryFixture = {
  worktree: '/tmp/takumi-fake-worktree',
  branch: 'takumi/issue-7-abcdef12',
  baseBranch: 'main',
  remote: 'origin',
  itemId: '7',
  runId: 'abcdef12',
  baseSha: BASE,
  title: 'Fix the thing',
};

function makeProvider(overrides: Partial<ConstructorParameters<typeof FakeDeliveryProvider>[0]> = {}): FakeDeliveryProvider {
  return new FakeDeliveryProvider({ baseSha: BASE, headSha: AHEAD, ...overrides });
}


/**
 * The fake delivery OPENS pull requests, so its own tests may rely on the reference being there —
 * every other delivery keeps `pr` optional, which is the point of the port change this file was
 * updated for (a bare remote has no review surface and reports none).
 */
function prRefOf(out: { pr?: PullRequestRef }): PullRequestRef {
  if (out.pr === undefined) throw new Error('the fake delivery opens pull requests');
  return out.pr;
}

test('FakeDeliveryProvider: shared delivery contract suite', async () => {
  const provider = makeProvider();
  const out = await runDeliveryProviderContractSuite(provider, {
    id: 'fake',
    fixture,
    // The three state hooks make every fail-closed branch reachable, and the
    // reset restores a deliverable state between them.
    makeDirty: async (p) => (p as FakeDeliveryProvider).setDirty(true),
    makeNoCommit: async (p) => (p as FakeDeliveryProvider).setHead(BASE),
    makeUnmergeable: async (p) => (p as FakeDeliveryProvider).setMergeable(false),
    reset: async (p) => {
      const fake = p as FakeDeliveryProvider;
      fake.setDirty(false);
      fake.setHead(AHEAD);
      fake.setMergeable(true);
    },
    inspect: async (p) => (p as FakeDeliveryProvider).snapshotEffects(),
  });
  assert.equal(out.gate, 'delivery-contract');
  assert.equal(out.result, 'PASS');
  assert.ok(out.notes.some((n) => n.startsWith('dirtyWorktree: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('mergeGuard: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('merge: PASS')));
});

test('FakeDeliveryProvider: a dirty worktree is refused before anything is pushed', async () => {
  const provider = makeProvider({ dirty: true });
  await assert.rejects(
    () => provider.deliver({ worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' }, { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /uncommitted changes/.test(e.message),
  );
  assert.deepEqual(provider.snapshotEffects(), { pushes: 0, forcePushes: 0, prs: 0, merges: 0, baseMerges: 0 });
});

test('FakeDeliveryProvider: one pull request per delivery, reused on the second call', async () => {
  const provider = makeProvider();
  const req = { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' };
  const first = await provider.deliver(req, { baseSha: BASE });
  const second = await provider.deliver(req, { baseSha: BASE });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(prRefOf(second).number, prRefOf(first).number);
  assert.deepEqual(provider.snapshotEffects(), { pushes: 2, forcePushes: 0, prs: 1, merges: 0, baseMerges: 0 });
});

test('FakeDeliveryProvider: an advanced base is absorbed with a plain merge, never a force', async () => {
  const provider = makeProvider();
  provider.setRemoteBase(`${'a'.repeat(12)}newbase00000`);
  const out = await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  assert.equal(out.push.mode, 'plain');
  assert.match(out.notes.join(' '), /absorbed advanced base/);
  assert.equal(provider.snapshotEffects().baseMerges, 1);
});

test('FakeDeliveryProvider: mergeability unknown is not a yes', async () => {
  const provider = makeProvider({ mergeable: null });
  const out = await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  await assert.rejects(
    () => provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /not known yet/.test(e.message),
  );
});

test('FakeDeliveryProvider: a moved head refuses the merge and merges nothing', async () => {
  const provider = makeProvider();
  const out = await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  provider.setHead(`${'a'.repeat(12)}sneaky000000`);
  await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  await assert.rejects(
    () => provider.merge(prRefOf(out), { expectedHeadSha: prRefOf(out).headSha }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /head moved/.test(e.message),
  );
  assert.equal(provider.snapshotEffects().merges, 0);
});

test('FakeDeliveryProvider: capability gating is fail-closed', async () => {
  const provider = makeProvider({ capabilities: { canMerge: false, canOpenPullRequest: false } });
  await assert.rejects(
    () => provider.deliver({ worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' }, { baseSha: BASE }),
    DeliveryUnsupportedError,
  );
  // A provider that cannot open a pull request must still be able to push.
  assert.equal(provider.capabilities().canPushBranch, true);
  const pushOnly = makeProvider({ capabilities: { canOpenPullRequest: false } });
  await assert.rejects(
    () => pushOnly.deliver({ worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' }, { baseSha: BASE }),
    (e: unknown) => e instanceof DeliveryUnsupportedError && e.capability === 'canOpenPullRequest',
  );
});

test('FakeDeliveryProvider: checks are reported verbatim, pending is never success', async () => {
  const provider = makeProvider({
    checks: [
      { name: 'build', conclusion: 'success' },
      { name: 'tests', conclusion: 'pending' },
      { name: 'lint', conclusion: 'neutral' },
    ],
  });
  const out = await provider.deliver(
    { worktree: fixture.worktree, branch: fixture.branch, baseBranch: fixture.baseBranch, itemId: '7', runId: 'abcdef12' },
    { baseSha: BASE },
  );
  const checks = await provider.checks(prRefOf(out));
  assert.deepEqual(checks.map((c) => c.conclusion), ['success', 'pending', 'neutral']);
  assert.equal(checks.some((c) => c.name === 'tests' && c.conclusion === 'success'), false);
});

test('FakeDeliveryProvider: an unknown pull request is not_found', async () => {
  const provider = makeProvider();
  await assert.rejects(
    () => provider.status({ number: '99', url: 'u', headSha: 'x', baseSha: 'main' }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'not_found',
  );
});
