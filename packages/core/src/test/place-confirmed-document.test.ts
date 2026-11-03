import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LEDGER #120 — the confirm step must put the document where the implementer can see it.
 *
 * Measured 2026-11-04 on `wf-b4760a89`. Three different files were in play at once:
 *
 *   confirmed digest (what the confirmation licensed, what every GATE reads)   sha256:cdda0c7b...
 *   the delivery worktree's docs/requirements/intake.yaml (what the AGENT read) sha256:12dfd7f2...
 *     -> `27b8f14 feat: deliver per-region revenue summary`, a PREVIOUS request
 *   the project's copy at the end of the run                                     sha256:3ab28b75...
 *
 * The request was a `suite,passed,total` pass percentage. The implementer built a per-region revenue
 * summary, faithfully, from the document it could see. #114 had told it to take the input world from
 * "THIS requirement document" — advice about a file it could not see.
 *
 * So the argument is not about instructions. It is about DIGESTS: the document the confirmation
 * licensed must be the file the implementer reads, byte for byte, or the chain is grading one
 * requirement and implementing another.
 *
 * The check lives in `scripts/place-confirmed-document.sh` so it can be exercised directly.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCRIPT = join(REPO, 'scripts/place-confirmed-document.sh');

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A "project" holding the confirmed document, and a "worktree" cloned from another repository. */
function pair(projectDoc: string, worktreeDoc: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'place-doc-'));
  const project = join(dir, 'project');
  const worktree = join(dir, 'worktree');
  mkdirSync(join(project, 'docs/requirements'), { recursive: true });
  mkdirSync(join(worktree, 'docs/requirements'), { recursive: true });
  writeFileSync(join(project, 'docs/requirements/intake.yaml'), projectDoc);
  if (worktreeDoc !== null) {
    writeFileSync(join(worktree, 'docs/requirements/intake.yaml'), worktreeDoc);
  }
  // A worktree is a git checkout; give it one even when the document is absent, or `git commit` has
  // nothing to commit and the fixture fails before the script under test is reached.
  writeFileSync(join(worktree, 'README.md'), 'worktree fixture\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('add', '-A');
  git('commit', '-qm', 'worktree fixture');
  return { dir, project, worktree };
}

function place(project: string, worktree: string, digest: string) {
  try {
    const out = execFileSync(
      'bash',
      [SCRIPT, '--project', project, '--worktree', worktree, '--ref', 'docs/requirements/intake.yaml', '--digest', digest],
      { cwd: worktree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const MINE = 'requirements:\n  - id: REQ-001\n    title: per-suite pass percentage\n';

test('a worktree holding a DIFFERENT document is overwritten with the confirmed one', () => {
  const { dir, project, worktree } = pair(MINE, 'requirements:\n  - id: REQ-OLD\n    title: per-region revenue\n');
  try {
    const digest = sha256(join(project, 'docs/requirements/intake.yaml'));
    const r = place(project, worktree, digest);
    assert.equal(r.status, 0, r.out);
    assert.equal(
      sha256(join(worktree, 'docs/requirements/intake.yaml')),
      digest,
      'the implementer must read the byte-for-byte document the confirmation licensed',
    );
    assert.match(readFileSync(join(worktree, 'docs/requirements/intake.yaml'), 'utf8'), /REQ-001/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree with NO document gets one', () => {
  const { dir, project, worktree } = pair(MINE, null);
  try {
    const digest = sha256(join(project, 'docs/requirements/intake.yaml'));
    assert.equal(place(project, worktree, digest).status, 0);
    assert.equal(sha256(join(worktree, 'docs/requirements/intake.yaml')), digest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a worktree already holding the confirmed document is left alone', () => {
  const { dir, project, worktree } = pair(MINE, MINE);
  try {
    const digest = sha256(join(project, 'docs/requirements/intake.yaml'));
    const before = readFileSync(join(worktree, 'docs/requirements/intake.yaml'), 'utf8');
    assert.equal(place(project, worktree, digest).status, 0);
    assert.equal(readFileSync(join(worktree, 'docs/requirements/intake.yaml'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the placement is COMMITTED, so it travels with the delivery', () => {
  // An uncommitted copy would be refused by worktree_clean (#106) and never reach the host.
  const { dir, project, worktree } = pair(MINE, 'requirements:\n  - id: REQ-OLD\n    title: old\n');
  try {
    const digest = sha256(join(project, 'docs/requirements/intake.yaml'));
    assert.equal(place(project, worktree, digest).status, 0, 'placement succeeds');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' });
    assert.equal(status.trim(), '', `the tree must be clean after placement, got:\n${status}`);
    const tracked = execFileSync('git', ['show', 'HEAD:docs/requirements/intake.yaml'], { cwd: worktree, encoding: 'utf8' });
    assert.match(tracked, /REQ-001/, 'and the committed content is the confirmed one');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a digest that does not match the project document is REFUSED', () => {
  // The whole point is the digest: if the project file changed after confirmation, placing it would
  // deliver a document nobody licensed.
  const { dir, project, worktree } = pair(MINE, null);
  try {
    const r = place(project, worktree, 'f'.repeat(64));
    assert.notEqual(r.status, 0, 'a stale confirmation must not be delivered');
    assert.match(r.out, /digest/i);
    assert.equal(
      execFileSync('git', ['status', '--porcelain'], { cwd: worktree, encoding: 'utf8' }).trim(),
      '',
      'and nothing is written when it refuses',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing project document is refused, not silently skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'place-doc-'));
  try {
    const project = join(dir, 'project');
    const worktree = join(dir, 'worktree');
    mkdirSync(project, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    const r = place(project, worktree, 'a'.repeat(64));
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
