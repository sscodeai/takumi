// Quality gate test-report parsing and judging (pure, testable).
//
// The workflow quality gate must FAIL CLOSED: if it cannot recognise a known
// test-summary shape in the runner output, there is no evidence that a single
// test ran, so the gate fails. The legacy `(fails > 0 ? fails : 1)` fallback —
// which turned "unrecognised output" into "1 passing test" — is deliberately
// gone, because it let jest/vitest/pytest/gradle runs pass vacuously.

export type TestShape = 'tap' | 'jest' | 'pytest' | 'maven' | 'gradle' | 'ctrf';

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

/** Sum a run's several summary blocks (one per package, module or project). */
function sum(list: Counts[]): Counts {
  return list.reduce((acc, c) => counts(acc.total + c.total, acc.failed + c.failed, acc.skipped + c.skipped), counts(0, 0, 0));
}

/**
 * A runner's own reporting lines: TAP test results (`ok N - …`, `not ok N - …`),
 * TAP subtest names and diagnostics (`# …`).
 *
 * These carry the TEST NAMES, and a suite that tests this very detection names
 * the marker in a test name — `quality gate: Maven BUILD FAILURE is a hard fail`
 * is a real subtest in this repository. A detector that reads those lines fails a
 * green suite: the repository's own 606-test run could never pass its own quality
 * gate. The markers that matter are printed by the build itself (`[ERROR] BUILD
 * FAILURE`, `BUILD FAILED in 2s`), which are not TAP reporting lines.
 */
const RUNNER_REPORTING_LINE = /^[ \t]*(?:#.*|ok\b.*|not ok\b.*)$/gm;

/**
 * A JSON string literal element of a test name inside a MACHINE-READABLE report (CTRF records every test's
 * name, and the name may contain anything — `"kind": "BUILD FAILURE"` in a name is a name).
 *
 * The TAP scrubber above cannot see this: with the whole report on ONE line, the line does not start with
 * `ok`, so the strip leaves the JSON intact and the detector reads the names inside it. The repository's own
 * `acceptance-gate-delivery.test.ts` writes a CTRF-ish report on a single line — which is why this was
 * invisible until a test aimed at it existed (docs/bugs-fixed.md #40).
 *
 * The escaping is handled one level at a time — `\\` before `\"` — so a name ending in a backslash cannot
 * swallow the closing quote. What is removed is only the string ELEMENT (`"name": "…"` and its value);
 * `"summary": {"failed": 1}` stays, so a report that really says a test failed is still read.
 */
const REPORT_TEST_NAME = /"(?:name|fullName|suite|title|testName)"\s*:\s*"(?:[^"\\]|\\.)*"/g;

/**
 * The MESSAGE of a failing test, on the other hand, is the BUILD speaking: a CTRF suite whose only failing
 * test says `FATAL: the toolchain refused to start` is reporting a hard failure, and a scrubber that deleted
 * messages would make the detector blind exactly where it was just taught to look. Messages survive; NAMES
 * do not.
 */
const REPORT_TEST_MESSAGE = /"message"\s*:\s*"(?:[^"\\]|\\.)*"/g;

/**
 * Remove the test NAMES carried inside a JSON report, so a hard-failure marker that appears in a name is
 * not mistaken for the build failing.
 */
function withoutReportTestNames(out: string): string {
  // Names first (they are what a suite testing this detector writes), then messages restored verbatim:
  // removing names only would already leave messages alone, but making the two explicit keeps the next
  // reader from "simplifying" the message case away.
  return out.replace(REPORT_TEST_NAME, '""').replace(REPORT_TEST_MESSAGE, (hit) => hit);
}

/**
 * Whether the output carries a hard failure of the BUILD (not of a test): a
 * compile error, a toolchain that refused to start, a build that gave up before
 * the tests ran. Judged on the build's own output, with the runner's reporting
 * lines removed.
 */
export function detectHardFailure(out: string): boolean {
  const build = out.replace(RUNNER_REPORTING_LINE, '');
  return /BUILD FAILURE|BUILD FAILED|FATAL/i.test(withoutReportTestNames(build));
}

/**
 * Parse the test outcome out of raw runner output.
 *
 * Recognised shapes: TAP (`# tests N` / `# fail N` / `# skip N` / `not ok`),
 * jest and vitest (`Tests: ... total` / `Tests  N passed (N)`), pytest
 * (`= 1 failed, 2 passed in 0.4s` and the bare `N passed` form), Maven
 * (`Tests run: N, Failures: N, Errors: N, Skipped: N`), gradle/JUnit
 * (`N tests completed, M failed`) and CTRF (Common Test Report Format, the
 * JSON test-result interchange standard). Everything else is `unrecognised`.
 *
 * Every summary block in the output is counted, not just the first one: a
 * monorepo prints one block per package, and reporting only the first block
 * claims fewer tests ran than really did.
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

  const ctrf = parseCtrf(out);
  if (ctrf) return { shape: 'ctrf', ...ctrf };

  return {
    shape: 'unrecognised',
    reason:
      'no known test summary was found in the output (recognised: TAP, jest/vitest, pytest, Maven, gradle/JUnit, CTRF)',
  };
}

/**
 * Maven surefire: `Tests run: 2, Failures: 0, Errors: 1, Skipped: 0`.
 *
 * Surefire prints one line per test CLASS (`… Time elapsed: 0.05 s - in
 * com.foo.BarTest`) and then a summary line per module. Summing both would count
 * every module twice, so the per-class lines win when they are present; otherwise
 * the module summary lines are summed (a reactor prints one per module).
 */
function parseMaven(out: string): Counts | undefined {
  const re = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?[^\n]*/g;
  const perClass: Counts[] = [];
  const summaries: Counts[] = [];
  for (const m of out.matchAll(re)) {
    const c = counts(
      parseInt(m[1] ?? '0', 10),
      parseInt(m[2] ?? '0', 10) + parseInt(m[3] ?? '0', 10),
      parseInt(m[4] ?? '0', 10),
    );
    if (/Time elapsed| - in /i.test(m[0])) perClass.push(c);
    else summaries.push(c);
  }
  if (perClass.length > 0) return sum(perClass);
  if (summaries.length > 0) return sum(summaries);
  return undefined;
}

/**
 * TAP (`node --test`): `# tests N`, `# fail N`, `# skip N`, `not ok N`.
 * A `not ok` line without a `# tests` summary still counts as a failure.
 *
 * A monorepo prints one block per package: EVERY block is read. Reading only the
 * first one vetted 289 of this repository's 606 tests and reported the rest as
 * absent — a summary that hid what actually ran.
 */
function parseTap(out: string): Counts | undefined {
  const total_ = (re: RegExp) => [...out.matchAll(re)].reduce((n, m) => n + parseInt(m[1] ?? '0', 10), 0);
  const has = (re: RegExp) => re.test(out);
  const testLine = /^#\s*tests\s*:?\s*\d+/m;
  const failLine = /^#\s*fail\s*:?\s*\d+/m;
  const skipLine = /^#\s*skip\s*:?\s*\d+/m;
  const notOk = (out.match(/^not ok\b/gm) ?? []).length;
  if (!has(testLine) && !has(failLine) && !has(skipLine) && notOk === 0) return undefined;

  const failed = has(failLine) ? total_(/^#\s*fail\s*:?\s*(\d+)/gm) : notOk;
  const skipped = has(skipLine) ? total_(/^#\s*skip\s*:?\s*(\d+)/gm) : 0;
  // Without a `# tests` line, a failing TAP run reports no usable total; use the
  // failure count so `failed > 0` still drives the verdict.
  const total = has(testLine) ? total_(/^#\s*tests\s*:?\s*(\d+)/gm) : failed;
  return counts(total, failed, skipped);
}

/**
 * jest (`Tests: 1 failed, 2 skipped, 3 passed, 6 total`) and vitest
 * (`Tests  1 failed | 5 passed (6)`). `Test Suites:` / `Test Files:` lines are
 * ignored by construction — they do not start with `Tests`.
 *
 * A workspace prints one `Tests` line per project: every line is summed, so a
 * later project's failures are not invisible.
 */
function parseJest(out: string): Counts | undefined {
  const bodies = [
    ...[...out.matchAll(/^\s*Tests:\s*(.+)$/gm)].map((m) => m[1] ?? ''),
    ...[...out.matchAll(/^\s*Tests\s{2,}(.+)$/gm)].map((m) => m[1] ?? ''),
  ];
  if (bodies.length === 0) return undefined;

  let failed = 0;
  let skipped = 0;
  let passed = 0;
  let total = 0;
  for (const body of bodies) {
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
    total += totalMatch ? parseInt(totalMatch[1] ?? '0', 10) : 0;
  }
  if (total === 0) total = failed + skipped + passed;
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

/**
 * gradle / JUnit XML console summary: `N tests completed, M failed`.
 * A multi-project build prints one line per subproject: every line is summed.
 */
function parseGradle(out: string): Counts | undefined {
  const blocks: Counts[] = [];
  for (const m of out.matchAll(/(\d+)\s+tests? completed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?/gi)) {
    blocks.push(counts(parseInt(m[1] ?? '0', 10), parseInt(m[2] ?? '0', 10), parseInt(m[3] ?? '0', 10)));
  }
  return blocks.length > 0 ? sum(blocks) : undefined;
}

/**
 * CTRF (Common Test Report Format): an open MIT standard for JSON test-result
 * interchange, so any external E2E tool that emits a CTRF document can be the
 * evidence of a gate run without a per-tool adapter.
 *
 * A CTRF document is a JSON object with `reportFormat: "CTRF"`, a `specVersion`
 * and a `results` object holding `tool`, `summary` and `tests` (spec v0.1.0,
 * 2026-10-03; the JSON Schema in Appendix A is normative). `summary.tests` is
 * the total, `summary.failed` the failures and `summary.skipped` the skips;
 * each `tests[]` entry carries `name`, `status` (passed|failed|skipped|pending
 * |other) and `duration`.
 *
 * Where the document is malformed, is a JSON array, or carries none of those
 * markers, it is NOT a CTRF report: returning `unrecognised` keeps the gate
 * failing closed. A report claiming `tests > 0` is evidence even when nothing
 * else in the output is parseable, which is why CTRF is tried after the
 * text shapes.
 *
 * A summary that disagrees with its own test list must not under-report, so the
 * failure and skip counts are the larger of the summary count and the number of
 * entries the list itself marks `failed` / `skipped`. The spec says
 * `summary.tests` SHOULD equal the length of the `tests` array, so the array
 * length may raise the total but never lower it. `pending` and `other` are
 * unresolved outcomes, not evidence of a pass, so they are counted as skipped.
 */
function parseCtrf(out: string): Counts | undefined {
  const doc = parseCtrfDocument(out);
  if (!doc) return undefined;

  const entries = doc.results.tests;
  const summary = doc.results.summary;
  const marked = (status: string) => entries.filter((t) => t?.status === status).length;

  const total = Math.max(summary.tests, entries.length);
  const failed = Math.max(summary.failed, marked('failed'));
  const skipped = Math.max(summary.skipped + summary.pending + summary.other, marked('skipped') + marked('pending') + marked('other'));
  return counts(total, failed, skipped);
}

/** The minimal, well-typed view of a CTRF document this gate needs. */
interface CtrfDocument {
  results: {
    summary: { tests: number; failed: number; skipped: number; pending: number; other: number };
    tests: Array<{ status?: unknown }>;
  };
}

/**
 * Recognise a CTRF document and read its summary and test list. Returns
 * `undefined` for anything that is not a CTRF document: malformed or
 * non-object JSON, a JSON array, `reportFormat` other than "CTRF", a missing
 * or non-integer `summary`, or a `tests` value that is not an array.
 */
function parseCtrfDocument(out: string): CtrfDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const doc = parsed as Record<string, unknown>;
  if (doc.reportFormat !== 'CTRF') return undefined;
  // CTRF is pre-1.0; only the schema's "MAJOR.MINOR.PATCH" shape is required.
  if (typeof doc.specVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.specVersion)) return undefined;

  const results = doc.results;
  if (typeof results !== 'object' || results === null || Array.isArray(results)) return undefined;
  const { summary, tests } = results as Record<string, unknown>;
  if (typeof summary !== 'object' || summary === null || Array.isArray(summary)) return undefined;
  if (!Array.isArray(tests)) return undefined;

  const s = summary as Record<string, unknown>;
  return {
    results: {
      summary: {
        tests: num(s.tests),
        failed: num(s.failed),
        skipped: num(s.skipped),
        pending: num(s.pending),
        other: num(s.other),
      },
      tests: tests as Array<{ status?: unknown }>,
    },
  };
}

/** A summary counter, or 0 when it is absent or not a non-negative integer. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
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
