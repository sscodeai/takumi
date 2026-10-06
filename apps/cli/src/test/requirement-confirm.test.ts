import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requirementDigest } from '@takumi/core';
import { runRequirementCommand, withChosen, withConfirmation } from '../requirement-command.js';

// The bounded-choice confirmation (ADR-027). What is pinned here is the SHAPE of the human's answer
// and the two refusals that make it a confirmation rather than a formality: it must be interactive,
// and it must not produce a token while a blocking decision is undecided.

const DOC = [
  '# A hand-written requirement document, comments and all.',
  'requirement:',
  '  id: REQ-DOC-001',
  'requirements:',
  '  - id: REQ-001',
  '    title: Do the thing',
  '    acceptance_criteria:',
  '      - "A third party can check that the thing is done."',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: What happens to a malformed row?',
  '    options: ["stop", "skip and count"]',
  '    default: "skip and count"',
  '    chosen: "skip and count"',
  '    blocking: true',
  '  - id: AMB-002',
  '    question: Where does the output go?',
  '    options: ["stdout only", "stdout plus a file"]',
  '    default: "stdout plus a file"',
  '    blocking: false',
  '  - id: AMB-003',
  '    question: Which rounding?',
  '    options: ["half-up", "truncate"]',
  '    chosen: "half-up"',
  '    blocking: true',
  '',
].join('\n');

function project(text = DOC): { dir: string; ref: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-confirm-'));
  const ref = 'docs/requirements/feature.yaml';
  writeFileSync(join(dir, 'feature.yaml'), text);
  return { dir, ref: 'feature.yaml', path: join(dir, 'feature.yaml') };
}

/** Drive the REAL readline path: answer when the prompt is written. */
async function walk(dir: string, answers: string[]): Promise<{ code: number; lines: string[] }> {
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
    const code = await runRequirementCommand(dir, ['confirm', 'feature.yaml'], { input, out: (line) => lines.push(line) });
    return { code, lines };
  } finally {
    process.stdout.write = original;
  }
}

test('requirement confirm: a non-interactive confirmation is refused, and no token is printed', async () => {
  const f = project();
  try {
    const lines: string[] = [];
    const piped = new PassThrough(); // no isTTY: a pipeline
    const code = await runRequirementCommand(f.dir, ['confirm', f.ref], { input: piped, out: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /must be interactive/);
    assert.ok(!lines.join('\n').includes('sha256:'), 'no token may be produced by a pipeline');
    assert.equal(readFileSync(f.path, 'utf8'), DOC, 'the document is untouched');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm --dry-run: it never writes, and it refuses while a blocking decision is undecided', async () => {
  const undecided = DOC.replace('  - id: AMB-003\n    question: Which rounding?\n    options: ["half-up", "truncate"]\n    chosen: "half-up"\n', '  - id: AMB-003\n    question: Which rounding?\n    options: ["half-up", "truncate"]\n');
  const f = project(undecided);
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['confirm', f.ref, '--dry-run'], { out: (l) => lines.push(l) });
    assert.equal(code, 1, 'an undecided blocking decision is a refusal');
    assert.match(lines.join('\n'), /AMB-003 \(blocking\)/);
    assert.match(lines.join('\n'), /UNDECIDED/);
    assert.equal(readFileSync(f.path, 'utf8'), undecided, '--dry-run writes nothing');

    // And with everything decided it is a clean read-only check.
    const ok = project();
    try {
      const lines2: string[] = [];
      const code2 = await runRequirementCommand(ok.dir, ['confirm', ok.ref, '--dry-run'], { out: (l) => lines2.push(l) });
      assert.equal(code2, 0);
      assert.match(lines2.join('\n'), /decided: half-up/);
      assert.equal(readFileSync(ok.path, 'utf8'), DOC);
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: numbered answers are written into the document, and the token covers the written text', async () => {
  const f = project();
  try {
    // AMB-001: keep (enter, the current choice); AMB-002: pick 1 ("stdout only" — a CHANGE from the
    // default); AMB-003: pick 2 ("truncate" — another change).
    const { code, lines } = await walk(f.dir, ['', '1', '2']);
    assert.equal(code, 0, lines.join('\n'));
    const written = readFileSync(f.path, 'utf8');
    assert.match(written, /- id: AMB-001[\s\S]*?chosen: "skip and count"/);
    assert.match(written, /- id: AMB-002[\s\S]*?chosen: "stdout only"/, 'the answer is written into the document');
    assert.match(written, /- id: AMB-003[\s\S]*?chosen: "truncate"/);
    assert.match(written, /^confirmation:$/m, 'the confirmation block records who and when');
    assert.match(written, /^  method: bounded-choice$/m);
    assert.match(written, /# A hand-written requirement document, comments and all\./, 'comments survive');

    const printed = lines.find((l) => l.startsWith('sha256:')) ?? '';
    assert.equal(printed, `sha256:${requirementDigest(written)}`, 'the printed token is the digest of the WRITTEN document');
    // And it is the token the acceptance step would bind to.
    const again = await runRequirementCommand(f.dir, ['digest', f.ref], { out: () => {} });
    assert.equal(again, 0);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: an out-of-range answer is re-asked rather than guessed', async () => {
  const f = project();
  try {
    // '9' is not one of the two options, so the question is put again; then [enter] keeps the current
    // choice, and the remaining two questions are answered by number.
    const { code, lines } = await walk(f.dir, ['9', '', '2', '1']);
    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines.join('\n'), /enter a number between 1 and 2/, 'an out-of-range answer is named, not guessed');
    const written = readFileSync(f.path, 'utf8');
    assert.match(written, /- id: AMB-001[\s\S]*?chosen: "skip and count"/, 'enter kept the current choice');
    assert.match(written, /- id: AMB-002[\s\S]*?chosen: "stdout plus a file"/);
    assert.match(written, /- id: AMB-003[\s\S]*?chosen: "half-up"/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: leaving a blocking decision undecided refuses, and writes nothing', async () => {
  const f = project();
  try {
    const { code, lines } = await walk(f.dir, ['s', '1']);
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /AMB-001 is blocking and was left undecided/);
    assert.equal(readFileSync(f.path, 'utf8'), DOC, 'nothing is written when a blocking decision is open');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: aborting writes nothing and produces no token', async () => {
  const f = project();
  try {
    const { code, lines } = await walk(f.dir, ['q']);
    assert.equal(code, 2);
    assert.match(lines.join('\n'), /aborted/);
    assert.ok(!lines.join('\n').includes('sha256:'));
    assert.equal(readFileSync(f.path, 'utf8'), DOC);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('requirement confirm: a document with no open decisions points at the digest instead', async () => {
  const f = project(
    ['requirements:', '  - id: REQ-001', '    title: A thing', '    acceptance_criteria:', '      - "A third party can check it."', ''].join('\n'),
  );
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['confirm', f.ref], { out: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /records no open decisions/);
    assert.match(lines.join('\n'), /takumi requirement digest/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// --- the two text helpers, so a failure names itself ------------------------------------------

test('withChosen: replaces in place, and adds a line only when the document has none', () => {
  // AMB-001 already carries a `chosen:` line: replacing it must not change the file's line count.
  const replaced = withChosen(DOC, 'AMB-001', 'stop');
  assert.match(replaced, /    chosen: "stop"/);
  assert.equal(replaced.split('\n').length, DOC.split('\n').length, 'a replacement adds no line');

  // AMB-002 has none: the line is inserted into its own block.
  const added = withChosen(DOC, 'AMB-002', 'stdout only');
  assert.match(added, /- id: AMB-002[\s\S]*?chosen: "stdout only"/);
  assert.equal(added.split('\n').length, DOC.split('\n').length + 1);
});

test('withConfirmation: appended once, replaced in place after that', () => {
  const once = withConfirmation(DOC, 'ss', '2026-10-01T00:00:00.000Z');
  assert.match(once, /\nconfirmation:\n  by: "ss"\n  at: "2026-10-01T00:00:00.000Z"\n  method: bounded-choice\n$/);
  const twice = withConfirmation(once, 'ss', '2026-10-02T00:00:00.000Z');
  assert.equal(twice.match(/^confirmation:$/gm)?.length, 1);
  assert.match(twice, /at: "2026-10-02T00:00:00.000Z"/);
});
