import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBoardProvider } from '@takumi/board-fake';
import { GitDeliveryProvider } from '@takumi/delivery-git';
import { FakeDeliveryProvider } from '@takumi/delivery-fake';
import type {
  CheckSummary,
  DeliveryOutcome,
  DeliveryProvider,
  DeliveryRequest,
  MergeOutcome,
  PullRequestRef,
  PullRequestStatus,
} from '@takumi/core';
import { runAgentCommand, runOnce } from '../run-command.js';
import type { PilotConfig } from '../run-command.js';
import { runPilotCommand } from '../index.js';

/**
 * The pilot tick, end to end with a REAL git repository and a REAL agent process:
 * a bare "origin", a checkout, a worktree created from a frozen sha, an agent script
 * that commits a file, and the fake board/delivery proving the loop ran.
 *
 * The offline unit tests live in core (`pilot.test.ts`); this file exists to prove
 * the wiring a deployment actually uses — git commands, a child process, exit codes.
 */

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Takumi Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Takumi Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });

function makeRepo(): { root: string; work: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'takumi-pilot-e2e-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  mkdirSync(origin);
  git(['init', '--bare', '--initial-branch=main'], origin);
  mkdirSync(work);
  git(['init', '--initial-branch=main'], work);
  writeFileSync(join(work, 'README.md'), '# demo\n');
  git(['add', '.'], work);
  git(['commit', '-m', 'chore: initial commit'], work);
  git(['remote', 'add', 'origin', origin], work);
  git(['push', '-u', 'origin', 'main'], work);
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('runOnce: a real worktree, a real agent process, and a merged item', async () => {
  const repo = makeRepo();
  try {
    const worktreeRoot = join(repo.root, 'worktrees');
    const agentScript = join(repo.root, 'agent.mjs');
    // The agent's whole job: change a file and commit it. It receives the item
    // identity in the environment, which is how a real agent would know its task.
    writeFileSync(
      agentScript,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'if (!process.env.TAKUMI_ITEM_ID) throw new Error("TAKUMI_ITEM_ID missing");',
        'writeFileSync(`feature-${process.env.TAKUMI_ITEM_ID}.txt`, "done by the agent\\n");',
        'const g = (a) => execFileSync("git", a, { encoding: "utf8" });',
        'g(["add", "."]);',
        'g(["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "-m", "feat: agent work"]);',
        '',
      ].join('\n'),
    );

    const board = new FakeBoardProvider({ items: [{ id: 'ITEM-1', state: 'ready', title: 'Add the feature', labels: [] }] });
    const delivery = new FakeDeliveryProvider({ baseSha: 'a'.repeat(40), headSha: 'b'.repeat(12) + 'commit000001' });
    const pilot: PilotConfig = {
      repo: repo.work,
      worktreeRoot,
      slotDir: join(repo.root, 'slots'),
      baseBranch: 'main',
      agent: { command: process.execPath, args: [agentScript], timeoutSeconds: 60 },
      policy: { reviewMode: 'checks-only', retainWorktreesHours: 0 },
    };

    const metricsFile = join(repo.root, 'metrics.json');
    const lines: string[] = [];
    const { tick, exitCode } = await runOnce({
      board,
      delivery,
      pilot: { ...pilot, metricsFile },
      out: (line) => lines.push(line),
    });

    assert.equal(tick.outcome, 'delivered', tick.detail);
    assert.equal(exitCode, 0);
    assert.equal((await board.getWork('ITEM-1')).state, 'merged');
    // The fake delivery records what it DID: one plain push, one pull request, merged.
    const effects = delivery.snapshotEffects();
    assert.equal(effects.prs, 1);
    assert.equal(effects.merges, 1);
    assert.equal(effects.forcePushes, 0);

    // The worktree really exists, on the branch the pilot named, with the agent's
    // commit on it — and the item's identity reached the child process.
    const worktreePath = join(worktreeRoot, `${tick.itemId}-${tick.runId}`);
    assert.equal(existsSync(join(worktreePath, 'feature-ITEM-1.txt')), true, 'the agent’s file is in the worktree');
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim();
    assert.equal(branch, `takumi/ITEM-1-${tick.runId}`);
    const log = git(['log', '--oneline'], worktreePath);
    assert.match(log, /feat: agent work/);

    // The counters a scheduler's monitoring scrapes, written by the tick itself.
    const metrics = JSON.parse(readFileSync(metricsFile, 'utf8')) as { ticks: number; lastOutcome: string };
    assert.equal(metrics.ticks, 1);
    assert.equal(metrics.lastOutcome, 'delivered');
    assert.match(readFileSync(`${metricsFile}.prom`, 'utf8'), /takumi_pilot_outcome_delivered_total 1/);

    // The report is human-readable and names what happened.
    const report = lines.join('\n');
    assert.match(report, /delivered ITEM-1/);
    for (const step of ['claim', 'agent', 'deliver', 'review', 'merge']) {
      assert.match(report, new RegExp(`\\b${step}\\b`), `the report must show the ${step} step`);
    }
  } finally {
    repo.cleanup();
  }
});

test('runOnce: a failing agent exits 1 and blocks the item instead of retrying a wall', async () => {
  const repo = makeRepo();
  try {
    const board = new FakeBoardProvider({ items: [{ id: 'ITEM-2', state: 'ready', title: 'Broken', labels: [] }] });
    const delivery = new FakeDeliveryProvider({ baseSha: 'a'.repeat(40) });
    const { tick, exitCode } = await runOnce({
      board,
      delivery,
      pilot: {
        repo: repo.work,
        worktreeRoot: join(repo.root, 'worktrees'),
        slotDir: join(repo.root, 'slots'),
        baseBranch: 'main',
        // A command that fails immediately: the agent reporting it cannot do the job.
        agent: { command: process.execPath, args: ['-e', 'process.exit(3)'], timeoutSeconds: 30 },
        policy: { reviewMode: 'checks-only', agentRetries: 2, agentRetryDelaySeconds: 0 },
      },
    });

    assert.equal(tick.outcome, 'blocked');
    assert.equal(exitCode, 1, 'a human is needed, so the scheduler must be able to tell');
    assert.match(tick.detail, /exited 3/);
    assert.equal((await board.getWork('ITEM-2')).state, 'blocked');
  } finally {
    repo.cleanup();
  }
});

test('runOnce: nothing ready is `idle` and exits 0', async () => {
  const repo = makeRepo();
  try {
    const board = new FakeBoardProvider({ items: [] });
    const { tick, exitCode } = await runOnce({
      board,
      delivery: new FakeDeliveryProvider({ baseSha: 'a'.repeat(40) }),
      pilot: {
        repo: repo.work,
        worktreeRoot: join(repo.root, 'worktrees'),
        slotDir: join(repo.root, 'slots'),
        baseBranch: 'main',
        agent: { command: process.execPath, args: ['-e', ''] },
        policy: { reviewMode: 'checks-only' },
      },
    });
    assert.equal(tick.outcome, 'idle');
    assert.equal(exitCode, 0, 'an empty queue is not an error: a scheduler journal must stay quiet');
  } finally {
    repo.cleanup();
  }
});

test('runAgentCommand: the item identity reaches the child, and its failure is classified', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-agent-'));
  try {
    const out = join(dir, 'env.json');
    await runAgentCommand(
      {
        item: {
          id: 'ITEM-9',
          title: 'Add multiply to calc.py',
          body: 'the item the operator wrote',
          url: 'https://board.example/ITEM-9',
          state: 'ready',
          labels: [],
          assignees: [],
          updatedAt: '',
        },
        worktree: dir,
        branch: 'takumi/x',
        runId: 'c0ffee01',
        round: 2,
      },
      { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`] },
    );
    const env = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
    assert.equal(env['TAKUMI_ITEM_ID'], 'ITEM-9');
    // The work itself, not just its identity: a real agent (OpenHands, say) is a command
    // with no board access, so without these it is handed a task it cannot read.
    assert.equal(env['TAKUMI_ITEM_TITLE'], 'Add multiply to calc.py');
    assert.equal(env['TAKUMI_ITEM_BODY'], 'the item the operator wrote');
    assert.equal(env['TAKUMI_ITEM_URL'], 'https://board.example/ITEM-9');
    assert.equal(env['TAKUMI_RUN_ID'], 'c0ffee01');
    assert.equal(env['TAKUMI_BRANCH'], 'takumi/x');
    assert.equal(env['TAKUMI_ROUND'], '2');

    // A command that does not exist is a transport failure (retriable), not a block.
    await assert.rejects(
      () => runAgentCommand({ item: { id: 'I', title: '', body: '', url: '', state: 'ready', labels: [], assignees: [], updatedAt: '' }, worktree: dir, branch: 'b', runId: 'c0ffee01', round: 0 }, { command: join(dir, 'nope') }),
      /could not be started/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runPilotCommand: the pilot section of takumi.yaml is wired through, metrics included', async () => {
  const repo = makeRepo();
  try {
    const project = join(repo.root, 'project');
    mkdirSync(project);
    const metricsFile = join(project, 'metrics.json');
    const agentScript = join(repo.root, 'agent.mjs');
    writeFileSync(
      agentScript,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("work.txt", "done\\n");',
        'const g = (a) => execFileSync("git", a, { encoding: "utf8" });',
        'g(["add", "."]);',
        'g(["-c", "user.name=Agent", "-c", "user.email=a@example.invalid", "commit", "-m", "feat: work"]);',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'takumi.yaml'),
      [
        'runtime: fake',
        'registry:',
        '  skills: .takumi/skills',
        '  tools: .takumi/tools',
        '  workflows: .takumi/workflows',
        '  runtimes: .takumi/runtimes',
        'artifacts: .takumi/artifacts',
        'pilot:',
        `  repo: ${repo.work}`,
        `  worktreeRoot: ${join(repo.root, 'worktrees')}`,
        `  slotDir: ${join(repo.root, 'slots')}`,
        '  baseBranch: main',
        '  board: fake',
        '  delivery: fake',
        '  deliveryOptions:',
        `    baseSha: ${'a'.repeat(40)}`,
        `    headSha: ${'b'.repeat(12)}commit000001`,
        '  agent:',
        `    command: ${process.execPath}`,
        '    args:',
        `      - ${agentScript}`,
        '  policy:',
        '    reviewMode: checks-only',
        `  metricsFile: ${metricsFile}`,
        '',
      ].join('\n'),
    );

    const lines: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => lines.push(String(line ?? ''));
    let code = 1;
    try {
      code = await runPilotCommand(project, ['--once']);
    } finally {
      console.log = original;
    }
    assert.equal(code, 0, lines.join('\n'));
    assert.match(lines.join('\n'), /delivered DEMO-1/);
    // The whole point of this test: a configured option that nothing reads is a silent
    // drop, and the CLI is where the config is read.
    assert.equal(existsSync(metricsFile), true, 'the metrics file named in takumi.yaml must be written');
    const metrics = JSON.parse(readFileSync(metricsFile, 'utf8')) as { ticks: number };
    assert.equal(metrics.ticks, 1);
  } finally {
    repo.cleanup();
  }
});

/**
 * A delivery that reports the head REALLY on the branch.
 *
 * The fake delivery hands back a configured sha, which is fine for the loop's own tests and
 * useless for the reviewer: the reviewer reads the delivered CHANGE, so a canned head makes
 * it fail closed (correctly, and untestably). This double is the smallest thing that lets a
 * CLI test exercise the rules against a real commit.
 */
class RealHeadDelivery implements DeliveryProvider {
  merged = false;
  /** The head this delivery last reported — the only one a merge may name. */
  lastHead = '';
  /** Public so a test can say "the pull request is already open" — i.e. resuming, not opening. */
  opened = false;
  metadata() {
    return { id: 'real-head', name: 'Real Head Delivery', version: '0.1.0' };
  }
  capabilities() {
    return { canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true };
  }
  async deliver(req: DeliveryRequest, base: { baseSha: string }): Promise<DeliveryOutcome> {
    // The worktree the AGENT committed in — not the repository the worktree was cut from,
    // which is the same assumption every real delivery adapter makes (req.worktree).
    const cwd = req.worktree;
    const dirty = git(['status', '--porcelain'], cwd).trim();
    if (dirty.length > 0) throw new Error(`dirty worktree: ${dirty}`);
    const head = git(['rev-parse', 'HEAD'], cwd).trim();
    if (head === base.baseSha) throw new Error('no commit on the branch');
    this.lastHead = head;
    const created = !this.opened;
    this.opened = true;
    return {
      created,
      pr: { number: '1', url: 'https://host.example/pull/1', headSha: head, baseSha: base.baseSha },
      push: { mode: 'plain', branch: req.branch, head },
      notes: ['a plain push of the branch the worktree is on'],
    };
  }
  async status(ref: PullRequestRef): Promise<PullRequestStatus> {
    return { state: 'open', mergeable: true, headSha: ref.headSha, baseSha: ref.baseSha };
  }
  async checks(): Promise<CheckSummary[]> {
    return [];
  }
  async merge(_ref: PullRequestRef, opts: { expectedHeadSha: string }): Promise<MergeOutcome> {
    assert.equal(opts.expectedHeadSha, this.lastHead, 'only the reviewed head may merge');
    this.merged = true;
    return { merged: true, method: 'merge', headSha: opts.expectedHeadSha, url: 'https://host.example/pull/1' };
  }
}

test('runOnce: reviewMode rules refuses a delivery whose tests were weakened (the CLI wires the reviewer)', async () => {
  const repo = makeRepo();
  try {
    const worktreeRoot = join(repo.root, 'worktrees');
    // A test file in the repository, so there is something to weaken.
    writeFileSync(
      join(repo.work, 'test_calc.py'),
      'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n        self.assertEqual(add(0, 0), 0)\n',
    );
    writeFileSync(join(repo.work, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git(['add', '.'], repo.work);
    git(['commit', '-m', 'chore: add a test to weaken'], repo.work);
    git(['push', 'origin', 'main'], repo.work);

    // The agent's bad fix: delete an assertion so the pipeline looks green.
    const agentScript = join(repo.root, 'weaken.mjs');
    writeFileSync(
      agentScript,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("test_calc.py", "import unittest\\n\\nclass CalcTest(unittest.TestCase):\\n    def test_add(self):\\n        self.assertEqual(add(1, 2), 3)\\n");',
        'const g = (a) => execFileSync("git", a, { encoding: "utf8" });',
        'g(["add", "."]);',
        'g(["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "-m", "fix: make the test pass"]);',
        '',
      ].join('\n'),
    );

    const board = new FakeBoardProvider({ items: [{ id: 'ITEM-1', state: 'ready', title: 'Fix the failing test', labels: [] }] });
    const delivery = new RealHeadDelivery();
    const pilot: PilotConfig = {
      repo: repo.work,
      worktreeRoot,
      slotDir: join(repo.root, 'slots'),
      baseBranch: 'main',
      agent: { command: process.execPath, args: [agentScript], timeoutSeconds: 60 },
      // THE MODE UNDER TEST: no reviewer is injected here — the CLI builds it from this
      // policy, which is exactly the wiring that could silently be missing.
      policy: { reviewMode: 'rules', maxReviewRounds: 1, retainWorktreesHours: 0 },
    };

    const lines: string[] = [];
    const { tick, exitCode } = await runOnce({ board, delivery, pilot, out: (line) => lines.push(line) });

    assert.equal(tick.outcome, 'blocked', `a weakened test must block, got: ${lines.join('\n')}`);
    assert.equal(exitCode, 1, 'a blocked tick is the one outcome a human must look at');
    assert.equal(delivery.merged, false, 'nothing may merge');
    assert.equal((await board.getWork('ITEM-1')).state, 'blocked');
    assert.match(lines.join('\n'), /test-weakening\/assertions-removed/);
  } finally {
    repo.cleanup();
  }
});

test('runOnce: reviewMode rules lets honest work through, and a review mode that asks for rules without a repo fails closed', async () => {
  const repo = makeRepo();
  try {
    const worktreeRoot = join(repo.root, 'worktrees');
    writeFileSync(join(repo.work, 'test_calc.py'), 'import unittest\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n');
    writeFileSync(join(repo.work, 'calc.py'), 'def add(a, b):\n    return a + b\n');
    git(['add', '.'], repo.work);
    git(['commit', '-m', 'chore: fixture'], repo.work);
    git(['push', 'origin', 'main'], repo.work);

    const agentScript = join(repo.root, 'honest.mjs');
    writeFileSync(
      agentScript,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("test_calc.py", "import unittest\\n\\nclass CalcTest(unittest.TestCase):\\n    def test_add(self):\\n        self.assertEqual(add(1, 2), 3)\\n\\n    def test_sub(self):\\n        self.assertEqual(sub(3, 4), -1)\\n");',
        'writeFileSync("calc.py", "def add(a, b):\\n    return a + b\\n\\n\\ndef sub(a, b):\\n    return a - b\\n");',
        'const g = (a) => execFileSync("git", a, { encoding: "utf8" });',
        'g(["add", "."]);',
        'g(["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "-m", "feat: add sub() with a test"]);',
        '',
      ].join('\n'),
    );

    const board = new FakeBoardProvider({ items: [{ id: 'ITEM-1', state: 'ready', title: 'Add sub()', labels: [] }] });
    const delivery = new RealHeadDelivery();
    const pilot: PilotConfig = {
      repo: repo.work,
      worktreeRoot,
      slotDir: join(repo.root, 'slots'),
      baseBranch: 'main',
      agent: { command: process.execPath, args: [agentScript], timeoutSeconds: 60 },
      policy: { reviewMode: 'rules', maxReviewRounds: 1, retainWorktreesHours: 0 },
    };

    const lines: string[] = [];
    const { tick } = await runOnce({ board, delivery, pilot, out: (line) => lines.push(line) });
    assert.equal(tick.outcome, 'delivered', lines.join('\n'));
    assert.equal(delivery.merged, true, 'honest work still merges under the rules reviewer');

    // And the fail-closed direction, on the same repository: a reviewer that cannot read the
    // change set must not deliver. A git that refuses everything stands in for a real
    // outage (a shallow clone, a vanished object, a permission it does not have).
    const broken = {
      run: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: simulated outage' }),
    };
    const lines2: string[] = [];
    const second = await runOnce({
      board: new FakeBoardProvider({ items: [{ id: 'ITEM-2', state: 'ready', title: 'Another item', labels: [] }] }),
      delivery: new RealHeadDelivery(),
      pilot,
      git: broken,
      out: (line) => lines2.push(line),
    });
    assert.notEqual(second.tick.outcome, 'delivered', 'an unreadable change set must never deliver');
    assert.equal(second.tick.outcome, 'retriable', 'and it waits for the next tick instead of pretending');
    assert.match(lines2.join('\n'), /could not read the change set/);
  } finally {
    repo.cleanup();
  }
});

test('runOnce: an unfinished delivery is RESUMED, not redone (same branch, no agent run)', async () => {
  const repo = makeRepo();
  try {
    const worktreeRoot = join(repo.root, 'worktrees');
    // An earlier run did the work, pushed it, opened a pull request, and died before merging:
    // exactly the state a network blip during a push used to leave behind.
    git(['checkout', '-b', 'takumi/ITEM-1-deadrun'], repo.work);
    writeFileSync(join(repo.work, 'feature.txt'), 'work an earlier run already did\n');
    git(['add', '.'], repo.work);
    git(['commit', '-m', 'feat: the work an earlier run did'], repo.work);
    git(['push', '-u', 'origin', 'takumi/ITEM-1-deadrun'], repo.work);
    git(['checkout', 'main'], repo.work);

    const board = new FakeBoardProvider({
      items: [{ id: 'ITEM-1', state: 'pr_open', title: 'Finish it', labels: ['takumi-pr-open'] }],
    });
    await board.writeState('ITEM-1', {
      schema: 1,
      runId: 'dead-run',
      item: 'ITEM-1',
      reviewRound: 0,
      updatedAt: '2026-09-16T00:00:00.000Z',
      deliveryRef: '#3',
      branch: 'takumi/ITEM-1-deadrun',
    });

    const delivery = new RealHeadDelivery();
    delivery.opened = true; // the pull request is already open: this tick finishes it

    const pilot: PilotConfig = {
      repo: repo.work,
      worktreeRoot,
      slotDir: join(repo.root, 'slots'),
      baseBranch: 'main',
      // An agent that CANNOT run: if the tick still delivers, the agent demonstrably did not run,
      // which is the whole point of a resume — the work is already on the branch.
      agent: { command: '/nonexistent-agent-command', timeoutSeconds: 30 },
      policy: { reviewMode: 'rules', maxReviewRounds: 1, retainWorktreesHours: 0 },
    };

    const lines: string[] = [];
    const { tick } = await runOnce({ board, delivery, pilot, out: (line) => lines.push(line) });
    assert.equal(tick.outcome, 'delivered', lines.join('\n'));
    assert.equal(delivery.merged, true, 'a resumed delivery must finish: its work was already reviewed');
    assert.equal((await board.getWork('ITEM-1')).state, 'merged');
    // The decisive assertion: NO second branch was pushed for work that was already done.
    const heads = git(['ls-remote', '--heads', 'origin'], repo.work);
    assert.match(heads, /refs\/heads\/takumi\/ITEM-1-deadrun/);
    assert.doesNotMatch(heads, /takumi\/ITEM-1-(?!deadrun)/, 'a resume must not create a second branch');
  } finally {
    repo.cleanup();
  }
});

test('runOnce: a bare git remote is a REAL delivery — push, read back, fast-forward, no PR claimed', async () => {
  const repo = makeRepo();
  try {
    const worktreeRoot = join(repo.root, 'worktrees');
    const agentScript = join(repo.root, 'add-file.mjs');
    writeFileSync(
      agentScript,
      [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("delivered.txt", "work the agent did\\n");',
        'const g = (a) => execFileSync("git", a, { encoding: "utf8" });',
        'g(["add", "."]);',
        'g(["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "commit", "-m", "feat: the delivered work"]);',
        '',
      ].join('\n'),
    );

    const board = new FakeBoardProvider({ items: [{ id: 'ITEM-1', state: 'ready', title: 'Deliver to a bare remote', labels: [] }] });
    const delivery = new GitDeliveryProvider({ repo: repo.work, baseBranch: 'main' });
    const pilot: PilotConfig = {
      repo: repo.work,
      worktreeRoot,
      slotDir: join(repo.root, 'slots'),
      baseBranch: 'main',
      agent: { command: process.execPath, args: [agentScript], timeoutSeconds: 60 },
      policy: { reviewMode: 'rules', maxReviewRounds: 1, retainWorktreesHours: 0 },
    };

    const lines: string[] = [];
    const { tick } = await runOnce({ board, delivery, pilot, out: (line) => lines.push(line) });
    assert.equal(tick.outcome, 'delivered', lines.join('\n'));
    assert.equal((await board.getWork('ITEM-1')).state, 'merged');
    // The base branch ON THE REMOTE holds the agent's commit: the delivery is real, and the merge
    // was a fast-forward of the base to exactly that commit. Read from the remote, not from a
    // self-report: fetch and look at the file the agent wrote.
    git(['fetch', 'origin', 'main'], repo.work);
    const remoteMain = git(['rev-parse', 'origin/main'], repo.work).trim();
    assert.match(
      git(['show', `${remoteMain}:delivered.txt`], repo.work),
      /work the agent did/,
      'the agent\'s work must be ON the remote base branch after a fast-forward merge',
    );
    const trail = lines.join('\n');
    assert.doesNotMatch(trail, /PR #/, 'a bare remote has no review surface, so no pull request may appear');
    assert.match(trail, /none reported|no checks reported/, 'nothing may claim a green pipeline either');
  } finally {
    repo.cleanup();
  }
});

test('runOnce: an agent run through a RUNTIME reports what it cost, in the trail', async () => {
  const repo = makeRepo();
  try {
    const root = repo.root;
    const worktreeRoot = join(root, 'worktrees');
    const eventsFile = join(root, 'events.jsonl');
    const home = join(root, 'openhands-home');
    mkdirSync(home, { recursive: true });

    // A stand-in for the OpenHands CLI that COMMITS (as the prompt instructs), prints a captured
    // event stream, and leaves its accounting where OpenHands leaves it.
    const stub = join(root, 'runtime-stub.mjs');
    writeFileSync(
      stub,
      [
        'import { execFileSync } from "node:child_process";',
        'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const argv = process.argv.slice(2);',
        'const prompt = argv[argv.indexOf("-t") + 1] ?? "";',
        'writeFileSync("prompt.txt", prompt);',
        'mkdirSync("delivered", { recursive: true });',
        'writeFileSync(join("delivered", "note.txt"), "done\\n");',
        'const g = (a) => execFileSync("git", a, { encoding: "utf8" });',
        'g(["add", "."]);',
        'g(["-c", "user.name=Agent", "-c", "user.email=a@example.invalid", "commit", "-m", "feat: runtime work"]);',
        'const home = process.env.OPENHANDS_HOME;',
        'const id = "abc123def456abc123def456abc12345";',
        'mkdirSync(join(home, "conversations", id), { recursive: true });',
        'writeFileSync(join(home, "conversations", id, "base_state.json"), JSON.stringify({ id, execution_status: "finished", stats: { usage_to_metrics: { agent: { model_name: "stub-model", accumulated_cost: 0.0, accumulated_token_usage: { prompt_tokens: 4200, completion_tokens: 300, cache_read_tokens: 1000, reasoning_tokens: 5 } } } } }));',
        'process.stdout.write("Initializing agent...\\n");',
        'process.stdout.write(JSON.stringify({ id: "e1", kind: "MessageEvent", source: "user", llm_message: { content: [{ type: "text", text: prompt }] } }) + "\\n");',
        'process.stdout.write("Agent finished\\n");',
        'process.stdout.write("CONVERSATION SUMMARY\\nConversation ID:\\n" + id + "\\n");',
        '',
      ].join('\n'),
    );

    const board = new FakeBoardProvider({ items: [{ id: 'ITEM-1', state: 'ready', title: 'Costed work', body: "Do it", labels: [] }] });
    const delivery = new RealHeadDelivery();
    const pilot: PilotConfig = {
      repo: repo.work,
      worktreeRoot,
      slotDir: join(root, 'slots'),
      baseBranch: 'main',
      eventsFile,
      agent: {
        runtime: 'openhands',
        command: process.execPath,
        args: [stub],
        timeoutSeconds: 60,
        env: { OPENHANDS_HOME: home },
        runtimeOptions: { home },
      },
      policy: { reviewMode: 'rules', maxReviewRounds: 1, retainWorktreesHours: 0 },
    };

    const lines: string[] = [];
    const { tick } = await runOnce({ board, delivery, pilot, out: (line) => lines.push(line) });
    assert.equal(tick.outcome, 'delivered', lines.join('\n'));

    // The payoff: the tick's own trail says what the agent cost.
    const events = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { kind: string; message?: string; fields?: Record<string, unknown> });
    const usage = events.find((e) => e.kind === 'runtime.usage');
    assert.ok(usage !== undefined, `a runtime run must report its usage: ${events.map((e) => e.kind).join(',')}`);
    assert.equal(usage.fields?.['runtime'], 'openhands');
    assert.equal(usage.fields?.['promptTokens'], 4200);
    assert.equal(usage.fields?.['completionTokens'], 300);
    assert.equal(usage.fields?.['totalTokens'], 4500);
    assert.equal(usage.fields?.['model'], 'stub-model');
    assert.match(String(usage.message), /4500 tokens/);
    assert.ok(Number(usage.fields?.['artifacts'] ?? 0) > 0, 'the artifacts the runtime collected are counted');
  } finally {
    repo.cleanup();
  }
});
