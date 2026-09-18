/**
 * GitLabBoardProvider — proof against the shared Task-Board Contract Suite and
 * against the exact GitLab API v4 request shapes.
 *
 * EVERY test in this file runs with ZERO credentials and ZERO network: the HTTP
 * seam is injected (`FakeGitLab`, an in-process double of the endpoints the
 * adapter uses), and the only process that ever leaves the sandbox is curl in the
 * ONE loopback test that proves the default transport carries the token header.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BoardError,
  BoardStateError,
  BoardStateRecordError,
  BoardUnsupportedError,
  BOARD_WORK_ITEM_STATES,
  parseBoardStateRecord,
  renderBoardStateRecord,
  runTaskBoardProviderContractSuite,
  validateBoardCapabilities,
} from '@takumi/core';
import type {
  BoardCapabilities,
  BoardCommentRef,
  BoardRequestFn,
  BoardStateRecord,
  BoardWorkItem,
} from '@takumi/core';
import { GitLabBoardProvider, createGitLabBoardProvider, createGitLabTransport } from '../index.js';
import type { GitLabBoardOptions } from '../index.js';
import { FakeGitLab } from './fake-gitlab.js';
import type { FakeGitLabIssueSeed } from './fake-gitlab.js';

const API = 'https://gitlab.test/api/v4';
const PROJECT = 'group/project';
/** The username GitLab attributes a token's writes to — the only trusted one. */
const TRUSTED = 'takumi-bot';

const PROJECT_ID = encodeURIComponent(PROJECT);
const ISSUES = `${API}/projects/${PROJECT_ID}/issues`;

/** A provider wired to the in-process board, with the trust allowlist configured. */
function board(
  seed: FakeGitLabIssueSeed,
  options: Partial<GitLabBoardOptions> = {},
): { fake: FakeGitLab; provider: GitLabBoardProvider } {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue(seed);
  const provider = createGitLabBoardProvider({
    project: PROJECT,
    apiBase: API,
    trustedAuthors: [TRUSTED],
    request: fake.request,
    ...options,
  });
  return { fake, provider };
}

/** The work item's delivery state, as the port reports it. */
async function stateOf(provider: GitLabBoardProvider, id: string): Promise<string> {
  return (await provider.getWork(id)).state;
}

/** The state record block inside a note-write body, asserting one is there. */
function recordIn(body: unknown): BoardStateRecord {
  assert.ok(body !== null && typeof body === 'object', `expected a JSON body, got ${String(body)}`);
  const text = (body as { body?: unknown }).body;
  assert.equal(typeof text, 'string', 'a note write must carry a string body');
  const record = parseBoardStateRecord(text as string);
  assert.ok(record !== null, 'expected a versioned state block');
  return record;
}

// ---------------------------------------------------------------------------

test('GitLabBoardProvider: passes the shared task-board contract suite (injected transport, zero network, zero credentials)', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue({
    iid: 1,
    title: 'Ship the GitLab adapter',
    description: 'Issue body becomes BoardWorkItem.body',
    labels: ['takumi-ready', 'team-a'],
    assignees: ['moon'],
  });
  // No token anywhere: the transport is injected, so nothing authenticates and
  // nothing leaves the process.
  const provider = createGitLabBoardProvider({
    project: PROJECT,
    apiBase: API,
    request: fake.request,
    trustedAuthors: [TRUSTED],
  });

  const out = await runTaskBoardProviderContractSuite(provider, {
    id: 'gitlab',
    itemId: '1',
    writeUntrustedRecord: async (_provider, record) => {
      // The adapter cannot author as a stranger (GitLab derives a note's author
      // from the token), so a foreign write is injected where a drive-by
      // comment actually lands: straight into the board's note store. That is
      // what makes the trust boundary real rather than assumed.
      fake.appendNote(1, renderBoardStateRecord(record), 'drive-by');
    },
  });

  assert.equal(out.gate, 'task-board-contract');
  // PASS, not PASS_WITH_NOT_RUN: every capability-gated check really ran — all
  // six states are declared, comments and in-place editing are declared,
  // machine-readable state is declared, and `trustedAuthors` is configured so
  // the untrusted-record injection has a boundary to prove.
  assert.equal(out.result, 'PASS', out.notes.join('\n'));
  // The whole run went through the injected seam.
  assert.ok(fake.requests().length > 0, 'the suite must have exercised the adapter');
  assert.ok(
    fake.calls().every((call) => call.includes(API)),
    'no request may address anything but the injected apiBase',
  );
});

test('GitLabBoardProvider: the exact request shape of every port method', async () => {
  const { fake, provider } = board({ iid: 7, title: 'Work', description: 'Detail', labels: ['takumi-ready'], assignees: ['moon'] });
  const issue = `${ISSUES}/7`;
  const notes = `${issue}/notes?per_page=100&sort=asc`;

  // --- listWork: opened issues, one page, project id URL-encoded ---
  const listed = await provider.listWork();
  assert.deepEqual(fake.calls(), [`GET ${ISSUES}?state=opened&per_page=100`]);
  assert.deepEqual(listed.map((item) => item.id), ['7']);
  const firstItem = listed[0];
  assert.ok(firstItem !== undefined, 'the seeded issue must be listed');
  const { raw: _raw, ...listedItem } = firstItem;
  assert.deepEqual(listedItem, {
    id: '7',
    title: 'Work',
    body: 'Detail',
    url: `https://gitlab.test/${PROJECT}/-/issues/7`,
    state: 'ready',
    labels: ['takumi-ready'],
    assignees: ['moon'],
    // The double's clock is deterministic (origin + 1s per mutation); the seed is tick 1.
    updatedAt: '2026-01-01T00:00:01.000Z',
  });
  assert.equal(typeof firstItem.raw === 'object' && firstItem.raw !== null, true, 'the raw payload rides along');

  fake.clear();
  await provider.listWork({ labels: ['takumi-ready'], limit: 5 });
  assert.deepEqual(fake.calls(), [`GET ${ISSUES}?state=opened&per_page=100&labels=takumi-ready`]);

  // --- getWork: one issue, and an unknown iid is GitLab's 404 ---
  fake.clear();
  assert.equal(await stateOf(provider, '7'), 'ready');
  assert.deepEqual(fake.calls(), [`GET ${issue}`]);

  fake.clear();
  await assert.rejects(
    () => provider.getWork('takumi-contract-unknown-item'),
    (e: unknown) => e instanceof BoardError && e.kind === 'not_found',
  );
  assert.deepEqual(fake.calls(), [`GET ${ISSUES}/takumi-contract-unknown-item`]);

  // --- claim: read, decide, ONE label write, record, then RE-READ ---
  fake.clear();
  const claim = await provider.claim('7', 'c0ffee01');
  assert.equal(claim.claimed, true);
  assert.deepEqual(fake.calls(), [
    `GET ${issue}`,
    `GET ${notes}`,
    `PUT ${issue}`,
    `GET ${notes}`,
    `POST ${issue}/notes`,
    `GET ${issue}`,
    `GET ${notes}`,
  ]);
  // Comma-separated STRINGS, never arrays: GitLab 400s on an array.
  assert.deepEqual(fake.bodies()[2], { add_labels: 'takumi-claimed', remove_labels: 'takumi-ready' });
  const claimRecord = recordIn(fake.bodies()[4]);
  assert.equal(claimRecord.runId, 'c0ffee01');
  assert.equal(claimRecord.item, '7');
  assert.equal(claimRecord.schema, 1);
  assert.match(fake.calls()[4] ?? '', /^POST /, 'the first record for a run is a new note');

  // --- transition: read, assert the table, swap the state label, update the record ---
  fake.clear();
  await provider.transition('7', 'pr_open', { runId: 'c0ffee01', note: 'opened MR !3' });
  assert.deepEqual(fake.calls(), [`GET ${issue}`, `GET ${notes}`, `PUT ${issue}`, `GET ${notes}`, `PUT ${issue}/notes/1`]);
  assert.deepEqual(fake.bodies()[2], { add_labels: 'takumi-pr-open', remove_labels: 'takumi-claimed' });
  assert.deepEqual(Object.keys(fake.bodies()[4] as object), ['body'], 'a record write sends nothing but the block');
  const transitioned = recordIn(fake.bodies()[4]);
  assert.equal(transitioned.runId, 'c0ffee01');
  assert.equal(transitioned.note, 'opened MR !3');
  assert.equal(transitioned.reviewRound, 0);
  assert.deepEqual((await stateOf(provider, '7')) === 'pr_open', true);

  // --- comment: created once per run, then updated in place ---
  fake.clear();
  const first = await provider.comment('7', 'working', { runId: 'c0ffee01' });
  assert.deepEqual(fake.calls(), [`GET ${issue}`, `GET ${notes}`, `POST ${issue}/notes`]);
  assert.deepEqual(fake.bodies()[2], { body: 'working\n\n<!-- takumi:run=c0ffee01 -->' });
  assert.deepEqual(first, {
    item: '7',
    comment: '2',
    runId: 'c0ffee01',
    url: `https://gitlab.test/${PROJECT}/-/issues/7#note_2`,
  });

  fake.clear();
  const second = await provider.comment('7', 'still working', { runId: 'c0ffee01' });
  assert.deepEqual(fake.calls(), [`GET ${issue}`, `GET ${notes}`, `PUT ${issue}/notes/2`]);
  assert.deepEqual(fake.bodies()[2], { body: 'still working\n\n<!-- takumi:run=c0ffee01 -->' });
  assert.equal(second.comment, first.comment, 'one progress note per run: the same ref comes back');
  assert.equal(fake.notesOf(7).length, 2, 'one record note + one progress note');

  // --- updateComment: PUT the note, keep the run marker, surface a 404 ---
  fake.clear();
  await provider.updateComment(first, 'final');
  assert.deepEqual(fake.calls(), [`PUT ${issue}/notes/2`]);
  assert.deepEqual(fake.bodies()[0], { body: 'final\n\n<!-- takumi:run=c0ffee01 -->' });
  assert.equal(fake.notesOf(7)[1]?.body, 'final\n\n<!-- takumi:run=c0ffee01 -->');

  fake.clear();
  const gone: BoardCommentRef = { ...first, comment: 'takumi-no-such-comment' };
  await assert.rejects(
    () => provider.updateComment(gone, 'x'),
    (e: unknown) => e instanceof BoardError && e.kind === 'not_found' && e.item === '7',
  );
  assert.deepEqual(fake.calls(), [`PUT ${issue}/notes/takumi-no-such-comment`]);

  // --- writeState / readState: one record note per run, newest wins ---
  fake.clear();
  const run2: BoardStateRecord = {
    schema: 1,
    runId: 'c0ffee02',
    item: '7',
    reviewRound: 2,
    updatedAt: '2099-01-01T00:00:00.000Z',
    deliveryRef: '!4',
  };
  await provider.writeState('7', run2);
  assert.deepEqual(fake.calls(), [`GET ${notes}`, `POST ${issue}/notes`]);
  assert.deepEqual(fake.bodies()[1], { body: renderBoardStateRecord(run2) });

  fake.clear();
  await provider.writeState('7', { ...run2, note: 'second write' });
  assert.deepEqual(fake.calls(), [`GET ${notes}`, `PUT ${issue}/notes/3`], 'the same run upserts its own note');

  fake.clear();
  const read = await provider.readState('7');
  assert.deepEqual(fake.calls(), [`GET ${notes}`]);
  assert.deepEqual(read, { ...run2, note: 'second write' }, 'the newest trusted record is the one read back');
});

test('readState: control flow only ever follows a TRUSTED author', async () => {
  const trustedRecord: BoardStateRecord = {
    schema: 1,
    runId: 'deadbeef',
    item: '7',
    reviewRound: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  // NEWER than the trusted one, and still must lose: recency is not authority.
  const hostileRecord: BoardStateRecord = { ...trustedRecord, runId: 'cafebabe', updatedAt: '2099-01-01T00:00:00.000Z' };

  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue({
    iid: 7,
    title: 'Trust boundary',
    labels: ['takumi-ready'],
    notes: [
      { body: renderBoardStateRecord(trustedRecord), author: TRUSTED, createdAt: '2026-01-01T00:00:00.000Z' },
      { body: renderBoardStateRecord(hostileRecord), author: 'drive-by', createdAt: '2099-01-01T00:00:00.000Z' },
    ],
  });

  const guarded = new GitLabBoardProvider({
    project: PROJECT,
    apiBase: API,
    request: fake.request,
    trustedAuthors: [TRUSTED],
  });
  assert.equal(guarded.capabilities().trustedAuthorFilter, true);
  assert.equal((await guarded.readState('7'))?.runId, 'deadbeef');

  // The allowlist is exact: a near-miss username is not trusted either.
  const nearMiss = new GitLabBoardProvider({
    project: PROJECT,
    apiBase: API,
    request: fake.request,
    trustedAuthors: ['Takumi-Bot'],
  });
  assert.equal(await nearMiss.readState('7'), null);

  // Without an allowlist the adapter declares NO trust boundary — and that is
  // the honest answer, because GitLab notes expose no association or role to
  // filter on. The consequence is visible, not hidden: a stranger's record is
  // then readable and blocks the item.
  const unguarded = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request });
  assert.equal(
    unguarded.capabilities().trustedAuthorFilter,
    false,
    'without an allowlist GitLab offers no per-note trust signal, so the adapter must not pretend to have one',
  );
  assert.equal((await unguarded.readState('7'))?.runId, 'cafebabe');
  const refused = await unguarded.claim('7', 'my-run');
  assert.equal(refused.claimed, false);
  assert.match(refused.reason ?? '', /already claimed by run cafebabe/);
});

test('readState: a corrupt block is loud in a trusted note and ignored in an untrusted one', async () => {
  const strangerGarbage = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  strangerGarbage.seedIssue({ iid: 9, labels: ['takumi-ready'], notes: [{ body: '<!-- takumi:boardstate:v1 {"oops" -->', author: 'drive-by' }] });

  const guarded = new GitLabBoardProvider({
    project: PROJECT,
    apiBase: API,
    request: strangerGarbage.request,
    trustedAuthors: [TRUSTED],
  });
  assert.equal(await guarded.readState('9'), null, 'an untrusted note is never even parsed');

  // ...whereas with no allowlist the same text is parsed, and a corrupted run
  // must look corrupted rather than like a fresh one.
  const unguarded = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: strangerGarbage.request });
  await assert.rejects(() => unguarded.readState('9'), BoardStateRecordError);

  const ownGarbage = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  ownGarbage.seedIssue({ iid: 9, labels: ['takumi-ready'], notes: [{ body: '<!-- takumi:boardstate:v1 {"runId":"x"} -->', author: TRUSTED }] });
  const trusting = new GitLabBoardProvider({
    project: PROJECT,
    apiBase: API,
    request: ownGarbage.request,
    trustedAuthors: [TRUSTED],
  });
  await assert.rejects(() => trusting.readState('9'), BoardStateRecordError);
});

test('claim: a lost race and a repeated claim are both refused with a reason', async () => {
  const { fake, provider } = board({ iid: 7, labels: ['takumi-ready'] });

  // A competing worker's record lands between our label write and our re-read —
  // exactly the window GitLab's non-conditional label PUT leaves open.
  fake.onRequest((req) => {
    if (req.method !== 'PUT' || req.url.includes('/notes')) return;
    if (fake.notesOf(7).some((note) => note.body.includes('racer-run'))) return;
    fake.appendNote(
      7,
      renderBoardStateRecord({ schema: 1, runId: 'racer-run', item: '7', reviewRound: 0, updatedAt: '2099-01-01T00:00:00.000Z' }),
      TRUSTED,
    );
  });

  const racy = await provider.claim('7', 'my-run');
  assert.equal(racy.claimed, false, 'the re-read shows another run owns the item');
  assert.match(racy.reason ?? '', /lost the claim race on issue 7/);
  assert.match(racy.reason ?? '', /racer-run/);
  assert.match(racy.reason ?? '', /atomicClaim/, 'the reason points at the declared capability gap');
  // The label write really happened — GitLab cannot roll it back, so the
  // refusal must describe the board as it is, not as we wished it were.
  assert.ok(fake.labelsOf(7).includes('takumi-claimed'));

  // A same-instant tie is a refusal for BOTH racers: the newest record must be
  // uniquely ours, so a coin-flip is never reported as a win.
  const tie = board({ iid: 8, labels: ['takumi-ready'] });
  tie.fake.onRequest((req) => {
    if (req.method !== 'POST' || !req.url.endsWith('/notes')) return;
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string') return;
    const mine = parseBoardStateRecord(body);
    if (mine === null) return;
    // Same timestamp, different run: the board cannot say who was first.
    tie.fake.appendNote(8, renderBoardStateRecord({ ...mine, runId: 'racer-run' }), TRUSTED);
  });
  const tied = await tie.provider.claim('8', 'my-run');
  assert.equal(tied.claimed, false);
  assert.match(tied.reason ?? '', /lost the claim race on issue 8/);
  assert.match(tied.reason ?? '', /at the same instant/);

  // A repeated claim by the SAME run is a non-silent no-op too.
  const { fake: calm, provider: calmProvider } = board({ iid: 7, labels: ['takumi-ready'] });
  assert.equal((await calmProvider.claim('7', 'c0ffee01')).claimed, true);
  const again = await calmProvider.claim('7', 'c0ffee01');
  assert.equal(again.claimed, false);
  assert.match(again.reason ?? '', /already claimed by run c0ffee01/);
  assert.equal(calm.labelsOf(7).filter((label) => label === 'takumi-claimed').length, 1);

  // An item that is not ready is not ours to take.
  const { provider: taken } = board({ iid: 5, labels: ['takumi-pr-open'] });
  const notReady = await taken.claim('5', 'run-9');
  assert.equal(notReady.claimed, false);
  assert.match(notReady.reason ?? '', /in state pr_open, not ready/);
});

test('transition: an illegal move is rejected before any write reaches the board', async () => {
  const { fake, provider } = board({ iid: 5, title: 'Delivery under human control', labels: ['takumi-merged'] });
  await assert.rejects(() => provider.transition('5', 'claimed', { runId: 'c0ffee01' }), BoardStateError);
  assert.deepEqual(fake.calls(), [`GET ${ISSUES}/5`], 'one read, and no write at all');
  assert.ok(fake.calls().every((call) => call.startsWith('GET')));

  // A terminal state has no automated exit either.
  await assert.rejects(() => provider.transition('5', 'ready', { runId: 'c0ffee01' }), BoardStateError);
  assert.equal(await stateOf(provider, '5'), 'merged');
});

test('HTTP failures are classified, never bare Errors', async () => {
  const { fake, provider } = board({ iid: 7, labels: ['takumi-ready'] });

  const cases: Array<[number, string]> = [
    [404, 'not_found'],
    [401, 'auth'],
    [403, 'auth'],
    [400, 'precondition'],
    [409, 'precondition'],
    [422, 'precondition'],
    [500, 'transport'],
    [503, 'transport'],
  ];
  for (const [status, kind] of cases) {
    fake.failNext(status);
    await assert.rejects(
      () => provider.getWork('7'),
      (e: unknown) => {
        assert.ok(e instanceof BoardError, `HTTP ${status} must be a BoardError`);
        assert.equal(e.kind, kind, `HTTP ${status} must classify as ${kind}`);
        assert.equal(e.item, '7');
        assert.equal(e.retriable, kind === 'transport', 'only transport failures are retriable');
        assert.match(e.message, new RegExp(`HTTP ${status}`));
        return true;
      },
    );
  }

  // The WRITE of a mutation is classified the same way (the reads succeeded).
  fake.failWhen((req) => req.method === 'PUT' && !req.url.includes('/notes'), 409);
  await assert.rejects(
    () => provider.transition('7', 'claimed', { runId: 'c0ffee01' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition',
  );
  fake.clearFaults();

  fake.failWhen((req) => req.method === 'PUT' && req.url.includes('/notes/'), 404);
  await assert.rejects(
    () => provider.updateComment({ item: '7', comment: '1', runId: 'c0ffee01' }, 'x'),
    (e: unknown) => e instanceof BoardError && e.kind === 'not_found',
  );
  fake.clearFaults();

  // A 500 while collecting the state record is retriable, not a lost run.
  fake.failNext(500);
  await assert.rejects(
    () => provider.readState('7'),
    (e: unknown) => e instanceof BoardError && e.kind === 'transport' && e.retriable,
  );
});

test('capabilities(): GitLab declares its real limits instead of an idealised board', () => {
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: async () => ({ status: 200, body: '[]' }) });
  const caps = provider.capabilities();

  assert.deepEqual(caps.states, [...BOARD_WORK_ITEM_STATES]);
  assert.equal(caps.comments, true);
  assert.equal(caps.editableComment, true, 'the notes API supports PUT /notes/:id');
  assert.equal(caps.machineReadableState, true);
  assert.equal(caps.atomicClaim, false, 'GitLab cannot update labels conditionally');
  assert.equal(caps.trustedAuthorFilter, false, 'no allowlist was configured');
  assert.deepEqual(caps.delivery, { canOpenPullRequest: true, canRunChecks: true, canMerge: true });
  assert.equal(provider.metadata().id, 'gitlab');

  // A caller that needs the guarantee GitLab cannot give is told so up front.
  assert.deepEqual(validateBoardCapabilities(provider, { atomicClaim: true, comments: true }), {
    ok: false,
    missing: ['atomicClaim'],
  });
  assert.deepEqual(
    validateBoardCapabilities(provider, {
      states: [...BOARD_WORK_ITEM_STATES],
      comments: true,
      editableComment: true,
      machineReadableState: true,
      delivery: { canOpenPullRequest: true, canRunChecks: true, canMerge: true },
    }),
    { ok: true },
  );
  assert.equal(
    new GitLabBoardProvider({ project: PROJECT, trustedAuthors: [TRUSTED], request: async () => ({ status: 200, body: '[]' }) })
      .capabilities().trustedAuthorFilter,
    true,
  );
});

/** A provider whose board cannot comment or store a state record (capability gating). */
class NoNotesGitLabBoard extends GitLabBoardProvider {
  override capabilities(): BoardCapabilities {
    return { ...super.capabilities(), comments: false, editableComment: false, machineReadableState: false };
  }
}

test('gated operations fail closed BEFORE any request', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue({ iid: 7, labels: ['takumi-ready'] });
  const provider = new NoNotesGitLabBoard({ project: PROJECT, apiBase: API, request: fake.request, trustedAuthors: [TRUSTED] });

  const gated: Array<[() => Promise<unknown>, string]> = [
    [() => provider.comment('7', 'x', { runId: 'c0ffee01' }), 'comments'],
    [() => provider.updateComment({ item: '7', comment: '1', runId: 'c0ffee01' }, 'x'), 'editableComment'],
    [() => provider.readState('7'), 'machineReadableState'],
    [() => provider.writeState('7', { schema: 1, runId: 'c0ffee01', item: '7', reviewRound: 0, updatedAt: 'now' }), 'machineReadableState'],
  ];
  for (const [run, capability] of gated) {
    await assert.rejects(run, (e: unknown) => {
      assert.ok(e instanceof BoardUnsupportedError);
      assert.equal(e.capability, capability);
      assert.equal(e.kind, 'unsupported');
      return true;
    });
  }
  assert.deepEqual(fake.calls(), [], 'a gated operation must not touch the board');
  // The ungated part of the port keeps working.
  assert.equal((await stateOf(provider, '7')), 'ready');
});

test('the state-label vocabulary is explicit: intake, precedence and custom prefixes', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue({ iid: 1, title: 'filed by a human' }); // no labels at all
  fake.seedIssue({ iid: 2, title: 'dirty', labels: ['takumi-ready', 'takumi-blocked'] });
  fake.seedIssue({ iid: 3, title: 'delivered', labels: ['takumi-merged'] });
  fake.seedIssue({ iid: 4, title: 'unrelated prefixed label', labels: ['takumi-unknown-thing', 'takumi-claimed'] });
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request });

  const states = (await provider.listWork()).map((item: BoardWorkItem): [string, string] => [item.id, item.state]);
  assert.deepEqual(
    states,
    [
      ['1', 'ready'], // no takumi-* label → the board's intake state
      ['2', 'blocked'], // a human's block outranks a stale ready
      ['3', 'merged'],
      ['4', 'claimed'], // takumi-unknown-thing is not a state label
    ],
  );
  assert.deepEqual((await provider.listWork({ states: ['claimed', 'merged'] })).map((item) => item.id), ['3', '4']);
  assert.deepEqual((await provider.listWork({ limit: 2 })).map((item) => item.id), ['1', '2']);

  // A team's own vocabulary: prefix and apiBase are configurable.
  const custom = new FakeGitLab({ project: 'team/app', username: TRUSTED });
  custom.seedIssue({ iid: 3, title: 'custom', labels: ['ship-ready'] });
  const customProvider = new GitLabBoardProvider({
    project: 'team/app',
    labelPrefix: 'ship-',
    apiBase: API,
    request: custom.request,
  });
  assert.equal(await stateOf(customProvider, '3'), 'ready');
  custom.clear();
  await customProvider.transition('3', 'claimed', { runId: 'c0ffee01' });
  assert.deepEqual(custom.bodies()[2], { add_labels: 'ship-claimed', remove_labels: 'ship-ready' });
  assert.deepEqual(custom.calls()[0], `GET ${API}/projects/team%2Fapp/issues/3`);

  custom.clear();
  await customProvider.listWork({ labels: ['team a', 'ready'] });
  assert.deepEqual(custom.calls(), [`GET ${API}/projects/team%2Fapp/issues?state=opened&per_page=100&labels=team%20a,ready`]);
});

test('writeState: a record naming another item is refused before any request', async () => {
  const { fake, provider } = board({ iid: 7, labels: ['takumi-ready'] });
  await assert.rejects(
    () => provider.writeState('7', { schema: 1, runId: 'c0ffee01', item: '9', reviewRound: 0, updatedAt: 'now' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && e.item === '7',
  );
  assert.deepEqual(fake.calls(), []);
});

test('bad construction options are refused loudly', () => {
  assert.throws(() => new GitLabBoardProvider({ project: '   ' }), /`project` is required/);
  assert.throws(() => new GitLabBoardProvider({ project: PROJECT, labelPrefix: '' }), /`labelPrefix` must not be empty/);
  assert.throws(() => new GitLabBoardProvider({ project: PROJECT, apiBase: '/' }), /`apiBase` must not be empty/);
});

test('without a credential the adapter fails closed instead of calling out anonymously', async () => {
  const saved = process.env['GITLAB_TOKEN'];
  delete process.env['GITLAB_TOKEN'];
  try {
    const provider = new GitLabBoardProvider({ project: PROJECT });
    await assert.rejects(
      () => provider.getWork('7'),
      (e: unknown) => {
        assert.ok(e instanceof BoardError);
        assert.equal(e.kind, 'auth');
        assert.equal(e.retriable, false);
        assert.match(e.message, /no request transport configured/);
        return true;
      },
    );
  } finally {
    if (saved === undefined) delete process.env['GITLAB_TOKEN'];
    else process.env['GITLAB_TOKEN'] = saved;
  }
});

test('createGitLabTransport: the default transport authenticates with PRIVATE-TOKEN (loopback only)', async () => {
  const seen: Array<{ method?: string; token?: string; path?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        token: req.headers['private-token'] as string | undefined,
        path: req.url,
        body,
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ iid: 7 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const saved = process.env['GITLAB_TOKEN'];

  try {
    const explicit: BoardRequestFn = createGitLabTransport({ token: 'secret-token', timeoutSeconds: 10 });
    const response = await explicit({
      method: 'PUT',
      url: `http://127.0.0.1:${port}/api/v4/projects/${PROJECT_ID}/issues/7`,
      body: { add_labels: 'takumi-claimed', remove_labels: '' },
    });
    assert.equal(response.status, 200);
    assert.equal(seen[0]?.method, 'PUT');
    assert.equal(seen[0]?.token, 'secret-token', 'the GitLab auth header must ride along');
    assert.equal(seen[0]?.path, `/api/v4/projects/${PROJECT_ID}/issues/7`, 'the project id stays URL-encoded');
    assert.equal(seen[0]?.body, JSON.stringify({ add_labels: 'takumi-claimed', remove_labels: '' }));

    // The token may equally come from GITLAB_TOKEN.
    process.env['GITLAB_TOKEN'] = 'from-env';
    await createGitLabTransport()({ method: 'GET', url: `http://127.0.0.1:${port}/api/v4/projects/${PROJECT_ID}/issues/7` });
    assert.equal(seen[1]?.token, 'from-env');
  } finally {
    if (saved === undefined) delete process.env['GITLAB_TOKEN'];
    else process.env['GITLAB_TOKEN'] = saved;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
