import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner, type GitRunner } from '../git-runner.js';
import { ProviderError } from '../provider-error.js';
import { collectReviewInput, createRuleReviewer } from '../review.js';
import type { ReviewContext } from '../delivery-loop.js';

/**
 * The reviewer against REAL git.
 *
 * The rules are tested as pure functions (review-rules.test.ts); what these tests prove is
 * the plumbing that feeds them — which files it reads, what it does when git will not
 * answer, and the verdict mapping the delivery loop acts on.
 */

function repo(): { dir: string; commit: (message: string) => string; git: GitRunner } {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-review-'));
  const raw = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' },
    });
  raw(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(
    join(dir, 'tests', 'test_calc.py'),
    'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n        self.assertEqual(add(0, 0), 0)\n',
  );
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  raw(['add', '-A']);
  raw(['commit', '-q', '-m', 'chore: fixture']);
  return {
    dir,
    git: createGitRunner(),
    commit: (message: string): string => {
      raw(['add', '-A']);
      raw(['commit', '-q', '-m', message]);
      return raw(['rev-parse', 'HEAD']).trim();
    },
  };
}

const HEAD = 'b'.repeat(40);

function ctx(dir: string, baseSha: string, headSha: string): ReviewContext {
  return {
    round: 0,
    pr: { number: '1', url: 'https://host.example/pr/1', headSha, baseSha },
    headSha,
    changedFiles: [],
    worktree: dir,
    baseSha,
  };
}

test('a weakened test is found in the real change set and blocked with its rule named', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  // The failure this reviewer exists for: the pipeline goes green by deleting an assertion.
  writeFileSync(
    join(r.dir, 'tests', 'test_calc.py'),
    'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n',
  );
  const head = r.commit('fix: make the tests pass');

  const outcome = await createRuleReviewer({ git: r.git })(ctx(r.dir, base, head));
  assert.equal(outcome.verdict, 'findings');
  assert.match(outcome.note ?? '', /test-weakening\/assertions-removed \(tests\/test_calc\.py\)/);
});

test('a deleted test file is blocked, and the deletion is visible in the change set', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['rm', '-q', 'tests/test_calc.py'], { cwd: r.dir });
  const head = r.commit('chore: remove the failing test');

  const input = await collectReviewInput(r.git, { worktree: r.dir, baseSha: base, headSha: head });
  assert.deepEqual(input.changes.map((c) => [c.path, c.status]), [['tests/test_calc.py', 'deleted']]);

  const outcome = await createRuleReviewer({ git: r.git })(ctx(r.dir, base, head));
  assert.equal(outcome.verdict, 'findings');
  assert.match(outcome.note ?? '', /test-weakening\/deleted/);
});

test('a rename does not break the reviewer: base content is read from the OLD path', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['mv', 'tests/test_calc.py', 'tests/test_calculator.py'], { cwd: r.dir });
  const head = r.commit('refactor: rename the test file');

  const input = await collectReviewInput(r.git, { worktree: r.dir, baseSha: base, headSha: head });
  const renamed = input.changes.find((c) => c.status === 'renamed');
  assert.ok(renamed, 'git rename detection must be on');
  assert.equal(renamed.path, 'tests/test_calculator.py');
  assert.equal(renamed.previousPath, 'tests/test_calc.py');
  assert.ok(renamed.baseContent !== null, 'the base side must have been read, from the old path');

  const outcome = await createRuleReviewer({ git: r.git })(ctx(r.dir, base, head));
  assert.equal(outcome.verdict === 'clean' || outcome.verdict === 'findings', true);
  assert.equal(outcome.verdict, 'clean', 'nothing was weakened by renaming');
});

test('a protected path goes to a HUMAN, not back to the agent', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  writeFileSync(join(r.dir, 'package.json'), '{"name":"fixture","version":"1.0.1","dependencies":{"left-pad":"1.0.0"}}\n');
  const head = r.commit('feat: bump a dependency');

  const outcome = await createRuleReviewer({ git: r.git })(ctx(r.dir, base, head));
  assert.equal(outcome.verdict, 'awaiting-human');
  assert.match(outcome.note ?? '', /protected-path \(package\.json\)/);
});

test('a clean change is clean, and a test-only change is clean WITH a note', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  writeFileSync(join(r.dir, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n');
  const head = r.commit('feat: add sub()');

  const clean = await createRuleReviewer({ git: r.git })(ctx(r.dir, base, head));
  assert.deepEqual(clean, { verdict: 'clean' });

  // Now the same item, but only the test file moves.
  const base2 = head;
  writeFileSync(
    join(r.dir, 'tests', 'test_calc.py'),
    'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n\n    def test_sub(self):\n        self.assertEqual(sub(3, 4), -1)\n',
  );
  const head2 = r.commit('test: cover sub()');
  const noted = await createRuleReviewer({ git: r.git })(ctx(r.dir, base2, head2));
  assert.equal(noted.verdict, 'clean', 'writing tests is not a defect');
  assert.match(noted.note ?? '', /test-only-change/);
});

test('the reviewer reads content ONLY for the files a rule reads', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  writeFileSync(join(r.dir, 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n');
  writeFileSync(join(r.dir, 'tests', 'test_calc.py'), 'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n        self.assertEqual(add(0, 0), 0)\n\n    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n');
  const head = r.commit('feat: add mul() with a test');

  const calls: string[][] = [];
  const recording: GitRunner = {
    run: async (args, opts) => {
      calls.push(args);
      return await r.git.run(args, opts);
    },
  };
  await createRuleReviewer({ git: recording })(ctx(r.dir, base, head));
  const showed = calls.filter((args) => args[0] === 'show').map((args) => args[1] ?? '');
  assert.equal(showed.some((ref) => ref.endsWith(':calc.py')), false, 'a source file is not read for content');
  assert.equal(showed.filter((ref) => ref.endsWith(':tests/test_calc.py')).length, 2, 'the test file is read on both sides');
});

test('the reviewer FAILS CLOSED: a git that cannot answer is never a clean verdict', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();

  // A revision that does not exist: the change set cannot be computed.
  await assert.rejects(
    () => createRuleReviewer({ git: r.git })(ctx(r.dir, base, 'c'.repeat(40))),
    (e: unknown) => {
      assert.ok(e instanceof ProviderError, 'the failure must be a classified provider error');
      assert.equal(e.kind, 'transport', 'transport is retriable: the item waits, nothing merges');
      return true;
    },
  );

  // A git binary that refuses everything: same posture, and the message says why.
  const broken: GitRunner = { run: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: boom' }) };
  await assert.rejects(
    () => createRuleReviewer({ git: broken })(ctx(r.dir, base, HEAD)),
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.kind, 'transport');
      assert.match(e.message, /could not read the change set/);
      return true;
    },
  );
});

test('a change set nobody could review is refused, not skimmed', async () => {
  const r = repo();
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).trim();
  for (let i = 0; i < 12; i++) writeFileSync(join(r.dir, `file-${i}.txt`), `${i}\n`);
  const head = r.commit('chore: many files');

  await assert.rejects(
    () => collectReviewInput(r.git, { worktree: r.dir, baseSha: base, headSha: head, maxChangedFiles: 5 }),
    (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.match(e.message, /refuses to judge a change set of 12 files/);
      return true;
    },
  );
});
