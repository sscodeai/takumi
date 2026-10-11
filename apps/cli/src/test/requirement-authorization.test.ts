import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizationDigest, requirementDigest, validateRequirementDocument } from '@takumi/core';
import { runRequirementCommand } from '../requirement-command.js';

/**
 * The standing authorization at the REAL confirmation path (ADR-045, pin-only v1).
 *
 * These tests drive `takumi requirement confirm <ref> --authorization <ref>` with a NON-TTY stdin —
 * the input the command refuses outright today — and pin the two things that make the exception safe:
 *   * a covered document is confirmed non-interactively, writes its own defaults, and prints the same
 *     token an interactive confirmation would (the token is the document's, unchanged, ADR-025); and
 *   * a document the authorization does not cover is refused BY NAME with nothing written — the
 *     refusal is the feature, so the load-bearing assertion is that the file is byte-identical.
 */

const DOC_REF = 'docs/requirements/intake.yaml';
const AUTH_REF = 'docs/authorizations/SA-001.yaml';

const DOC = [
  '# A hand-written requirement document, comments and all.',
  'requirements:',
  '  - id: REQ-001',
  '    title: "Summarise the readings"',
  '    description: "Print one aggregate line per station."',
  '    acceptance_criteria:',
  '      - "A third party can check the summary."',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: "How are unparseable rows handled?"',
  '    options:',
  '      - "skip-count: skipped and counted on a SKIPPED line"',
  '      - "stop-error: the first bad row aborts the run"',
  '    default: "skip-count: skipped and counted on a SKIPPED line"',
  '    checkedAs: skip-count',
  '    blocking: true',
  '  - id: AMB-002',
  '    question: "When a (date, station) key repeats, what wins?"',
  '    options:',
  '      - "merge: every occurrence counts as its own reading"',
  '      - "last-row: only the last occurrence is kept"',
  '    default: "merge: every occurrence counts as its own reading"',
  '    checkedAs: merge',
  '    blocking: true',
  '  - id: AMB-003',
  '    question: "In what order are the station lines printed?"',
  '    options:',
  '      - "ascending station id"',
  '      - "order of first appearance in the input"',
  '    default: "ascending station id"',
  '    blocking: false',
  'deliverable:',
  '  run: "bash summary.sh {csv}"',
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
  '  relations:',
  '    - id: REL-001',
  '      relation: malformed-row-accounting',
  '      decides: AMB-001',
  '      description: "bad rows are skipped and counted"',
  '    - id: REL-002',
  '      relation: duplicate-resolution',
  '      decides: AMB-002',
  '      description: "a repeated key merges"',
  '',
].join('\n');

function authText(doc: string, mutate: (lines: string[]) => string[] = (l) => l): string {
  return mutate([
    'id: SA-001',
    'signedBy: "moon"',
    'signedAt: "2026-10-11T00:00:00Z"',
    'expiresAt: "2099-11-11T00:00:00Z"',
    'revoked: false',
    'reason: "unattended intake for the station-summary document"',
    'pin:',
    `  ref: "${DOC_REF}"`,
    `  digest: "${requirementDigest(doc)}"`,
    'decisions:',
    '  - class: malformed-row-accounting',
    '    policy: document-default',
    '  - class: duplicate-resolution',
    '    policy: document-default',
    '  - class: unmechanised',
    '    policy: document-default',
    'failures:',
    '  - class: implementation-changes',
    '',
  ]).join('\n');
}

interface Project {
  dir: string;
  docPath: string;
  authPath: string;
}

function project(doc = DOC, authorization = authText(doc)): Project {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-standing-'));
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(join(dir, 'docs/authorizations'), { recursive: true });
  const docPath = join(dir, DOC_REF);
  const authPath = join(dir, AUTH_REF);
  writeFileSync(docPath, doc, 'utf8');
  writeFileSync(authPath, authorization, 'utf8');
  return { dir, docPath, authPath };
}

/** A pipeline: no isTTY, which is the input the command refuses without an authorization. */
function piped(): PassThrough & { isTTY?: boolean } {
  return new PassThrough() as PassThrough & { isTTY?: boolean };
}

async function confirm(f: Project, extra: string[] = [], input = piped()) {
  const lines: string[] = [];
  const code = await runRequirementCommand(f.dir, ['confirm', DOC_REF, '--authorization', AUTH_REF, ...extra], {
    input,
    out: (line) => lines.push(line),
  });
  return { code, lines, text: lines.join('\n') };
}

test('a covered document is confirmed non-interactively: the defaults are written, and the token is the document\'s', async () => {
  const f = project();
  try {
    const { code, lines, text } = await confirm(f);
    assert.equal(code, 0, text);

    const written = readFileSync(f.docPath, 'utf8');
    // Every open decision now carries its OWN default as its chosen answer.
    assert.match(written, /- id: AMB-001[\s\S]*?chosen: "skip-count: skipped and counted on a SKIPPED line"/);
    assert.match(written, /- id: AMB-002[\s\S]*?chosen: "merge: every occurrence counts as its own reading"/);
    assert.match(written, /- id: AMB-003[\s\S]*?chosen: "ascending station id"/);
    // The comments survive: the write is textual, not a re-serialisation.
    assert.match(written, /# A hand-written requirement document, comments and all\./);

    // The confirmation block says HOW: the method, the authorization it was checked against, and which
    // answers nobody read.
    assert.match(written, /^confirmation:$/m);
    assert.match(written, /^  method: standing-authorization$/m);
    assert.match(written, /^  by: "moon"$/m, 'by is the SIGNER, not the process');
    assert.match(written, /SA-001\.yaml/);
    assert.match(written, new RegExp(authorizationDigest(readFileSync(f.authPath, 'utf8'))));
    assert.match(written, /^  defaulted:$/m);
    assert.match(written, /- id: AMB-001/);

    // The token is the digest of the document the command just wrote — the same token an interactive
    // confirmation would print for the same text (ADR-025's binding is untouched).
    const printed = lines.find((l) => l.startsWith('sha256:')) ?? '';
    assert.equal(printed, `sha256:${requirementDigest(written)}`);
    const again = await runRequirementCommand(f.dir, ['digest', DOC_REF], { out: (l) => lines.push(l) });
    assert.equal(again, 0);

    // And the written document is still a document the front door accepts.
    assert.deepEqual(validateRequirementDocument(written), [], 'the standing confirmation leaves a valid document');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('out of scope STOPS the confirmation: nothing is written, no token, and the decision is named', async () => {
  // The authorization does not grant duplicate-resolution, so AMB-002 is out of scope.
  const f = project(DOC, authText(DOC, (lines) => lines.filter((line) => line !== '  - class: duplicate-resolution' && line !== '    policy: document-default')));
  try {
    const { code, text } = await confirm(f);
    assert.equal(code, 1);
    assert.match(text, /AMB-002/);
    assert.match(text, /duplicate-resolution/);
    assert.ok(!text.includes('sha256:'), 'no token may be produced for a document out of scope');
    assert.equal(readFileSync(f.docPath, 'utf8'), DOC, 'the document is byte-identical');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a decision marked human: true is never defaulted, whatever the authorization grants', async () => {
  const doc = DOC.replace('    checkedAs: merge\n', '    checkedAs: merge\n    human: true\n');
  const f = project(doc);
  try {
    const { code, text } = await confirm(f);
    assert.equal(code, 1);
    assert.match(text, /AMB-002/);
    assert.match(text, /human/i);
    assert.equal(readFileSync(f.docPath, 'utf8'), doc, 'nothing is written');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('an open acceptance failure stops it: a machine may not close a failure in v1', async () => {
  const doc = [
    DOC,
    'feedback:',
    '  - id: FB-001',
    '    at: "2026-10-01T00:00:00.000Z"',
    '    run: "wf-deadbeef"',
    '    requirementDigest: "aaaa"',
    '    judgeDigest: "sha256:bbbb"',
    '    status: open',
    '    checks:',
    '      - "REL-002 duplicate-resolution: the chosen option \\"merge\\" does not hold"',
    '',
  ].join('\n');
  const f = project(doc);
  try {
    const { code, text } = await confirm(f);
    assert.equal(code, 1);
    assert.match(text, /FB-001/);
    assert.match(text, /failure/i);
    assert.equal(readFileSync(f.docPath, 'utf8'), doc);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a revoked, expired or edited authorization is refused by name', async () => {
  const revoked = project(DOC, authText(DOC, (lines) => lines.map((l) => (l === 'revoked: false' ? 'revoked: true' : l))));
  try {
    const { code, text } = await confirm(revoked);
    assert.equal(code, 1);
    assert.match(text, /revoked/i);
    assert.equal(readFileSync(revoked.docPath, 'utf8'), DOC);
  } finally {
    rmSync(revoked.dir, { recursive: true, force: true });
  }

  const expired = project(DOC, authText(DOC, (lines) => lines.map((l) => (l.startsWith('expiresAt:') ? 'expiresAt: "2020-01-01T00:00:00Z"' : l))));
  try {
    const { code, text } = await confirm(expired);
    assert.equal(code, 1);
    assert.match(text, /expired/i);
    assert.equal(readFileSync(expired.docPath, 'utf8'), DOC);
  } finally {
    rmSync(expired.dir, { recursive: true, force: true });
  }

  // The pin binds the revision a human READ: an edit after signing is refused with both digests.
  const f = project();
  try {
    const edited = `${DOC}# an edit after the authorization was signed\n`;
    writeFileSync(f.docPath, edited, 'utf8');
    const { code, text } = await confirm(f);
    assert.equal(code, 1);
    assert.match(text, new RegExp(requirementDigest(DOC)));
    assert.match(text, new RegExp(requirementDigest(edited)));
    assert.equal(readFileSync(f.docPath, 'utf8'), edited, 'nothing is written');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--authorization <ref>@sha256:<digest> pins the authorization file itself', async () => {
  const f = project();
  try {
    const lines: string[] = [];
    const wrong = 'f'.repeat(64);
    const code = await runRequirementCommand(
      f.dir,
      ['confirm', DOC_REF, '--authorization', `${AUTH_REF}@sha256:${wrong}`],
      { input: piped(), out: (l) => lines.push(l) },
    );
    assert.equal(code, 1);
    assert.match(lines.join('\n'), new RegExp(wrong));
    assert.match(lines.join('\n'), new RegExp(authorizationDigest(readFileSync(f.authPath, 'utf8'))));
    assert.equal(readFileSync(f.docPath, 'utf8'), DOC);

    // The right digest is accepted.
    const ok = await runRequirementCommand(
      f.dir,
      ['confirm', DOC_REF, '--authorization', `${AUTH_REF}@sha256:${authorizationDigest(readFileSync(f.authPath, 'utf8'))}`],
      { input: piped(), out: (l) => lines.push(l) },
    );
    assert.equal(ok, 0, lines.join('\n'));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('--dry-run runs the SAME check and writes nothing', async () => {
  const covered = project();
  try {
    const { code, text } = await confirm(covered, ['--dry-run']);
    assert.equal(code, 0, text);
    assert.equal(readFileSync(covered.docPath, 'utf8'), DOC, '--dry-run never writes');
    assert.ok(!text.includes('sha256:'), '--dry-run prints no token');
    assert.match(text, /AMB-001/);
  } finally {
    rmSync(covered.dir, { recursive: true, force: true });
  }

  const uncovered = project(DOC, authText(DOC, (lines) => lines.filter((line) => line !== '  - class: malformed-row-accounting' && line !== '    policy: document-default')));
  try {
    const { code, text } = await confirm(uncovered, ['--dry-run']);
    assert.equal(code, 1, 'CI can see the refusal without ever confirming anything');
    assert.match(text, /AMB-001/);
    assert.equal(readFileSync(uncovered.docPath, 'utf8'), DOC);
  } finally {
    rmSync(uncovered.dir, { recursive: true, force: true });
  }
});

test('without an authorization a non-interactive confirmation is still refused, and the refusal points at one', async () => {
  const f = project();
  try {
    const lines: string[] = [];
    const code = await runRequirementCommand(f.dir, ['confirm', DOC_REF], { input: piped(), out: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /must be interactive/);
    assert.match(lines.join('\n'), /--authorization/, 'the narrowed refusal names the one way forward');
    assert.ok(!lines.join('\n').includes('sha256:'));
    assert.equal(readFileSync(f.docPath, 'utf8'), DOC);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('it fills blanks only: an answer a human already wrote is left exactly as it is', async () => {
  const doc = DOC.replace(
    '    checkedAs: merge\n',
    '    checkedAs: merge\n    chosen: "last-row: only the last occurrence is kept"\n',
  );
  const f = project(doc);
  try {
    const { code, text } = await confirm(f);
    assert.equal(code, 0, text);
    const written = readFileSync(f.docPath, 'utf8');
    assert.match(written, /- id: AMB-002[\s\S]*?chosen: "last-row: only the last occurrence is kept"/, 'the human answer stands');
    assert.match(written, /- id: AMB-001[\s\S]*?chosen: "skip-count: skipped and counted on a SKIPPED line"/, 'the blank is filled');
    assert.ok(!/AMB-002[\s\S]*?defaulted/.test(written), 'the answered decision is not in the defaulted list');
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});
