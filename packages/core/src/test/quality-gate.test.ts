import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, detectHardFailure, executeWorkflow, judgeGate, parseTestReport, WorkflowDefinition } from '../index.js';
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

// --- Python stdlib unittest (docs/bugs-fixed.md #45) -----------------------
//
// A delivered project may test itself with the standard library
// (`python3 -m unittest discover -v`), and the gate read that as nothing at all
// — then reported the absence as `0 failing`, which misled both the human and
// the repair agent. The shape is recognised only when the `Ran N tests in …`
// line AND the `OK`/`FAILED` line are BOTH present: a stray `OK` in unrelated
// output is not a test run.

test('quality gate: unittest verbose with 1 failure and 2 errors counts both', () => {
  const out = [
    'test_alpha (tests.test_summary.Foo.test_alpha) ... ok',
    'test_beta (tests.test_summary.Foo.test_beta) ... FAIL',
    'test_gamma (tests.test_summary.Foo.test_gamma) ... ERROR',
    '======================================================================',
    'FAIL: test_beta (tests.test_summary.Foo.test_beta)',
    '----------------------------------------------------------------------',
    'Traceback (most recent call last):',
    '  File "tests/test_summary.py", line 12, in test_beta',
    '    self.assertEqual(1, 2)',
    'AssertionError: expected 1, got 2',
    '----------------------------------------------------------------------',
    'ERROR: test_gamma (tests.test_summary.Foo.test_gamma)',
    '----------------------------------------------------------------------',
    'Traceback (most recent call last):',
    '  File "tests/test_summary.py", line 20, in test_gamma',
    '    raise RuntimeError("boom")',
    'RuntimeError: boom',
    '----------------------------------------------------------------------',
    'Ran 12 tests in 0.003s',
    '',
    'FAILED (failures=1, errors=2)',
    '',
  ].join('\n');
  const report = parseTestReport(out);
  assert.deepEqual(report, { shape: 'unittest', total: 12, failed: 3, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false, 'a red unittest run fails the gate even on exit 0');
  assert.match(verdict.reason, /3 failing over 12 tests/i);
});

test('quality gate: unittest `OK` is a clean green run', () => {
  const out = [
    'test_alpha (tests.test_summary.Foo.test_alpha) ... ok',
    '',
    '----------------------------------------------------------------------',
    'Ran 12 tests in 0.003s',
    '',
    'OK',
    '',
  ].join('\n');
  const report = parseTestReport(out);
  assert.deepEqual(report, { shape: 'unittest', total: 12, failed: 0, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, true, `expected PASS (got: ${verdict.reason})`);
  assert.match(verdict.reason, /12 tests passed/i);
});

test('quality gate: unittest non-verbose output is recognised', () => {
  // Non-verbose prints only the two summary lines.
  const report = parseTestReport('Ran 5 tests in 0.010s\n\nFAILED (failures=2)\n');
  assert.deepEqual(report, { shape: 'unittest', total: 5, failed: 2, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /2 failing over 5 tests/i);
});

test('quality gate: unittest `FAILED` with only `errors=` counts the errors as failing', () => {
  const report = parseTestReport('Ran 4 tests in 0.004s\n\nFAILED (errors=1)\n');
  assert.deepEqual(report, { shape: 'unittest', total: 4, failed: 1, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false, 'an ERROR is a failing test, not a pass');
  assert.match(verdict.reason, /1 failing over 4 tests/i);
});

test('quality gate: unittest `FAILED` with neither count fails closed and says what it read', () => {
  const out = 'Ran 3 tests in 0.002s\n\nFAILED\n';
  const report = parseTestReport(out);
  assert.equal(report.shape, 'unrecognised', 'a FAILED line with no count is not readable as a report');
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false, 'a run that said FAILED must never be reported as 0 failing');
  assert.match(verdict.reason, /unittest/i, `reason says what it read (got: ${verdict.reason})`);
  assert.match(verdict.reason, /FAILED/, 'reason names the FAILED line it read');
  assert.match(verdict.reason, /failures=.*errors=/, 'reason names the counts it looked for');
  assert.match(verdict.reason, /Ran 3 tests in 0\.002s/, 'reason quotes the line it did read');
  assert.doesNotMatch(verdict.reason, /0 failing/);
});

test('quality gate: a stray `OK` with no `Ran N tests` line is not a unittest run', () => {
  for (const out of ['OK\n', 'build finished\nOK\n', 'all checks done\nOK\n']) {
    const report = parseTestReport(out);
    assert.equal(report.shape, 'unrecognised', `a stray OK must not be read as a green run: ${JSON.stringify(out)}`);
    const verdict = judgeGate(report, { exitOk: true, hardFail: false });
    assert.equal(verdict.passed, false, `must fail closed for: ${JSON.stringify(out)}`);
  }
  // The same guard applies to a stray `FAILED`.
  assert.equal(parseTestReport('FAILED\n').shape, 'unrecognised');
});

test('quality gate: a real pytest run stays pytest, and a unittest run is not read as pytest', () => {
  // pytest's matcher reads any `N passed` / `N failed` token, and a unittest
  // traceback can contain exactly that text — so the unittest shape is tried
  // before pytest, and neither may be read as the other.
  const pytestOut = [
    '=========================== short test summary info ============================',
    'FAILED tests/test_a.py::test_x - AssertionError: assert 1 == 2',
    '========================= 1 failed, 2 passed in 0.42s =========================',
    '',
  ].join('\n');
  assert.deepEqual(parseTestReport(pytestOut), { shape: 'pytest', total: 3, failed: 1, skipped: 0 });

  const unittestOut = [
    'test_alpha (tests.test_x.Foo.test_alpha) ... FAIL',
    '======================================================================',
    'FAIL: test_alpha (tests.test_x.Foo.test_alpha)',
    '----------------------------------------------------------------------',
    'Traceback (most recent call last):',
    'AssertionError: \'2 passed\' != \'1 failed\'',
    '----------------------------------------------------------------------',
    'Ran 4 tests in 0.005s',
    '',
    'FAILED (failures=1)',
    '',
  ].join('\n');
  assert.deepEqual(
    parseTestReport(unittestOut),
    { shape: 'unittest', total: 4, failed: 1, skipped: 0 },
    'a unittest run is read by its own counts, not by pytest reading its traceback',
  );
});

test('quality gate: an unreadable report names what was tried and never says `0 failing`', () => {
  const report = parseTestReport('PASS src/a.test.ts\nTest Suites: 1 passed, 1 total\ngate saw nothing it could read\n');
  assert.equal(report.shape, 'unrecognised');
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.reason, report.shape === 'unrecognised' ? report.reason : '');
  assert.match(verdict.reason, /could not be read as any known report/i, 'the message says what actually happened');
  assert.match(verdict.reason, /tried: TAP, jest\/vitest, unittest, pytest, Maven, gradle\/JUnit, CTRF/i, 'and names the shapes that were tried');
  assert.doesNotMatch(verdict.reason, /0 failing/, 'the misleading phrase is gone');
});

test('quality gate step: a stdlib unittest delivery is accepted, not refused as `0 failing`', async () => {
  // The live defect (run i12): `run-tests.sh` ran `python3 -m unittest discover -v`,
  // the gate read no report at all, and a COMPLETE delivery was refused twice with
  // `quality gate FAILED (0 failing)` — a message that says the tests failed when
  // they had not.
  const dir = mkdtempSync(join(tmpdir(), 'qg-unittest-'));
  try {
    writeFileSync(
      join(dir, 'run-tests.sh'),
      [
        '#!/bin/sh',
        'echo "test_alpha (tests.test_summary.Foo.test_alpha) ... ok"',
        'echo "test_beta (tests.test_summary.Foo.test_beta) ... ok"',
        'echo "----------------------------------------------------------------------"',
        'echo "Ran 12 tests in 0.003s"',
        'echo ""',
        'echo "OK"',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'run-tests.sh'), 0o755);
    const rt = new TestRuntime(() => 'ok', undefined, 'qg-unittest');
    const wf: WorkflowDefinition = {
      name: 'qg-unittest',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'gate', type: 'quality_gate', prompt: 'sh run-tests.sh' }],
    };
    const res = await executeWorkflow(wf, {
      cwd: dir,
      runtime: rt,
      artifacts: new ArtifactStore(join(dir, '.takumi/a')),
      onApproval: () => true,
    });
    const gate = res.steps.find((s) => s.stepId === 'gate');
    assert.equal(
      gate?.status,
      'completed',
      `a green stdlib unittest delivery must pass (got: ${gate?.summary?.slice(0, 200)})`,
    );
    assert.equal(res.status, 'completed');
    assert.match(gate.summary, /shape: unittest/, 'the gate names the shape it read');
    assert.match(gate.summary, /0 failing over 12 tests/, 'the REAL total, not 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// --- CTRF (Common Test Report Format, JSON) --------------------------------

test('quality gate: CTRF green is recognised and reports the real total', () => {
  // Minimal valid CTRF document (spec 0.1.0), emitted as a single JSON object.
  const ctrf = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'any-e2e-tool' },
      summary: { tests: 3, passed: 3, failed: 0, pending: 0, skipped: 0, other: 0, start: 1700000000000, stop: 1700000002000 },
      tests: [
        { name: 'opens the page', status: 'passed', duration: 800 },
        { name: 'logs in', status: 'passed', duration: 700 },
        { name: 'loads the dashboard', status: 'passed', duration: 500 },
      ],
    },
  });
  const report = parseTestReport(ctrf);
  assert.deepEqual(report, { shape: 'ctrf', total: 3, failed: 0, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, true, `expected PASS (got: ${verdict.reason})`);
  assert.match(verdict.reason, /3 tests passed/i);
});

test('quality gate: CTRF failures fail the run even when the runner exits 0', () => {
  // The whole point of parsing the report: several E2E tools exit 0 while their
  // report records failures.
  const ctrf = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'any-e2e-tool' },
      summary: { tests: 5, passed: 3, failed: 2, pending: 0, skipped: 0, other: 0, start: 1, stop: 2 },
      tests: [
        { name: 'a', status: 'passed', duration: 1 },
        { name: 'b', status: 'passed', duration: 1 },
        { name: 'c', status: 'passed', duration: 1 },
        { name: 'd', status: 'failed', duration: 1 },
        { name: 'e', status: 'failed', duration: 1 },
      ],
    },
  });
  const report = parseTestReport(ctrf);
  assert.deepEqual(report, { shape: 'ctrf', total: 5, failed: 2, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false, 'a failed report must fail the gate on exit 0');
  assert.match(verdict.reason, /2 failing over 5 tests/i, `reason names the count (got: ${verdict.reason})`);
});

test('quality gate: CTRF skipped-only run fails closed', () => {
  const ctrf = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'any-e2e-tool' },
      summary: { tests: 2, passed: 0, failed: 0, pending: 0, skipped: 2, other: 0, start: 1, stop: 2 },
      tests: [
        { name: 'a', status: 'skipped', duration: 0 },
        { name: 'b', status: 'skipped', duration: 0 },
      ],
    },
  });
  const report = parseTestReport(ctrf);
  assert.deepEqual(report, { shape: 'ctrf', total: 2, failed: 0, skipped: 2 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /every test was skipped/i);
});

test('quality gate: a CTRF summary that disagrees with its own tests does not under-report', () => {
  // The spec says summary.tests SHOULD equal the length of the tests array; a
  // summary claiming 0 failures while its own list holds a failed test must not
  // be believed (it would hide the failure).
  const ctrf = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'any-e2e-tool' },
      summary: { tests: 2, passed: 2, failed: 0, pending: 0, skipped: 0, other: 0, start: 1, stop: 2 },
      tests: [
        { name: 'green', status: 'passed', duration: 1 },
        { name: 'red', status: 'failed', duration: 1, message: 'boom' },
      ],
    },
  });
  const report = parseTestReport(ctrf);
  assert.equal(report.shape, 'ctrf');
  const counts = report as { failed: number; total: number };
  assert.equal(counts.failed, 1, 'the failing test in the list wins over a summary claiming 0');
  assert.equal(counts.total, 2);
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, false);
});

test('quality gate: a CTRF report with 0 tests still fails (no vacuous green)', () => {
  const ctrf = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'any-e2e-tool' },
      summary: { tests: 0, passed: 0, failed: 0, pending: 0, skipped: 0, other: 0, start: 1, stop: 2 },
      tests: [],
    },
  });
  const report = parseTestReport(ctrf);
  assert.deepEqual(report, { shape: 'ctrf', total: 0, failed: 0, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: false });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /0 tests ran/i);
});

test('quality gate: CTRF tooling disabled the CTRF report by making it a string, not an object', () => {
  // Real CTRF reporters can be switched off, which replaces the document with a
  // plain string (e.g. "ctrf report disabled"). It is not a report and must fail
  // closed rather than being parsed as one.
  const report = parseTestReport('"ctrf report disabled"');
  assert.equal(report.shape, 'unrecognised');
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, false);
});

test('quality gate: malformed JSON is unrecognised and fails closed', () => {
  for (const out of ['{ "results": { "summary": { "tests": 3, ', '{ "reportFormat": "CTRF", ']) {
    const report = parseTestReport(out);
    assert.equal(report.shape, 'unrecognised', `expected unrecognised for: ${out}`);
    assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, false);
  }
});

test('quality gate: a JSON array is not a CTRF document', () => {
  const report = parseTestReport('[{"name":"a","status":"passed"}]');
  assert.equal(report.shape, 'unrecognised');
  assert.equal(judgeGate(report, { exitOk: true, hardFail: false }).passed, false);
});

test('quality gate: a JSON object with no CTRF markers is unrecognised', () => {
  for (const out of [
    '{"foo":"bar"}',
    JSON.stringify({ results: { tool: { name: 'runner' }, summary: { tests: 3 } } }), // summary present, no CTRF identity
    JSON.stringify({ summary: { tests: 3, failed: 1 } }), // a bare summary is not CTRF
    JSON.stringify({ results: { summary: { tests: 3 }, tests: [] } }), // no tool, no reportFormat
  ]) {
    const report = parseTestReport(out);
    assert.equal(report.shape, 'unrecognised', `expected unrecognised for: ${out}`);
    const verdict = judgeGate(report, { exitOk: true, hardFail: false });
    assert.equal(verdict.passed, false, `must fail closed for: ${out}`);
    assert.match(verdict.reason, /no known test summary|CTRF/i);
  }
});

test('quality gate: a real build failure inside a ONE-LINE JSON report is still a hard failure', () => {
  // The TAP scrubber strips reporting LINES; a JSON report printed on one line carries the same names
  // WITHOUT a line that starts with `ok`. Scrub-strings must therefore remove the names (and their
  // escaped quotes) while leaving the report's own status fields readable — otherwise this is the
  // detector going blind on the shape it was just taught to read (docs/bugs-fixed.md #40).
  const fatal = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'x' },
      summary: { tests: 1, passed: 0, failed: 1, pending: 0, skipped: 0, other: 0 },
      tests: [{ name: 'compilation', status: 'failed', message: 'FATAL: the toolchain refused to start' }],
    },
  });
  assert.equal(detectHardFailure(fatal), true, 'a FATAL in the build message is a hard failure');

  // And the noisy name, with the escapes a JSON name really carries: quotes and a trailing backslash.
  // It must NOT be read as the build failing — a name is the runner's reporting, wherever it is written,
  // and the marker is only a marker when the report's own STATUS or MESSAGE says so.
  const noisyName = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'x' },
      summary: { tests: 1, passed: 1, failed: 0, pending: 0, skipped: 0, other: 0 },
      tests: [{ name: 'the \\"BUILD FAILURE\\" branch, with a trailing backslash \\\\', status: 'passed', duration: 1 }],
    },
  });
  assert.equal(detectHardFailure(noisyName), false, 'a marker inside a test NAME is not the build failing, escapes and all');

  // The status field survives the scrub: the report's own verdict stays readable.
  const failedNoMessage = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: { tool: { name: 'x' }, summary: { tests: 1, passed: 0, failed: 1 }, tests: [{ name: 'a test', status: 'failed' }] },
  });
  const parsed = parseTestReport(failedNoMessage);
  assert.equal(parsed.shape, 'ctrf', 'the CTRF verdict is still parsed with names scrubbed');
  assert.equal((parsed as { total: number }).total, 1, 'and the count is the real one');
});

test('quality gate: CTRF field names inside a test NAME are not a hard failure', () => {
  // The runner's own reporting carries the test names. A suite that tests this
  // very detection names the CTRF field in a test name, so a detector that reads
  // reported names would fail a green run.
  const ctrf = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'any-e2e-tool' },
      summary: { tests: 2, passed: 2, failed: 0, pending: 0, skipped: 0, other: 0, start: 1, stop: 2 },
      tests: [
        { name: 'summary.failed is reported, not fatal', status: 'passed', duration: 1 },
        { name: 'results.summary.failed counts failures', status: 'passed', duration: 1, message: 'no error here' },
      ],
    },
  });
  // A reported test name is the runner's reporting, not the build output, so the
  // hard-failure detector must not read it: a green CTRF suite still passes.
  assert.equal(detectHardFailure(`# Subtest: ${'summary.failed is reported, not fatal'}\nok 1 - summary.failed is reported, not fatal\n${ctrf}\n`), false, 'a CTRF field name in a test name is not the build failing');
  const report = parseTestReport(ctrf);
  assert.deepEqual(report, { shape: 'ctrf', total: 2, failed: 0, skipped: 0 });
  const verdict = judgeGate(report, { exitOk: true, hardFail: detectHardFailure(ctrf) });
  assert.equal(verdict.passed, true, `a green CTRF suite must pass (got: ${verdict.reason})`);
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

// --- the hard-fail detector must read the BUILD, not the runner's test names --

test('quality gate: a build-failure marker inside a test NAME is not a build failure', () => {
  // Subtest names are the runner's reporting. This repository's own suite contains
  // the name below, so a detector that reads test names fails a green run — the
  // repository could never pass its own quality gate.
  const out = [
    'TAP version 13',
    '# Subtest: quality gate: Maven BUILD FAILURE is a hard fail',
    'ok 188 - quality gate: Maven BUILD FAILURE is a hard fail',
    '  ---',
    '  duration_ms: 1.2',
    '  ...',
    '1..1',
    '# tests 1',
    '# pass 1',
    '# fail 0',
    '',
  ].join('\n');
  assert.equal(detectHardFailure(out), false, 'the runner reporting a test name is not the build failing');
  const report = parseTestReport(out);
  assert.equal(report.shape, 'tap');
  const verdict = judgeGate(report, { exitOk: true, hardFail: detectHardFailure(out) });
  assert.equal(verdict.passed, true, `a green suite must pass (got: ${verdict.reason})`);
});

test('quality gate: a real build failure is still a hard fail', () => {
  for (const marker of ['[ERROR] BUILD FAILURE', 'BUILD FAILED in 2s', 'FATAL: could not start the toolchain']) {
    const out = `${marker}\nTests:       6 passed, 6 total\n`;
    assert.equal(detectHardFailure(out), true, `"${marker}" must still be detected`);
    assert.equal(judgeGate(parseTestReport(out), { exitOk: true, hardFail: detectHardFailure(out) }).passed, false);
  }
});

test('quality gate step: a green suite whose test NAME mentions a build failure passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qg-name-'));
  try {
    writeFileSync(
      join(dir, 'named.sh'),
      [
        '#!/bin/sh',
        'echo "TAP version 13"',
        'echo "# Subtest: quality gate: Maven BUILD FAILURE is a hard fail"',
        'echo "ok 1 - quality gate: Maven BUILD FAILURE is a hard fail"',
        'echo "1..1"',
        'echo "# tests 1"',
        'echo "# pass 1"',
        'echo "# fail 0"',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(join(dir, 'named.sh'), 0o755);
    const rt = new TestRuntime(() => 'ok', undefined, 'qg-name');
    const wf: WorkflowDefinition = {
      name: 'qg-name',
      version: '0.1.0',
      description: '',
      steps: [{ id: 'gate', type: 'quality_gate', prompt: 'sh named.sh' }],
    };
    const res = await executeWorkflow(wf, {
      cwd: dir,
      runtime: rt,
      artifacts: new ArtifactStore(join(dir, '.takumi/a')),
      onApproval: () => true,
    });
    const gate = res.steps.find((s) => s.stepId === 'gate');
    assert.equal(
      gate?.status,
      'completed',
      `a green suite must pass even when a test name says BUILD FAILURE (got: ${gate?.summary?.slice(0, 160)})`,
    );
    assert.equal(res.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- every summary block counts, not just the first -------------------------

test('quality gate: every TAP block is counted, not only the first', () => {
  // A monorepo prints one block per package. Reading only the first reported 289
  // of this repository's 606 tests, so the count described a run that never happened.
  const out = [
    '# tests 289',
    '# pass 289',
    '# fail 0',
    'ok 1 - a',
    '',
    '# tests 5',
    '# pass 5',
    '# fail 0',
    'ok 1 - b',
    '',
  ].join('\n');
  assert.deepEqual(parseTestReport(out), { shape: 'tap', total: 294, failed: 0, skipped: 0 });
});

test('quality gate: a failure in a LATER package is not invisible', () => {
  const out = [
    '# tests 10',
    '# pass 10',
    '# fail 0',
    '',
    '# tests 3',
    '# pass 1',
    '# fail 2',
    'not ok 2 - broken',
    'not ok 3 - also broken',
    '',
  ].join('\n');
  const report = parseTestReport(out);
  assert.deepEqual(report, { shape: 'tap', total: 13, failed: 2, skipped: 0 });
  assert.equal(judgeGate(report, { exitOk: false, hardFail: false }).passed, false);
});

test('quality gate: jest / vitest workspace summaries are summed', () => {
  const out = ['Tests:       6 passed, 6 total', 'Tests:       1 failed, 5 passed, 6 total', ''].join('\n');
  assert.deepEqual(parseTestReport(out), { shape: 'jest', total: 12, failed: 1, skipped: 0 });
});

test('quality gate: Maven per-class lines are summed, the module summary is not added again', () => {
  const out = [
    '[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0, Time elapsed: 0.05 s - in com.foo.BarTest',
    '[INFO] Tests run: 2, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.02 s - in com.foo.BazTest',
    '[INFO] Results:',
    '[INFO] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0',
    '',
  ].join('\n');
  assert.deepEqual(
    parseTestReport(out),
    { shape: 'maven', total: 5, failed: 1, skipped: 0 },
    'the per-class lines are the tests; the module summary repeats them',
  );
});

test('quality gate: gradle multi-project summaries are summed', () => {
  const out = ['4 tests completed, 0 failed', '2 tests completed, 1 failed', ''].join('\n');
  assert.deepEqual(parseTestReport(out), { shape: 'gradle', total: 6, failed: 1, skipped: 0 });
});

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
