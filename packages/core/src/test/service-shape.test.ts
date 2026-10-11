import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS, validateRequirementDocument } from '../index.js';
import { readDeliverableRunTimeoutMs, renderCiConfig, runTimeoutSeconds, type CiDialect } from '../ci-pipeline.js';

// The SERVICE shape (ADR-046). Every delivery the black-box chain had produced was a SCRIPT: one file,
// invoked once, prints to stdout and exits. A service is the OTHER shape — a command that STARTS the
// thing and never exits — and it exposed four places where the chain would have waited for ever or read
// green without looking:
//
//   1. the judge's `run_tool` had no bound (metamorphic-forge.sh), so a start-and-serve `run` hung it;
//   2. the generated CI `deliverable` job had no bound, so the host waited out its own six-hour limit;
//   3. a scenario's `start` never had `{csv}` resolved, so `bash serve.sh {csv}` served a file named `{csv}`;
//   4. a service scenario could pass by exiting 0 without ever looking at the response — a vacuous green.
//
// These tests drive the REAL paths: the validator that refuses a document, the renderer that writes the
// pipeline, and (for the bound) the generated script actually run through `bash -e`, the shell the host
// uses. Nothing here asserts that a bound "would" be applied: the generated job is executed and its exit
// status read.

const repo = new URL('../../../../', import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, repo), 'utf8');

/** A document with `deliverable` extras spliced in, so one builder serves every refusal below. */
const DOC = (extras: string[] = [], scenarios = ''): string =>
  [
    'requirements:',
    '  - id: REQ-001',
    '    title: A station summary',
    '    acceptance_criteria:',
    '      - It summarises the CSV.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: How do numbers round?',
    '    options: ["half-up", "truncate"]',
    '    default: "half-up"',
    '    chosen: "half-up"',
    '    checkedAs: half-up',
    '    blocking: true',
    'deliverable:',
    '  run: "bash summary.sh {csv}"',
    ...extras,
    '  input_format:',
    '    columns: "date:date,station:id,temperature_c:measure"',
    '    sample: |',
    '      2024-01-01,ALPHA,10.4',
    '      2024-01-01,BRAVO,-2.5',
    '      2024-01-02,ALPHA,11.6',
    '  output_format:',
    '    station_line:',
    '      shape: "<station> <count> <min> <max> <mean>"',
    '      fields: [id, count, min, max, mean]',
    '    total_line:',
    '      shape: "TOTAL <count>"',
    '      fields: [count]',
    scenarios,
    '  relations:',
    '    - id: REL-001',
    '      relation: row-order-invariance',
    '      description: Shuffling the rows changes nothing.',
    '  differential:',
    '    - id: DIFF-001',
    '      anchor: independent-aggregation',
    '      decides: AMB-001',
    '      description: An independent recomputation matches the report.',
    '',
  ].join('\n');

// --- the front door: a document a judge cannot honestly check is REFUSED ------------------------

test('service: deliverable.build and deliverable.tests are REFUSED, naming the key (dead text reads as compliance)', () => {
  for (const key of ['build', 'tests'] as const) {
    const issues = validateRequirementDocument(DOC([`  ${key}: "bash ${key}.sh"`]));
    const refusal = issues.find((i) => i.includes(`declares ${key}`)) ?? '';
    assert.match(
      refusal,
      new RegExp(`the deliverable block declares ${key}, which nothing in the chain reads or runs`),
      `a declared deliverable.${key} must be refused by name (issues: ${issues.join(' | ')})`,
    );
  }
});

test('service: deliverable.timeoutMs below the floor is refused, and a valid one is accepted', () => {
  const tooSmall = validateRequirementDocument(DOC(['  timeoutMs: 500']));
  assert.ok(
    tooSmall.some((i) => i.includes('the bound on one invocation of the deliverable must be a whole number of milliseconds at or above')),
    `a bound below the floor is a refusal nobody sees (issues: ${tooSmall.join(' | ')})`,
  );
  const notANumber = validateRequirementDocument(DOC(['  timeoutMs: "soon"']));
  assert.ok(notANumber.some((i) => i.includes('must be a whole number of milliseconds')), notANumber.join(' | '));
  const ok = validateRequirementDocument(DOC(['  timeoutMs: 5000']));
  assert.deepEqual(ok.filter((i) => i.includes('timeoutMs')), [], 'a whole bound at or above the floor is accepted');
});

test('service: a scenario that reaches a surface without asserting the response is REFUSED', () => {
  const urlNoAssertion = DOC(
    [],
    [
      '  scenarios:',
      '    - id: SCN-001',
      '      run: "curl -fsS http://127.0.0.1:9/summary"',
      '      expect: the service answers',
      '      start: "bash serve.sh {csv}"',
      '      url: "http://127.0.0.1:9/summary"',
    ].join('\n'),
  );
  const issues = validateRequirementDocument(urlNoAssertion);
  assert.ok(
    issues.some((i) => i.includes('SCN-001 declares a url/start but neither expect_status nor expect_body')),
    `a vacuous service scenario must be refused (issues: ${issues.join(' | ')})`,
  );

  // A declared assertion the judge cannot apply is refused too, rather than silently dropped.
  const badStatus = validateRequirementDocument(
    DOC(
      [],
      [
        '  scenarios:',
        '    - id: SCN-001',
        '      run: "curl -fsS http://127.0.0.1:9/summary"',
        '      expect: the service answers',
        '      start: "bash serve.sh {csv}"',
        '      url: "http://127.0.0.1:9/summary"',
        '      expect_status: 99',
      ].join('\n'),
    ),
  );
  assert.ok(
    badStatus.some((i) => i.includes('SCN-001 declares expect_status 99, which is not an HTTP status code')),
    badStatus.join(' | '),
  );

  // With an assertion, the scenario is a real check and the front door accepts it.
  const asserted = DOC(
    [],
    [
      '  scenarios:',
      '    - id: SCN-001',
      '      run: "curl -fsS http://127.0.0.1:9/summary"',
      '      expect: the service answers 200 with the station table',
      '      start: "bash serve.sh {csv}"',
      '      url: "http://127.0.0.1:9/summary"',
      '      expect_status: 200',
      '      expect_body: "station"',
    ].join('\n'),
  );
  assert.deepEqual(
    validateRequirementDocument(asserted).filter((i) => i.includes('SCN-001')),
    [],
    'a service scenario that asserts its response is accepted',
  );
});

test('service: the deliverable bound is read from the deliverable block, never from a scenario or the mutation block', () => {
  const withScenarioTimeout = DOC(
    [],
    ['  scenarios:', '    - id: SCN-001', '      run: "bash e2e.sh"', '      expect: x', '      timeoutMs: 60000'].join('\n'),
  );
  assert.equal(readDeliverableRunTimeoutMs(withScenarioTimeout), undefined, 'a scenario timeoutMs is not the deliverable bound');

  const withMutationTimeout = DOC(['  mutation:', '    run: "npx stryker run"', '    report_path: "m.json"', '    format: survivors-json', '    max_survivors: 0', '    timeoutMs: 900000']);
  assert.equal(readDeliverableRunTimeoutMs(withMutationTimeout), undefined, 'a mutation timeoutMs is not the deliverable bound');

  assert.equal(readDeliverableRunTimeoutMs(DOC(['  timeoutMs: 45000'])), 45000, 'the deliverable own timeoutMs is the bound');
  assert.equal(readDeliverableRunTimeoutMs(DOC(['  timeoutMs: 500'])), undefined, 'a below-floor bound is not invented here; the front door refuses it');
});

// --- the generated CI job: BOUNDED, and a bound that is hit FAILS naming the command ------------

/** The `deliverable` job's script, read back from the generated pipeline YAML. */
function generatedDeliverableScript(yaml: string): string {
  const doc = parseYaml(yaml) as {
    jobs?: { deliverable?: { steps?: Array<{ run?: unknown }> } };
    deliverable?: { script?: unknown };
  };
  const stepRuns = (doc.jobs?.deliverable?.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === 'string');
  if (stepRuns.length > 0) return stepRuns[stepRuns.length - 1]!;
  const script = doc.deliverable?.script;
  if (Array.isArray(script)) {
    const parts = script.filter((s): s is string => typeof s === 'string');
    if (parts.length > 0) return parts.join('\n');
  }
  throw new Error('the generated pipeline has no deliverable-job script to run');
}

/** Run the generated deliverable job the way the host does: a non-interactive `bash -e`. */
function runGeneratedDeliverableJob(dialect: CiDialect, runCommand: string, deliverableTimeoutMs?: number): { status: number; output: string } {
  const script = generatedDeliverableScript(
    renderCiConfig({
      dialect,
      testCommand: 'true',
      runCommand,
      ...(deliverableTimeoutMs === undefined ? {} : { deliverableTimeoutMs }),
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), 'takumi-ci-bound-'));
  try {
    const res = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8' });
    return { status: res.status ?? -1, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('service: the generated deliverable job is BOUNDED, and a command that never exits FAILS naming itself', () => {
  for (const dialect of ['github', 'forgejo', 'gitlab'] as const) {
    const yaml = renderCiConfig({ dialect, testCommand: 'true', runCommand: 'sleep 30', deliverableTimeoutMs: 1000 });
    assert.match(yaml, /timeout 1s bash -c 'sleep 30'/, `the ${dialect} deliverable job runs the command under a bound`);
    assert.ok(!yaml.includes('{csv}'), 'no placeholder survives into the pipeline');

    // The real path: the generated job, run through `bash -e` exactly as the host runs it. A command that
    // never exits must FAIL — and the message must name the command, so a human reads what hung.
    const r = runGeneratedDeliverableJob(dialect, 'sleep 30', 1000);
    assert.notEqual(r.status, 0, `a never-exiting deliverable command must FAIL the ${dialect} job, not read green: ${r.output}`);
    assert.match(r.output, /the deliverable command did not exit within 1s and was killed, so this job fails instead of waiting out the runner's own limit: sleep 30/, r.output);
  }
});

test('service: a deliverable command that exits is NOT failed by the bound, and the default bound is generous', () => {
  for (const dialect of ['github', 'forgejo', 'gitlab'] as const) {
    const ok = runGeneratedDeliverableJob(dialect, 'printf "summarised\\n"', 1000);
    assert.equal(ok.status, 0, `a command that exits inside the bound must pass the ${dialect} job: ${ok.output}`);
    assert.match(ok.output, /summarised/, 'the command output is still shown');

    const yaml = renderCiConfig({ dialect, testCommand: 'true', runCommand: 'bash summary.sh' });
    assert.match(yaml, new RegExp(`timeout ${runTimeoutSeconds(undefined)}s bash -c`), `the ${dialect} job is bounded even when the document declares none`);
  }
});

// --- the two languages stay honest about the same numbers -------------------------------------

test('service: the forge carries the same floor and default the front door does', () => {
  const forge = read('extensions/judges/metamorphic-forge.sh');
  const floor = /^RUN_MIN_TIMEOUT_MS=(\d+)$/m.exec(forge);
  const fallback = /^DEFAULT_RUN_TIMEOUT_MS=(\d+)$/m.exec(forge);
  assert.ok(floor !== null, 'the forge declares RUN_MIN_TIMEOUT_MS on its own line');
  assert.ok(fallback !== null, 'the forge declares DEFAULT_RUN_TIMEOUT_MS on its own line');
  assert.equal(Number(floor[1]), MIN_RUN_TIMEOUT_MS, 'the forge floor matches MIN_RUN_TIMEOUT_MS');
  assert.equal(Number(fallback[1]), DEFAULT_RUN_TIMEOUT_MS, 'the forge default matches DEFAULT_RUN_TIMEOUT_MS');

  // And the forge actually applies the bound to the invocation of the deliverable.
  assert.match(forge, /RUN_OUT=\$\( \( cd "\$WORKTREE" && timeout "\$RUN_TIMEOUT_S" sh -c "\$cmd" \) 2>&1 \)/, 'run_tool runs the deliverable under `timeout`');
});
