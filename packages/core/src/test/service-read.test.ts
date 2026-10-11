import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRequirementDocument } from '../index.js';

// The SERVICE shape, read side (ADR-047). `deliverable.run` for a service STARTS it and it prints
// nothing, so a judge that reads stdout finds no report and every output-shape relation reports "the
// judge did not exercise the deliverable" — which is what the first live service run produced (1/11
// checks). These tests drive the REAL forge and the REAL judge against a real HTTP service: the judge
// starts it per fixture on a port IT allocated, waits for the declared url, fetches the report through
// `deliverable.read`, judges the relations, and kills the surface.

const FORGE = join(dirname(fileURLToPath(import.meta.url)), '../../../../extensions/judges/metamorphic-forge.sh');

/** A service that aggregates the CSV it was started with and serves the report line by line. */
const SERVICE = [
  '#!/usr/bin/env bash',
  'set -eu',
  'exec python3 - "$1" "$2" <<\'PY\'',
  'import csv, http.server, sys',
  'from decimal import Decimal, ROUND_HALF_UP',
  'path, port = sys.argv[1], int(sys.argv[2])',
  'rows, skipped = {}, 0',
  'with open(path, newline="") as f:',
  '    for rec in csv.reader(f):',
  '        if len(rec) != 3:',
  '            skipped += 1',
  '            continue',
  '        date, station, temp = rec[0].strip(), rec[1].strip(), rec[2].strip()',
  '        try:',
  '            v = Decimal(temp)',
  '        except Exception:',
  '            skipped += 1',
  '            continue',
  '        if not station or not date:',
  '            skipped += 1',
  '            continue',
  '        rows.setdefault(station, []).append(v)',
  'def q(x):',
  '    return str(Decimal(x).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))',
  'lines = []',
  'for station in sorted(rows):',
  '    vals = rows[station]',
  '    n = len(vals) - MUTATION',
  '    lines.append(f"{station} {n} {q(min(vals))} {q(max(vals))} {q(sum(vals) / len(vals))}")',
  'lines.append(f"TOTAL {sum(len(v) for v in rows.values())}")',
  'body = ("\\n".join(lines) + "\\n").encode()',
  'class H(http.server.BaseHTTPRequestHandler):',
  '    def do_GET(self):',
  '        self.send_response(200)',
  '        self.send_header("Content-Type", "text/plain")',
  '        self.send_header("Content-Length", str(len(body)))',
  '        self.end_headers()',
  '        self.wfile.write(body)',
  '    def log_message(self, *a):',
  '        pass',
  'http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()',
  'PY',
  '',
].join('\n');

const DOC = (run: string, mutation: number): string =>
  [
    'requirements:',
    '  - id: REQ-001',
    '    title: A station summary service',
    '    acceptance_criteria:',
    '      - The service answers with one row per station.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: How are values rounded?',
    '    options: ["half-up", "truncate"]',
    '    default: "half-up"',
    '    chosen: "half-up"',
    '    checkedAs: half-up',
    '    blocking: true',
    '  - id: AMB-002',
    '    question: When the same station repeats, what wins?',
    '    options: ["merge", "last-row"]',
    '    default: "merge"',
    '    chosen: "merge"',
    '    checkedAs: merge',
    '    blocking: true',
    'deliverable:',
    `  run: "${run}"`,
    '  read: "curl -fsS {url}"',
    '  url: "http://127.0.0.1:{port}/summary"',
    '  timeoutMs: 5000',
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
    '  relations:',
    '    - id: REL-001',
    '      relation: row-order-invariance',
    '      description: Shuffling the rows changes nothing.',
    '    - id: REL-002',
    '      relation: additivity',
    '      description: The per-station counts sum to the total.',
    '    - id: REL-003',
    '      relation: duplicate-resolution',
    '      description: A repeated station merges.',
    '      decides: AMB-002',
    '  differential:',
    '    - id: DIFF-001',
    '      anchor: independent-aggregation',
    '      decides: AMB-001',
    '      description: An independent recomputation matches the report.',
    `  # the service the judge starts, with the mutation baked in (0 = honest)`,
    `  # MUTATION ${mutation}`,
    '',
  ].join('\n');

interface Fixture {
  dir: string;
  env: Record<string, string>;
  forge: { status: number; out: string };
  judge: () => { status: number; out: string };
  cleanup: () => void;
}

function run(command: string, args: string[], env: Record<string, string>, cwd: string): { status: number; out: string } {
  const res = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  return { status: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/** Forge a judge for a SERVICE document whose `serve.sh` serves the report, then run the judge. */
function serviceFixture(mutation: number, runTemplate = 'bash serve.sh {csv} {port}'): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-read-'));
  const worktree = join(dir, 'worktree');
  const judgeDir = join(dir, 'judge');
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/poc.yaml'), DOC(runTemplate, mutation));
  writeFileSync(join(worktree, 'serve.sh'), SERVICE.replace('MUTATION', String(mutation)));
  chmodSync(join(worktree, 'serve.sh'), 0o755);
  const env = {
    ...process.env,
    TAKUMI_REQUIREMENT: 'docs/requirements/poc.yaml',
    TAKUMI_PROJECT: dir,
    TAKUMI_WORKTREE: worktree,
    TAKUMI_JUDGE_DIR: judgeDir,
  };
  const forge = run('bash', [FORGE], env, dir);
  return {
    dir,
    env,
    forge,
    judge: () => run('bash', [join(judgeDir, 'judge.sh')], env, judgeDir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('service: the judge starts the deliverable per fixture, reads the report over HTTP, and the relations are EXERCISED', () => {
  const f = serviceFixture(0);
  try {
    assert.equal(f.forge.status, 0, `the forge builds for a service document (${f.forge.out})`);
    const r = f.judge();
    // The five relations the old service shape could never exercise — the run reported every one of them
    // as "the judge did not exercise the deliverable" — are now real checks.
    assert.match(r.out, /^ok \d+ - REL-001 row-order-invariance/m, r.out);
    assert.match(r.out, /^ok \d+ - REL-002 additivity/m, r.out);
    assert.match(r.out, /^ok \d+ - REL-003 duplicate-resolution/m, r.out);
    assert.match(r.out, /^ok \d+ - DIFF-001 independent-aggregation/m, r.out);
    assert.match(r.out, /ACCEPT_VERDICT: pass/, r.out);

    // And nothing is left listening: a leaked service answers the NEXT fixture, which is how a check
    // turns into one that always passes.
    const left = execFileSync('bash', ['-c', "ss -ltn 2>/dev/null | grep -cE '127.0.0.1:200[0-9][0-9]' || true"], { encoding: 'utf8' });
    assert.equal(left.trim(), '0', `the judge left a listener behind: ${left}`);
  } finally {
    f.cleanup();
  }
});

test('service: a service that reports the wrong arithmetic FAILS the relation that checks it', () => {
  // The count is reported one lower than the fixture's — the arithmetic a relation exists to catch.
  const f = serviceFixture(1);
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = f.judge();
    assert.match(r.out, /not ok \d+ - DIFF-001 independent-aggregation/, r.out);
    assert.match(r.out, /ACCEPT_VERDICT: fail/, r.out);
  } finally {
    f.cleanup();
  }
});

test('service: read without url (and url without read) is refused by the FRONT DOOR and by the FORGE', () => {
  const withRead = DOC('bash serve.sh {csv} {port}', 0).replace('  url: "http://127.0.0.1:{port}/summary"\n', '');
  assert.ok(
    validateRequirementDocument(withRead).some((i) => i.includes('declares read but no url')),
    validateRequirementDocument(withRead).join(' | '),
  );
  const withUrl = DOC('bash serve.sh {csv} {port}', 0).replace('  read: "curl -fsS {url}"\n', '');
  assert.ok(
    validateRequirementDocument(withUrl).some((i) => i.includes('declares url but no read')),
    validateRequirementDocument(withUrl).join(' | '),
  );

  // The forge refuses them too: a service whose report no judge can fetch must not reach a judge.
  const dir = mkdtempSync(join(tmpdir(), 'takumi-read-refuse-'));
  try {
    mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
    mkdirSync(join(dir, 'worktree'), { recursive: true });
    mkdirSync(join(dir, 'judge'), { recursive: true });
    writeFileSync(join(dir, 'docs/requirements/poc.yaml'), withRead);
    const env = {
      ...process.env,
      TAKUMI_REQUIREMENT: 'docs/requirements/poc.yaml',
      TAKUMI_PROJECT: dir,
      TAKUMI_WORKTREE: join(dir, 'worktree'),
      TAKUMI_JUDGE_DIR: join(dir, 'judge'),
    };
    const forge = run('bash', [FORGE], env, dir);
    assert.notEqual(forge.status, 0, 'the forge must refuse read without url');
    assert.match(forge.out, /declares read but no url/, forge.out);
    assert.ok(!existsSync(join(dir, 'judge', 'judge.sh')), 'nothing is forged for a document that cannot be judged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('service: a single-quoted expect_body resolves to the INNER string (the outer pair is the quoting)', () => {
  // The first live service run failed SCN-001 on exactly this: the document wrote `expect_body: '"total"'`
  // and the judge searched for a substring that still carried the single quotes.
  const dir = mkdtempSync(join(tmpdir(), 'takumi-quote-'));
  try {
    const worktree = join(dir, 'worktree');
    mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(dir, 'judge'), { recursive: true });
    const doc = [
      'requirements:',
      '  - id: REQ-001',
      '    title: A summary endpoint',
      '    acceptance_criteria:',
      '      - It answers with JSON.',
      'ambiguities:',
      '  - id: AMB-001',
      '    question: How are values rounded?',
      '    options: ["half-up", "truncate"]',
      '    default: "half-up"',
      '    chosen: "half-up"',
      '    checkedAs: half-up',
      '    blocking: true',
      'deliverable:',
      '  run: "bash serve.sh {csv} {port}"',
      '  read: "curl -fsS {url}"',
      '  url: "http://127.0.0.1:{port}/summary"',
      '  timeoutMs: 5000',
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
      '  scenarios:',
      '    - id: SCN-001',
      '      start: "bash serve.sh {csv} {port}"',
      '      url: "http://127.0.0.1:{port}/summary"',
      '      run: "curl -fsS {url}"',
      '      expect_status: 200',
      "      expect_body: '\"TOTAL\"'",
      '      expect: the surface answers with the JSON summary',
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
    writeFileSync(join(dir, 'docs/requirements/poc.yaml'), doc);
    // The surface answers with a JSON body carrying `"TOTAL"` — the substring the document declares.
    const server = [
      '#!/usr/bin/env bash',
      'set -eu',
      'exec python3 - "$2" <<\'PY\'',
      'import http.server, sys',
      'port = int(sys.argv[1])',
      'body = b\'{"stations": [], "TOTAL": 5}\'',
      'class H(http.server.BaseHTTPRequestHandler):',
      '    def do_GET(self):',
      '        self.send_response(200)',
      '        self.send_header("Content-Length", str(len(body)))',
      '        self.end_headers()',
      '        self.wfile.write(body)',
      '    def log_message(self, *a): pass',
      'http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()',
      'PY',
      '',
    ].join('\n');
    writeFileSync(join(worktree, 'serve.sh'), server);
    chmodSync(join(worktree, 'serve.sh'), 0o755);
    const env = {
      ...process.env,
      TAKUMI_REQUIREMENT: 'docs/requirements/poc.yaml',
      TAKUMI_PROJECT: dir,
      TAKUMI_WORKTREE: worktree,
      TAKUMI_JUDGE_DIR: join(dir, 'judge'),
    };
    const forge = run('bash', [FORGE], env, dir);
    assert.equal(forge.status, 0, `the forge builds (${forge.out})`);
    const r = run('bash', [join(dir, 'judge', 'judge.sh')], env, join(dir, 'judge'));
    assert.match(r.out, /^ok \d+ - SCN-001 the surface answers with the JSON summary/m, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
