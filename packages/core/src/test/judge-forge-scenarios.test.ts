import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The forged judge, running a SCENARIO the document declares (ADR-035).
//
// The document names the commands; the judge starts what the document says to start, waits for the surface
// it names, runs the scenario command, reads the report the document points at, and ALWAYS kills what it
// started. What these tests pin is that behaviour — including the two ways a scenario check can rot
// silently: passing because no report was read, and leaving a process behind for the next run to trip on.

const FORGE = join(dirname(fileURLToPath(import.meta.url)), '../../../../extensions/judges/metamorphic-forge.sh');

const DOC = (scenario: string): string =>
  [
    'requirement:',
    '  id: REQ-DOC-001',
    'requirements:',
    '  - id: REQ-001',
    '    title: A station summary page',
    '    acceptance_criteria:',
    '      - The page answers with one row per station.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: How are values rounded?',
    '    options: ["half-up", "truncate"]',
    '    default: "half-up"',
    '    chosen: "half-up"',
    '    checkedAs: half-up',
    '    blocking: true',
    'deliverable:',
    '  run: "bash summary.sh {csv}"',
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
    scenario,
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

interface Fixture {
  dir: string;
  worktree: string;
  judgeDir: string;
  env: Record<string, string>;
  forge: { status: number; out: string };
}

function run(command: string, args: string[], env: Record<string, string>, cwd: string): { status: number; out: string } {
  try {
    const out = execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** Forge for `doc` with `check.sh` written into the worktree. `extraFiles` are written beside it. */
function forgeFixture(doc: string, check: string, extraFiles: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-scenarios-'));
  const worktree = join(dir, 'worktree');
  const judgeDir = join(dir, 'judge');
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(join(worktree, 'e2e'), { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/poc.yaml'), doc);
  writeFileSync(join(worktree, 'e2e/check.sh'), check);
  chmodSync(join(worktree, 'e2e/check.sh'), 0o755);
  for (const [name, content] of Object.entries(extraFiles)) {
    const path = join(worktree, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    // Any script the fixture writes must be runnable: a scenario that fails because the harness forgot the
    // executable bit is a test of the fixture, not of the judge.
    if (name.endsWith('.sh')) chmodSync(path, 0o755);
  }
  const env = {
    TAKUMI_REQUIREMENT: 'docs/requirements/poc.yaml',
    TAKUMI_PROJECT: dir,
    TAKUMI_WORKTREE: worktree,
    TAKUMI_JUDGE_DIR: judgeDir,
  };
  return { dir, worktree, judgeDir, env, forge: run('bash', [FORGE], env, dir) };
}

const judge = (f: Fixture): { status: number; out: string } => run('bash', [join(f.judgeDir, 'judge.sh')], f.env, f.judgeDir);
const cleanup = (f: Fixture): void => rmSync(f.dir, { recursive: true, force: true });

const scenarioLine = (out: string): string => out.split('\n').find((l) => l.includes('SCN-001')) ?? '';

/** Build the `scenarios:` block from real lines (a literal '\n' inside a test string is two characters). */
function scenario(fields: { run?: string; expect: string; start?: string; url?: string; report?: string; reportPath?: string }): string {
  return [
    '  scenarios:',
    '    - id: SCN-001',
    ...(fields.run === undefined ? [] : [`      run: "${fields.run}"`]),
    `      expect: ${fields.expect}`,
    ...(fields.start === undefined ? [] : [`      start: "${fields.start}"`]),
    ...(fields.url === undefined ? [] : [`      url: "${fields.url}"`]),
    ...(fields.report === undefined ? [] : [`      report: ${fields.report}`]),
    ...(fields.reportPath === undefined ? [] : [`      report_path: "${fields.reportPath}"`]),
  ].join('\n');
}

test('scenario: a passing scenario is reported ok against the criterion the document wrote', () => {
  const f = forgeFixture(
    DOC(scenario({ run: 'bash e2e/check.sh', expect: 'the summary page answers with the station table' })),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(scenarioLine(r.out), /^ok \d+ - SCN-001 the summary page answers with the station table$/, r.out);
  } finally {
    cleanup(f);
  }
});

test('scenario: a command that exits non-zero fails the scenario, naming the exit code', () => {
  const f = forgeFixture(
    DOC(scenario({ run: 'bash e2e/check.sh', expect: 'the summary page answers' })),
    '#!/usr/bin/env bash\necho "the page is missing the station table" >&2\nexit 3\n',
  );
  try {
    const r = judge(f);
    assert.match(scenarioLine(r.out), /not ok \d+ - SCN-001 the summary page answers — the scenario command exited 3: the page is missing the station table/);
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});

test('scenario: exit 0 with a FAILING report is a failure — the report is the evidence, not the exit code', () => {
  const failing = JSON.stringify({
    reportFormat: 'CTRF',
    specVersion: '0.1.0',
    results: {
      tool: { name: 'check.sh' },
      summary: { tests: 2, passed: 1, failed: 1, pending: 0, skipped: 0, other: 0 },
      tests: [
        { name: 'the station table is served', status: 'passed' },
        { name: 'each row carries a mean', status: 'failed', message: 'row 2 has no mean' },
      ],
    },
  });
  const f = forgeFixture(
    DOC(scenario({ run: 'bash e2e/check.sh', expect: 'the summary page answers', report: 'ctrf', reportPath: 'e2e/report.json' })),
    `#!/usr/bin/env bash\nset -eu\nmkdir -p e2e\ncat > e2e/report.json <<'JSON'\n${failing}\nJSON\nexit 0\n`,
  );
  try {
    const r = judge(f);
    assert.match(scenarioLine(r.out), /not ok \d+ - SCN-001 the summary page answers — the CTRF report says 1 failing test\(s\)/);
  } finally {
    cleanup(f);
  }
});

test('scenario: a report the judge cannot find fails, naming the path — never a silent pass', () => {
  const f = forgeFixture(
    DOC(scenario({ run: 'bash e2e/check.sh', expect: 'the summary page answers', report: 'junit', reportPath: 'e2e/report.xml' })),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(scenarioLine(r.out), /not ok \d+ - SCN-001 the summary page answers — the report .*report\.xml does not exist/, r.out);
  } finally {
    cleanup(f);
  }
});

test('scenario: the judge starts the declared surface, waits for it, and LEAVES NO PROCESS BEHIND', () => {
  const f = forgeFixture(
    DOC(
      scenario({
        run: 'bash e2e/probe.sh',
        expect: 'the declared surface answers',
        start: 'python3 -m http.server 8733 -d site --bind 127.0.0.1',
        url: 'http://127.0.0.1:8733/index.html',
      }),
    ),
    '#!/usr/bin/env bash\ncurl -fsS http://127.0.0.1:8733/index.html >/dev/null\n',
    { 'site/index.html': '<html><body><p>the surface</p></body></html>\n', 'e2e/probe.sh': '#!/usr/bin/env bash\nset -eu\ncurl -fsS http://127.0.0.1:8733/index.html >/dev/null\n' },
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(scenarioLine(r.out), /^ok \d+ - SCN-001 the declared surface answers$/, r.out);

    // The surface the judge started must be gone: a leaked server answers the NEXT run's scenario, which
    // is how a self-healing check turns into a check that always passes (docs/bugs-fixed.md #41).
    const left = execFileSync('bash', ['-c', "ps -eo args | grep -F 'http.server 8733' | grep -v grep || true"], { encoding: 'utf8' });
    assert.equal(left.trim(), '', `the judge left a process behind: ${left}`);
  } finally {
    cleanup(f);
  }
});

test('scenario: a scenario the document declares but cannot run is refused by the forge, before any judging', () => {
  const f = forgeFixture(
    DOC(scenario({ expect: 'the summary page answers' })),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  try {
    assert.notEqual(f.forge.status, 0, 'a scenario with no command must be refused');
    assert.match(f.forge.out, /SCN-001 declares no run: a scenario with no command to run is not a check/);
    assert.ok(!existsSync(join(f.judgeDir, 'judge.sh')), 'nothing is forged for a document that cannot be checked');
  } finally {
    cleanup(f);
  }
});
