import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_STATE_MARKER_VERSION,
  BoardStateRecordError,
  newestBoardStateRecord,
  parseBoardStateRecord,
  renderBoardStateRecord,
  validateBoardStateRecord,
} from '../index.js';
import type { BoardStateRecord } from '../index.js';

// The versioned state record is the ONE machine-readable thing takumi writes
// back to a board, so its grammar is pinned here: a wording change must never
// be able to change control flow, and a corrupted record must fail loudly
// instead of looking like a fresh run.

const record: BoardStateRecord = {
  schema: 1,
  runId: 'abc12345',
  item: 'T-1',
  baseBranch: 'main',
  deliveryRef: '#7',
  reviewRound: 2,
  updatedAt: '2026-09-15T00:00:00.000Z',
};

test('render: emits a hidden versioned block carrying the whole record', () => {
  const rendered = renderBoardStateRecord(record);
  assert.match(rendered, /^<!-- takumi:boardstate:v1 /);
  assert.match(rendered, /-->$/);
  assert.ok(rendered.startsWith('<!--'));
  // Hidden in rendered markdown: an HTML comment, never visible text.
  assert.equal(rendered.split('-->').length, 2);
});

test('round-trip: parse(render(record)) equals the record', () => {
  const parsed = parseBoardStateRecord(`Some human text\n\n${renderBoardStateRecord(record)}\nmore text`);
  assert.deepEqual(parsed, record);
});

test('parse: text without a block is null, not an error', () => {
  assert.equal(parseBoardStateRecord('just a normal comment'), null);
  assert.equal(parseBoardStateRecord(''), null);
});

test('parse: a present but malformed block is CORRUPTED, never silently null', () => {
  assert.throws(() => parseBoardStateRecord('<!-- takumi:boardstate:v1 {oops} -->'), BoardStateRecordError);
  assert.throws(() => parseBoardStateRecord('<!-- takumi:boardstate:v1 -->'), BoardStateRecordError);
  assert.throws(() => parseBoardStateRecord('<!-- takumi:boardstate:v1 [1,2] -->'), BoardStateRecordError);
});

test('parse: a truncated payload still matches the marker and fails as corrupted', () => {
  const truncated = renderBoardStateRecord(record).slice(0, 40);
  assert.throws(() => parseBoardStateRecord(`${truncated} -->`), BoardStateRecordError);
});

test('validate: rejects a future schema and missing required fields', () => {
  assert.throws(() => validateBoardStateRecord({ ...record, schema: 2 }), /unsupported schema 2/);
  assert.throws(() => validateBoardStateRecord({ schema: 1, item: 'T-1', reviewRound: 0 }), /missing runId/);
  assert.throws(() => validateBoardStateRecord({ schema: 1, runId: 'a', reviewRound: 0 }), /missing item/);
  assert.throws(() => validateBoardStateRecord({ schema: 1, runId: 'a', item: 'b', reviewRound: -1 }), /invalid reviewRound/);
});

test('validate: optional fields survive and unknown ones are dropped', () => {
  const validated = validateBoardStateRecord({
    schema: BOARD_STATE_MARKER_VERSION,
    runId: 'r1',
    item: 'T-1',
    reviewRound: 1,
    updatedAt: '2026-09-15T00:00:00.000Z',
    futureField: 'ignored',
  });
  assert.equal(validated.runId, 'r1');
  assert.equal(validated.baseBranch, undefined);
  assert.equal(Object.hasOwn(validated, 'futureField'), false);
});

test('render: refuses to write a schema this takumi does not speak', () => {
  assert.throws(() => renderBoardStateRecord({ ...record, schema: 2 as unknown as 1 }), BoardStateRecordError);
});

test('newestBoardStateRecord: picks the newest record across candidate texts', () => {
  const older = renderBoardStateRecord({ ...record, runId: 'aaaa0001', updatedAt: '2026-09-15T00:00:00.000Z' });
  const newer = renderBoardStateRecord({ ...record, runId: 'bbbb0002', updatedAt: '2026-09-15T01:00:00.000Z' });
  assert.equal(newestBoardStateRecord([older, newer])?.runId, 'bbbb0002');
  assert.equal(newestBoardStateRecord([newer, older])?.runId, 'bbbb0002');
  assert.equal(newestBoardStateRecord(['no block here']), null);
  assert.equal(newestBoardStateRecord([]), null);
});
