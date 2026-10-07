import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFeedback, parseFeedback, requirementDigest } from '@takumi/core';
import { runRequirementCommand } from '../requirement-command.js';

// The human's side of the loop (ADR-029): `takumi requirement feedback` shows what the machine wrote
// back, `resolve` records what addresses it, and `confirm` puts each open failure to the human as a
// bounded choice — a document carrying an unanswered failure is not confirmable.

const DOC = [
  '# A hand-written requirement document, comments and all.',
  'requirement:',
  '  id: REQ-DOC-001',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: What happens to a malformed row?',
  '    options: ["stop", "skip and count"]',
  '    default: "skip and count"',
  '    chosen: "skip and count"',
  '    blocking: true',
  '',
  'confirmation:',
  '  by: "SS"',
  '  at: "2026-10-01T00:00:00.000Z"',
  '  method: bounded-choice',
  '',
].join('\n');

const FEEDBACK_ENTRY = [
  'feedback:',
  '  - id: FB-001',
  '    at: "2026-10-01T03:00:00.000Z"',
  '    run: "2026-10-01T02-59-00-000Z"',
  '    requirementDigest: "sha256:aaa"',
  '    judgeDigest: "sha256:bbb"',
  '    status: open',
  '    checks:',
  '      - "DEC-002 AMB-002 NOT honoured: \'First row wins\' (checked by REL-003, which failed)"',
  '',
].join('\n');

const WITH_FAILURE = `${DOC}\n${FEEDBACK_ENTRY}`;

function project(text: string): { dir: string; ref: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-feedback-cli-'));
  const ref = 'feature.yaml';
  writeFileSync(join(dir, ref), text);
  return { dir, ref, path: join(dir, ref) };
}

/** Drive the REAL readline path for `confirm`: answer when the prompt is written. */
async function walk(dir: string, ref: string, answers: string[]): Promise<{ code: number; lines: string[] }> {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  const lines: string[] = [];
  const queued = [...answers];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    const text = String(chunk);
    if (text.includes('    > ') && queued.length > 0) {
      setImmediate(() => input.write(`${queued.shift()}\n`));
    }
    return original(chunk as never, ...(rest as never[]));
  }) as typeof process.stdout.write;
  try {
    const code = await runRequirementCommand(dir, ['confirm', ref], { input, out: (line) => lines.push(line) });
    return { code, lines };
  } finally {
    process.stdout.write = original;
  }
}

test('requirement feedback: an open failure is listed and the command exits non-zero', async () => {
  const f = project(WITH_FAILURE);
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['feedback', f.ref], { out: (l) => lines.push(l) });
    assert.equal(code, 1, 'an open failure is the thing this command exists to surface');
    const text = lines.join('\n');
    assert.match(text, /FB-001 \[open\]/);
    assert.match(text, /DEC-002 AMB-002 NOT honoured/);
    assert.match(text, /still open/);
    assert.match(text, /takumi requirement resolve/);
    assert.equal(readFileSync(f.path, 'utf8'), WITH_FAILURE, 'reading never writes');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement feedback: a document with no failure is a clean exit 0', async () => {
  const f = project(DOC);
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['feedback', f.ref], { out: (l) => lines.push(l) });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /no acceptance failure has been written back/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement resolve: a resolution without a note is refused, and nothing is written', async () => {
  const f = project(WITH_FAILURE);
  try {
    const lines: string[] = [];
    assert.equal(await runRequirementCommand(f.dir, ['resolve', f.ref, '--id', 'FB-001'], { out: (l) => lines.push(l) }), 1);
    assert.match(lines.join('\n'), /usage: takumi requirement resolve/);
    assert.equal(readFileSync(f.path, 'utf8'), WITH_FAILURE);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement resolve: an unknown id is refused by name', async () => {
  const f = project(WITH_FAILURE);
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['resolve', f.ref, '--id', 'FB-099', '--note', 'a note'], { out: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /records no feedback entry FB-099/);
    assert.equal(readFileSync(f.path, 'utf8'), WITH_FAILURE);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement resolve: a resolution is recorded, and the token moves with it', async () => {
  const f = project(WITH_FAILURE);
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(
      f.dir,
      ['resolve', f.ref, '--id', 'FB-001', '--note', 'the duplicate rule now keeps the latest start_date'],
      { out: (l) => lines.push(l) },
    );
    assert.equal(code, 0, lines.join('\n'));
    const written = readFileSync(f.path, 'utf8');
    assert.match(written, /^    status: resolved$/m);
    assert.match(written, /^    resolvedNote: "the duplicate rule now keeps the latest start_date"$/m);
    assert.match(written, /# A hand-written requirement document, comments and all\./, 'comments survive');
    const entries = parseFeedback(written);
    assert.equal(entries[0]?.status, 'resolved');
    assert.equal(openFeedback(written).length, 0);
    // The failure itself is still on the record.
    assert.match(entries[0]?.checks[0] ?? '', /DEC-002/);

    // The digest moved, and the command says so — the token the next run needs is the new one.
    assert.match(lines.join('\n'), /the confirmation token moved/i);
    const printed = lines.filter((l) => l.startsWith('sha256:')).pop() ?? '';
    assert.equal(printed, `sha256:${requirementDigest(written)}`);

    const after: string[] = [];
    assert.equal(await runRequirementCommand(f.dir, ['feedback', f.ref], { out: (l) => after.push(l) }), 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: leaving a written-back failure open refuses the confirmation', async () => {
  const f = project(WITH_FAILURE);
  try {
    // The failure question comes first; [enter] keeps the current state, which is "leave it open".
    const { code, lines } = await walk(f.dir, f.ref, ['']);
    assert.equal(code, 1, lines.join('\n'));
    assert.match(lines.join('\n'), /FB-001 is still open/);
    assert.ok(!lines.join('\n').includes('sha256:'), 'no token is produced while a failure is open');
    assert.equal(readFileSync(f.path, 'utf8'), WITH_FAILURE, 'nothing is written');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: answering the failure resolves it in the same act as the confirmation', async () => {
  const f = project(WITH_FAILURE);
  try {
    // [1] = the failure is addressed; then [enter] keeps the one decision (round 1 asks every decision).
    const { code, lines } = await walk(f.dir, f.ref, ['1', '']);
    assert.equal(code, 0, lines.join('\n'));
    const written = readFileSync(f.path, 'utf8');
    assert.match(written, /^    status: resolved$/m);
    assert.match(written, /^  method: bounded-choice$/m);
    assert.equal(openFeedback(written).length, 0);
    // The token is the digest of the document AFTER both writes: the resolution and the confirmation
    // are covered by the same confirmation the run binds to.
    const printed = lines.filter((l) => l.startsWith('sha256:')).pop() ?? '';
    assert.equal(printed, `sha256:${requirementDigest(written)}`);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- ADR-030: the failure becomes a choice about WHICH SIDE is wrong ---------------------------

/** A document that binds a check to a decision, so a failure can be traced to an answer. */
const BOUND = [
  '# A hand-written requirement document, comments and all.',
  'requirement:',
  '  id: REQ-DOC-001',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: Which row wins when employee_id repeats?',
  '    options: ["First row wins", "Last row wins", "The row with the latest start_date wins"]',
  '    default: "First row wins"',
  '    chosen: "The row with the latest start_date wins"',
  '    checkedAs: latest-start-date',
  '    blocking: true',
  'deliverable:',
  '  run: "node csv-summary.mjs {csv}"',
  '  input_format:',
  '    columns: "employee_id:id,start_date:date,annual_salary:measure"',
  '    sample: |',
  '      1001,2021-04-01,100.5',
  '      1002,2020-02-02,80.0',
  '      1003,2020-01-10,90.5',
  '  output_format:',
  '    department_line:',
  '      shape: "<department> <count> <total> <average>"',
  '      fields: [id, count, sum, mean]',
  '  relations:',
  '    - id: REL-003',
  '      relation: duplicate-resolution',
  '      decides: AMB-001',
  '      description: A repeated id resolves the way AMB-001 decided.',
  '',
  'confirmation:',
  '  by: "SS"',
  '  at: "2026-10-01T00:00:00.000Z"',
  '  method: bounded-choice',
  '',
  'feedback:',
  '  - id: FB-001',
  '    at: "2026-10-01T03:00:00.000Z"',
  '    run: "wf-2"',
  '    requirementDigest: "sha256:aaa"',
  '    judgeDigest: "sha256:bbb"',
  '    status: open',
  '    checks:',
  '      - "REL-003 duplicate-resolution: the chosen option does not hold"',
  '',
].join('\n');

function bound(text = BOUND): { dir: string; ref: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-twoside-'));
  const ref = 'feature.yaml';
  writeFileSync(join(dir, ref), text);
  return { dir, ref, path: join(dir, ref) };
}

test('requirement confirm: a decision with no answer is asked in a round, and the recommendation is named', async () => {
  const withSecond = BOUND.replace(
    '    blocking: true\n',
    '    blocking: true\n  - id: AMB-002\n    question: How is a station with no rows reported?\n    options: ["an error", "a row of zeros"]\n    blocking: true\n',
  ).replace(
    '      description: A repeated id resolves the way AMB-001 decided.',
    '      description: A repeated id resolves the way AMB-001 decided.\n    - id: REL-008\n      relation: row-order-invariance\n      decides: AMB-002\n      description: The scenario that settles AMB-002.',
  );
  const f = bound(withSecond);
  try {
    // The fixture also carries an open failure, so the order is: what settles the failure (1 = the
    // implementation changes, nothing to re-decide), then round 1 asks EVERY decision in document order —
    // [enter] keeps AMB-001's current answer, then `2` answers AMB-002.
    const { code, lines } = await walk(f.dir, f.ref, ['1', '', '2']);
    const text = lines.join('\n');
    assert.match(text, /round 1 of at most 3 — 2 decision\(s\) still open/, text);
    assert.match(text, /\[1\] an error/);
    assert.match(text, /\[2\] a row of zeros/);
    assert.equal(code, 0, text);
    // A decision with NO default cannot be assumed, so the round asks it: `2` writes option 2.
    assert.match(readFileSync(f.path, 'utf8'), /- id: AMB-002[\s\S]*?chosen: "a row of zeros"/, 'the answer is written');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: `done` stops the questions and the checklist names what was left open', async () => {
  const withSecond = BOUND.replace(
    '    blocking: true\n',
    '    blocking: true\n  - id: AMB-002\n    question: How is a station with no rows reported?\n    options: ["an error", "a row of zeros"]\n    blocking: false\n',
  ).replace(
    '      description: A repeated id resolves the way AMB-001 decided.',
    '      description: A repeated id resolves the way AMB-001 decided.\n    - id: REL-008\n      relation: row-order-invariance\n      decides: AMB-002\n      description: The check that settles AMB-002.',
  );
  const f = bound(withSecond);
  try {
    // [enter] keeps AMB-001 (round 1 asks it), then `done` stops before AMB-002 — which is non-blocking, so
    // the document is still confirmable and the checklist names it as left undecided.
    const { code, lines } = await walk(f.dir, f.ref, ['1', '', 'done']);
    const text = lines.join('\n');
    assert.equal(code, 0, text);
    assert.match(text, /\[x\] AMB-001: /, 'a decided entry is ticked in the reviewer list');
    assert.match(text, /\[ \] AMB-002: left undecided/);
    assert.match(text, /1 decision\(s\) were left UNDECIDED/);
    assert.match(text, /sha256:/, 'the token is still produced: a non-blocking decision may be left open');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement brief: the failing check is traced to its decision, its answer and the alternatives', async () => {
  const f = bound();
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['brief', f.ref], { out: (l) => lines.push(l) });
    assert.equal(code, 0, 'the brief is a read-only account, so it succeeds');
    const text = lines.join('\n');
    assert.match(text, /^## Acceptance feedback \(written back by the machine\)$/m);
    assert.match(text, /decision: AMB-001 \(blocking\)/);
    assert.match(text, /recorded answer: The row with the latest start_date wins/);
    assert.match(text, /- First row wins/);
    assert.match(text, /- Last row wins/);
    assert.equal(readFileSync(f.path, 'utf8'), BOUND, 'the brief writes nothing');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: the failure is put as a choice between the implementation and the answer', async () => {
  const f = bound();
  try {
    // [2] = the answer was wrong; then pick option 1 ("First row wins") for AMB-001 when it is re-asked.
    const { code, lines } = await walk(f.dir, f.ref, ['2', '1']);
    assert.equal(code, 0, lines.join('\n'));
    const text = lines.join('\n');
    assert.match(text, /the recorded answer stands and the IMPLEMENTATION changes/);
    assert.match(text, /the answer was wrong — decide that decision again below/);
    assert.match(text, /either the implementation ignored that answer, or the answer itself was wrong/i);

    const written = readFileSync(f.path, 'utf8');
    assert.match(written, /- id: AMB-001[\s\S]*?chosen: "First row wins"/, 'the new answer is written');
    assert.match(written, /^    status: resolved$/m);
    assert.match(written, /^    resolvedByDecision: "AMB-001"$/m, 'the resolution records which decision answered it');
    assert.equal(openFeedback(written).length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: claiming the answer was wrong while leaving it unchanged is refused', async () => {
  const f = bound();
  try {
    // [2] = the answer was wrong, then [enter] keeps the current answer — nothing changed, so the claim
    // is empty and the confirmation must not be produced.
    const { code, lines } = await walk(f.dir, f.ref, ['2', '']);
    assert.equal(code, 1, lines.join('\n'));
    assert.match(lines.join('\n'), /you answered that the answer was wrong, but AMB-001 still reads "The row with the latest start_date wins"/);
    assert.ok(!lines.join('\n').includes('sha256:'), 'no token');
    assert.equal(readFileSync(f.path, 'utf8'), BOUND, 'nothing is written');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: saying the implementation changes needs no change to the document answers', async () => {
  const f = bound();
  try {
    const { code, lines } = await walk(f.dir, f.ref, ['1', '']);
    assert.equal(code, 0, lines.join('\n'));
    const written = readFileSync(f.path, 'utf8');
    assert.match(written, /^    resolvedNote: "the recorded answer stands; the implementation changes/m);
    assert.match(written, /- id: AMB-001[\s\S]*?chosen: "The row with the latest start_date wins"/, 'the answer is unchanged');
    assert.equal(openFeedback(written).length, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: a decision citing a failure the document does not record stops the confirmation', async () => {
  const dangling = BOUND.replace('    blocking: true', '    blocking: true\n    fromFeedback: FB-009');
  const f = bound(dangling);
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['confirm', f.ref, '--dry-run'], { out: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /AMB-001 cites FB-009, which this document does not record/);
    assert.match(lines.join('\n'), /Nothing was written/);
    assert.equal(readFileSync(f.path, 'utf8'), dangling);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm --dry-run: an open failure is reported and refuses', async () => {
  const f = project(WITH_FAILURE);
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['confirm', f.ref, '--dry-run'], { out: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /FB-001 \(run /);
    assert.match(lines.join('\n'), /open acceptance failure\(s\)/);
    assert.equal(readFileSync(f.path, 'utf8'), WITH_FAILURE);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
