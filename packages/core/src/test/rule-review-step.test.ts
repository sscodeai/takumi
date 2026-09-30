import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, WorkflowDefinition } from '../index.js';
import { createGitRunner } from '../git-runner.js';
import { TestRuntime } from '../test-utils.js';

/**
 * `rule_review` against REAL git.
 *
 * The deterministic rules themselves are pure and tested in review-rules.test.ts. What these
 * tests prove is the WIRING: that a workflow step resolves the base and the head through the
 * GitRunner, judges the actual change set, maps the verdict fail-closed, and never lets a
 * review that could not run read as a review that passed.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

interface Fixture {
  dir: string;
  baseSha: string;
  commit: (message: string) => string;
  cleanup: () => void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-rule-review-'));
  const raw = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV });

  raw(['init', '-q', '-b', 'main']);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(
    join(dir, 'tests', 'test_calc.py'),
    'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n        self.assertEqual(add(0, 0), 0)\n',
  );
  writeFileSync(
    join(dir, 'tests', 'calc.test.js'),
    "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n",
  );
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  raw(['add', '-A']);
  raw(['commit', '-q', '-m', 'chore: fixture']);

  return {
    dir,
    baseSha: raw(['rev-parse', 'HEAD']).trim(),
    commit: (message: string): string => {
      raw(['add', '-A']);
      raw(['commit', '-q', '-m', message]);
      return raw(['rev-parse', 'HEAD']).trim();
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Drive a workflow whose only real step is `rule_review`, with a downstream step to observe. */
async function runRuleReview(
  f: Fixture,
  step: { baseRef: string; headRef?: string },
): Promise<{ status: string; rules?: { status: string; summary: string; artifacts: string[] }; shipped?: { status: string } }> {
  const artifacts = mkdtempSync(join(tmpdir(), 'takumi-rule-review-artifacts-'));
  try {
    const wf: WorkflowDefinition = {
      name: 'rule-review',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'rules', type: 'rule_review', baseRef: step.baseRef, ...(step.headRef === undefined ? {} : { headRef: step.headRef }) },
        { id: 'shipped', type: 'agent', prompt: 'ship it', dependsOn: ['rules'] },
      ],
    };
    const res = await executeWorkflow(wf, {
      cwd: f.dir,
      runtime: new TestRuntime(() => 'shipped'),
      artifacts: new ArtifactStore(artifacts),
      git: createGitRunner(),
      onApproval: () => true,
    });
    return {
      status: res.status,
      rules: res.steps.find((s) => s.stepId === 'rules'),
      shipped: res.steps.find((s) => s.stepId === 'shipped'),
    };
  } finally {
    rmSync(artifacts, { recursive: true, force: true });
  }
}

test('rule_review: a deleted test file fails with test-weakening/deleted', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['rm', '-q', 'tests/test_calc.py'], { cwd: f.dir, env: GIT_ENV });
    f.commit('chore: remove the failing test');

    const res = await runRuleReview(f, { baseRef: f.baseSha });
    assert.equal(res.status, 'failed');
    assert.equal(res.rules?.status, 'failed');
    assert.match(res.rules?.summary ?? '', /test-weakening\/deleted/);
  } finally {
    f.cleanup();
  }
});

test('rule_review: a newly skipped test fails with test-weakening/skipped', async () => {
  const f = fixture();
  try {
    writeFileSync(
      join(f.dir, 'tests', 'calc.test.js'),
      "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n\nit.skip('adds negatives', () => {\n  expect(add(-1, -2)).toBe(-3);\n});\n",
    );
    f.commit('fix: make the failing test suite green');

    const res = await runRuleReview(f, { baseRef: f.baseSha });
    assert.equal(res.status, 'failed');
    assert.equal(res.rules?.status, 'failed');
    assert.match(res.rules?.summary ?? '', /test-weakening\/skipped/);
  } finally {
    f.cleanup();
  }
});

test('rule_review: a protected path fails and is handed to a human, not the agent', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'package.json'), '{"name":"fixture","version":"1.0.1"}\n');
    f.commit('feat: bump a dependency');

    const res = await runRuleReview(f, { baseRef: f.baseSha });
    assert.equal(res.status, 'failed');
    assert.equal(res.rules?.status, 'failed');
    assert.match(res.rules?.summary ?? '', /protected-path/);
    assert.match(res.rules?.summary ?? '', /human must decide this/);
    assert.match(res.rules?.summary ?? '', /machine may not decide it/);
  } finally {
    f.cleanup();
  }
});

test('rule_review: a clean implementation change with a strengthened test passes', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, 'src', 'calc.py'), 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n');
    writeFileSync(
      join(f.dir, 'tests', 'test_calc.py'),
      'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n        self.assertEqual(add(0, 0), 0)\n\n    def test_sub(self):\n        self.assertEqual(sub(3, 1), 2)\n',
    );
    f.commit('feat: add sub with a test');

    const res = await runRuleReview(f, { baseRef: f.baseSha });
    assert.equal(res.status, 'completed');
    assert.equal(res.rules?.status, 'completed');
    assert.match(res.rules?.summary ?? '', /rule_review PASSED: no findings/);
  } finally {
    f.cleanup();
  }
});

test('rule_review: an unresolvable baseRef fails closed and no downstream step runs', async () => {
  const f = fixture();
  try {
    const res = await runRuleReview(f, { baseRef: 'refs/heads/does-not-exist' });
    assert.equal(res.status, 'failed');
    assert.equal(res.rules?.status, 'failed');
    assert.match(res.rules?.summary ?? '', /precondition failed/);
    assert.notEqual(res.shipped?.status, 'completed');
  } finally {
    f.cleanup();
  }
});

test('rule_review: a missing repository fails closed rather than being skipped', async () => {
  const f = fixture();
  const notARepo = mkdtempSync(join(tmpdir(), 'takumi-not-a-repo-'));
  try {
    const artifacts = mkdtempSync(join(tmpdir(), 'takumi-rule-review-artifacts-'));
    try {
      const wf: WorkflowDefinition = {
        name: 'rule-review',
        version: '0.1.0',
        description: '',
        steps: [{ id: 'rules', type: 'rule_review', baseRef: f.baseSha }],
      };
      const res = await executeWorkflow(wf, {
        cwd: notARepo,
        runtime: new TestRuntime(() => 'ok'),
        artifacts: new ArtifactStore(artifacts),
        git: createGitRunner(),
        onApproval: () => true,
      });
      assert.equal(res.status, 'failed');
      assert.equal(res.steps.find((s) => s.stepId === 'rules')?.status, 'failed');
      assert.match(res.steps.find((s) => s.stepId === 'rules')?.summary ?? '', /precondition failed/);
    } finally {
      rmSync(artifacts, { recursive: true, force: true });
    }
  } finally {
    f.cleanup();
    rmSync(notARepo, { recursive: true, force: true });
  }
});

test('rule_review: the findings are persisted as a markdown artifact', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['rm', '-q', 'tests/test_calc.py'], { cwd: f.dir, env: GIT_ENV });
    f.commit('chore: remove the failing test');

    const res = await runRuleReview(f, { baseRef: f.baseSha });
    assert.equal(res.rules?.artifacts.length, 1);
    assert.match(res.rules?.artifacts[0] ?? '', /rules\.md$/);
  } finally {
    f.cleanup();
  }
});
