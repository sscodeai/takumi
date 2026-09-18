import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardError, BoardUnsupportedError, runTaskBoardProviderContractSuite } from '@takumi/core';
import type { BoardStateRecord } from '@takumi/core';
import { FakeBoardProvider } from '../index.js';

// FakeBoardProvider runs the SHARED Task-Board Contract Suite (ADR-006).
// The same suite runs against the GitHub, GitLab, Jira and Notion adapters —
// proving Core never learns a board's internals.

function seeded(overrides: ConstructorParameters<typeof FakeBoardProvider>[0] = {}): FakeBoardProvider {
  return new FakeBoardProvider({ items: [{ id: 'T-1', state: 'ready', labels: ['takumi-ready'] }], ...overrides });
}

test('FakeBoardProvider: shared task-board contract suite', async () => {
  const out = await runTaskBoardProviderContractSuite(seeded(), {
    id: 'fake',
    itemId: 'T-1',
    writeUntrustedRecord: (provider, record) =>
      provider.writeState('T-1', record, { author: { login: 'drive-by', trusted: false } }),
  });
  assert.equal(out.gate, 'task-board-contract');
  assert.equal(out.result, 'PASS');
});

test('FakeBoardProvider: a second claim is refused with a reason, never silently accepted', async () => {
  const board = seeded();
  const first = await board.claim('T-1', 'aaaaaaaa');
  assert.equal(first.claimed, true);
  const second = await board.claim('T-1', 'bbbbbbbb');
  assert.equal(second.claimed, false);
  assert.match(second.reason ?? '', /already claimed by aaaaaaaa/);
});

test('FakeBoardProvider: an item that is not ready cannot be claimed', async () => {
  const board = seeded({ items: [{ id: 'T-2', state: 'blocked' }] });
  const result = await board.claim('T-2', 'aaaaaaaa');
  assert.equal(result.claimed, false);
  assert.match(result.reason ?? '', /state blocked, not ready/);
});

test('FakeBoardProvider: one progress comment per run, updated in place', async () => {
  const board = seeded();
  const first = await board.comment('T-1', 'starting', { runId: 'aaaaaaaa' });
  const second = await board.comment('T-1', 'still working', { runId: 'aaaaaaaa' });
  assert.equal(first.comment, second.comment);
  assert.deepEqual(board.commentsOf('T-1'), ['still working']);
  await board.updateComment(second, 'done');
  assert.deepEqual(board.commentsOf('T-1'), ['done']);
  // A different run gets its own comment.
  const other = await board.comment('T-1', 'other run', { runId: 'bbbbbbbb' });
  assert.notEqual(other.comment, first.comment);
});

test('FakeBoardProvider: an untrusted author\'s state record is stored but never returned', async () => {
  const board = seeded();
  const record: BoardStateRecord = {
    schema: 1,
    runId: 'aaaaaaaa',
    item: 'T-1',
    reviewRound: 0,
    updatedAt: '2026-09-15T00:00:00.000Z',
  };
  await board.writeState('T-1', record);
  assert.equal((await board.readState('T-1'))?.runId, 'aaaaaaaa');

  await board.writeState('T-1', { ...record, runId: 'deadbeef' }, { author: { login: 'drive-by', trusted: false } });
  assert.equal((await board.readState('T-1'))?.runId, 'aaaaaaaa', 'the untrusted record must not win');
  // ... but the board still physically carries both blocks, which is why reads filter.
  assert.equal(board.rawStateComments('T-1').length, 2);
});

test('FakeBoardProvider: a state record for another item is rejected', async () => {
  const board = seeded();
  await assert.rejects(
    () =>
      board.writeState('T-1', { schema: 1, runId: 'aaaaaaaa', item: 'T-9', reviewRound: 0, updatedAt: '2026-09-15T00:00:00.000Z' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition',
  );
});

test('FakeBoardProvider: a narrowed provider gates its operations fail-closed', async () => {
  const board = seeded({ capabilities: { comments: false, machineReadableState: false } });
  await assert.rejects(() => board.comment('T-1', 'x', { runId: 'aaaaaaaa' }), BoardUnsupportedError);
  await assert.rejects(() => board.readState('T-1'), BoardUnsupportedError);
  // listWork / claim / transition stay available.
  assert.equal((await board.listWork()).length, 1);
});

test('FakeBoardProvider: listWork filters by state and limit', async () => {
  const board = new FakeBoardProvider({
    items: [
      { id: 'A', state: 'ready' },
      { id: 'B', state: 'claimed' },
      { id: 'C', state: 'ready' },
    ],
  });
  assert.deepEqual((await board.listWork({ states: ['ready'] })).map((i) => i.id), ['A', 'C']);
  assert.deepEqual((await board.listWork({ limit: 2 })).map((i) => i.id), ['A', 'B']);
  assert.deepEqual((await board.listWork({ labels: ['nope'] })), []);
});

test('FakeBoardProvider: deterministic clock keeps timestamps reproducible', async () => {
  let now = 1_700_000_000_000;
  const board = new FakeBoardProvider({ clock: () => now, items: [{ id: 'A' }] });
  await board.claim('A', 'aaaaaaaa');
  const first = (await board.getWork('A')).updatedAt;
  now += 60_000;
  await board.transition('A', 'pr_open', { runId: 'aaaaaaaa' });
  const second = (await board.getWork('A')).updatedAt;
  assert.notEqual(first, second);
  assert.equal(second, new Date(now).toISOString());
});
