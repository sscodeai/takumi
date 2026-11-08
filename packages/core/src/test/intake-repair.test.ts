import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { WorkflowDefinition } from '../workflow.js';

/**
 * LEDGER #129 — repair the document from what step 1 ALREADY decided, instead of asking the model again.
 *
 * The intake's first attempt passes its own gate about one time in three (measured 2026-11-08: 1 of 3,
 * twice over). With the forge's words finally visible (#126/#128), the failures turned out to be the
 * same shape: a decision step 1 made correctly is MISSING FROM THE DOCUMENT.
 *
 *   checkedAs:        absent, while step 1 answered ROUNDING_MEANS: half-up
 *   deliverable.run   absent, while step 1 answered ENTRY_POINT: bash x.sh {csv}
 *
 * Four rounds of prompt rules (#102, #107, #121, #127) tried to make the model carry those across a
 * 400-line document and the rate did not move. But they are DETERMINISTIC — the answer is already known
 * — so the document is repaired from step 1's answers by code.
 *
 * The refusal half matters as much as the repair half: `ROUNDING_MEANS: NONE` means no rounding answer
 * exists, so a ratio relation that settles one is a contradiction and must be refused, never given a
 * mode nobody chose. And a mixed field model is a REWRITE (the line shapes and the requirement text that
 * quote them all move), so it is refused rather than guessed at.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/intake-repair.sh');

const SHAPE = [
  'ANSWER_SHAPE: QUOTIENT',
  'THE_NUMBER_IS: pass percentage per suite',
  'THE_TWO_COUNTS_ARE: passed divided by total',
  'ENTRY_POINT: bash summary.sh {csv}',
  'ALLOWED_RELATIONS: derived-ratio, row-order-invariance, mutation-detection, browser-scenario',
  'ROUNDING_MEANS: half-up',
  'WHY_NOT_THE_OTHER: a rate is a division.',
  '',
].join('\n');

function repair(doc: string, shape = SHAPE): { status: number; out: string; after: string } {
  const dir = mkdtempSync(join(tmpdir(), 'repair-'));
  try {
    const p = join(dir, 'intake.yaml');
    writeFileSync(p, doc);
    const s = join(dir, 'shape.txt');
    writeFileSync(s, shape);
    let status = 0;
    let out = '';
    try {
      out = execFileSync('bash', [SCRIPT, '--doc', p, '--shape', s], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? 1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    return { status, out, after: readFileSync(p, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const DOC_MISSING_BOTH = [
  'requirements:',
  '  - id: REQ-001',
  '    title: report a pass percentage',
  'deliverable:',
  '  input_format:',
  '    columns: "suite:id,passed:measure,total:other"',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: "How is the percentage rounded?"',
  '    options:',
  '      - "half-up"',
  '    default: "half-up"',
  '  relations:',
  '    - id: REL-001',
  '      relation: derived-ratio',
  '      decides: AMB-001',
  '      description: each percentage is passed/total',
  '',
].join('\n');

test('a missing `deliverable.run` is filled from ENTRY_POINT', () => {
  const r = repair(DOC_MISSING_BOTH);
  assert.equal(r.status, 0, r.out);
  assert.match(r.after, /^\s+run: "bash summary\.sh \{csv\}"$/m, 'the entry point step 1 decided lands in the document');
});

test('a missing `checkedAs` is filled from ROUNDING_MEANS', () => {
  const r = repair(DOC_MISSING_BOTH);
  assert.equal(r.status, 0, r.out);
  assert.match(r.after, /^\s+checkedAs: half-up$/m, 'the rounding step 1 decided lands on the decision');
});

test('the repair is idempotent: a second run changes nothing', () => {
  const first = repair(DOC_MISSING_BOTH);
  const second = repair(first.after);
  assert.equal(second.status, 0, second.out);
  assert.equal(second.after, first.after, 'a repaired document is a fixed point');
  assert.match(second.out, /nothing to repair/);
});

test('ROUNDING_MEANS: NONE with a ratio relation is REFUSED, and the file is untouched', () => {
  const shapeNone = SHAPE.replace('ROUNDING_MEANS: half-up', 'ROUNDING_MEANS: NONE');
  const r = repair(DOC_MISSING_BOTH, shapeNone);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /ROUNDING_MEANS: NONE/, 'it says which answer it could not honour');
  assert.match(r.out, /no rounding answer to record/, 'and why');
  assert.equal(r.after, DOC_MISSING_BOTH, 'a refusal writes nothing');
});

test('a mixed field model is REFUSED as a rewrite, not guessed at', () => {
  const doc = DOC_MISSING_BOTH.replace(
    '  input_format:',
    '  output_format:\n    suite_line:\n      shape: "<suite> <count> <pct>"\n      fields: [id, count, ratio]\n  input_format:',
  );
  const r = repair(doc);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /mixes the two field models/);
  assert.match(r.out, /rewrite, not a repair/, 'it says why it will not touch it');
  assert.equal(r.after, doc, 'a refusal writes nothing');
});

test('a shape decision with no ANSWER_SHAPE is exit 2, never a silent pass', () => {
  const r = repair(DOC_MISSING_BOTH, 'ENTRY_POINT: bash x.sh {csv}\n');
  assert.equal(r.status, 2, r.out);
});

test('the workflow runs the repair BEFORE the gate that judges the document', () => {
  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  const order = (def.steps ?? []).map((s) => s.id);
  const at = (id: string) => order.indexOf(id);
  assert.ok(at('intake_repair') > 0, 'the repair step exists');
  assert.ok(at('intake_repair') > at('shape_decision'), 'it needs step 1\'s answer first');
  assert.ok(at('intake_repair') < at('intake_shape'), 'and it must run before the gate that judges the document');
  const gate = (def.steps ?? []).find((s) => s.id === 'intake_shape');
  assert.ok((gate?.dependsOn ?? []).includes('intake_repair'), 'the gate depends on the repair, not on luck');
  const step = (def.steps ?? []).find((s) => s.id === 'intake_repair');
  assert.match(String(step?.prompt ?? ''), /\{step\.shape_decision\}/, 'and it reads step 1\'s own answer');
});

// LEDGER #132 — a step that reads `{step.X}` must DEPEND on X.
//
// `intake_repair` takes step 1's answer through `{step.shape_decision}`. Declared against `req_intake`
// alone it ran in the SAME LEVEL as `shape_decision`, so the engine had not recorded that step's summary
// yet and the placeholder reached the shell verbatim. Every repair then refused with "step 1 recorded no
// ANSWER_SHAPE", and two real runs were lost to an ordering that was never declared.
//
// A placeholder that is not resolved is not an error the engine can see: `renderPrompt` leaves unknown
// keys alone, so the failure surfaces as a confusing refusal three steps later. The dependency is the
// only thing that makes the interpolation true.
test('a step that interpolates `{step.X}` depends on X', () => {
  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  const steps = def.steps ?? [];
  const offenders: string[] = [];
  for (const step of steps) {
    const prompt = String(step.prompt ?? '');
    for (const m of prompt.matchAll(/\{step\.([A-Za-z0-9_]+)\}/g)) {
      const needed = m[1];
      if (!(step.dependsOn ?? []).includes(needed)) {
        offenders.push(`${step.id} reads {step.${needed}} but does not depend on it`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'an undeclared dependency means the placeholder reaches the shell verbatim, and the refusal that follows names the wrong cause',
  );
});

test('the repair step depends on BOTH the document and the decision it repairs from', () => {
  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  const repair = (def.steps ?? []).find((s) => s.id === 'intake_repair');
  assert.ok((repair?.dependsOn ?? []).includes('req_intake'), 'the document it edits');
  assert.ok((repair?.dependsOn ?? []).includes('shape_decision'), 'and the answer it edits from');
});

// LEDGER #134 — step 1 answers inside a ``` fence.
//
// The shape prompt shows its answer in a code block, so the model writes the fence lines too and the
// engine hands the whole thing to `{step.shape_decision}`. `sed -n "s/^KEY://p"` then matches nothing —
// the line is "ANSWER_SHAPE: QUOTIENT" with no leading spaces, so this looked like it should work, and
// the repair refused with "no ANSWER_SHAPE" for a reason unrelated to the document.
//
// Measured 2026-11-08, immediately after #133 made the placeholder resolve at all.
test('a fenced shape answer is still read', () => {
  const fenced = ['```', ...SHAPE.trimEnd().split('\n'), '```', ''].join('\n');
  const r = repair(DOC_MISSING_BOTH, fenced);
  assert.equal(r.status, 0, r.out);
  assert.match(r.after, /^\s+run: "bash summary\.sh \{csv\}"$/m, 'the entry point is still found');
  assert.match(r.after, /^\s+checkedAs: half-up$/m, 'and the rounding');
});

test('an indented shape answer is still read', () => {
  const indented = SHAPE.trimEnd()
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
  const r = repair(DOC_MISSING_BOTH, `${indented}\n`);
  assert.equal(r.status, 0, r.out);
  assert.match(r.after, /^\s+checkedAs: half-up$/m);
});

// LEDGER #135 — a multi-line answer cannot be a quoted shell argument.
//
// `--shape-text "{step.shape_decision}"` splices newlines into a double-quoted argument. Measured
// 2026-11-08, immediately after #134 made the fence parse: `/bin/sh: 9: Syntax error: Unterminated
// quoted string`, and the run died with the repair never attempted. A quoted argument can hold a
// phrase; step 1's answer is a document.
test('the repair step passes the answer through a FILE, not a quoted argument', () => {
  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  const step = (def.steps ?? []).find((s) => s.id === 'intake_repair');
  const prompt = String(step?.prompt ?? '');
  assert.doesNotMatch(prompt, /--shape-text/, 'no quoted multi-line argument');
  assert.match(prompt, /<<'TAKUMI_SHAPE_EOF'/, 'the answer goes in a heredoc');
  assert.match(prompt, /--shape "\$shape_file"/, 'and the script reads it from the file');
  assert.match(prompt, /rm -f "\$shape_file"/, 'the temp file is cleaned up');
});

test('the heredoc delimiter is at column 0 after YAML parsing, or it never terminates', () => {
  const def = parseYaml(
    readFileSync(new URL('../../../../extensions/workflows/intake-attempt/workflow.yaml', import.meta.url), 'utf8'),
  ) as WorkflowDefinition;
  const prompt = String((def.steps ?? []).find((s) => s.id === 'intake_repair')?.prompt ?? '');
  const lines = prompt.split('\n');
  const open = lines.findIndex((l) => /<<'TAKUMI_SHAPE_EOF'/.test(l));
  const close = lines.findIndex((l) => l === 'TAKUMI_SHAPE_EOF');
  assert.ok(open >= 0 && close > open, 'both delimiters exist');
  assert.equal(lines[close], 'TAKUMI_SHAPE_EOF', 'the closing delimiter has no leading whitespace');
});

// LEDGER #136 — a relation step 1 did not allow is DROPPED.
//
// Step 1 emits `ALLOWED_RELATIONS` for the shape it chose, and #121 tells the document step that
// `relations:` must be a subset of it. Measured 2026-11-08, on a run where the repair step was finally
// working: the document still declared `independent-aggregation` on a ratio line and the forge refused
// with "it recomputes COUNTS or SUMS from the fixture ... a ratio line carries none". Step 1 had already
// answered that it could not. Leaving it in refuses the run; keeping it silently would be a document
// that declares a check it cannot have. So it is dropped, and the drop is reported.
test('a relation outside ALLOWED_RELATIONS is dropped, and the drop is reported', () => {
  const doc = DOC_MISSING_BOTH.replace(
    '  relations:\n    - id: REL-001',
    [
      '  relations:',
      '    - id: DIFF-001',
      '      relation: independent-aggregation',
      '      decides: AMB-001',
      '      description: an anchor step 1 does not allow on a ratio line',
      '    - id: REL-001',
    ].join('\n'),
  );
  const r = repair(doc);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /dropped DIFF-001 \(independent-aggregation\)/, 'the drop is named');
  assert.doesNotMatch(r.after, /independent-aggregation/, 'and the relation is gone');
  assert.match(r.after, /relation: derived-ratio/, 'the allowed one survives');
});

test('a relation step 1 DID allow is kept', () => {
  const doc = DOC_MISSING_BOTH.replace(
    '  relations:\n    - id: REL-001',
    [
      '  relations:',
      '    - id: REL-002',
      '      relation: row-order-invariance',
      '      description: shuffling the input leaves the report identical',
      '    - id: REL-001',
    ].join('\n'),
  );
  const r = repair(doc);
  assert.equal(r.status, 0, r.out);
  assert.match(r.after, /row-order-invariance/, 'row-order is on the list and stays');
});

// LEDGER #137 — the repair EDITS the document, so a document that does not parse must be refused first.
//
// Measured 2026-11-08 on a real run: an `aggregate` document carried `source: "prints the total revenue"
// (the request asks for totals)` — valid-looking, not YAML — and the validator downstream reported it.
// But a TEXT repair on a document that does not parse edits lines it only thinks it understands, so the
// refusal has to come first.
//
// The verdict comes from `requirement confirm --dry-run`, which reports a broken document in its OUTPUT
// and still exits 0. `requirement digest` cannot be used: it hashes whatever it is given, valid or not.
test('a document that is not valid YAML is REFUSED before any repair, and untouched', () => {
  const broken = [
    'requirements:',
    '  - id: REQ-001',
    '    source: "prints the total revenue" (the request asks for totals)',
    '',
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'repair-yaml-'));
  try {
    const p = join(dir, 'intake.yaml');
    writeFileSync(p, broken);
    const s = join(dir, 'shape.txt');
    writeFileSync(s, SHAPE);
    let status = 0;
    let out = '';
    try {
      out = execFileSync('bash', [SCRIPT, '--doc', p, '--shape', s], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TAKUMI_PROJECT: REPO },
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? 1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    assert.equal(status, 1, out);
    assert.match(out, /not valid YAML/, 'it says what is wrong');
    assert.match(out, /make it worse|Fix the YAML first/, 'and why it will not touch it');
    assert.equal(readFileSync(p, 'utf8'), broken, 'a refusal writes nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// LEDGER #138 — a blocking decision no check exercises, repaired from `checkedAs`.
//
// Measured 2026-11-09: `blocking decision(s) AMB-NNN are exercised by no declared relation or anchor` was
// the single most common remaining failure, twice in a row.
//
// It is NOT a guess which relation owns a decision, because the document already says what the answer
// MEANS in `checkedAs:`, and the forge's own table maps a mode to the relations that can verify it:
//   skip-count | skip-silent | stop-error                -> malformed-row-accounting
//   first-row | last-row | latest-start-date | merge | error -> duplicate-resolution
//   half-up | truncate                                  -> derived-ratio | independent-aggregation
// So a decision with mode `half-up` that no relation names can only be settled by a rounding relation,
// and when exactly one such relation is declared, that is where `decides:` belongs.
//
// It REFUSES when the inference is not unique or no relation can verify the mode — a wrong `decides:`
// would have the judge verify a decision the document never meant.
const DOC_UNDECIDED = [
  'requirements:',
  '  - id: REQ-001',
  '    title: t',
  'deliverable:',
  '  run: "bash s.sh {csv}"',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: how is it rounded?',
  '    default: "half-up"',
  '    checkedAs: half-up',
  '    blocking: true',
  '  - id: AMB-002',
  '    question: what about repeats?',
  '    default: "merge"',
  '    checkedAs: merge',
  '    blocking: true',
  'relations:',
  '  - id: REL-001',
  '    relation: derived-ratio',
  '    description: ratio',
  '  - id: REL-002',
  '    relation: duplicate-resolution',
  '    description: dup',
  '',
].join('\n');

test('a blocking decision with no check gets `decides:` from its checkedAs mode', () => {
  const r = repair(DOC_UNDECIDED, SHAPE.replace(/ALLOWED_RELATIONS:.*/, 'ALLOWED_RELATIONS: derived-ratio, duplicate-resolution'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /AMB-001 \(blocking, checkedAs: half-up\) had no check/, 'the reasoning is reported');
  assert.match(r.out, /AMB-002 \(blocking, checkedAs: merge\) had no check/);
  // Each lands on the relation whose KIND can verify that mode.
  const rel1 = r.after.slice(r.after.indexOf('id: REL-001'), r.after.indexOf('id: REL-002'));
  const rel2 = r.after.slice(r.after.indexOf('id: REL-002'));
  assert.match(rel1, /decides: AMB-001/, 'half-up goes to the rounding relation');
  assert.match(rel2, /decides: AMB-002/, 'merge goes to the duplicate relation');
});

test('an ambiguous inference is REFUSED, not guessed', () => {
  // Two rounding relations and one rounding decision: which one is meant is a judgment.
  const doc = DOC_UNDECIDED.replace(
    '  - id: REL-002\n    relation: duplicate-resolution\n    description: dup',
    '  - id: REL-002\n    relation: independent-aggregation\n    description: anchor',
  );
  const r = repair(doc, SHAPE.replace(/ALLOWED_RELATIONS:.*/, 'ALLOWED_RELATIONS: derived-ratio, independent-aggregation'));
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /MORE THAN ONE declared relation could verify it/, 'it names the ambiguity');
  assert.doesNotMatch(r.after, /decides: AMB-001/, 'and writes nothing');
});

test('a mode no declared relation can verify is REMOVED (ledger #140 changed this from a refusal)', () => {
  // This case used to assert a refusal. #140 reversed it: a decision nothing may check blocks the run
  // forever, and its answer belongs in the requirement text. The refusal survives only for a mode the
  // repair cannot place at all.
  const doc = DOC_UNDECIDED.replace('  - id: REL-002\n    relation: duplicate-resolution\n    description: dup\n', '');
  const r = repair(doc, SHAPE.replace(/ALLOWED_RELATIONS:.*/, 'ALLOWED_RELATIONS: derived-ratio'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /removed AMB-002 \(blocking, checkedAs: merge\)/, 'the decision is removed');
  assert.match(r.out, /belongs in/, 'and its answer is redirected to the requirement text');
});

// LEDGER #140 — a decision no allowed relation can verify is REMOVED, not left to block the run.
//
// Measured 2026-11-09, twice: a ratio document kept recording "what happens to a repeated id"
// (`checkedAs: merge`) and "what happens to a malformed row" (`checkedAs: skip-count`) as blocking
// ambiguities, while its ALLOWED_RELATIONS — correctly, see #139 — contains neither
// duplicate-resolution nor malformed-row-accounting, because both read a `count` role a ratio totals
// line no longer carries (#108).
//
// #139's prompt told the model not to write them. It wrote them anyway — the fifth rule to fail that
// way. But the decision is DETERMINISTICALLY unusable: no vocabulary the document may use can check it.
// So the repair removes it and reports where its answer belongs instead. The removal is done line by
// line, not with a block regex, because a block that fails to match would silently leave the decision
// in place — the exact state that blocks the run.
test('a decision no allowed relation can verify is removed, with its answer reported', () => {
  const doc = DOC_UNDECIDED.replace(
    'relations:',
    [
      'relations:',
      '  - id: REL-001',
      '    relation: derived-ratio',
      '    description: only the rounding relation is declared',
    ].join('\n'),
  ).replace('  - id: REL-001\n  - id: REL-001', '');
  // DOC_UNDECIDED declares both relations; strip the duplicate one so only derived-ratio remains.
  const onlyRatio = DOC_UNDECIDED.replace(
    '  - id: REL-002\n    relation: duplicate-resolution\n    description: dup\n',
    '',
  );
  const r = repair(onlyRatio, SHAPE.replace(/ALLOWED_RELATIONS:.*/, 'ALLOWED_RELATIONS: derived-ratio'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /removed AMB-002 \(blocking, checkedAs: merge\)/, 'the unusable decision is named');
  assert.match(r.out, /belongs in\s+the requirement text|belongs in the requirement text/, 'and where its answer goes');
  assert.doesNotMatch(r.after, /AMB-002/, 'the decision is gone');
  assert.match(r.after, /decides: AMB-001/, 'the usable one is bound to its relation');
});

// LEDGER #141 — a `differential:` entry names its check with `anchor:`, not `relation:`.
//
// Measured 2026-11-09: run-14's repair dropped REL-001 and REL-002 as out-of-list, left DIFF-001
// (`anchor: independent-aggregation`) alone, and the forge refused the document for the relation that
// survived. The two keys carry the same relation kinds, and a repair that speaks only one vocabulary
// leaves half the document unexamined — which looks like the repair did nothing.
test('an out-of-list `anchor:` is dropped just like a `relation:`', () => {
  const doc = [
    'requirements:',
    '  - id: REQ-001',
    '    title: t',
    'deliverable:',
    '  run: "bash s.sh {csv}"',
    'ambiguities:',
    '  - id: AMB-001',
    '    question: q',
    '    default: "half-up"',
    '    checkedAs: half-up',
    '    blocking: true',
    'relations:',
    '  - id: REL-001',
    '    relation: derived-ratio',
    '    description: ratio',
    'differential:',
    '  - id: DIFF-001',
    '    anchor: independent-aggregation',
    '    decides: AMB-001',
    '    description: anchor',
    '',
  ].join('\n');
  const r = repair(doc, SHAPE.replace(/ALLOWED_RELATIONS:.*/, 'ALLOWED_RELATIONS: derived-ratio'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /dropped DIFF-001 \(independent-aggregation\)/, 'the anchor is named as dropped');
  assert.doesNotMatch(r.after, /anchor: independent-aggregation/, 'and it is gone');
  assert.match(r.after, /relation: derived-ratio/, 'the allowed relation survives');
});
