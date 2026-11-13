import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LEDGER #145 — a failure that cannot be re-read is a failure that cannot be diagnosed.
 *
 * `measure-intake-rate.sh` wrote every run to `$LOGDIR/run-<i>-<shape>.log`, so measuring twice into the
 * same `--logdir` OVERWROTE the first batch while `report.tsv` kept appending — the two then disagreed.
 *
 * This is not hypothetical. It actively corrupted a real investigation: while chasing why a run reported
 * "the requirement document is not the one that was confirmed", reading `run-2-aggregate.log` produced
 * TWO different confirmation tokens, and the conclusion drawn was that one run had confirmed twice. It
 * had not — the tail of one run and a stale artifact from another were being read as one document. An
 * hour went into a defect that did not exist, because the evidence had been overwritten.
 *
 * These tests pin the two properties that make the evidence trustworthy:
 *   - each invocation writes into its own timestamped directory, so nothing overwrites anything;
 *   - the report carries the log path AND the first named reason, so a batch's failures can be read as a
 *     table instead of by grepping logs that may not be the run they claim to be.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = readFileSync(join(REPO, 'scripts/measure-intake-rate.sh'), 'utf8');

test('each invocation writes to its own timestamped directory', () => {
  assert.match(SCRIPT, /STAMP=\$\(date -u \+%Y%m%dT%H%M%SZ\)/, 'a UTC stamp per invocation');
  assert.match(SCRIPT, /LOGDIR="\$LOGDIR\/\$STAMP"/, 'and the log dir is nested under it');
  assert.match(SCRIPT, /mkdir -p "\$LOGDIR"/, 'the directory is created, not assumed');
});

test('the batch directory is announced, so a reader can find the batch it is looking at', () => {
  assert.match(SCRIPT, /measure-intake-rate: batch \$STAMP -> \$LOGDIR/, 'the batch id is printed');
});

test('the report records the log path and the first named reason', () => {
  const header = SCRIPT.match(/^printf 'shape\\trun\\tfirst_attempt_ok\\tdelivered\\tseconds\\t([^']*)'/m);
  assert.ok(header, 'the report header exists');
  assert.equal(header?.[1], 'log\\treason\\n', 'the header declares the log path and the reason');
  assert.match(SCRIPT, /reason=\$\(grep -hoE/, 'a reason is captured');
  assert.match(SCRIPT, /\$\{reason:-\}/, 'and written into the row');
});

test('the reason patterns cover the failures actually observed', () => {
  // Each of these named itself in a real run this cycle; a pattern that misses one leaves the row blank
  // even though the log says exactly what went wrong.
  for (const marker of [
    'FORGE SAID: ',
    'is not valid YAML',
    'not the one that was confirmed',
    'timeout after ',
  ]) {
    assert.ok(SCRIPT.includes(marker), `the reason capture recognises: ${marker}`);
  }
});

test('the reason is flattened to one line, so the TSV stays parseable', () => {
  assert.ok(SCRIPT.includes("tr '\\t\\n' '  '"), 'tabs and newlines become spaces');
  assert.match(SCRIPT, /cut -c1-90/, 'and it is truncated to fit one column');
});
