import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * LEDGER #103 — a FAILING quality gate that cannot say WHAT failed.
 *
 * Measured 2026-10-27: seven of seventeen classified refusals came out as "document" group with
 * `[no child record]`, and re-reading the records showed why. `quality_gate` built its summary as
 *
 *     `${out.slice(0, 1200)}`
 *
 * — a HEAD slice. The intake shape gate emits a TAP stream whose first lines are `ok 1 - the intake
 * wrote ...` followed by the decisions it found, which in the failing sample ran to ~1383 bytes. The
 * `not ok` line that said WHICH of the six checks failed was past the cut, so every failing run
 * recorded one passing check and no reason. `scripts/chain-failures.sh` could not attribute them and
 * reported "UNKNOWN: the record says only refused", which reads like a classifier weakness but is
 * actually the engine throwing the evidence away before it is written.
 *
 * A tail slice alone would fix this case and break the other one: a 6000-line test run puts its only
 * `not ok` near the top. What has to survive is the FALSIFYING LINES, wherever they are.
 */

const { summariseGateOutput } = await import('../quality-gate-output.js');

test('a failing gate keeps the `not ok` line even when it is past the head budget', () => {
  const out = [
    'ok 1 - the intake wrote docs/requirements/intake.yaml',
    ...Array.from({ length: 40 }, (_, i) => `# decision ${i}: a line of explanatory prose about the document`),
    'not ok 4 - the document declares a relation its field model cannot carry',
    'not ok 5 - a decision nobody made',
  ].join('\n');
  assert.ok(out.length > 1200, 'the fixture is longer than the old budget, or it does not test the bug');

  const kept = summariseGateOutput(out);
  assert.match(kept, /not ok 4 - the document declares a relation its field model cannot carry/);
  assert.match(kept, /not ok 5 - a decision nobody made/);
  assert.ok(kept.length <= 4000, 'the summary still has a bound');
});

test('a failing gate keeps the failing lines of a test framework that reports them as `FAIL`/`✗`', () => {
  const out = [
    ...Array.from({ length: 60 }, (_, i) => `  ✓ passes ${i}`),
    '  ✗ refuses a ratio document that also claims additivity',
    ...Array.from({ length: 60 }, (_, i) => `  ✓ passes later ${i}`),
  ].join('\n');
  const kept = summariseGateOutput(out);
  assert.match(kept, /✗ refuses a ratio document that also claims additivity/);
});

test('a PASSING gate is not padded with its own `ok` lines: the head is enough', () => {
  const out = [
    'ok 1 - wrote the document',
    ...Array.from({ length: 200 }, (_, i) => `ok ${i + 2} - check ${i}`),
  ].join('\n');
  const kept = summariseGateOutput(out);
  assert.ok(kept.length <= 1200, 'a passing gate needs no rescue');
});

test('the kept text names how much was dropped, so a truncated summary is visibly truncated', () => {
  const out = [
    ...Array.from({ length: 100 }, (_, i) => `# filler ${i} ${'x'.repeat(40)}`),
    'not ok 1 - the real reason',
  ].join('\n');
  const kept = summariseGateOutput(out);
  assert.match(kept, /not ok 1 - the real reason/);
  assert.match(kept, /\d+ earlier line\(s\) omitted|\d+ line\(s\) omitted/, 'the cut is stated, not silent');
});
