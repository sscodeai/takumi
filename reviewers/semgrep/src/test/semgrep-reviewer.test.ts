import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner, ProviderError, type ReviewContext } from '@takumi/core';
import {
  createSemgrepReviewer,
  DEFAULT_SEVERITY_MAP,
  readRuleSetHash,
  semgrepReviewerId,
} from '../index.js';

/**
 * The semgrep reviewer is tested against a FAKE RUNNER, not against semgrep: what this package owns
 * is the translation (bytes -> findings -> verdict) and the failure behaviour, and both must be
 * exhaustible without a 333MB toolchain present. One test at the bottom runs the REAL binary when
 * the host has it, because "the shipped rule set works on a real finding" is not something a fake
 * can certify (the ledger's "the double that answers more kindly than the host").
 */

const RULE_FILE = `rules:
  - id: takumi.test.rule
    languages: [generic]
    severity: ERROR
    message: a fixture rule
    pattern-regex: 'NEVER_MATCHES_ANYTHING'
`;

function scratch(): { dir: string; configPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'semgrep-reviewer-'));
  const configPath = join(dir, 'rules.yml');
  writeFileSync(configPath, RULE_FILE);
  return { dir, configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const CTX: ReviewContext = {
  round: 0,
  headSha: 'b'.repeat(40),
  baseSha: 'a'.repeat(40),
  changedFiles: ['calc.py'],
  worktree: '/tmp/does-not-matter-for-a-fake-runner',
};

interface Reply {
  version?: string;
  scan?: string;
  scanCode?: number;
  stderr?: string;
  seen?: string[][];
}

function fakeRunner(reply: Reply = {}) {
  return async ({ argv }: { argv: readonly string[]; cwd: string; timeoutMs: number }) => {
    reply.seen?.push([...argv]);
    if (argv.includes('--version')) {
      return { code: 0, stdout: `${reply.version ?? '1.177.0'}\n`, stderr: '' };
    }
    return {
      code: reply.scanCode ?? 0,
      stdout: reply.scan ?? '{"results":[],"errors":[]}',
      stderr: reply.stderr ?? '',
    };
  };
}

function result(severity: string, line = 3, checkId = 'takumi.test.rule'): string {
  return JSON.stringify({
    results: [
      { check_id: checkId, path: 'calc.py', start: { line }, extra: { severity, message: `a ${severity} finding` } },
    ],
    errors: [],
  });
}

test('semgrep reviewer: the tool\'s severities translate once, into the verdicts they mean', async () => {
  const s = scratch();
  try {
    const block = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner({ scan: result('ERROR') }),
      composeDeterministic: false,
    });
    const blocked = await block.review(CTX);
    assert.equal(blocked.verdict, 'findings');
    assert.match(blocked.note ?? '', /ERROR|a ERROR finding/);

    const human = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner({ scan: result('WARNING') }),
      composeDeterministic: false,
    });
    assert.equal((await human.review(CTX)).verdict, 'awaiting-human');

    const note = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner({ scan: result('INFO') }),
      composeDeterministic: false,
    });
    const noted = await note.review(CTX);
    assert.equal(noted.verdict, 'clean');
    assert.match(noted.note ?? '', /INFO|a INFO finding/);

    // An unknown severity from a newer tool is a JUDGEMENT, never a gate: a tool must not be able
    // to start blocking deliveries through our translation by inventing a level.
    const unknown = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner({ scan: result('EXPERIMENTAL') }),
      composeDeterministic: false,
    });
    assert.equal((await unknown.review(CTX)).verdict, 'awaiting-human');
    assert.equal(DEFAULT_SEVERITY_MAP.ERROR, 'block');
  } finally {
    s.cleanup();
  }
});

test('semgrep reviewer: findings carry the file and the line, and the rule keeps the tool\'s name', async () => {
  const s = scratch();
  try {
    const reviewer = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner({ scan: result('ERROR', 42, 'tmp.probe.takumi.secret.aws-access-key') }),
      composeDeterministic: false,
    });
    const outcome = await reviewer.review({ ...CTX, changedFiles: ['calc.py'] });
    assert.equal(outcome.verdict, 'findings');
    // The path AND the line travel in the rendered finding, which is what a person (and any
    // diff-anchored surface) reads.
    assert.match(outcome.note ?? '', /\(calc\.py:42\): a ERROR finding/);
    // The identity names which rule FILE judged, because the file's content is what changed.
    assert.equal(reviewer.id, `reviewer:semgrep:${reviewer.ruleSetHash}`);
    assert.equal(semgrepReviewerId(reviewer.ruleSetHash, true), `reviewer:rules@2+semgrep:${reviewer.ruleSetHash}`);
  } finally {
    s.cleanup();
  }
});

test('semgrep reviewer: the scan is of the CHANGE, and `--config auto` never appears', async () => {
  const s = scratch();
  try {
    const seen: string[][] = [];
    const reviewer = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner({ seen }),
      composeDeterministic: false,
    });
    await reviewer.review(CTX);
    const scan = seen.find((argv) => argv.includes('--json'));
    assert.ok(scan !== undefined, 'the scan ran');
    assert.ok(scan.includes('--baseline-commit'), 'only findings this change introduced');
    assert.equal(scan[scan.indexOf('--baseline-commit') + 1], CTX.baseSha);
    assert.equal(scan[scan.indexOf('--config') + 1], s.configPath);
    // `auto` would fetch rules over the network at review time and report usage.
    assert.equal(scan.some((arg) => arg === 'auto'), false);
  } finally {
    s.cleanup();
  }
});

test('semgrep reviewer: every way of not running is a refusal, never a clean review', async () => {
  const s = scratch();
  try {
    const cases: Array<{ name: string; reply: Reply; ruleSet?: string }> = [
      { name: 'a non-zero exit', reply: { scanCode: 7, stderr: 'invalid rule set' } },
      { name: 'output that is not JSON', reply: { scan: 'not json at all' } },
      { name: 'a missing results array', reply: { scan: '{"errors":[]}' } },
      { name: 'errors reported while scanning', reply: { scan: '{"results":[],"errors":[{"message":"could not parse calc.py"}]}' } },
    ];
    for (const testCase of cases) {
      const reviewer = createSemgrepReviewer({
        configPath: s.configPath,
        runner: fakeRunner(testCase.reply),
        composeDeterministic: false,
      });
      await assert.rejects(
        () => reviewer.review(CTX),
        (error: unknown) => {
          assert.ok(error instanceof ProviderError, `${testCase.name}: classified`);
          assert.equal(error.kind, 'transport', `${testCase.name}: transport`);
          return true;
        },
        `${testCase.name} must throw`,
      );
    }

    // A version that is not the pinned one means a different ENGINE than the identity names.
    const pinned = createSemgrepReviewer({
      configPath: s.configPath,
      expectedVersion: '1.177.0',
      runner: fakeRunner({ version: '2.0.0' }),
      composeDeterministic: false,
    });
    await assert.rejects(
      () => pinned.review(CTX),
      (error: unknown) => error instanceof ProviderError && error.kind === 'precondition',
    );

    // A binary that is not installed at all: the real runner, the real ENOENT.
    const absent = createSemgrepReviewer({
      configPath: s.configPath,
      binary: '/nonexistent-semgrep-binary',
      composeDeterministic: false,
    });
    await assert.rejects(
      () => absent.review(CTX),
      (error: unknown) => error instanceof ProviderError && error.kind === 'transport',
    );
  } finally {
    s.cleanup();
  }
});

test('semgrep reviewer: a rule file edited under a live reviewer is refused, not adopted', async () => {
  const s = scratch();
  try {
    const reviewer = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner(),
      composeDeterministic: false,
    });
    writeFileSync(s.configPath, `${RULE_FILE}\n# a rule added while the reviewer was alive\n`);
    await assert.rejects(
      () => reviewer.review(CTX),
      (error: unknown) => error instanceof ProviderError && error.kind === 'precondition',
    );
  } finally {
    s.cleanup();
  }
});

test('semgrep reviewer: an unreadable rule set fails at construction, not with a rubber stamp', () => {
  assert.throws(
    () => readRuleSetHash('/nonexistent/rules.yml'),
    (error: unknown) => error instanceof ProviderError && error.kind === 'precondition',
  );
  assert.throws(
    () => createSemgrepReviewer({ configPath: '/nonexistent/rules.yml', runner: fakeRunner() }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'precondition',
  );
});

test('semgrep reviewer: the deterministic rules still run — a sidecar must not be a downgrade', async () => {
  const s = scratch();
  const repo = mkdtempSync(join(tmpdir(), 'semgrep-compose-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(
      join(repo, 'test_calc.py'),
      'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1 + 1, 2)\n        self.assertEqual(2 + 2, 4)\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    // The change under review WEAKENS the test: semgrep knows nothing about that, and this is
    // exactly the finding a semgrep-only reviewer would have let through.
    writeFileSync(
      join(repo, 'test_calc.py'),
      'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(1 + 1, 2)\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'weaken the test');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    const reviewer = createSemgrepReviewer({
      configPath: s.configPath,
      runner: fakeRunner({ scan: '{"results":[],"errors":[]}' }),
      git: createGitRunner(),
    });
    const outcome = await reviewer.review({ ...CTX, worktree: repo, baseSha: base, headSha: head });
    assert.equal(outcome.verdict, 'findings');
    assert.match(outcome.note ?? '', /test-weakening/);
  } finally {
    s.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * The real thing, when the host has it. `skip` rather than a silent pass: a suite that quietly does
 * nothing when a tool is absent is how "we tested it" becomes a thing nobody can check.
 */
const hasSemgrep = spawnSync('semgrep', ['--version'], { stdio: 'pipe' }).status === 0;

test('semgrep reviewer (REAL BINARY): the shipped rule set blocks a committed credential', { skip: !hasSemgrep ? 'semgrep is not installed on this host' : false }, async () => {
  const repo = mkdtempSync(join(tmpdir(), 'semgrep-real-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  };
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    writeFileSync(
      join(repo, 'calc.py'),
      'def add(a, b):\n    return a + b\n\n\nAWS_KEY = "AKIAIOSFODNN7EXAMPLE"\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'the change under review');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

    const reviewer = createSemgrepReviewer({
      configPath: join(import.meta.dirname, '..', '..', 'rules', 'takumi.yml'),
      git: createGitRunner(),
      timeoutMs: 180_000,
    });
    const outcome = await reviewer.review({ ...CTX, worktree: repo, baseSha: base, headSha: head });
    assert.equal(outcome.verdict, 'findings', 'a committed AWS key is a blocking finding');
    assert.match(outcome.note ?? '', /AKIA|aws-access-key|rotate/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
