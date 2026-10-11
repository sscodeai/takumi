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

const DOC = (scenario: string, opts: { run?: string; timeoutMs?: number } = {}): string =>
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
    `  run: "${opts.run ?? 'bash summary.sh {csv}'}"`,
    ...(opts.timeoutMs === undefined ? [] : [`  timeoutMs: ${opts.timeoutMs}`]),
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
function scenario(fields: {
  run?: string;
  expect: string;
  start?: string;
  url?: string;
  report?: string;
  reportPath?: string;
  expectStatus?: number;
  expectBody?: string;
}): string {
  return [
    '  scenarios:',
    '    - id: SCN-001',
    ...(fields.run === undefined ? [] : [`      run: "${fields.run}"`]),
    `      expect: ${fields.expect}`,
    ...(fields.start === undefined ? [] : [`      start: "${fields.start}"`]),
    ...(fields.url === undefined ? [] : [`      url: "${fields.url}"`]),
    ...(fields.expectStatus === undefined ? [] : [`      expect_status: ${fields.expectStatus}`]),
    ...(fields.expectBody === undefined ? [] : [`      expect_body: "${fields.expectBody}"`]),
    ...(fields.report === undefined ? [] : [`      report: ${fields.report}`]),
    ...(fields.reportPath === undefined ? [] : [`      report_path: "${fields.reportPath}"`]),
  ].join('\n');
}

/**
 * A tiny HTTP surface the scenario's `start` command brings up: it answers EVERY path with one fixed
 * status and body, so the declared `expect_status`/`expect_body` can be judged without a framework.
 * When `echoArg` is given (the last argv element) it is appended to the body, which is how a test can
 * PROVE `{csv}` was substituted in `start` rather than passed through as the literal `{csv}`.
 */
const serverScript = (port: number, status: number, body: string, echoArg: boolean): string =>
  [
    'import http.server, sys',
    `data = ${JSON.stringify(body)}`,
    `if ${echoArg ? 'len(sys.argv) > 1' : 'False'}: data = data + " argv=" + " ".join(sys.argv[1:])`,
    'data = data.encode()',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    `        self.send_response(${status})`,
    "        self.send_header('Content-Type', 'text/plain')",
    "        self.send_header('Content-Length', str(len(data)))",
    '        self.end_headers()',
    '        self.wfile.write(data)',
    '    def log_message(self, *a): pass',
    `http.server.HTTPServer(('127.0.0.1', ${port}), H).serve_forever()`,
    '',
  ].join('\n');

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
        expectStatus: 200,
        expectBody: 'the surface',
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

// ADR-046: a service scenario has to SAY WHAT IT ASSERTS about the response. A scenario whose `run`
// only has to exit 0 passes whatever the surface said — the vacuous green this project treats as the
// worst kind of defect — so a document that declares a url/start with neither assertion is REFUSED
// before a judge is forged, and the refusal names the fix.
test('scenario: a service scenario that asserts NOTHING about the response is refused by the forge', () => {
  const f = forgeFixture(
    DOC(
      scenario({
        run: 'bash e2e/check.sh',
        expect: 'the surface answers',
        start: 'python3 -m http.server 8735 -d site --bind 127.0.0.1',
        url: 'http://127.0.0.1:8735/index.html',
      }),
    ),
    '#!/usr/bin/env bash\nexit 0\n',
    { 'site/index.html': '<html><body>the surface</body></html>\n' },
  );
  try {
    assert.notEqual(f.forge.status, 0, 'a service scenario with no assertion must be refused');
    assert.match(
      f.forge.out,
      /SCN-001 declares a url\/start but neither expect_status nor expect_body: .*the check is vacuous — declare expect_status: <100-599> and\/or expect_body: <substring of the response body>/,
      f.forge.out,
    );
    assert.ok(!existsSync(join(f.judgeDir, 'judge.sh')), 'nothing is forged for a document that cannot be checked');
  } finally {
    cleanup(f);
  }
});

test('scenario: {csv} in the scenario start is resolved to the judge own fixture, never left literal', () => {
  const port = 8711;
  const f = forgeFixture(
    DOC(
      scenario({
        run: 'bash e2e/check.sh',
        expect: 'the surface serves the declared world',
        // `{csv}` here is the placeholder the document declares; the judge resolves it to the fixture it
        // generated. The server echoes the argv it was handed, so the assertion below can only pass if the
        // literal `{csv}` did NOT survive into the shell.
        start: 'python3 e2e/server.py {csv}',
        url: `http://127.0.0.1:${port}/summary`,
        expectStatus: 200,
        expectBody: 'base.csv',
      }),
    ),
    '#!/usr/bin/env bash\nexit 0\n',
    { 'e2e/server.py': serverScript(port, 200, 'the summary is served', true) },
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(scenarioLine(r.out), /^ok \d+ - SCN-001 the surface serves the declared world$/, r.out);
  } finally {
    cleanup(f);
  }
});

test('scenario: an expect_status the surface does not answer FAILS, naming the status', () => {
  const port = 8712;
  const f = forgeFixture(
    DOC(
      scenario({
        run: 'bash e2e/check.sh',
        expect: 'the surface answers 200',
        start: 'python3 e2e/server.py',
        url: `http://127.0.0.1:${port}/summary`,
        expectStatus: 200,
      }),
    ),
    '#!/usr/bin/env bash\nexit 0\n',
    { 'e2e/server.py': serverScript(port, 500, 'boom', false) },
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(
      scenarioLine(r.out),
      /not ok \d+ - SCN-001 the surface answers 200 — the surface answered HTTP 500 where the document declares expect_status 200/,
      r.out,
    );
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});

test('scenario: an expect_body the response does not contain FAILS, naming the substring', () => {
  const port = 8713;
  const f = forgeFixture(
    DOC(
      scenario({
        run: 'bash e2e/check.sh',
        expect: 'the response carries the station table',
        start: 'python3 e2e/server.py',
        url: `http://127.0.0.1:${port}/summary`,
        expectBody: 'station-table',
      }),
    ),
    '#!/usr/bin/env bash\nexit 0\n',
    { 'e2e/server.py': serverScript(port, 200, 'hello, nothing here', false) },
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(
      scenarioLine(r.out),
      /not ok \d+ - SCN-001 the response carries the station table — the response body does not contain the declared expect_body "station-table" \(the surface answered HTTP 200\)/,
      r.out,
    );
  } finally {
    cleanup(f);
  }
});

// ADR-046: the judge BOUNDS every invocation of the deliverable. A start-and-serve command never exits,
// so an unbounded `run_tool` would hang the judge for ever. The bound is reported as a FAILURE that names
// the command — never a pass, and never an "exit 124" a human has to decode.
test('judge: a deliverable command that never exits is BOUNDED and reported as a failure naming the command', () => {
  const f = forgeFixture(
    DOC(scenario({ run: 'bash e2e/check.sh', expect: 'the summary page answers' }), { run: 'sleep 30', timeoutMs: 1000 }),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(
      r.out,
      /not ok \d+ - REL-001 row-order-invariance: reshuffling the rows changes nothing — the deliverable command timed out after 1000ms, so the deliverable was never exercised: sleep 30/,
      r.out,
    );
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});
