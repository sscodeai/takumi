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
    const { code, lines } = await walk(f.dir, f.ref, ['', '', '']);
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
    // [1] = the failure is addressed; then [enter] keeps the one decision.
    const { code, lines } = await walk(f.dir, f.ref, ['1', '2']);
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
