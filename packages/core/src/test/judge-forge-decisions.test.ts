import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The forged judge, bound to the human's DECISIONS (ADR-028).
//
// These tests run the REAL forge (extensions/judges/metamorphic-forge.sh) against real requirement
// documents and a real deliverable, because what ADR-028 claims is a property of the generated judge:
// an expectation derived from the `chosen` option, and a decision reported as its own DEC-nnn line.
// The property that matters most is the one that cannot be asserted by reading the forge — that
// CHANGING THE HUMAN'S ANSWER changes the verdict against an UNCHANGED implementation. That is the
// flip cases below, and they are the reason this file exists.

const FORGE = join(dirname(fileURLToPath(import.meta.url)), '../../../../extensions/judges/metamorphic-forge.sh');

const requirement = (opts: { duplicate?: string; malformed?: string; rounding?: string; dropDecides?: string; unknownDecision?: boolean } = {}): string =>
  [
    'requirement:',
    '  id: REQ-DOC-001',
    '  title: A CSV summary',
    'requirements:',
    '  - id: REQ-001',
    '    title: Summarise a CSV by department',
    '    acceptance_criteria:',
    '      - One line per department with count, total and average.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: What happens to a malformed row?',
    '    options:',
    '      - "Skip the row, count it, and report the count"',
    '      - "Stop with an error"',
    '    default: "Skip the row, count it, and report the count"',
    `    chosen: "${opts.malformed ?? 'Skip the row, count it, and report the count'}"`,
    '    blocking: true',
    '  - id: AMB-002',
    '    question: Which row wins when employee_id repeats?',
    '    options:',
    '      - "First row wins"',
    '      - "The row with the latest start_date wins"',
    '    default: "First row wins"',
    `    chosen: "${opts.duplicate ?? 'The row with the latest start_date wins'}"`,
    '    blocking: true',
    '  - id: AMB-003',
    '    question: Where does the summary go?',
    '    options:',
    '      - "stdout only"',
    '      - "stdout, plus an optional file path"',
    '    default: "stdout only"',
    '    chosen: "stdout only"',
    '    blocking: false',
    '  - id: AMB-004',
    '    question: How is the average rounded?',
    '    options:',
    '      - "Half-up, no currency printed"',
    '      - "Truncate, no currency printed"',
    '    default: "Half-up, no currency printed"',
    `    chosen: "${opts.rounding ?? 'Half-up, no currency printed'}"`,
    '    blocking: true',
    'deliverable:',
    '  run: "node csv-summary.mjs {csv}"',
    '  relations:',
    '    - id: REL-001',
    '      relation: row-order-invariance',
    '      description: Shuffling the rows changes nothing.',
    '    - id: REL-002',
    '      relation: additivity',
    '      description: The department totals sum to the printed overall total.',
    '    - id: REL-003',
    '      relation: duplicate-resolution',
    opts.dropDecides === 'AMB-002' ? '' : '      decides: AMB-002',
    '      description: A repeated id resolves the way AMB-002 decided.',
    '    - id: REL-004',
    '      relation: malformed-row-accounting',
    '      decides: AMB-001',
    '      description: A malformed row behaves the way AMB-001 decided.',
    '  differential:',
    '    - id: DIFF-001',
    '      anchor: independent-aggregation',
    opts.dropDecides === 'AMB-004' ? '' : '      decides: AMB-004',
    '      description: An independent recomputation matches the report.',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');

/** The deliverable, parameterised by the rules the test wants it to implement (not by the document). */
const deliverable = (): string =>
  [
    "import { readFileSync } from 'node:fs';",
    // The names are deliberately NOT the judge's own variables (DUP_RULE, ROUNDING_MODE, ...): an
    // inherited variable of the same name is reassigned BY the judge and exported to the tool it runs,
    // so a test that reuses those names silently changes the judge instead of the implementation.
    'const DUP = process.env.IMPL_DUP ?? "latest";',
    'const ROUND = process.env.IMPL_ROUNDING ?? "half-up";',
    'const MALFORMED = process.env.IMPL_MALFORMED ?? "skip-count";',
    'const rnd = (s) => (ROUND === "half-up" ? Math.round(s) : Math.trunc(s));',
    'const lines = readFileSync(process.argv[2], "utf8").split("\\n").slice(1).filter((l) => l.length > 0);',
    'const rows = [];',
    'let skipped = 0;',
    'let malformedSeen = false;',
    'for (const line of lines) {',
    '  const f = line.split(",");',
    '  if (f.length !== 5 || !/^-?\\d+(\\.\\d+)?$/.test(f[4]) || !/^\\d{4}-\\d{2}-\\d{2}$/.test(f[3])) { skipped++; malformedSeen = true; continue; }',
    '  rows.push({ id: f[0], dept: f[2], start: f[3], salary: Number(f[4]) });',
    '}',
    'if (malformedSeen && MALFORMED === "stop-error") { console.error("malformed row"); process.exit(3); }',
    'const byId = new Map();',
    'for (const r of rows) {',
    '  const prev = byId.get(r.id);',
    '  if (!prev) { byId.set(r.id, r); continue; }',
    '  if (DUP === "error") { console.error("duplicate id " + r.id); process.exit(4); }',
    '  if (DUP === "first") continue;',
    '  if (DUP === "last") { byId.set(r.id, r); continue; }',
    '  if (DUP === "latest" && r.start >= prev.start) byId.set(r.id, r);',
    '}',
    'const agg = new Map();',
    'let hc = 0;',
    'let total = 0;',
    'for (const r of byId.values()) { const a = agg.get(r.dept) ?? { c: 0, t: 0 }; const s = rnd(r.salary); a.c++; a.t += s; agg.set(r.dept, a); hc++; total += s; }',
    'for (const [d, a] of [...agg].sort()) console.log(`${d} ${a.c} ${a.t} ${Math.round(a.t / a.c)}`);',
    'if (skipped > 0) console.log(`SKIPPED ${skipped}`);',
    'console.log(`TOTAL ${hc} ${total}`);',
    '',
  ].join('\n');

interface Run {
  status: number;
  out: string;
}

function run(command: string, args: string[], env: Record<string, string>, cwd: string): Run {
  try {
    const out = execFileSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

interface Fixture {
  dir: string;
  worktree: string;
  judgeDir: string;
  project: string;
  env: Record<string, string>;
  forge: Run;
}

/** Forge a judge for `doc` and leave the fixture in place for the caller to run or inspect. */
function forge(doc: string, implEnv: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-decisions-'));
  const worktree = join(dir, 'worktree');
  const judgeDir = join(dir, 'judge');
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/poc.yaml'), doc);
  writeFileSync(join(worktree, 'csv-summary.mjs'), deliverable());
  const env = {
    TAKUMI_REQUIREMENT: 'docs/requirements/poc.yaml',
    TAKUMI_PROJECT: dir,
    TAKUMI_WORKTREE: worktree,
    TAKUMI_JUDGE_DIR: judgeDir,
    ...implEnv,
  };
  const r = run('bash', [FORGE], env, dir);
  return { dir, worktree, judgeDir, project: dir, env, forge: r };
}

function judge(f: Fixture): Run {
  return run('bash', [join(f.judgeDir, 'judge.sh')], f.env, f.judgeDir);
}

function cleanup(f: Fixture): void {
  rmSync(f.dir, { recursive: true, force: true });
}

// --- the forge refuses a document it cannot fully decide -----------------------------------------

test('decisions: the forge exists where these tests expect it', () => {
  assert.ok(existsSync(FORGE), `the forge must be at ${FORGE}`);
});

test('decisions: a blocking decision no relation exercises is refused, by name', () => {
  const f = forge(requirement({ dropDecides: 'AMB-002' }));
  try {
    assert.notEqual(f.forge.status, 0, 'the forge must refuse');
    assert.match(f.forge.out, /blocking decision\(s\) AMB-002 are exercised by no declared relation or anchor/);
    assert.match(f.forge.out, /does not bind the implementation/);
  } finally {
    cleanup(f);
  }
});

test('decisions: a decision no relation exercises but that is NOT blocking is reported, not refused', () => {
  const f = forge(requirement());
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.match(r.out, /# not mechanised \(non-blocking decision\): AMB-003 "stdout only" is exercised by no declared relation or anchor/);
    // Reported as a diagnostic, never as a pass: an unmechanised decision is not an honoured one.
    assert.ok(!/^ok \d+ - .*AMB-003/m.test(r.out), 'an unmechanised decision must not be reported ok');
  } finally {
    cleanup(f);
  }
});

test('decisions: a relation bound to a decision the document does not contain is refused', () => {
  const f = forge(requirement().replace('decides: AMB-002', 'decides: AMB-099'));
  try {
    assert.notEqual(f.forge.status, 0, 'the forge must refuse');
    assert.match(f.forge.out, /"REL-003" exercises "AMB-099", which is not a decision in this document/);
  } finally {
    cleanup(f);
  }
});

test('decisions: a chosen option the forge cannot mechanise is refused, with the mechanisable ones named', () => {
  const f = forge(requirement({ duplicate: 'Ask the user at runtime' }));
  try {
    assert.notEqual(f.forge.status, 0, 'the forge must refuse');
    assert.match(f.forge.out, /cannot mechanise/);
    assert.match(f.forge.out, /"First row wins"/);
    assert.match(f.forge.out, /"The row with the latest start_date wins"/);
  } finally {
    cleanup(f);
  }
});

test('decisions: the judge refuses to guess a rounding rule the document never decides', () => {
  // AMB-004 stays non-blocking and nothing exercises it, so no relation can say how salaries round.
  // The forge must refuse rather than invent one: an invented rounding rule is an invented requirement.
  const doc = requirement({ dropDecides: 'AMB-004' }).replace(
    ['    chosen: "Half-up, no currency printed"', '    blocking: true'].join('\n'),
    ['    chosen: "Half-up, no currency printed"', '    blocking: false'].join('\n'),
  );
  const f = forge(doc);
  try {
    assert.notEqual(f.forge.status, 0, 'the forge must refuse');
    assert.match(f.forge.out, /would have to assume how salaries are rounded/);
  } finally {
    cleanup(f);
  }
});

// --- a decision the human recorded is a decision the implementation must honour ------------------

test('decisions: every blocking decision is reported as its own check, and a correct implementation passes', () => {
  const f = forge(requirement());
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.equal(r.status, 0, `the judge passes (${r.out})`);
    assert.match(r.out, /^ok \d+ - DEC-001 AMB-001 honoured: "Skip the row, count it, and report the count" \(checked by REL-004\)$/m);
    assert.match(r.out, /^ok \d+ - DEC-002 AMB-002 honoured: "The row with the latest start_date wins" \(checked by REL-003\)$/m);
    assert.match(r.out, /^ok \d+ - DEC-003 AMB-004 honoured: "Half-up, no currency printed" \(checked by DIFF-001\)$/m);
    assert.match(r.out, /ACCEPT_VERDICT: pass/);
  } finally {
    cleanup(f);
  }
});

test('decisions: CHANGING THE ANSWER fails the UNCHANGED implementation — the decision binds it', () => {
  // The implementation is the same in both runs; only the human's `chosen` option differs. If the
  // verdict did not move, the decision would be decoration rather than a requirement.
  const accepted = forge(requirement());
  const flipped = forge(requirement({ duplicate: 'First row wins' }));
  try {
    const before = judge(accepted);
    const after = judge(flipped);
    assert.equal(before.status, 0, `the latest-start_date answer accepts this implementation (${before.out})`);
    assert.notEqual(after.status, 0, 'the first-row answer must reject the SAME implementation');
    assert.match(after.out, /^not ok \d+ - DEC-002 AMB-002 NOT honoured: "First row wins" \(checked by REL-003, which failed\)$/m);
    assert.match(after.out, /late-date total 537 want 428/);
    assert.match(after.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(accepted);
    cleanup(flipped);
  }
});

test('decisions: an implementation that does the opposite of the malformed-row decision fails DEC-001', () => {
  const f = forge(requirement({ malformed: 'Stop with an error' }));
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.notEqual(r.status, 0, 'the judge must fail');
    assert.match(r.out, /the chosen option is "stop with an error" and the tool exited 0 on a malformed input/);
    assert.match(r.out, /^not ok \d+ - DEC-001 AMB-001 NOT honoured: "Stop with an error"/m);
    // The other decisions are untouched: a failure names what it is about.
    assert.match(r.out, /^ok \d+ - DEC-002 AMB-002 honoured/m);
  } finally {
    cleanup(f);
  }
});

test('decisions: the rounding decision drives the differential anchor', () => {
  const f = forge(requirement({ rounding: 'Truncate, no currency printed' }));
  try {
    assert.equal(f.forge.status, 0, `the forge builds (${f.forge.out})`);
    const r = judge(f);
    assert.notEqual(r.status, 0, 'the judge must fail');
    assert.match(r.out, /independent recomputation \(rounding: truncate\) disagrees with the report/);
    assert.match(r.out, /^not ok \d+ - DEC-003 AMB-004 NOT honoured: "Truncate, no currency printed" \(checked by DIFF-001, which failed\)$/m);
  } finally {
    cleanup(f);
  }
});

test('decisions: a defect the implementer tests would share anyway still fails a DEC line', () => {
  // The implementation keeps the LAST row rather than the latest start_date — the classic "green
  // suite, wrong behaviour" case ADR-026 exists for. The document's answer is unchanged.
  const f = forge(requirement(), { IMPL_DUP: 'last' });
  try {
    const r = judge(f);
    assert.notEqual(r.status, 0, 'the judge must fail');
    assert.match(r.out, /^not ok \d+ - DEC-002 AMB-002 NOT honoured/m);
    assert.match(r.out, /early-date total /);
  } finally {
    cleanup(f);
  }
});

test('decisions: the forged judge is bound to the requirement, not to the implementation', () => {
  const f = forge(requirement());
  try {
    const text = readFileSync(join(f.judgeDir, 'judge.sh'), 'utf8');
    assert.ok(!text.includes(f.worktree), 'the judge must not hard-code the implementation worktree');
    assert.match(text, /# decisions declared here: DEC-001->AMB-001 DEC-002->AMB-002 DEC-003->AMB-004/);
  } finally {
    cleanup(f);
  }
});
