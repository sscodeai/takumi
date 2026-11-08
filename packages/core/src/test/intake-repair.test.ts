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
