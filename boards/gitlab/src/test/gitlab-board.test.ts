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
const LABELS = `${API}/projects/${PROJECT_ID}/labels`;

/**
 * Every state label the default vocabulary writes, in `BOARD_WORK_ITEM_STATES`
 * order — declared as LITERALS on purpose: a list derived from the adapter's own
 * constant could not notice that constant changing.
 */
const STATE_LABELS = [
  'takumi-ready',
  'takumi-claimed',
  'takumi-pr-open',
  'takumi-fix-needed',
  'takumi-merged',
  'takumi-blocked',
];

/** A predicate for the error taxonomy: an adapter failure is classified, never a bare Error. */
function boardError(kind: string, re?: RegExp) {
  return (e: unknown): boolean =>
    e instanceof BoardError && e.kind === kind && (re === undefined || re.test(e.message));
}

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
  // The suite now bootstraps the state vocabulary itself, and this project had no
  // label at all: the report must say the six were CREATED, not merely hoped for.
  assert.ok(
    out.notes.some((note) => note.startsWith('bootstrapStates: PASS (canCreate=true created=6 exists=0 notCreatable=0')),
    out.notes.join('\n'),
  );
  // ...and it files an issue of its own: `canCreateWork: true` is a promise, and the
  // suite checks the hard part of it (one item per idempotency key, claimable after).
  assert.ok(
    out.notes.some((note) => note.startsWith('createWork: PASS')),
    out.notes.join('\n'),
  );
  // The suite searches FOR REAL now: it files a probe whose title carries a distinctive
  // term and requires the adapter to find it, then requires a term nothing carries to
  // find nothing. An adapter that ignored `query` could not pass that pair.
  assert.ok(
    out.notes.some((note) => note.startsWith('query: PASS')),
    out.notes.join('\n'),
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

// --- listWork: the free-text scope is GitLab's search, not a local filter ----

test('listWork: a text scope reaches the request as GitLab `search`, and a term nothing carries finds nothing', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue({
    iid: 1,
    title: 'Epic alpha: ship the intake',
    description: 'the milestone this belongs to is takuepicalpha',
    labels: ['takumi-ready'],
  });
  fake.seedIssue({ iid: 2, title: 'Unrelated chore', description: 'nothing to see here', labels: ['takumi-ready'] });
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request });

  // (1) the term REACHES the request. This is the whole point of the capability: the
  // BOARD searches, so a scope finds work beyond the first page too — filtering this
  // page locally would only ever find what `per_page` had already returned.
  fake.clear();
  const hit = await provider.listWork({ states: ['ready'], query: 'takuepicalpha' });
  assert.deepEqual(fake.calls(), [`GET ${ISSUES}?state=opened&per_page=100&search=takuepicalpha`]);
  assert.deepEqual(hit.map((item) => item.id), ['1'], 'the item whose text carries the term is returned');

  // (2) a term NOTHING carries returns nothing — and, just as important, it did not
  // silently degrade into "no filter at all" (the failure mode the shared suite checks).
  fake.clear();
  const miss = await provider.listWork({ states: ['ready'], query: 'takunothingcarriesthis' });
  assert.deepEqual(fake.calls(), [`GET ${ISSUES}?state=opened&per_page=100&search=takunothingcarriesthis`]);
  assert.deepEqual(miss, [], 'a term no issue carries must find nothing, never everything');

  // (3) the search reads the DESCRIPTION as well as the title: GitLab greps both, so a
  // scope does not depend on where the operator put the epic's name.
  fake.clear();
  const inBody = await provider.listWork({ query: 'milestone' });
  assert.deepEqual(fake.calls(), [`GET ${ISSUES}?state=opened&per_page=100&search=milestone`]);
  assert.deepEqual(inBody.map((item) => item.id), ['1']);

  // (4) several terms are an AND, and it is GitLab's to apply: no single issue carries
  // both of these, so a hit would mean the adapter had loosened the operator's scope.
  assert.deepEqual(
    await provider.listWork({ query: 'takuepicalpha unrelated' }),
    [],
    'every term must appear in the ONE item; a term only another issue carries is not a hit',
  );

  // (5) the scope composes with the label filter, and the local state/limit filters
  // still apply to what came back.
  fake.clear();
  const scoped = await provider.listWork({ labels: ['takumi-ready'], limit: 1, query: 'Epic alpha' });
  assert.deepEqual(fake.calls(), [
    `GET ${ISSUES}?state=opened&per_page=100&labels=takumi-ready&search=Epic%20alpha`,
  ]);
  assert.deepEqual(scoped.map((item) => item.id), ['1']);

  // (6) a BLANK term is REFUSED, not turned into an unscoped request. This test used to
  // assert the opposite — "a blank term is absent, so no `search=` is sent" — which is the
  // silent widening the core rule forbids: the caller asked to narrow and got the whole
  // board back, with nothing to show the scope had been dropped. The request is what proves
  // it: a refused scope never reaches the host at all.
  fake.clear();
  await assert.rejects(
    () => provider.listWork({ query: '   ' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError);
      assert.equal(e.kind, 'precondition');
      return true;
    },
  );
  assert.deepEqual(fake.calls(), [], 'a refused scope must not be sent');

  assert.equal(provider.capabilities().canTextSearch, true);
});

// --- createWork: filing a failure as work, exactly once ---------------------

/**
 * The create-search URL the adapter uses: all states, the API's page ceiling, and the
 * KEY as GitLab's `search` parameter. It is built by the SAME URL builder as the work
 * list (one shape to keep correct), so the parameter order here is that builder's.
 */
function createSearch(key: string): string {
  return `${ISSUES}?state=all&per_page=100&search=${encodeURIComponent(key)}`;
}

test('createWork: the exact create request, the hidden marker, and a second call that files nothing', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request, trustedAuthors: [TRUSTED] });
  const KEY = 'ci:red:481';

  const first = await provider.createWork({
    title: 'Pipeline red on main',
    body: 'job test failed on retry 2',
    labels: ['ci'],
    idempotencyKey: KEY,
  });

  // --- the request shape: search FIRST, then one create ---
  assert.deepEqual(fake.calls(), [`GET ${createSearch(KEY)}`, `POST ${ISSUES}`]);
  assert.deepEqual(fake.bodies()[1], {
    title: 'Pipeline red on main',
    // The marker rides in the description, where the reader greps for it.
    description: `job test failed on retry 2\n\n<!-- takumi:created=${KEY} -->`,
    // The state comes from the adapter's own vocabulary, and the caller's labels ride along.
    labels: ['ci', 'takumi-ready'],
  });

  // --- the result: a real, ready, claimable work item ---
  assert.equal(first.created, true);
  assert.equal(first.item.id, '1', 'the created issue is addressed by its iid');
  assert.equal(first.item.state, 'ready', 'the state label IS the delivery state, so a filed item starts ready');
  assert.equal(first.item.body, `job test failed on retry 2\n\n<!-- takumi:created=${KEY} -->`);
  assert.deepEqual(fake.labelsOf(1), ['ci', 'takumi-ready']);

  fake.clear();
  const ready = await provider.listWork({ states: ['ready'] });
  assert.equal(ready.filter((item) => item.id === first.item.id).length, 1, 'the filed item appears exactly once');

  // --- the retry: the search decides, and nothing is filed twice ---
  fake.clear();
  const second = await provider.createWork({
    title: 'Pipeline red on main',
    body: 'job test failed on retry 2',
    labels: ['ci'],
    idempotencyKey: KEY,
  });
  assert.equal(second.created, false, 'a repeated key must not report a creation');
  assert.equal(second.item.id, first.item.id, 'and must return the FIRST item');
  assert.deepEqual(second.item.labels, ['ci', 'takumi-ready']);
  assert.deepEqual(fake.calls(), [`GET ${createSearch(KEY)}`], 'the search alone answers the retry');
});

test('createWork: the key is found after the item moved on (a retried tick must not re-file delivered work)', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request, trustedAuthors: [TRUSTED] });
  const KEY = 'flake:timeout:9';

  const filed = await provider.createWork({ title: 'Flaky test', idempotencyKey: KEY });
  // The work happens: the item is claimed and a merge request is opened.
  assert.equal((await provider.claim(filed.item.id, 'c0ffee01')).claimed, true);
  await provider.transition(filed.item.id, 'pr_open', { runId: 'c0ffee01', note: 'opened MR !4' });

  fake.clear();
  const again = await provider.createWork({ title: 'Flaky test', idempotencyKey: KEY });
  assert.equal(again.created, false);
  assert.equal(again.item.id, filed.item.id);
  assert.equal(again.item.state, 'pr_open', "the returned item is the board's CURRENT view of it");
  // `state=all` in the search is what makes this work: the label has changed, so an
  // open-issues-only search would have filed a second copy of finished work.
  assert.deepEqual(fake.calls(), [`GET ${createSearch(KEY)}`]);
});

test('createWork: the title is the search result, the MARKER is the proof', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  // A person happened to write the key into a description, and GitLab's full-text
  // search returns that issue for it. Only the marker can tell the two apart.
  fake.seedIssue({ iid: 1, title: 'Discussion', description: 'we hit ci:red:481 yesterday' });
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request });

  const filed = await provider.createWork({ title: 'Pipeline red', idempotencyKey: 'ci:red:481' });
  assert.equal(filed.created, true, 'a search hit without the create marker is not our item');
  assert.equal(filed.item.id, '2');
  assert.deepEqual(fake.calls(), [`GET ${createSearch('ci:red:481')}`, `POST ${ISSUES}`]);
});

test('createWork: the requested state is the label it is filed under, and no key means no marker', async () => {
  const fake = new FakeGitLab({ project: 'team/app', username: TRUSTED });
  const provider = new GitLabBoardProvider({
    project: 'team/app',
    labelPrefix: 'ship-',
    apiBase: API,
    request: fake.request,
  });

  // Without a key there is nothing to search for: one create, and the description is
  // exactly what the caller wrote (no stray blank line, no empty marker).
  const filed = await provider.createWork({ title: 'Blocked intake', body: 'needs a human', state: 'blocked' });
  assert.deepEqual(fake.calls(), [`POST ${API}/projects/team%2Fapp/issues`]);
  assert.deepEqual(fake.bodies()[0], { title: 'Blocked intake', description: 'needs a human', labels: ['ship-blocked'] });
  assert.equal(filed.item.state, 'blocked', 'a filed item can start in any state this adapter can express');
  assert.equal(filed.created, true);
  assert.deepEqual((await provider.listWork({ states: ['blocked'] })).map((item) => item.id), [filed.item.id]);

  // The same through the ready default, with an empty body: the marker alone.
  fake.clear();
  const ready = await provider.createWork({ title: 'No body', idempotencyKey: 'k:1' });
  assert.deepEqual(fake.bodies()[1], {
    title: 'No body',
    description: '<!-- takumi:created=k:1 -->',
    labels: ['ship-ready'],
  });
  assert.equal(ready.item.state, 'ready');
});

test('createWork: a create the host rejects is classified, and the message names the fix', async () => {
  const { fake, provider } = board({ iid: 1, labels: ['takumi-ready'] });
  // GitLab's real answer for a label the project does not have.
  fake.failWhen(
    (req) => req.method === 'POST' && req.url.endsWith('/issues'),
    400,
    '{"message":"Label(s) not allowed for this project: takumi-ready"}',
  );

  await assert.rejects(
    () => provider.createWork({ title: 'will not be filed', idempotencyKey: 'ci:red:2' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError, 'a rejected create must be a classified board error');
      assert.equal(e.kind, 'precondition', 'retrying a refused create changes nothing');
      assert.equal(e.retriable, false);
      assert.match(e.message, /Label\(s\) not allowed/);
      assert.match(e.message, /"takumi-ready"/, 'the label that caused it is named');
      assert.match(e.message, /takumi board --bootstrap/, 'and so is the command that creates it');
      return true;
    },
  );
  // Nothing was filed, and nothing is pretended to have been.
  assert.deepEqual(fake.calls(), [`GET ${createSearch('ci:red:2')}`, `POST ${ISSUES}`]);
  assert.equal((await provider.listWork()).length, 1, 'the board still holds only the seeded issue');
});

test('createWork: a malformed idempotency key fails before any request', async () => {
  const { fake, provider } = board({ iid: 1, labels: ['takumi-ready'] });
  await assert.rejects(
    () => provider.createWork({ title: 'x', idempotencyKey: 'not a key!' }),
    boardError('precondition', /invalid idempotency key/),
  );
  // A marker nothing can find again would file a duplicate on every retry, so the
  // key is rejected before the search rather than after the create.
  assert.deepEqual(fake.calls(), []);
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
  assert.equal(caps.canBootstrapStates, true, 'GitLab labels are creatable through the API, so the adapter says it can');
  assert.equal(caps.canCreateWork, true, 'GitLab issues are creatable, so a failure can be filed as work');
  assert.equal(caps.canTextSearch, true, 'the issue list takes GitLab\'s own `search` parameter, so free text is the board\'s job');
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

/** A provider that declares it cannot file items: `createWork` must fail closed. */
class NoCreateGitLabBoard extends GitLabBoardProvider {
  override capabilities(): BoardCapabilities {
    return { ...super.capabilities(), canCreateWork: false };
  }
}

test('createWork: a board that declares it cannot file work refuses it, before any request', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue({ iid: 7, labels: ['takumi-ready'] });
  const provider = new NoCreateGitLabBoard({ project: PROJECT, apiBase: API, request: fake.request });

  await assert.rejects(
    () => provider.createWork({ title: 'must be refused', idempotencyKey: 'ci:red:3' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardUnsupportedError);
      assert.equal(e.capability, 'canCreateWork');
      assert.equal(e.kind, 'unsupported');
      return true;
    },
  );
  // Refusing is the honest answer; quietly filing anyway (or returning a fabricated
  // item) would hand the caller an id nothing backs.
  assert.deepEqual(fake.calls(), []);
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

// --- state bootstrapping ----------------------------------------------------

test('bootstrapStates: a dry run changes nothing, the real call creates every missing label, a second call is a no-op', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  fake.seedIssue({ iid: 1 });
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request });
  fake.clear();

  // --- dry run: ONE read, a promise per missing label, no write ---
  const dry = await provider.bootstrapStates([...BOARD_WORK_ITEM_STATES], { dryRun: true });
  assert.deepEqual(fake.calls(), [`GET ${LABELS}?per_page=100&page=1`], 'a dry run must only read');
  assert.equal(dry.provider, 'gitlab', 'the report names the provider the suite checked');
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.unsupported, []);
  assert.deepEqual(
    dry.actions,
    [...BOARD_WORK_ITEM_STATES].map((state, index) => ({ state, name: STATE_LABELS[index], outcome: 'would-create' })),
  );
  assert.deepEqual(fake.labelsOnBoard(), [], 'the dry run must not have created anything');

  // --- the real call creates exactly the labels the dry run promised ---
  fake.clear();
  const applied = await provider.bootstrapStates([...BOARD_WORK_ITEM_STATES]);
  assert.equal(applied.applied, true);
  assert.deepEqual(
    applied.actions,
    [...BOARD_WORK_ITEM_STATES].map((state, index) => ({ state, name: STATE_LABELS[index], outcome: 'created' })),
  );
  assert.deepEqual(fake.calls(), [`GET ${LABELS}?per_page=100&page=1`, ...STATE_LABELS.map(() => `POST ${LABELS}`)]);
  // GitLab 400s on a label without a colour, so the create carries one; the name
  // is the one THIS instance writes (`<prefix><suffix>`), and nothing else rides along.
  assert.deepEqual(
    fake.bodies().slice(1),
    STATE_LABELS.map((name) => ({ name, color: '#1f6feb' })),
  );
  assert.deepEqual(fake.labelsOnBoard().map((label) => label.name), STATE_LABELS);
  // The labels are not only created but USABLE: the state they encode is now readable.
  assert.equal(await stateOf(provider, '1'), 'ready');

  // --- idempotence: reading is enough now ---
  fake.clear();
  const again = await provider.bootstrapStates([...BOARD_WORK_ITEM_STATES]);
  assert.equal(again.applied, false, 'a second bootstrap changes nothing');
  assert.deepEqual(
    again.actions,
    [...BOARD_WORK_ITEM_STATES].map((state, index) => ({ state, name: STATE_LABELS[index], outcome: 'exists' })),
  );
  assert.deepEqual(fake.calls(), [`GET ${LABELS}?per_page=100&page=1`], 'a second call must not write');
});

test('bootstrapStates: a custom prefix is honoured, and colour drift is reported `exists`, never rewritten', async () => {
  const fake = new FakeGitLab({ project: 'team/app', username: TRUSTED });
  // A human made this label by hand, in their own colour: a bootstrap is not a
  // licence to repaint somebody else's label.
  fake.seedLabel('ship-claimed', '#ff0000');
  fake.seedLabel('unrelated');
  const provider = new GitLabBoardProvider({ project: 'team/app', labelPrefix: 'ship-', apiBase: API, request: fake.request });
  fake.clear();

  const report = await provider.bootstrapStates(['ready', 'claimed']);
  assert.deepEqual(report.actions, [
    { state: 'ready', name: 'ship-ready', outcome: 'created' },
    { state: 'claimed', name: 'ship-claimed', outcome: 'exists' },
  ]);
  assert.deepEqual(fake.calls(), [
    `GET ${API}/projects/team%2Fapp/labels?per_page=100&page=1`,
    `POST ${API}/projects/team%2Fapp/labels`,
  ]);
  assert.deepEqual(fake.bodies()[1], { name: 'ship-ready', color: '#1f6feb' });
  assert.deepEqual(fake.labelsOnBoard(), [
    { name: 'ship-claimed', color: '#ff0000' },
    { name: 'unrelated', color: '#ededed' },
    { name: 'ship-ready', color: '#1f6feb' },
  ]);
});

test('bootstrapStates: every label page is read, so a label on page 2 is found (a re-create would be a 409)', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  // 100 unrelated labels fill page one EXACTLY. The seam exposes no response
  // headers, so a page shorter than `per_page` is the only end-of-list signal —
  // and this proves the walk reaches page 2 before deciding what is missing.
  for (let index = 0; index < 100; index += 1) fake.seedLabel(`filler-${String(index).padStart(3, '0')}`);
  for (const name of STATE_LABELS) fake.seedLabel(name);
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request });
  fake.clear();

  const report = await provider.bootstrapStates([...BOARD_WORK_ITEM_STATES]);
  assert.deepEqual(fake.calls(), [`GET ${LABELS}?per_page=100&page=1`, `GET ${LABELS}?per_page=100&page=2`]);
  assert.equal(report.applied, false, 'everything was already there');
  assert.ok(report.actions.every((action) => action.outcome === 'exists'));
});

/** A provider that declares only part of the vocabulary: the fail-closed report path. */
class PartialVocabularyGitLabBoard extends GitLabBoardProvider {
  override capabilities(): BoardCapabilities {
    const caps = super.capabilities();
    return { ...caps, states: caps.states.filter((state) => state !== 'merged') };
  }
}

test('bootstrapStates: a state this adapter cannot express is reported with an instruction, never created', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  const provider = new PartialVocabularyGitLabBoard({ project: PROJECT, apiBase: API, request: fake.request });

  const report = await provider.bootstrapStates(['ready', 'merged']);
  assert.deepEqual(report.unsupported, ['merged'], 'the complement of capabilities().states is named');
  assert.deepEqual(report.actions[0], { state: 'ready', name: 'takumi-ready', outcome: 'created' });
  const merged = report.actions[1];
  assert.equal(merged?.state, 'merged');
  assert.equal(merged?.outcome, 'not-creatable');
  assert.match(merged?.instruction ?? '', /cannot express "merged" as a label/);
  assert.match(merged?.instruction ?? '', /takumi board --check/, 'an instruction must say what to do next');
  // Only the expressible state was written.
  assert.deepEqual(fake.calls(), [`GET ${LABELS}?per_page=100&page=1`, `POST ${LABELS}`]);
  assert.deepEqual(fake.labelsOnBoard().map((label) => label.name), ['takumi-ready']);
});

test('bootstrapStates: a refused label create is classified, never reported as success', async () => {
  const fake = new FakeGitLab({ project: PROJECT, username: TRUSTED });
  const provider = new GitLabBoardProvider({ project: PROJECT, apiBase: API, request: fake.request });

  fake.failWhen((req) => req.method === 'POST' && req.url.endsWith('/labels'), 403);
  await assert.rejects(
    () => provider.bootstrapStates(['ready']),
    boardError('auth', /createLabel takumi-ready failed with HTTP 403/),
  );
  assert.deepEqual(fake.labelsOnBoard(), [], 'a failed bootstrap must not look like it worked');

  // A 409 (somebody created the label between our read and our write) is a
  // precondition: retrying it changes nothing, so it must not be retriable.
  fake.clearFaults();
  fake.failWhen((req) => req.method === 'POST' && req.url.endsWith('/labels'), 409, '{"message":"Label already exists"}');
  await assert.rejects(
    () => provider.bootstrapStates(['ready']),
    (e: unknown) => boardError('precondition', /already exists/)(e) && (e as BoardError).retriable === false,
  );
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
