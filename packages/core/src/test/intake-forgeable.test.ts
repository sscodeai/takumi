/**
 * THE GATE ASKS THE JUDGE'S QUESTION.
 *
 * Found on the real machine, 2026-10-12, in the THIRD unattended chain (`scripts/autopilot.sh`, run
 * `wf-f84f3a1a`). The intake produced a document the shape gate passed 5/5 — and the judge forge REFUSED
 * it:
 *
 *     the deliverable block declares 0 output line(s) that are neither a per-id line nor a skipped line,
 *     where exactly one totals line is needed: additivity and the independent recomputation both compare
 *     against it
 *
 * The document was not unusable. It declared a per-id line and a skipped line, both correct and both
 * judgeable; the intake had simply omitted the totals line its own prompt's example shows. What made
 * that expensive is WHERE the disagreement was discovered: the gate asks whether a document HAS a
 * `deliverable` block and delegates the rest to `requirement confirm --dry-run`, which knows nothing
 * about forgeability. So the refusal arrived at `judge_forge` — AFTER the implementation, the delivered
 * tests and the quality gate had all been paid for (measured 1 047 s for that round) — and, because the
 * delivery attempt is a `repair` step with `maxRounds: 2`, it was paid for a SECOND time by a round that
 * could never succeed: a document does not change between attempts. The second round's implementer,
 * handed a failure no implementation could repair, went looking for what could, and left the delivery
 * worktree for this repository (see docs/bugs-fixed.md #69).
 *
 * The gate is the only place in the chain where a document is still free to fix. So it asks the judge's
 * own question there: the forge is run against the document BEFORE a human (or a signed grant) is asked
 * to confirm it, and a refusal is a failed check — not a note. The cost of a document no judge can be
 * forged from becomes ~2 s instead of ~35 min.
 *
 * What these tests pin:
 *   (a) the gate REFUSES a document the forge refuses, and the failing check is the one that says so;
 *   (b) it PASSES the very document the forge accepts — the fix may not make a good document
 *       unconfirmable, which is the half that makes this a gate rather than a wall;
 *   (c) the fixture differs from the accepted document in exactly one way (the totals line), so (a) can
 *       only be about what the forge could not implement.
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
/** A document this repository's own forge accepts: it delivered the station-summary service (PR #7). */
const ACCEPTED = join(REPO, 'docs/requirements/service-station-summary.yaml');

/** Run the gate over a document and report what it decided. */
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

/** A scratch directory INSIDE the project: the gate resolves the document against the project root. */
function scratch(): string {
  const root = join(REPO, '.takumi');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, 'forgeable-test-'));
}

/** The accepted document, with its totals line (and only that) removed: a document no judge can be forged
 *  from, because a judge that must compare a whole against its parts has no whole to read. */
function withoutTotalsLine(): string {
  const lines = readFileSync(ACCEPTED, 'utf8').split('\n');
  const at = lines.findIndex((line) => /^ {4}total_object:\s*$/.test(line));
  assert.ok(at >= 0, 'the fixture document declares a totals line to remove');
  let end = at + 1;
  while (end < lines.length && (/^\s/.test(lines[end] ?? '') || (lines[end] ?? '').trim() === '')) end += 1;
  return [...lines.slice(0, at), ...lines.slice(end)].join('\n');
}

test('the gate REFUSES a document no judge can be forged from, where the shape gate alone passed it', () => {
  const dir = scratch();
  try {
    const refused = gate(dir, withoutTotalsLine());
    assert.notEqual(refused.status, 0, `the gate fails a document the forge refuses\n${refused.out}`);
    assert.match(
      refused.out,
      /not ok \d+ - a judge can be forged from the document as the confirmation will leave it/,
      `the failing check is the one that asked the judge's question\n${refused.out}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the gate PASSES the document the forge accepts (no false red)', () => {
  const dir = scratch();
  try {
    const passed = gate(dir, readFileSync(ACCEPTED, 'utf8'));
    assert.equal(passed.status, 0, `the accepted document passes\n${passed.out}`);
    assert.match(
      passed.out,
      /ok \d+ - a judge can be forged from the document as the confirmation will leave it/,
      `the judge's question was asked and answered with a pass\n${passed.out}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
