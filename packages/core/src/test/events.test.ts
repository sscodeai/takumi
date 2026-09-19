import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arraySink,
  createEventLog,
  EVENT_KINDS,
  formatEventLine,
  isEventKind,
  lineSink,
  nullEventLog,
  ProviderError,
} from '../index.js';
import type { RunEvent } from '../index.js';

/**
 * The event registry is an audit trail, so the tests are about the two ways such a
 * trail becomes worthless: a vocabulary that drifts, and a side channel that
 * decides the outcome of the thing it is describing.
 */

test('the registry is closed and every kind is namespaced', () => {
  assert.ok(EVENT_KINDS.length >= 15);
  for (const kind of EVENT_KINDS) {
    assert.match(kind, /^[a-z]+\.[a-z_]+$/, `event kind ${kind} must be <domain>.<action>`);
  }
  assert.equal(new Set(EVENT_KINDS).size, EVENT_KINDS.length, 'no duplicate kinds');
  assert.equal(isEventKind('deliver.pushed'), true);
  assert.equal(isEventKind('deliver.something_new'), false);
  // The shape the lock module emits: this is the seam between the two P0 pieces.
  assert.equal(isEventKind('slot.busy'), true);
});

test('emit: records a known event with its timestamp, run id and message', () => {
  const log = createEventLog({ now: () => Date.parse('2026-09-15T01:02:03.000Z') });
  const event = log.emit({ kind: 'claim.acquired', runId: 'c0ffee01', itemId: '42', message: 'claimed' });
  assert.equal(event.at, '2026-09-15T01:02:03.000Z');
  assert.equal(event.kind, 'claim.acquired');
  assert.equal(event.itemId, '42');
  assert.deepEqual(log.events(), [event]);
  assert.deepEqual(log.of('claim.acquired'), [event]);
  assert.deepEqual(log.of('merge.done'), []);
});

test('emit: an unregistered kind FAILS rather than entering the trail', () => {
  const written: RunEvent[] = [];
  const log = createEventLog({ sink: arraySink(written), retain: false });
  assert.throws(
    () => log.emit({ kind: 'deliver.made_up' as never, runId: 'c0ffee01', message: 'nope' }),
    (e: unknown) => e instanceof ProviderError && e.kind === 'precondition' && /unregistered event kind/.test(e.message),
  );
  assert.deepEqual(written, [], 'an unregistered event must not reach the sink');
});

test('emit: an event without a run id FAILS (an unexplained event is noise)', () => {
  const log = createEventLog();
  assert.throws(
    () => log.emit({ kind: 'claim.acquired', runId: '', message: 'claimed' }),
    (e: unknown) => e instanceof ProviderError && e.kind === 'precondition' && /must carry a runId/.test(e.message),
  );
});

test('emit: a broken sink never changes the outcome of the work it describes', () => {
  const seen: unknown[] = [];
  const log = createEventLog({
    sink: {
      write: () => {
        throw new Error('the disk is full');
      },
    },
    onSinkError: (error) => seen.push(error),
  });
  const event = log.emit({ kind: 'deliver.pushed', runId: 'c0ffee01', message: 'pushed' });
  assert.equal(event.kind, 'deliver.pushed', 'emit still returns the event');
  assert.equal(seen.length, 1, 'the caller can still hear about the broken sink');
  assert.match(String((seen[0] as Error).message), /disk is full/);
});

test('formatEventLine: one line, stable key order, and a message that round-trips', () => {
  const line = formatEventLine({
    at: '2026-09-15T00:00:00.000Z',
    kind: 'board.commented',
    runId: 'c0ffee01',
    itemId: '42',
    pr: '7',
    message: 'line one\nline two',
    fields: { round: 2, ok: true, note: null },
  });
  assert.equal(line.includes('\n'), false, 'a formatted event must be exactly one line');
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['at', 'kind', 'runId', 'itemId', 'pr', 'message', 'fields']);
  // JSON escapes the newline, so the LINE stays single while the VALUE survives
  // exactly: a reader never has to un-escape an escape we invented.
  assert.equal(parsed.message, 'line one\nline two');
  assert.deepEqual(parsed.fields, { round: 2, ok: true, note: null });
});

test('lineSink: hands the writer complete lines, and arraySink keeps the objects', () => {
  const lines: string[] = [];
  const toLines = createEventLog({ sink: lineSink((line) => lines.push(line)), retain: false });
  toLines.emit({ kind: 'review.clean', runId: 'c0ffee01', message: 'clean' });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.endsWith('\n'), true);

  const kept: RunEvent[] = [];
  const toArray = createEventLog({ sink: arraySink(kept), retain: false });
  toArray.emit({ kind: 'review.findings', runId: 'c0ffee01', message: 'findings' });
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.kind, 'review.findings');
});

test('nullEventLog: keeps nothing and writes nothing, so wiring it up costs nothing', () => {
  const log = nullEventLog();
  log.emit({ kind: 'slot.acquired', runId: 'c0ffee01', message: 'acquired' });
  assert.deepEqual(log.events(), []);
});
