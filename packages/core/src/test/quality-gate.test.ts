import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, judgeGate, parseTestReport, WorkflowDefinition } from '../index.js';
import { TestRuntime } from '../test-utils.js';

// The quality gate must FAIL CLOSED: output it cannot parse is not evidence of
// a green suite. These tests were written before the fix and were red against
// the legacy `(fails > 0 ? fails : 1)` fallback.

// --- jest / vitest ---------------------------------------------------------

test('quality gate: jest green parses the real total, not 1', () => {
  const report = parseTestReport('Tests:       6 passed, 6 total\nTime:        0.8 s\n');
  assert.equal(report.shape, 'jest');
  assert.deepEqual(report, { shape: 'jest', total: 6, failed: 0, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, true, `expected PASS (got: ${verdict.reason})`);
});

test('quality gate: jest all-skipped is a failure even on exit 0', () => {
  const report = parseTestReport('Tests:       10 skipped, 10 total\nTime:        0.2 s\n');
  assert.equal(report.shape, 'jest');
  assert.deepEqual(report, { shape: 'jest', total: 10, failed: 0, skipped: 10 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false, 'every test skipped proves nothing');
  assert.match(verdict.reason, /every test was skipped/i);
});

test('quality gate: vitest summary is recognised', () => {
  const report = parseTestReport(' Test Files  1 passed (1)\n      Tests  6 passed (6)\n');
  assert.deepEqual(report, { shape: 'jest', total: 6, failed: 0, skipped: 0 });
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, true);
});

test('quality gate: jest output with no Tests: line is unrecognised', () => {
  const report = parseTestReport('PASS src/a.test.ts\nTest Suites: 1 passed, 1 total\nRan all test suites.\n');
  assert.equal(report.shape, 'unrecognised');
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /no known test summary/i);
});

test('quality gate: "No tests found" and --passWithNoTests are unrecognised', () => {
  for (const out of ['No tests found, exiting with code 0\n', 'No tests found\n--passWithNoTests\n']) {
    const report = parseTestReport(out);
    assert.equal(report.shape, 'unrecognised', `expected unrecognised for: ${out.trim()}`);
    const verdict = judgeGate(report, { exitOk: true, hardFail: false });
    assert.equal(verdict.passed, false, `must fail closed for: ${out.trim()}`);
  }
});

// --- pytest / gradle -------------------------------------------------------

test('quality gate: pytest green is recognised and passes', () => {
  const report = parseTestReport('==================== 2 passed in 0.42s ====================\n');
  assert.deepEqual(report, { shape: 'pytest', total: 2, failed: 0, skipped: 0 });
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, true);
});

test('quality gate: pytest mixed summary counts failures and skips', () => {
  const report = parseTestReport('= 1 failed, 2 passed, 1 skipped in 0.42s =\n');
  assert.deepEqual(report, { shape: 'pytest', total: 4, failed: 1, skipped: 1 });
  const verdict = judgeGate(report, { exitOk: false, hardFail: false });
  assert.equal(verdict.passed, false);
});

test('quality gate: pytest "no tests ran" is unrecognised', () => {
  const report = parseTestReport('no tests ran in 0.01s\n');
  assert.equal(report.shape, 'unrecognised');
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, false);
});

test('quality gate: gradle / JUnit green is recognised and passes', () => {
  const report = parseTestReport('3 tests completed, 0 failed\n');
  assert.deepEqual(report, { shape: 'gradle', total: 3, failed: 0, skipped: 0 });
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, true);
});

test('quality gate: gradle failure summary fails', () => {
  const report = parseTestReport('3 tests completed, 1 failed\n');
  assert.deepEqual(report, { shape: 'gradle', total: 3, failed: 1, skipped: 0 });
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, false);
});

// --- TAP (regression guard: keep the existing strength) --------------------

test('quality gate: node --test TAP green still passes with the real total', () => {
  const tap = '# tests 3\n# pass 3\n# fail 0\nok 1 - first\nok 2 - second\n';
  const report = parseTestReport(tap);
  assert.deepEqual(report, { shape: 'tap', total: 3, failed: 0, skipped: 0 });
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, true);
});

test('quality gate: TAP "# tests 0" still fails (no vacuous green)', () => {
  const report = parseTestReport('# tests 0\n# pass 0\n# fail 0\n');
  assert.deepEqual(report, { shape: 'tap', total: 0, failed: 0, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /0 tests ran/i);
});

test('quality gate: TAP "not ok" without a summary still fails', () => {
  const report = parseTestReport('not ok 1 - broken\n');
  assert.equal(report.shape, 'tap');
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, false);
});

test('quality gate: TAP "# skip N" counts skipped tests as no evidence', () => {
  const report = parseTestReport('# tests 3\n# pass 0\n# fail 0\n# skip 3\nok 1 # SKIP\n');
  assert.deepEqual(report, { shape: 'tap', total: 3, failed: 0, skipped: 3 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /every test was skipped/i);
});

// --- Maven (regression guard: keep the existing strength) ------------------

test('quality gate: Maven green still passes', () => {
  const report = parseTestReport('[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD SUCCESS\n');
  assert.deepEqual(report, { shape: 'maven', total: 2, failed: 0, skipped: 0 });
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, true);
});

test('quality gate: Maven BUILD FAILURE is a hard fail', () => {
  const out = '[INFO] Tests run: 2, Failures: 0, Errors: 0, Skipped: 0\n[INFO] BUILD FAILURE\n';
  const report = parseTestReport(out);
  assert.equal(report.shape, 'maven');
  const verdict = judgeGate(report, { exitOk: true, hardFail: true });
  assert.equal(verdict.passed, false);
});

test('quality gate: a non-zero exit is always a hard fail', () => {
  const report = parseTestReport('Tests:       6 passed, 6 total\n');
  const verdict = judgeGate(report, { exitOk: false, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /non-zero/i);
});

test('quality gate: Maven skipped-only run fails closed', () => {
  const report = parseTestReport('[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 4\n');
  assert.deepEqual(report, { shape: 'maven', total: 4, failed: 0, skipped: 4 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /every test was skipped/i);
});

// --- integration: the step summary must stay diagnosable -------------------

test('quality gate step: unparseable output fails with the command and output tail in the summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qg-unrecognised-'));
  try {
    writeFileSync(
      join(dir, 'ghost.sh'),
      '#!/bin/sh\necho "PASS src/a.test.ts"\necho "Test Suites: 1 passed, 1 total"\necho "ghost run finished"\nexit 0\n',
    );
    chmodSync(join(dir, 'ghost.sh'), 0o755);
    const rt = new TestRuntime(() => 'ok', undefined, 'qg-unrecognised');
    const wf: WorkflowDefinition = {
      name: 'qg-unrecognised',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'gate', type: 'quality_gate', prompt: 'sh ghost.sh' }],
    };
    const res = await executeWorkflow(wf, {
      cwd: dir,
      runtime: rt,
      artifacts: new ArtifactStore(join(dir, '.takumi/a')),
      onApproval: () => true,
    });
    const gate = res.steps.find((s) => s.stepId === 'gate');
    assert.ok(gate && gate.status === 'failed', 'unrecognised output must fail the gate');
    assert.equal(res.status, 'failed', 'workflow aborts on a failed gate');
    assert.ok(/quality_gate FAILED/i.test(gate.summary), `summary flags FAILED (got: ${gate.summary.slice(0, 80)})`);
    assert.match(gate.summary, /0 failing over 0 tests/, 'first line keeps the existing shape');
    assert.match(gate.summary, /sh ghost\.sh/, 'summary names the raw command');
    assert.match(gate.summary, /no known test summary/i, 'summary explains the fail-closed reason');
    assert.match(gate.summary, /ghost run finished/, 'summary keeps the output tail');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
