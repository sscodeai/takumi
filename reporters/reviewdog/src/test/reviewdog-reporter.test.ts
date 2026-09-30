import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError, type ReviewFinding } from '@takumi/core';
import { createReviewdogReporter, DEFAULT_RDJSON_SEVERITY } from '../index.js';

/**
 * The translation and the failure behaviour are tested against a FAKE RUNNER (they must be
 * exhaustible without reviewdog installed); one test at the bottom runs the REAL binary with
 * `-reporter=local`, because "the diff filter actually filters" is not something a fake can certify.
 */

const LOCATED: ReviewFinding = {
  rule: 'semgrep:takumi.secret.aws-access-key',
  severity: 'block',
  path: 'config.py',
  line: 7,
  detail: 'An AWS access key id is committed. ROTATE it.',
};

const UNLOCATED: ReviewFinding = { rule: 'test-weakening/deleted', severity: 'block', detail: 'a test file was deleted' };

interface Invocation {
  argv: readonly string[];
  stdin?: string;
}

function fakeRunner(reply: { code?: number; stdout?: string; stderr?: string; seen?: Invocation[] } = {}) {
  return async ({ argv, stdin }: { argv: readonly string[]; cwd: string; timeoutMs: number; stdin?: string }) => {
    reply.seen?.push({ argv, ...(stdin === undefined ? {} : { stdin }) });
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  };
}

const SHAS = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };

test('reviewdog reporter: our severities translate back, and the line travels', () => {
  const reporter = createReviewdogReporter();
  const text = reporter.toRdjsonl([
    LOCATED,
    { ...LOCATED, severity: 'human', line: 3 },
    { ...LOCATED, severity: 'note' },
    UNLOCATED,
  ]);
  const lines = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 3, 'a finding with no path cannot be an inline comment, so it is not in the text');
  assert.deepEqual(lines.map((line) => line.severity), ['ERROR', 'WARNING', 'INFO']);
  assert.equal(lines[0].location.path, 'config.py');
  assert.equal(lines[0].location.range.start.line, 7);
  assert.equal(lines[0].code.value, 'semgrep:takumi.secret.aws-access-key');
  assert.equal(lines[0].source.name, 'takumi');
  assert.equal(DEFAULT_RDJSON_SEVERITY.block, 'ERROR');
  // ...and an unlocated finding is RETURNED rather than dropped, so nothing disappears quietly.
  assert.equal(reporter.toRdjsonl([UNLOCATED]), '');
});

test('reviewdog reporter: the review is of THIS change, and no token reaches argv', async () => {
  const seen: Invocation[] = [];
  const reporter = createReviewdogReporter({ reporter: 'github-pr-review', runner: fakeRunner({ seen }) });
  const outcome = await reporter.report({ findings: [LOCATED], ...SHAS, cwd: '/tmp/x' });
  assert.equal(outcome.posted, 1);
  const call = seen[0];
  assert.ok(call !== undefined);
  assert.equal(call.argv.some((arg) => arg === '-f=rdjsonl'), true);
  assert.equal(call.argv.some((arg) => arg === `-diff=git diff ${SHAS.baseSha} ${SHAS.headSha}`), true);
  assert.equal(call.argv.some((arg) => arg === '-reporter=github-pr-review'), true);
  // Host credentials come from the environment, and nowhere else.
  assert.equal(call.argv.some((arg) => /token/i.test(arg)), false);
  // The payload on stdin IS the rdjsonl line: one JSON object per finding, reviewdog's format.
  const payload = JSON.parse((call.stdin ?? '').trim());
  assert.equal(payload.location.path, 'config.py');
  assert.equal(payload.location.range.start.line, 7);
  assert.equal(payload.severity, 'ERROR');
  assert.equal(payload.code.value, LOCATED.rule);
});

test('reviewdog reporter: a commit id that is not hex is refused, because -diff is a COMMAND', async () => {
  const seen: Invocation[] = [];
  const reporter = createReviewdogReporter({ runner: fakeRunner({ seen }) });
  await assert.rejects(
    () => reporter.report({ findings: [LOCATED], baseSha: 'a; rm -rf /', headSha: SHAS.headSha, cwd: '/tmp/x' }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.kind, 'precondition');
      return true;
    },
  );
  assert.equal(seen.length, 0, 'nothing was run with an interpolated command');
});

test('reviewdog reporter: nothing to report does not start the tool; a failure to run is visible', async () => {
  const seen: Invocation[] = [];
  const quiet = createReviewdogReporter({ runner: fakeRunner({ seen }) });
  const empty = await quiet.report({ findings: [UNLOCATED], ...SHAS, cwd: '/tmp/x' });
  assert.equal(empty.posted, 0);
  assert.deepEqual(empty.unlocated.map((f) => f.rule), ['test-weakening/deleted']);
  assert.equal(seen.length, 0, 'no findings to post means no process');

  const failing = createReviewdogReporter({ runner: fakeRunner({ code: 1, stderr: 'no diff' }) });
  await assert.rejects(
    () => failing.report({ findings: [LOCATED], ...SHAS, cwd: '/tmp/x' }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'transport',
  );

  const absent = createReviewdogReporter({ binary: '/nonexistent-reviewdog', runner: undefined });
  await assert.rejects(
    () => absent.report({ findings: [LOCATED], ...SHAS, cwd: tmpdir() }),
    (error: unknown) => error instanceof ProviderError && error.kind === 'transport',
  );
});

const hasReviewdog = spawnSync('reviewdog', ['--version'], { stdio: 'pipe' }).status === 0;

test(
  'reviewdog reporter (REAL BINARY): the diff filter drops what this change did not touch',
  { skip: !hasReviewdog ? 'reviewdog is not installed on this host' : false },
  async () => {
    const repo = mkdtempSync(join(tmpdir(), 'reviewdog-real-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    };
    try {
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      // A pre-existing line nobody touched in this change (it must be filtered OUT) and a change
      // that adds a new one (it must be reported).
      writeFileSync(join(repo, 'app.py'), 'old_marker = 1\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
      writeFileSync(join(repo, 'app.py'), 'old_marker = 1\nnew_marker = 2\n');
      git('add', '-A');
      git('commit', '-qm', 'the change');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();

      const reporter = createReviewdogReporter({ reporter: 'local', filterMode: 'added' });
      const outcome = await reporter.report({
        findings: [
          { rule: 'fixture/added', severity: 'block', path: 'app.py', line: 2, detail: 'REPORTED-MARKER-NEW' },
          { rule: 'fixture/untouched', severity: 'block', path: 'app.py', line: 1, detail: 'FILTERED-MARKER-OLD' },
        ],
        baseSha: base,
        headSha: head,
        cwd: repo,
      });
      assert.equal(outcome.posted, 2);
      assert.match(outcome.stdout, /REPORTED-MARKER-NEW/);
      assert.equal(
        /FILTERED-MARKER-OLD/.test(outcome.stdout),
        false,
        'a finding on an untouched line is not this change\'s business',
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
