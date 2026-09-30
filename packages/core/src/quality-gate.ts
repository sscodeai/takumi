// Quality gate test-report parsing and judging (pure, testable).
//
// The workflow quality gate must FAIL CLOSED: if it cannot recognise a known
// test-summary shape in the runner output, there is no evidence that a single
// test ran, so the gate fails. The legacy `(fails > 0 ? fails : 1)` fallback —
// which turned "unrecognised output" into "1 passing test" — is deliberately
// gone, because it let jest/vitest/pytest/gradle runs pass vacuously.

export type TestShape = 'tap' | 'jest' | 'pytest' | 'maven' | 'gradle';

export type TestReport =
  | { shape: TestShape; total: number; failed: number; skipped: number }
  | { shape: 'unrecognised'; reason: string };

/** A parsed count triple: total tests observed, failing tests, skipped tests. */
interface Counts {
  total: number;
  failed: number;
  skipped: number;
}

function counts(total: number, failed: number, skipped: number): Counts {
  return { total, failed, skipped };
}

/**
 * Parse the test outcome out of raw runner output.
 *
 * Recognised shapes: TAP (`# tests N` / `# fail N` / `# skip N` / `not ok`),
 * jest and vitest (`Tests: ... total` / `Tests  N passed (N)`), pytest
 * (`= 1 failed, 2 passed in 0.4s` and the bare `N passed` form), Maven
 * (`Tests run: N, Failures: N, Errors: N, Skipped: N`) and gradle/JUnit
 * (`N tests completed, M failed`). Everything else is `unrecognised`.
 */
export function parseTestReport(out: string): TestReport {
  const maven = parseMaven(out);
  if (maven) return { shape: 'maven', ...maven };

  const tap = parseTap(out);
  if (tap) return { shape: 'tap', ...tap };

  const jest = parseJest(out);
  if (jest) return { shape: 'jest', ...jest };

  const pytest = parsePytest(out);
  if (pytest) return { shape: 'pytest', ...pytest };

  const gradle = parseGradle(out);
  if (gradle) return { shape: 'gradle', ...gradle };

  return {
    shape: 'unrecognised',
    reason:
      'no known test summary was found in the output (recognised: TAP, jest/vitest, pytest, Maven, gradle/JUnit)',
  };
}

/** Maven surefire: `Tests run: 2, Failures: 0, Errors: 1, Skipped: 0`. */
function parseMaven(out: string): Counts | undefined {
  const m = out.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/);
  if (!m) return undefined;
  return counts(
    parseInt(m[1] ?? '0', 10),
    parseInt(m[2] ?? '0', 10) + parseInt(m[3] ?? '0', 10),
    parseInt(m[4] ?? '0', 10),
  );
}

/**
 * TAP (`node --test`): `# tests N`, `# fail N`, `# skip N`, `not ok N`.
 * A `not ok` line without a `# tests` summary still counts as a failure.
 */
function parseTap(out: string): Counts | undefined {
  const testLine = out.match(/^#\s*tests\s*:?\s*(\d+)/m);
  const failLine = out.match(/^#\s*fail\s*:?\s*(\d+)/m);
  const skipLine = out.match(/^#\s*skip\s*:?\s*(\d+)/m);
  const notOk = (out.match(/^not ok\b/gm) ?? []).length;
  if (!testLine && !failLine && !skipLine && notOk === 0) return undefined;

  const failed = failLine ? parseInt(failLine[1] ?? '0', 10) : notOk;
  const skipped = skipLine ? parseInt(skipLine[1] ?? '0', 10) : 0;
  // Without a `# tests` line, a failing TAP run reports no usable total; use the
  // failure count so `failed > 0` still drives the verdict.
  const total = testLine ? parseInt(testLine[1] ?? '0', 10) : failed;
  return counts(total, failed, skipped);
}

/**
 * jest (`Tests: 1 failed, 2 skipped, 3 passed, 6 total`) and vitest
 * (`Tests  1 failed | 5 passed (6)`). `Test Suites:` / `Test Files:` lines are
 * ignored by construction — they do not start with `Tests`.
 */
function parseJest(out: string): Counts | undefined {
  const line = out.match(/^\s*Tests:\s*(.+)$/m) ?? out.match(/^\s*Tests\s{2,}(.+)$/m);
  if (!line) return undefined;
  const body = line[1] ?? '';

  let failed = 0;
  let skipped = 0;
  let passed = 0;
  for (const m of body.matchAll(/(\d+)\s+(failed|skipped|passed|todo)/g)) {
    const n = parseInt(m[1] ?? '0', 10);
    switch (m[2]) {
      case 'failed':
        failed += n;
        break;
      case 'skipped':
      case 'todo':
        skipped += n;
        break;
      case 'passed':
        passed += n;
        break;
    }
  }
  const totalMatch = body.match(/(\d+)\s+total/) ?? body.match(/\((\d+)\)/);
  const total = totalMatch ? parseInt(totalMatch[1] ?? '0', 10) : failed + skipped + passed;
  return counts(total, failed, skipped);
}

/**
 * pytest: `= 1 failed, 2 passed, 1 skipped in 0.42s` and the bare `N passed`
 * form. `no tests ran in 0.01s` is explicitly NOT a test report.
 */
function parsePytest(out: string): Counts | undefined {
  if (/no tests ran/i.test(out)) return undefined;
  // Require a pytest-looking summary line: a timing suffix or a `===` rule.
  if (!/\bin \d+(?:\.\d+)?s\b/i.test(out) && !/^=+/m.test(out)) return undefined;

  let failed = 0;
  let skipped = 0;
  let passed = 0;
  let matched = false;
  for (const m of out.matchAll(/(\d+)\s+(failed|passed|skipped|errors?|xfailed|xpassed)/gi)) {
    matched = true;
    const n = parseInt(m[1] ?? '0', 10);
    const word = (m[2] ?? '').toLowerCase();
    if (word === 'passed' || word === 'xpassed') passed += n;
    else if (word === 'skipped' || word === 'xfailed') skipped += n;
    else failed += n;
  }
  if (!matched) return undefined;
  return counts(passed + failed + skipped, failed, skipped);
}

/** gradle / JUnit XML console summary: `N tests completed, M failed`. */
function parseGradle(out: string): Counts | undefined {
  const m = out.match(/(\d+)\s+tests? completed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?/i);
  if (!m) return undefined;
  return counts(parseInt(m[1] ?? '0', 10), parseInt(m[2] ?? '0', 10), parseInt(m[3] ?? '0', 10));
}

/**
 * Judge a parsed report against process outcome. A non-zero exit and a hard
 * failure marker (e.g. Maven `BUILD FAILURE`) are always failures; an
 * unparseable report is a failure; an all-skipped run proves nothing.
 */
export function judgeGate(
  report: TestReport,
  run: { exitOk: boolean; hardFail: boolean },
): { passed: boolean; reason: string } {
  if (report.shape === 'unrecognised') {
    return { passed: false, reason: report.reason };
  }
  if (!run.exitOk) {
    return { passed: false, reason: 'the test command exited non-zero' };
  }
  if (run.hardFail) {
    return { passed: false, reason: 'a hard failure marker (BUILD FAILURE/BUILD FAILED/FATAL) was present' };
  }
  if (report.failed > 0) {
    return { passed: false, reason: `${report.failed} failing over ${report.total} tests` };
  }
  if (report.total === 0) {
    return { passed: false, reason: '0 tests ran: the gate has nothing to vouch for' };
  }
  if (report.skipped === report.total) {
    return { passed: false, reason: 'every test was skipped: nothing was proven' };
  }
  return { passed: true, reason: `${report.total} tests passed (${report.skipped} skipped)` };
}
