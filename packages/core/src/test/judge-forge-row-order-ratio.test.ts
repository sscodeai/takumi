import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LEDGER #110 — `row-order-invariance` was refused on a ratio document for a reason that was not true.
 *
 * Ledger #101 put a whitelist at the forge's front door: when the per-id line is a ratio, only
 * `derived-ratio`, `mutation-detection` and a scenario may be declared, on the grounds that the others
 * "recompute counts and sums from the fixture and require them in the line, and a ratio line carries
 * none". That is true of `additivity`, `duplicate-resolution`, `malformed-row-accounting` and
 * `independent-aggregation`. It is NOT true of `row-order-invariance`.
 *
 * That relation's implementation is `run_tool` twice, `sort` both reports, compare. It reads no field
 * roles at all — a ratio report is exactly as checkable for order-invariance as an aggregate one. The
 * whitelist was copying the reasoning of its neighbours onto a relation that never needed it, and the
 * cost was real: measured 2026-10-29, four separate runs wrote
 *
 *   "Shuffling the input data rows leaves the report byte-identical."
 *
 * which is TRUE of a correct ratio report and is worth stating, and the forge refused the document for
 * claiming something it can perfectly well check.
 *
 * So `row-order-invariance` is admitted on a ratio document, and the test proves the check actually
 * runs — a report whose lines are in INPUT order rather than sorted order must FAIL it.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FORGE = join(REPO, 'extensions/judges/metamorphic-forge.sh');

const ROUND_HALF_UP = 'Half-up, no currency printed';

/**
 * A ratio requirement: one line per site carrying numerator, denominator and the ratio.
 *
 * @param opts.withRowOrder when false the relation is omitted, so the same document can be used to
 *   declare one of the three aggregate relations instead.
 */
function requirement(opts: { withRowOrder?: boolean } = {}): string {
  return [
    'requirement:',
    '  id: REQ-UPTIME-001',
    '  title: Site availability from probe records',
    'requirements:',
    '  - id: REQ-001',
    '    title: Report availability per site',
    '    acceptance_criteria:',
    '      - One line per site with successes, probes and availability.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: How is the availability percentage rounded?',
    '    options:',
    `      - "${ROUND_HALF_UP}"`,
    '      - "Truncate, no currency printed"',
    `    default: "${ROUND_HALF_UP}"`,
    `    chosen: "${ROUND_HALF_UP}"`,
    '    checkedAs: half-up',
    '    blocking: true',
    'deliverable:',
    '  run: "node uptime.mjs {csv}"',
    '  input_format:',
    '    columns: "site:id,probe_date:date,ok:measure"',
    '    sample: |',
    '      alpha.example,2026-01-01,1',
    '      alpha.example,2026-01-02,0',
    '      bravo.example,2026-01-01,1',
    '      bravo.example,2026-01-02,1',
    '  output_format:',
    '    site_line:',
    '      shape: "<site> <successes> <probes> <availability>"',
    '      fields: [id, numerator, denominator, ratio]',
    '    totals_line:',
    '      shape: "TOTAL <probes_sum> <successes_sum>"',
    '      fields: [sum, sum]',
    '  relations:',
    '    - id: REL-001',
    '      relation: derived-ratio',
    '      decides: AMB-001',
    '      description: Each printed availability equals its successes/probes, rounded as AMB-001 decided.',
    ...(opts.withRowOrder === false
      ? []
      : [
          '    - id: REL-002',
          '      relation: row-order-invariance',
          '      description: Shuffling the input rows leaves the report byte-identical.',
        ]),
    '',
  ].join('\n');
}

/** The delivered tool. `sorted` decides whether its lines follow the ids or the input order. */
function deliverable(): string {
  return [
    'import { readFileSync } from "node:fs";',
    'const rows = readFileSync(process.argv[2], "utf8").trim().split("\\n").slice(1);',
    'const bySite = new Map();',
    'const order = [];',
    'for (const r of rows) {',
    '  const f = r.split(",");',
    '  if (f.length !== 3) continue;',
    '  if (!bySite.has(f[0])) { bySite.set(f[0], { probes: 0, failures: 0 }); order.push(f[0]); }',
    '  const a = bySite.get(f[0]);',
    '  a.probes += 1;',
    '  if (Number(f[2]) === 0) a.failures += 1;',
    '}',
    'const rnd = (v) => Math.round(v);',
    'const keys = order;',
    'let probesSum = 0, successSum = 0;',
    'for (const site of keys) {',
    '  const a = bySite.get(site);',
    '  const successes = a.probes - a.failures;',
    '  const availability = a.probes === 0 ? 0 : successes / a.probes * 100;',
    '  console.log(`${site} ${successes} ${a.probes} ${rnd(availability).toFixed(1)}`);',
    '  probesSum += a.probes;',
    '  successSum += successes;',
    '}',
    'console.log(`TOTAL ${probesSum} ${successSum}`);',
    '',
  ].join('\n');
}

function forge(doc: string): { dir: string; status: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-ord-'));
  const worktree = join(dir, 'worktree');
  const judgeDir = join(dir, 'judge');
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/uptime.yaml'), doc);
  writeFileSync(join(worktree, 'uptime.mjs'), deliverable());
  try {
    const out = execFileSync('bash', [FORGE], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TAKUMI_REQUIREMENT: 'docs/requirements/uptime.yaml',
        TAKUMI_PROJECT: dir,
        TAKUMI_WORKTREE: worktree,
        TAKUMI_JUDGE_DIR: judgeDir,
      },
    });
    return { dir, status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { dir, status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('a ratio document MAY declare row-order-invariance (the judge can check it)', () => {
  const f = forge(requirement());
  try {
    assert.equal(
      f.status,
      0,
      `the forge must accept row-order-invariance on a ratio document — it reads no field roles. Output:\n${f.out}`,
    );
    assert.match(f.out, /JUDGE_FORGE: ok/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('and the check actually RUNS: a report in input order fails it', () => {
  // The tool prints sites in the order they first appear. The base fixture and the reshuffled fixture
  // therefore put different ids first, so the two reports differ and the relation must say so. If the
  // whitelist were merely widened without the check being live, this would pass and prove nothing.
  const f = forge(requirement());
  try {
    assert.equal(f.status, 0, `the forge itself must still succeed — it only forges.\n${f.out}`);
    const judge = join(f.dir, 'judge', 'judge.sh');
    const run = (() => {
      try {
        return {
          status: 0,
          out: execFileSync('bash', [judge], {
            cwd: join(f.dir, 'judge'),
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              TAKUMI_REQUIREMENT: 'docs/requirements/uptime.yaml',
              TAKUMI_PROJECT: f.dir,
              TAKUMI_WORKTREE: join(f.dir, 'worktree'),
              TAKUMI_JUDGE_DIR: join(f.dir, 'judge'),
            },
          }),
        };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    })();
    // Make the failure self-explanatory: if the FIXTURE is degenerate (one row per id) the check can
    // never fire, and the assertion below would look like a code defect when it is a fixture defect.
    const ordBase = readFileSync(join(f.dir, 'judge', 'fixtures', 'ord-base.csv'), 'utf8');
    const rowsInBase = ordBase.trim().split('\n').slice(1);
    assert.ok(
      rowsInBase.length >= 3,
      `the order fixture must keep enough rows to be order-sensitive, got ${rowsInBase.length}: ${JSON.stringify(ordBase)}`,
    );
    const baseOut = execFileSync('node', [join(f.dir, 'worktree', 'uptime.mjs'), join(f.dir, 'judge', 'fixtures', 'ord-base.csv')], { encoding: 'utf8' });
    const revOut = execFileSync('node', [join(f.dir, 'worktree', 'uptime.mjs'), join(f.dir, 'judge', 'fixtures', 'ord-reversed.csv')], { encoding: 'utf8' });
    assert.match(
      run.out,
      /not ok \d+ - REL-002 row-order-invariance: reshuffling the rows changes the report/,
      `the two reports must differ for this to be a check.\nbase:\n${baseOut}\nreversed:\n${revOut}\njudge:\n${run.out}`,
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the other three aggregate relations are STILL refused on a ratio document', () => {
  // The whitelist is narrowed for row-order-invariance only. These three genuinely recompute counts
  // and sums (or compare against a totals count) and a ratio line carries neither, so admitting them
  // would bring back #101: a correct report refused for not matching a shape it never had.
  for (const kind of ['additivity', 'duplicate-resolution', 'malformed-row-accounting']) {
    const doc = requirement().replace(
      '      relation: row-order-invariance',
      `      relation: ${kind}`,
    );
    const f = forge(doc);
    try {
      assert.notEqual(f.status, 0, `${kind} must still be refused on a ratio document`);
      assert.match(f.out, new RegExp(kind));
      assert.match(f.out, /RATIO/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

// LEDGER #111 — NO DUPLICATE RULE MEANS "EVERY ROW COUNTS", NOT "ONE ROW PER ID".
//
// `DUPLICATE_MODE` is empty when a document declares no duplicate-resolution relation, and that empty
// string fell through the aggregator's `rule != "merge"` branch, which keeps only the FIRST row of each
// id. Measured 2026-10-29 on a plainly correct aggregate report —
//
//   north 2 25 / south 1 20 / west 1 5 / TOTAL 4 50
//
// — the judge recomputed `north count=1 want 10` and failed it. The same `!= merge` mistake had also
// collapsed the row-order fixture to one row per id, which is why the row-order check could not fire.
// Both now treat "no rule declared" as "no rule to apply".
test('with no duplicate rule declared, every row counts (the judge does not invent first-row)', () => {
  const doc = [
    'requirement:',
    '  id: REQ-SALES-001',
    '  title: Revenue per region',
    'requirements:',
    '  - id: REQ-001',
    '    title: Report revenue and order count per region',
    '    acceptance_criteria:',
    '      - One line per region with its order count and total revenue.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: What happens to a row with a non-numeric amount?',
    '    options:',
    '      - "Skip it silently"',
    '      - "Stop with an error"',
    '    default: "Skip it silently"',
    '    chosen: "Skip it silently"',
    '    checkedAs: half-up',
    '    blocking: true',
    'deliverable:',
    '  run: "node sales.mjs {csv}"',
    '  input_format:',
    '    columns: "region:id,amount:measure"',
    '    sample: |',
    '      north,10',
    '      south,20',
    '      north,15',
    '      west,5',
    '  output_format:',
    '    region_line:',
    '      shape: "<region> <count> <sum>"',
    '      fields: [id, count, sum]',
    '    totals_line:',
    '      shape: "TOTAL <count> <sum>"',
    '      fields: [count, sum]',
    '  relations:',
    '    - id: REL-001',
    '      relation: row-order-invariance',
    '      description: Shuffling the input rows leaves the report byte-identical.',
    '    - id: REL-002',
    '      relation: independent-aggregation',
    '      decides: AMB-001',
    '      description: The judge recomputes count and sum per region from the records.',
    '',
  ].join('\n');
  // A CORRECT aggregate tool: it sorts by region, so its report is invariant under a shuffle.
  const dir = mkdtempSync(join(tmpdir(), 'takumi-none-'));
  const worktree = join(dir, 'worktree');
  const judgeDir = join(dir, 'judge');
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/sales.yaml'), doc);
  writeFileSync(
    join(worktree, 'sales.mjs'),
    [
      'import { readFileSync } from "node:fs";',
      'const rows = readFileSync(process.argv[2], "utf8").trim().split("\\n").slice(1);',
      'const by = new Map();',
      'for (const r of rows) {',
      '  const f = r.split(",");',
      '  const amt = Number(f[1]);',
      '  if (!Number.isFinite(amt)) continue;',
      '  const a = by.get(f[0]) ?? { count: 0, sum: 0 };',
      '  a.count += 1; a.sum += amt;',
      '  by.set(f[0], a);',
      '}',
      'let tc = 0, ts = 0;',
      'for (const k of [...by.keys()].sort()) {',
      '  const a = by.get(k);',
      '  console.log(`${k} ${a.count} ${a.sum}`);',
      '  tc += a.count; ts += a.sum;',
      '}',
      'console.log(`TOTAL ${tc} ${ts}`);',
      '',
    ].join('\n'),
  );
  try {
    const forgeEnv = {
      ...process.env,
      TAKUMI_REQUIREMENT: 'docs/requirements/sales.yaml',
      TAKUMI_PROJECT: dir,
      TAKUMI_WORKTREE: worktree,
      TAKUMI_JUDGE_DIR: judgeDir,
    };
    execFileSync('bash', [FORGE], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: forgeEnv });
    const run = execFileSync('bash', [join(judgeDir, 'judge.sh')], {
      cwd: judgeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: forgeEnv,
    });
    assert.match(run, /ok \d+ - REL-002 independent-aggregation: an independent recomputation .* matches the report/);
    assert.match(run, /ok \d+ - REL-001 row-order-invariance: reshuffling the rows changes nothing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
