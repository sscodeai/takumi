/**
 * THE INTAKE PROPOSES; THE CONFIRMATION DECIDES.
 *
 * Found on the real machine, 2026-10-12: an intake run produced a document whose every decision already
 * carried the intake's own answer in `chosen:` — because the SKILL PROMPT'S OWN EXAMPLE wrote it that
 * way (`extensions/skills/req-intake/prompts/intake.md` showed `default:` followed by an identical
 * `chosen:`). The consequence was measured, not assumed: confirming that document with a signed standing
 * authorization reported
 *
 *     docs/requirements/intake.yaml: 0 decision(s) would be defaulted
 *
 * — there was nothing left for the confirmation to answer, so its `defaulted:` list came out EMPTY. That
 * list is the ONE place a machine's answers are visible to a reviewer (ADR-025, ADR-045): an unattended
 * confirmation says "I took these answers from the document's own defaults", and a document that
 * pre-chooses them says nothing at all. The review surface was emptied by the thing that was supposed to
 * be reviewed.
 *
 * What these tests pin:
 *   (a) the gate REFUSES a document that arrives with answers chosen and no record of who chose them;
 *   (b) the same document WITHOUT pre-chosen answers passes — which is the important half: the fix is
 *       not allowed to make the intake unconfirmable (the validator treats a blocking decision's
 *       `default:` as its decided value, so `chosen:` was never needed for the document to hold
 *       together);
 *   (c) a document that carries an ACTUAL `confirmation:` block is left alone — there, `chosen:` has a
 *       record of who chose, which is exactly what the refusal is about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../..', import.meta.url));
const GATE = join(REPO, 'extensions/workflows/request-intake/checks/intake-shape-tap.sh');
const CLI = join(REPO, 'apps/cli/dist/index.js');
const DOC = join(REPO, 'docs/requirements/intake.yaml');

/** The gate needs a document INSIDE the project, named RELATIVE to it: the CLI joins the ref onto the
 * project root, so an absolute path is read as a path under the root and cannot be found. */
function gate(dir: string, text: string): { status: number; out: string } {
  const ref = join(dir, 'fixture.yaml');
  writeFileSync(ref, text);
  try {
    const out = execFileSync('bash', [GATE], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, TAKUMI_INTAKE_DOC: relative(REPO, ref), TAKUMI_CLI: CLI },
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { status: err.status ?? 1, out: err.stdout ?? '' };
  }
}

/** Drop the whole top-level `confirmation:` block (its indented body included), if the document has one. */
function stripConfirmationBlock(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^confirmation:\s*$/.test(line));
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end] ?? '') || (lines[end] ?? '').trim() === '')) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** The document as an intake WITHOUT the pre-chosen answers writes it: no `chosen:`, no confirmation. */
function proposed(): string {
  return stripConfirmationBlock(readFileSync(DOC, 'utf8'))
    .split('\n')
    .filter((line) => !/^\s+chosen:\s/.test(line))
    .join('\n');
}

/** The observed defect: every `default:` answered by the intake itself, in `chosen:`. */
function preChosen(): string {
  const lines = proposed().split('\n');
  const at = lines.findIndex((line) => /^\s+default:\s/.test(line));
  assert.ok(at >= 0, 'the fixture document has a default to pre-choose');
  const defaultValue = (lines[at] ?? '').replace(/^\s*default:\s*/, '');
  lines.splice(at + 1, 0, `    chosen: ${defaultValue}`);
  return lines.join('\n');
}

/** A document a person (or a signed grant) has already confirmed: `chosen:` has a record. */
function confirmed(): string {
  return ['confirmation:', '  by: "SS"', '  at: "2026-10-12T00:00:00Z"', '  method: bounded-choice', '', preChosen()].join('\n');
}

/** A scratch directory INSIDE the project: the gate resolves the document against the project root, and
 * `.takumi/` is where a project keeps its own output — it may not exist in a fresh checkout (it is
 * created by `initProject`), which is exactly how this test failed CI once. */
function scratch(): string {
  const root = join(REPO, '.takumi');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'prechosen-test-'));
}

test('the gate refuses an intake that answers its own questions, and passes the same document without them', () => {
  const dir = scratch();
  try {
    const refused = gate(dir, preChosen());
    assert.equal(refused.status, 1, `expected a refusal, the gate said:\n${refused.out}`);
    assert.match(refused.out, /already chosen and no record of who chose them/);
    assert.match(refused.out, /defaulted:/, 'the refusal says what the pre-chosen answers cost a reviewer');

    const accepted = gate(dir, proposed());
    assert.equal(
      accepted.status,
      0,
      `the same document WITHOUT pre-chosen answers must pass — otherwise the intake could never run:\n${accepted.out}`,
    );
    assert.match(accepted.out, /leaves its answers to the confirmation/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate leaves a CONFIRMED document alone: its chosen answers have a record of who chose', () => {
  const dir = mkdtempSync(join(REPO, '.takumi', 'prechosen-test-'));
  try {
    const out = gate(dir, confirmed());
    assert.equal(out.status, 0, `a document with a confirmation block is legitimate:\n${out.out}`);
    assert.match(out.out, /confirmation block: present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
