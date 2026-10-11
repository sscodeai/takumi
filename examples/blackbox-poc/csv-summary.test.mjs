#!/usr/bin/env node
// The deliverable's OWN test, for the black-box acceptance PoC (ADR-026).
//
// It is deliberately written to the implementer's blind spot: it asserts the summary's SHAPE and the
// per-department numbers from one fixture, and it does NOT assert that the department totals add up
// to the printed overall total. So it passes for BOTH `csv-summary.mjs` and
// `csv-summary-broken.mjs` — which is the point of the demonstration: a green `quality_gate` says
// the implementer's tests pass, not that the requirement is met. The forged judge, which derives its
// relations from the requirement, catches the defect this test cannot see.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const TOOL = new URL('./csv-summary.mjs', import.meta.url).pathname;

function summarise(csv) {
  const dir = mkdtempSync(join(tmpdir(), 'csv-test-'));
  try {
    const path = join(dir, 'input.csv');
    writeFileSync(path, csv);
    return execFileSync(process.execPath, [TOOL, path], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the summary names a department per line, with a count, a total and an average', () => {
  const out = summarise(
    ['employee_id,name,department,start_date,annual_salary', '1,Ada,Engineering,2021-01-01,100', '2,Alan,Engineering,2021-01-02,200', '3,Grace,Sales,2021-01-03,300', ''].join('\n'),
  );
  const lines = out.trim().split('\n');
  assert.match(lines[0] ?? '', /^Engineering 2 \d+ \d+$/, `got: ${lines[0]}`);
  assert.match(lines[1] ?? '', /^Sales 1 \d+ \d+$/, `got: ${lines[1]}`);
  assert.match(out, /^TOTAL 3 \d+$/m);
  assert.match(out, /^SKIPPED 0$/m);
});

test('a malformed row is skipped and counted', () => {
  const out = summarise(
    ['employee_id,name,department,start_date,annual_salary', '1,Ada,Engineering,2021-01-01,100', '2,Bad,Engineering,2021-01-01', ''].join('\n'),
  );
  assert.match(out, /^SKIPPED 1$/m);
  assert.match(out, /^TOTAL 1 \d+$/m);
});
