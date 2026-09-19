import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeBoardProvider } from '@takumi/board-fake';
import { FakeDeliveryProvider } from '@takumi/delivery-fake';
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
      { item: { id: 'ITEM-9', title: 't', body: '', url: 'u', state: 'ready', labels: [], assignees: [], updatedAt: '' }, worktree: dir, branch: 'takumi/x', runId: 'c0ffee01', round: 2 },
      { command: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`] },
    );
    const env = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
    assert.equal(env['TAKUMI_ITEM_ID'], 'ITEM-9');
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
