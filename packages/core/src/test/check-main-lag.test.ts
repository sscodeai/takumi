import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ledger #94: `main` was found 131 commits (fourteen days) behind `dev` on 2026-10-20, including five
// ledgers of fixes. Nothing was broken — which is why it went unnoticed. A release line that is always
// one PR behind is reviewable; one that is a fortnight behind turns "merge dev into main" into a
// 10,000-line review nobody reads.
//
// The check answers ONE question — has the release line been left behind? — and fits in one number, so
// it is cheap enough to run on every push rather than being discovered at release time.
const SCRIPT = fileURLToPath(new URL('../../../../scripts/check-main-lag.sh', import.meta.url));

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * A throwaway repository with `main` and `dev`, `dev` carrying `ahead` extra commits.
 *
 * `ageDays` backdates every `dev` commit, so the AGE bound can be tested without waiting: a count
 * bound cannot tell the difference between 155 commits released in a day and one commit forgotten
 * for a month, and that difference is the whole point of the second bound.
 */
function repo(ahead: number, ageDays = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'mainlag-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'f.txt'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'branch', '-m', 'main');
  git(dir, 'checkout', '-qb', 'dev');
  const when = ageDays > 0 ? new Date(Date.now() - ageDays * 86_400_000).toISOString() : null;
  for (let i = 1; i <= ahead; i += 1) {
    writeFileSync(join(dir, 'f.txt'), `base\n${i}\n`);
    git(dir, 'add', '.');
    const args = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=test', 'commit', '-qm', `dev commit ${i}`];
    if (when) {
      const r = spawnSync('git', args, {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when },
      });
      if (r.status !== 0) throw new Error(r.stderr);
    } else {
      git(dir, ...args);
    }
  }
  return dir;
}

function check(cwd: string, ...args: string[]) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('check-main-lag: passes when the release line is within the bound', () => {
  const dir = repo(3);
  try {
    const r = check(dir, '--max', '10');
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /lags dev by 3 commit\(s\)/, 'it prints the NUMBER, not just a verdict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-main-lag: fails beyond the bound, and names what is waiting', () => {
  const dir = repo(5);
  try {
    const r = check(dir, '--max', '2');
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    const err = r.stderr;
    assert.match(err, /lags dev by 5 commits \(bound 2\)/, 'the number and the bound are both stated');
    assert.match(err, /dev commit 1/, 'the oldest waiting commit is named, so the reader can judge it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-main-lag: the default bound applies when none is given', () => {
  const dir = repo(3);
  try {
    const r = check(dir);
    assert.equal(r.status, 0, 'three commits is well inside the default');
    assert.match(r.stdout, /bound 40/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// THE BUG THIS TEST EXISTS FOR. The first version derived its root from `$BASH_SOURCE` — the directory
// the SCRIPT lives in — so run from any other repository it silently reported TAKUMI's distance and
// passed. A check that measures a different repository than the one it was asked about is worse than
// no check: it produces a confident, wrong answer. The repository is the CALLER'S (`git rev-parse
// --show-toplevel`), and this pins it.
test('check-main-lag: measures the CALLER\'s repository, not the one the script lives in', () => {
  const dir = repo(5);
  try {
    // 5 ahead with a bound of 2 must FAIL here — and it must fail on THIS repo's numbers, not on
    // takumi's (which is the trap: takumi's main and dev are equal, so the broken version passed).
    const r = check(dir, '--max', '2');
    assert.equal(r.status, 1, 'the check answered about the wrong repository');
    assert.match(r.stderr, /lags dev by 5 commits/, 'and it reported THIS repository\'s count');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-main-lag: an unreadable ref is a refusal (2), never a silent pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mainlag-empty-'));
  try {
    git(dir, 'init', '-q');
    // No commits at all: `main` and `dev` do not exist, so the check cannot answer — and a check that
    // cannot see its inputs must not report success.
    const r = check(dir, '--max', '2');
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /no 'main' ref|no 'dev' ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-main-lag: a non-numeric bound is refused, not coerced', () => {
  const dir = repo(1);
  try {
    const r = check(dir, '--max', 'lots');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wants a whole number, got 'lots'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// LEDGER #104 — THE COUNT WAS THE WRONG SHAPE OF NUMBER.
//
// Measured on this repository on 2026-10-27: 11, 34 and 155 commits in three consecutive weeks. A
// count bound calibrated in the quiet week (40) waves through two months of the busy one, and the
// same bound calibrated in the busy week fails during the quiet one. The number describes the
// author's throughput, not the thing that hurts. The sentence this script was written from already
// said the right bound — "one that is a fortnight behind is a formality" — so the age is what is
// now measured, and the count stays as a cheap second opinion.

test('check-main-lag: FEW commits, left unmerged for too long, still fails', () => {
  // Two commits, well inside the count bound, twenty days old. The old check passed this happily;
  // that is a release line nobody has touched for three weeks.
  const dir = repo(2, 20);
  try {
    const r = check(dir);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /oldest unmerged commit has sat on \S+ for 2\d day\(s\) \(bound 14\)/);
    assert.match(r.stderr, /The count is within bounds \(2 commit\(s\)\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-main-lag: MANY commits released promptly pass — a burst is a release, not a lag', () => {
  // Ten commits, all today. The count is inside the bound and the age is zero: nothing was left
  // sitting. A count-only check cannot tell this apart from ten commits forgotten a month ago.
  const dir = repo(10);
  try {
    const r = check(dir);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /oldest unmerged commit is 0 day\(s\) old \(bound 14\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check-main-lag: the age bound is configurable, and a bad value is refused', () => {
  const dir = repo(3, 10);
  try {
    assert.equal(check(dir, '--max-age', '30').status, 0, 'a looser age bound accepts the same tree');
    assert.equal(check(dir, '--max-age', '5').status, 1, 'a tighter one rejects it');
    const bad = check(dir, '--max-age', 'soon');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--max-age wants a whole number of days, got 'soon'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
