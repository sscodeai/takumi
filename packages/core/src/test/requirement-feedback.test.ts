import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFeedback, openFeedback, parseFeedback, resolveFeedback } from '../index.js';

// The write-back module (ADR-029). Everything here returns TEXT: the requirement document is
// hand-written and commented, so the writes are textual edits whose result the caller validates before
// it lands. These tests pin the two properties the loop depends on — the entry is readable back, and
// the write does not destroy the document it edits — plus the refusals.

const DOC = [
  '# A commented requirement document.',
  'requirement:',
  '  id: REQ-DOC-001',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: What happens to a malformed row?',
  '    chosen: "skip and count"',
  '    blocking: true',
  '',
  'confirmation:',
  '  by: "SS"',
  '  at: "2026-10-01T00:00:00.000Z"',
  '  method: bounded-choice',
  '',
].join('\n');

const input = {
  at: '2026-10-01T03:00:00.000Z',
  run: '2026-10-01T02-59-00-000Z',
  requirementDigest: 'sha256:aaa',
  judgeDigest: 'sha256:bbb',
  checks: ['DEC-002 AMB-002 NOT honoured: "First row wins" (checked by REL-003, which failed)'],
};

test('feedback: an entry is appended after the confirmation block and reads back', () => {
  const appended = appendFeedback(DOC, input);
  assert.equal(appended.duplicate, false);
  assert.equal(appended.id, 'FB-001');
  assert.match(appended.text, /^feedback:$/m);
  assert.match(appended.text, /^  - id: FB-001$/m);
  assert.match(appended.text, /^    status: open$/m);

  const entries = parseFeedback(appended.text);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0]?.checks, input.checks);
  assert.equal(entries[0]?.run, input.run);
  assert.equal(openFeedback(appended.text).length, 1);
});

test('feedback: the append is textual — the comments and the human text survive', () => {
  const appended = appendFeedback(DOC, input);
  assert.match(appended.text, /^# A commented requirement document\.$/m);
  assert.match(appended.text, /^    question: What happens to a malformed row\?$/m);
  assert.match(appended.text, /^confirmation:$/m);
  assert.match(appended.text, /^  by: "SS"$/m);
});

test('feedback: a second failure takes the next id, and the first entry is left alone', () => {
  const first = appendFeedback(DOC, input);
  const second = appendFeedback(first.text, { ...input, run: 'another-run', requirementDigest: 'sha256:ccc' });
  assert.equal(second.id, 'FB-002');
  const entries = parseFeedback(second.text);
  assert.deepEqual(entries.map((e) => e.id), ['FB-001', 'FB-002']);
  assert.equal(entries[0]?.requirementDigest, 'sha256:aaa');
  assert.equal(openFeedback(second.text).length, 2);
});

test('feedback: the same run at the same digest is not recorded twice', () => {
  const first = appendFeedback(DOC, input);
  const again = appendFeedback(first.text, input);
  assert.equal(again.duplicate, true);
  assert.equal(again.id, 'FB-001');
  assert.equal(again.text, first.text, 'the document is unchanged');
});

test('feedback: a resolution needs a note, and records who resolved it', () => {
  const appended = appendFeedback(DOC, input);
  const empty = resolveFeedback(appended.text, 'FB-001', 'SS', '   ', '2026-10-01T04:00:00.000Z');
  assert.match(empty.error ?? '', /needs a note/);
  assert.equal(empty.text, appended.text, 'nothing changes on a refusal');

  const resolved = resolveFeedback(appended.text, 'FB-001', 'SS', 'the implementation now keeps the latest start_date', '2026-10-01T04:00:00.000Z');
  assert.equal(resolved.error, undefined);
  const entries = parseFeedback(resolved.text);
  assert.equal(entries[0]?.status, 'resolved');
  assert.equal(entries[0]?.resolvedBy, 'SS');
  assert.match(entries[0]?.resolvedNote ?? '', /keeps the latest start_date/);
  assert.equal(openFeedback(resolved.text).length, 0);
  // The entry itself is still readable: a resolution does not erase the failure.
  assert.deepEqual(entries[0]?.checks, input.checks);
  assert.match(resolved.text, /^# A commented requirement document\.$/m);
});

test('feedback: resolving is refused for an unknown entry and for an already-resolved one', () => {
  const appended = appendFeedback(DOC, input);
  assert.match(resolveFeedback(appended.text, 'FB-099', 'SS', 'a note', 'now').error ?? '', /records no feedback entry FB-099/);
  const once = resolveFeedback(appended.text, 'FB-001', 'SS', 'a note', '2026-10-01T04:00:00.000Z');
  const twice = resolveFeedback(once.text, 'FB-001', 'SS', 'a different note', '2026-10-01T05:00:00.000Z');
  assert.match(twice.error ?? '', /already resolved/);
  assert.equal(twice.text, once.text);
});

test('feedback: a document with no feedback block reports no entries rather than throwing', () => {
  assert.deepEqual(parseFeedback(DOC), []);
  assert.deepEqual(parseFeedback('not: [valid'), []);
  assert.deepEqual(parseFeedback(''), []);
});
