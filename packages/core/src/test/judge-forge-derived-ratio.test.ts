import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `derived-ratio` (ledger #99): the answer is a QUOTIENT of two counts the report itself prints —
// availability, hit rate, pass rate — rather than an aggregate of a per-row measure.
//
// WHY IT EXISTS. Measured 2026-10-23: a correct `availability = 100*(1-fail/probes)` delivery was
// REFUSED, because the only vocabulary that could express "a number per site" was `mean` of the measure,
// so the judge recomputed 25.0 where the report printed 0.8 and reported a disagreement that was not
// one. The requirement was fine, the implementation was fine, and the judge was answering a different
// question. A ratio is not a mean, and a vocabulary that cannot say so refuses correct work.
//
// These tests run the REAL forge and the REAL judge against a real deliverable, the way the neighbouring
// decision tests do: a unit test of a string builder would prove nothing about what the judge does.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const FORGE = join(REPO, 'extensions/judges/metamorphic-forge.sh');

const PROSE_HALF_UP = 'Half-up, no currency printed';

/** A requirement whose answer is a ratio of two counts the report prints. */
function requirement(opts: { rounding?: string; anchor?: boolean } = {}): string {
  const rounding = opts.rounding ?? 'half-up';
  return [
    'requirement:',
    '  id: REQ-UPTIME-001',
    '  title: Site availability from probe records',
    'requirements:',
    '  - id: REQ-001',
    '    title: Report availability per site',
    '    acceptance_criteria:',
    '      - One line per site with probes, failures and availability.',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: How is the availability percentage rounded?',
    '    options:',
    `      - "${PROSE_HALF_UP}"`,
    '      - "Truncate, no currency printed"',
    `    default: "${PROSE_HALF_UP}"`,
    `    chosen: "${rounding === 'half-up' ? PROSE_HALF_UP : 'Truncate, no currency printed'}"`,
    `    checkedAs: ${rounding}`,
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
    '      shape: "TOTAL <count>"',
    '      fields: [count]',
    '  relations:',
    '    - id: REL-001',
    '      relation: derived-ratio',
    '      decides: AMB-001',
    '      description: Each printed availability equals its own failures/probes, rounded as AMB-001 decided.',
    ...(opts.anchor
      ? [
          '  differential:',
          '    - id: DIFF-001',
          '      anchor: independent-aggregation',
          '      decides: AMB-001',
          '      description: An independent recomputation matches the report.',
        ]
      : []),
    '',
  ].join('\n');
}

/**
 * The deliverable. `IMPL_RATIO_SCALE=100` prints a percentage, `IMPL_RATIO_SCALE=1` a fraction — BOTH are
 * legitimate conventions and the judge accepts either, because guessing one would refuse correct work.
 * `IMPL_RATIO_OFFSET` corrupts the printed ratio itself, which is the defect this relation exists to
 * catch: a number that neither scale can produce.
 */
function deliverable(): string {
  return [
    'import { readFileSync } from "node:fs";',
    'const ROUND = process.env.IMPL_ROUNDING ?? "half-up";',
    'const SCALE = Number(process.env.IMPL_RATIO_SCALE ?? "100");',
    'const OFFSET = Number(process.env.IMPL_RATIO_OFFSET ?? "0");',
    'const lines = readFileSync(process.argv[2], "utf8").split("\\n").slice(1).filter((l) => l.length > 0);',
    'const bySite = new Map();',
    'for (const line of lines) {',
    '  const f = line.split(",");',
    '  if (f.length !== 3) continue;',
    '  const a = bySite.get(f[0]) ?? { probes: 0, failures: 0 };',
    '  a.probes += 1;',
    '  if (Number(f[2]) === 0) a.failures += 1;',
    '  bySite.set(f[0], a);',
    '}',
    'const rnd = (v) => (ROUND === "half-up" ? Math.round(v) : Math.trunc(v));',
    'let total = 0;',
    'for (const [site, a] of [...bySite].sort()) {',
    '  const availability = a.probes === 0 ? 0 : (a.probes - a.failures) / a.probes * SCALE;',
    '  const successes = a.probes - a.failures;',
    '  console.log(`${site} ${successes} ${a.probes} ${rnd(availability) + OFFSET}`);',
    '  total += a.probes;',
    '}',
    'console.log(`TOTAL ${total}`);',
    '',
  ].join('\n');
}

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
  env: Record<string, string>;
  forge: Run;
}

function forge(doc: string, implEnv: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-ratio-'));
  const worktree = join(dir, 'worktree');
  const judgeDir = join(dir, 'judge');
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(worktree, { recursive: true });
  mkdirSync(judgeDir, { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/uptime.yaml'), doc);
  writeFileSync(join(worktree, 'uptime.mjs'), deliverable());
  const env = {
    TAKUMI_REQUIREMENT: 'docs/requirements/uptime.yaml',
    TAKUMI_PROJECT: dir,
    TAKUMI_WORKTREE: worktree,
    TAKUMI_JUDGE_DIR: judgeDir,
    ...implEnv,
  };
  const r = run('bash', [FORGE], env, dir);
  return { dir, worktree, judgeDir, env, forge: r };
}

function judge(f: Fixture): Run {
  return run('bash', [join(f.judgeDir, 'judge.sh')], f.env, f.judgeDir);
}

function cleanup(f: Fixture): void {
  rmSync(f.dir, { recursive: true, force: true });
}

test('derived-ratio: the forge builds a judge for a ratio requirement', () => {
  const f = forge(requirement());
  try {
    assert.equal(f.forge.status, 0, `the forge must build this document:\n${f.forge.out}`);
    assert.match(f.forge.out, /JUDGE_FORGE: ok/);
  } finally {
    cleanup(f);
  }
});

test('derived-ratio: a CORRECT ratio passes — this is the delivery the old vocabulary refused', () => {
  // The whole point: before this relation, this delivery was rejected because the judge recomputed a
  // mean of the measure. It is correct, and it must pass.
  const f = forge(requirement(), { IMPL_RATIO_SCALE: '100' });
  try {
    assert.equal(f.forge.status, 0, f.forge.out);
    const r = judge(f);
    assert.match(r.out, /ok \d+ - REL-001 derived-ratio: each of 2 printed ratio\(s\) equals its own numerator\/denominator/);
    assert.match(r.out, /ACCEPT_VERDICT: pass/);
  } finally {
    cleanup(f);
  }
});

test('derived-ratio: a WRONG ratio fails, and the verdict names the arithmetic', () => {
  // The printed ratio is corrupted (offset by 7), so it matches NEITHER scale. This is a genuinely wrong
  // answer. An earlier version of this test used the wrong SCALE, which is not a wrong answer at all —
  // the judge accepts a fraction and a percentage, and the test was asserting that a legitimate
  // convention should fail.
  const f = forge(requirement(), { IMPL_RATIO_OFFSET: '7' });
  try {
    assert.equal(f.forge.status, 0, f.forge.out);
    const r = judge(f);
    assert.match(r.out, /not ok \d+ - REL-001 derived-ratio: the printed ratio does not equal its own numerator\/denominator/);
    assert.match(r.out, /alpha\.example ratio=/, 'the failing site is named');
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});

test('derived-ratio: a report line that omits the ratio fails rather than passing unexercised', () => {
  // A relation must never pass by comparing nothing: if no line declares the three roles together, the
  // derived value was never checked, and "nothing to check" is not a pass.
  const f = forge(requirement());
  try {
    assert.equal(f.forge.status, 0, f.forge.out);
    // Replace the deliverable with one that prints only probes/failures.
    writeFileSync(
      join(f.worktree, 'uptime.mjs'),
      [
        'import { readFileSync } from "node:fs";',
        'const lines = readFileSync(process.argv[2], "utf8").split("\\n").slice(1).filter((l) => l.length > 0);',
        'const m = new Map();',
        'for (const l of lines) { const f = l.split(","); if (f.length !== 3) continue; const a = m.get(f[0]) ?? { p: 0, x: 0 }; a.p += 1; if (Number(f[2]) === 0) a.x += 1; m.set(f[0], a); }',
        'let t = 0;',
        'for (const [s, a] of [...m].sort()) { console.log(`${s} ${a.x} ${a.p} n/a`); t += a.p; }',
        'console.log(`TOTAL ${t}`);',
        '',
      ].join('\n'),
    );
    const r = judge(f);
    assert.match(r.out, /not ok \d+ - REL-001 derived-ratio: no report line declared numerator, denominator and ratio/);
    assert.match(r.out, /ACCEPT_VERDICT: fail/);
  } finally {
    cleanup(f);
  }
});

test('derived-ratio: the vocabulary test and the forge agree on the relation set', () => {
  // The forge declares what it implements on one IMPLEMENTED= line, and judge-vocabulary.test.ts compares
  // it to the validator. Pinned here too, because this relation was added to three files at once and a
  // fourth place that drifts is exactly how a document passes one door and is refused at the other.
  const forgeText = readFileSync(FORGE, 'utf8');
  const line = /^IMPLEMENTED="([^"]*)"/m.exec(forgeText);
  assert.ok(line !== null);
  assert.ok((line[1] ?? '').includes('derived-ratio'), 'the forge declares derived-ratio as implemented');
  assert.match(forgeText, /^\s+derived-ratio\)/m, 'and has a case that actually runs it');
});

// LEDGER #99, FOUND ON A REAL RUN: `independent-aggregation` MUST NOT GRADE THE RATIO'S FIELDS.
//
// `role_token` answers `?` for a role it does not compute, and numerator/denominator/ratio are exactly
// that — they belong to `derived-ratio`. The comparison `[ "$tok" = "$want" ]` then always failed and
// reported `numerator=2 want ?`, which is not a finding: it is the relation grading a field it cannot
// see. Measured 2026-10-26: a correct uptime report, availability arithmetic right, was refused by
// DIFF-001 across three fields it has no business checking.
//
// A declared document may legitimately carry BOTH an independent-aggregation anchor and a derived-ratio
// relation (the anchor checks the counts, the relation checks the arithmetic), so this has to work.
// LEDGER #101: A RATIO DOCUMENT MAY NOT CARRY AN AGGREGATE RELATION.
//
// An earlier version of this file asserted that `independent-aggregation` alongside `derived-ratio` was
// FINE, and made the aggregate anchor skip the fields it could not compute. A real run (2026-10-27)
// proved the deeper problem: `row-order-invariance` and `duplicate-resolution` on a ratio document make
// the judge look for counts in a line that has none, and a CORRECT report (`checkout 8 10 80.0`) was
// refused with "nothing in its output matched a declared output shape".
//
// So the front door now refuses the combination instead of tolerating it, and this test pins the
// refusal — including that the message names the offending relation.
test('a ratio document may not declare an aggregate relation (ledger #101)', () => {
  const f = forge(requirement({ anchor: true }));
  try {
    assert.notEqual(f.forge.status, 0, 'the forge must refuse the mixed vocabularies');
    assert.match(f.forge.out, /independent-aggregation/);
    assert.match(f.forge.out, /RATIO/);
    assert.match(f.forge.out, /Pick ONE model for the answer/);
  } finally {
    cleanup(f);
  }
});

// LEDGER #99: THE FRONT DOOR REFUSES A MIXED LINE.
//
// Prose in the intake prompt was not enough. Three consecutive runs (2026-10-26) wrote a line carrying
// BOTH `count` and `numerator`/`denominator`/`ratio`, because a ratio answer that also skips malformed
// rows reads like a record report. The judge then demands the aggregate fields from a report with no
// reason to print them, and a CORRECT delivery dies at acceptance after paying for an implementation.
//
// The forge is the only place that can refuse it before any spend, so it refuses the SHAPE and names
// both sets.
test('the forge REFUSES an output line that mixes the aggregate and ratio field models', () => {
  const mixed = requirement().replace(
    '      fields: [id, numerator, denominator, ratio]',
    '      fields: [id, denominator, count, numerator, ratio]',
  );
  // ...and the shape must have five placeholders to line up with five roles.
  const doc = mixed.replace(
    '      shape: "<site> <successes> <probes> <availability>"',
    '      shape: "<site> <successes> <probes> <availability> <skipped>"',
  );
  const f = forge(doc);
  try {
    assert.notEqual(f.forge.status, 0, 'the forge must refuse a mixed line');
    assert.match(f.forge.out, /mixes the two field models/);
    // The message must name BOTH sets, or the repair round cannot tell what to drop.
    assert.match(f.forge.out, /count\/sum\/min\/max\/mean/);
    assert.match(f.forge.out, /numerator\/denominator\/ratio/);
    assert.match(f.forge.out, /Choose the model from the ANSWER/i);
  } finally {
    cleanup(f);
  }
});

test('the forge still ACCEPTS a pure ratio line (the refusal is not a blanket ban)', () => {
  const f = forge(requirement());
  try {
    assert.equal(f.forge.status, 0, `a pure ratio document must still build:\n${f.forge.out}`);
  } finally {
    cleanup(f);
  }
});
