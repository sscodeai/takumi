import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LEDGER #118 — a declared entry point that does not exist must be found BEFORE the judge.
 *
 * Measured 2026-11-03 on `wf-0a7781cf`: the document declared
 *
 *   deliverable.run          : bash summary.sh {csv}
 *   deliverable.mutation.run : bash run-mutation.sh
 *
 * and `artifact_acceptance` aborted the delivery on `REL-002 mutation-detection` with "the mutation
 * command could not run (exit 127)". Run by hand in that same worktree immediately afterwards it
 * succeeds — 18 mutants measured, 0 survivors — so the run HAD produced it.
 *
 * `worktree_clean` already ran before `rule_review`, `judge_forge` and `artifact_acceptance` and
 * checked exactly one thing: nothing left uncommitted. A missing `run-mutation.sh` is not an
 * uncommitted change — it is a file that was never written — so that step passed and the judge was
 * the first to notice: the most expensive place, and the least informative.
 *
 * The check lives in `scripts/worktree-ready.sh` rather than inline in the manifest for a reason the
 * first draft demonstrated: written inline, the indentation-based parse of a NESTED key
 * (`mutation.run` sits under `deliverable:`) silently found nothing and reported READY while the file
 * was absent. These tests exist so that cannot happen again.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/worktree-ready.sh');

function worktree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtready-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  // Requirement documents live in docs/requirements/ in a real delivery.
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function ready(cwd: string, req = 'docs/requirements/intake.yaml'): { status: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT, req], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

/** The document shape that failed: `mutation.run` NESTED under `deliverable:`. */
const DOC = [
  'deliverable:',
  '  run: "bash summary.sh {csv}"',
  '  timeoutMs: 10000',
  '  mutation:',
  '    run: "bash run-mutation.sh"',
  '    report_path: "reports/mutation/mutation.json"',
  '',
].join('\n');

test('a missing NESTED mutation script is refused, and named by its path', () => {
  const dir = worktree({
    'docs/requirements/intake.yaml': DOC,
    'summary.sh': '#!/bin/sh\necho ok\n',
  });
  try {
    const r = ready(dir);
    assert.equal(r.status, 1, `a declared script that is absent must fail the step. Output:\n${r.out}`);
    assert.match(r.out, /deliverable\.mutation\.run/, 'it names the key, so the repair round knows where to look');
    assert.match(r.out, /run-mutation\.sh/, 'and the file that is missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing TOP-LEVEL deliverable script is refused too', () => {
  const dir = worktree({ 'docs/requirements/intake.yaml': DOC });
  try {
    const r = ready(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /deliverable\.run/);
    assert.match(r.out, /summary\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('everything present and committed is ready', () => {
  const dir = worktree({
    'docs/requirements/intake.yaml': DOC,
    'summary.sh': '#!/bin/sh\necho ok\n',
    'run-mutation.sh': '#!/bin/sh\necho ok\n',
  });
  try {
    const r = ready(dir);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /every entry point the document declares exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an uncommitted leftover still fails, and names every path', () => {
  const dir = worktree({
    'docs/requirements/intake.yaml': DOC,
    'summary.sh': '#!/bin/sh\necho ok\n',
    'run-mutation.sh': '#!/bin/sh\necho ok\n',
  });
  try {
    writeFileSync(join(dir, 'stray.txt'), 'x');
    const r = ready(dir);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /uncommitted change/);
    assert.match(r.out, /stray\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable requirement is exit 2, never a pass', () => {
  const dir = worktree({ 'docs/requirements/intake.yaml': DOC });
  try {
    const r = ready(dir, 'docs/requirements/nope.yaml');
    assert.equal(r.status, 2, 'a check that cannot see its inputs must not report success');
    assert.match(r.out, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a template placeholder is not treated as a file to check', () => {
  // `{csv}` is replaced by the judge with a fixture path; requiring a file named `{csv}` would fail
  // every correct delivery.
  const dir = worktree({
    'docs/requirements/intake.yaml': ['deliverable:', '  run: "python3 report.py {csv}"', ''].join('\n'),
    'report.py': 'print("x")\n',
  });
  try {
    const r = ready(dir);
    assert.equal(r.status, 0, r.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the step runs in the delivery worktree and the engine gives it TAKUMI_PROJECT', () => {
  // The script lives in takumi, not in the delivery, so the manifest reaches it through
  // `$TAKUMI_PROJECT`. Asserting the manifest alone would miss a regression in the engine.
  const manifest = execFileSync('cat', [join(REPO, 'extensions/workflows/request-to-delivery-attempt/workflow.yaml')], {
    encoding: 'utf8',
  });
  assert.ok(
    manifest.includes('$TAKUMI_PROJECT/scripts/worktree-ready.sh'),
    'the manifest uses the project root to reach takumi\'s own script',
  );
  const engine = execFileSync('cat', [join(REPO, 'packages/core/src/workflow-engine.ts')], { encoding: 'utf8' });
  assert.ok(
    engine.includes('TAKUMI_PROJECT: ctx.cwd'),
    'and the engine actually sets it for tool steps',
  );
});
