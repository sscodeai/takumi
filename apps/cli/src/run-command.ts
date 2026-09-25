/**
 * `takumi run --once` — one tick of the pilot.
 *
 * ADR-009's shape: a ONE-SHOT process started by an external scheduler (a systemd
 * timer, cron, a CI job). Nothing is resident, nothing leaks between ticks, and
 * concurrency is the scheduler's business — the per-item slot lock (ADR-008) is what
 * makes overlapping ticks safe.
 *
 * The agent is a COMMAND, not a model API: takumi starts `pilot.agent.command` in the
 * task worktree with the item's identity in the environment, and the agent's job is to
 * commit its work. takumi never commits, never pushes and never merges on the agent's
 * behalf — the delivery loop does that, under the rules of ADR-007.
 *
 * Shutdown: SIGTERM/SIGINT kills the agent child (TERM, then KILL after a grace
 * period) and lets the tick end as `retriable`, so the slot is released and the item
 * is picked up again next tick instead of being left claimed forever.
 */

import { spawn } from 'node:child_process';

import {
  acquireSlot,
  bumpMetrics,
  createEventLog,
  createGitRunner,
  createRuleReviewer,
  createTaskWorktree,
  lineSink,
  readMetricsFile,
  writeMetricsFile,
  pruneTaskWorktrees,
  ProviderError,
  runPilotTick,
  type BoardWorkItem,
  type EventLog,
  type GitRunner,
  type ReviewContext,
  type ReviewOutcome,
  type PilotPolicy,
  type PilotTickResult,
  type TaskBoardProvider,
  type DeliveryProvider,
  type WorktreeHandle,
} from '@takumi/core';

export interface PilotAgentConfig {
  /** The executable to run (e.g. `pi`, `claude`, a repo script). */
  command: string;
  /** Its arguments. `{item}` and `{branch}` are substituted from the run. */
  args?: string[];
  /** Hard limit for one agent attempt. Default 45 minutes. */
  timeoutSeconds?: number;
  /** Extra environment for the child. */
  env?: Record<string, string>;
}

export interface PilotConfig {
  /** The main checkout the worktrees are created from. */
  repo: string;
  /** Where task worktrees live. */
  worktreeRoot: string;
  /** The slot directory: one lock per item. */
  slotDir: string;
  baseBranch: string;
  remote?: string;
  agent: PilotAgentConfig;
  policy: PilotPolicy;
  /** Where the event trail is appended (JSON lines). Omit for stderr only. */
  eventsFile?: string;
  /** Counters: JSON here, and a Prometheus textfile next to it if asked. */
  metricsFile?: string;
  /** The Prometheus textfile (default: `<metricsFile>.prom`). */
  metricsTextfile?: string;
}

export interface RunOnceDeps {
  board: TaskBoardProvider;
  delivery: DeliveryProvider;
  pilot: PilotConfig;
  /** Injected for tests: the agent runner (so no child process is needed). */
  runAgent?: AgentRunner;
  /** Injected for tests: overrides the reviewer the policy would build. */
  review?: (ctx: ReviewContext) => Promise<ReviewOutcome>;
  /** Injected for tests: the git the reviewer reads with. */
  git?: GitRunner;
  /** Injected for tests. */
  log?: EventLog;
  /** Where to report progress (default: stdout). */
  out?: (line: string) => void;
}

export interface AgentContext {
  item: BoardWorkItem;
  worktree: string;
  branch: string;
  runId: string;
  round: number;
}

/** What the pilot needs from whatever runs the agent. */
export type AgentRunner = (ctx: AgentContext, config: PilotAgentConfig) => Promise<void>;

export interface RunOnceResult {
  tick: PilotTickResult;
  /** Process exit code: 0 for every ordinary outcome, 1 only when a human must act. */
  exitCode: number;
}

/**
 * Run one tick and report it.
 *
 * Exit codes are deliberate: `idle`, `delivered`, `awaiting_review`, `busy`,
 * `not_claimed` and `retriable` are all 0 — a scheduled process that returns non-zero
 * for "nothing to do" fills a timer's journal with noise and trains people to ignore
 * it. `blocked` is 1, because that is the one outcome a human has to look at.
 */
export async function runOnce(deps: RunOnceDeps): Promise<RunOnceResult> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const runner = deps.runAgent ?? runAgentCommand;
  const events = deps.log ?? createEventLog();

  // Prune before working, not after: a tick that fails should still have cleaned up
  // yesterday's worktrees, and pruning after would never run for a failing pipeline.
  const retainHours = deps.pilot.policy.retainWorktreesHours ?? 0;
  if (retainHours > 0) {
    const pruned = await pruneTaskWorktrees({ root: deps.pilot.worktreeRoot, retainHours });
    if (pruned.removed.length > 0 || pruned.keptDirty.length > 0) {
      out(
        `worktrees: pruned ${pruned.removed.length}, kept ${pruned.keptRecent.length} recent, ` +
          `${pruned.keptDirty.length} dirty (never deleted)`,
      );
    }
    if (pruned.keptDirty.length > 0) {
      out(`  uncommitted work kept in:\n${pruned.keptDirty.map((p) => `    ${p}`).join('\n')}`);
    }
  }

  // Set while preparing a worktree: this tick is finishing an existing delivery, so the work is
  // already on its branch and the agent must not run again.
  let resumed = false;

  const tick = await runPilotTick({
    board: deps.board,
    delivery: deps.delivery,
    events,
    repo: deps.pilot.repo,
    worktreeRoot: deps.pilot.worktreeRoot,
    baseBranch: deps.pilot.baseBranch,
    ...(deps.pilot.remote === undefined ? {} : { remote: deps.pilot.remote }),
    resolveBaseSha: async () => {
      const { resolveRef } = await import('@takumi/core');
      return resolveRef(deps.pilot.repo, deps.pilot.remote === undefined ? deps.pilot.baseBranch : `${deps.pilot.remote}/${deps.pilot.baseBranch}`);
    },
    prepareWorktree: async (item, runId, resume) => {
      const { worktreeBranchName } = await import('@takumi/core');
      resumed = resume !== undefined;
      return createTaskWorktree({
        repo: deps.pilot.repo,
        root: deps.pilot.worktreeRoot,
        itemId: item.id,
        runId,
        branch: worktreeBranchName(item.id, runId),
        baseBranch: deps.pilot.baseBranch,
        baseSha: await resolveBaseFor(deps.pilot),
        // A resumed delivery checks out the branch it is finishing, and its frozen base becomes
        // the merge base with it: the diff the review reads is what the delivery adds, whatever
        // the base branch has done since.
        ...(resume === undefined ? {} : { resumeBranch: resume.branch }),
        ...(deps.pilot.remote === undefined ? {} : { remote: deps.pilot.remote }),
      });
    },
    agent: async (ctx) => {
      // A resumed tick finishes a delivery whose work is ALREADY committed on the branch, so
      // running the agent again would duplicate it — a second branch and a second pull request
      // for work that was reviewed once. The loop's contract (a commit exists, the worktree is
      // clean) is what the resumed branch already satisfies, and if it does not, the delivery
      // refuses exactly as it would for a fresh run.
      if (resumed) return;
      return runner(ctx, deps.pilot.agent);
    },
    // `reviewMode: rules` without a reviewer would be a policy that promises a gate and
    // delivers a rubber stamp, so the two are wired together here — and an injected
    // reviewer (tests) still wins.
    ...(deps.review ?? (deps.pilot.policy.reviewMode === 'rules'
      ? { review: createRuleReviewer({ git: deps.git ?? createGitRunner(), rules: deps.pilot.policy.reviewRules }) }
      : {})),
    policy: deps.pilot.policy,
    slotDir: deps.pilot.slotDir,
  });

  report(out, tick);

  if (deps.pilot.metricsFile !== undefined) {
    // Counters are read-modify-write on purpose: a tick is a separate process, and the
    // file is the only memory between ticks. Monotonic counters, so a lost tick is a
    // missed increment rather than a wrong total.
    const before = readMetricsFile(deps.pilot.metricsFile);
    const after = bumpMetrics(before, tick, {
      atSeconds: Math.floor(Date.now() / 1000),
      agentRetries: tick.agentRetries ?? 0,
      checksWaitedSeconds: tick.checksWaitedSeconds ?? 0,
    });
    writeMetricsFile(deps.pilot.metricsFile, after, deps.pilot.metricsTextfile ?? `${deps.pilot.metricsFile}.prom`);
    out(`metrics: ${deps.pilot.metricsFile} (ticks=${after.ticks}, last=${after.lastOutcome}, prom=${deps.pilot.metricsTextfile ?? `${deps.pilot.metricsFile}.prom`})`);
  }
  return { tick, exitCode: tick.outcome === 'blocked' ? 1 : 0 };
}

async function resolveBaseFor(pilot: PilotConfig): Promise<string> {
  const { resolveRef } = await import('@takumi/core');
  return resolveRef(pilot.repo, pilot.remote === undefined ? pilot.baseBranch : `${pilot.remote}/${pilot.baseBranch}`);
}

function report(out: (line: string) => void, tick: PilotTickResult): void {
  const where = tick.itemId === undefined ? '' : ` ${tick.itemId}`;
  out(`${tick.outcome}${where}: ${tick.detail}`);
  if (tick.pr !== undefined) out(`  pull request: ${tick.pr.url}`);
  for (const step of tick.steps ?? []) out(`  ${step.step.padEnd(12)} ${step.detail}`);
}

/**
 * Start the agent command in the worktree and wait for it.
 *
 * The child receives the item's identity (`TAKUMI_ITEM_ID`, `TAKUMI_RUN_ID`,
 * `TAKUMI_BRANCH`) so its own logs and commits can be tied to the run without takumi
 * parsing anything it prints.
 *
 * It ALSO receives the work itself (`TAKUMI_ITEM_TITLE`, `TAKUMI_ITEM_BODY`,
 * `TAKUMI_ITEM_URL`). Without them the command is handed a task it cannot read: a wrapper
 * around a real agent (OpenHands, say) has no way to know what to do, and the only
 * alternatives are re-reading the board from inside the agent — a second, unauthenticated
 * path to the same state — or hardcoding the task, which is not an agent at all. Found by
 * running a real agent against a real worktree (see docs/openhands-spike-report.md).
 */
export async function runAgentCommand(ctx: AgentContext, config: PilotAgentConfig): Promise<void> {
  const args = (config.args ?? []).map((arg) =>
    arg.replaceAll('{item}', ctx.item.id).replaceAll('{branch}', ctx.branch).replaceAll('{round}', String(ctx.round)),
  );
  const timeoutSeconds = config.timeoutSeconds ?? 45 * 60;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.command, args, {
      cwd: ctx.worktree,
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        ...config.env,
        TAKUMI_ITEM_ID: ctx.item.id,
        TAKUMI_ITEM_TITLE: ctx.item.title,
        TAKUMI_ITEM_BODY: ctx.item.body,
        TAKUMI_ITEM_URL: ctx.item.url,
        TAKUMI_RUN_ID: ctx.runId,
        TAKUMI_BRANCH: ctx.branch,
        TAKUMI_ROUND: String(ctx.round),
      },
    });

    let settled = false;
    const terminate = (signal: NodeJS.Signals): void => {
      // Ask politely, then insist: an agent that ignores SIGTERM must not keep the
      // slot until the stale window expires.
      child.kill(signal);
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      terminate(signal);
      setTimeout(() => terminate('SIGKILL'), 10_000).unref();
    };
    const signalHandlers: NodeJS.Signals[] = ['SIGTERM', 'SIGINT'];
    for (const signal of signalHandlers) process.on(signal, onSignal);
    const timer = setTimeout(() => {
      terminate('SIGKILL');
      finish(() => reject(new ProviderError('transport', `the agent exceeded ${timeoutSeconds}s and was killed`)));
    }, timeoutSeconds * 1000);
    timer.unref();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signalHandlers) process.off(signal, onSignal);
      fn();
    };

    child.on('error', (error) => {
      finish(() =>
        reject(new ProviderError('transport', `the agent command could not be started: ${error.message}`, { cause: error })),
      );
    });
    child.on('close', (code, signal) => {
      if (signal !== null) {
        // Killed (a shutdown or the timeout): retriable, so the item is not blocked
        // for a human because OUR process went away.
        finish(() => reject(new ProviderError('transport', `the agent was stopped by ${signal}`)));
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      // A non-zero exit is the AGENT reporting a real failure (bad task, broken
      // repo, refused work): retrying it would burn another attempt on the same
      // wall, so the item blocks for a human.
      finish(() =>
        reject(new ProviderError('precondition', `the agent exited ${String(code)}: the item needs a human`)),
      );
    });
  });
}

/** A log that appends JSON lines to a file, so a timer's ticks leave a trail. */
export async function eventLogFor(file: string | undefined): Promise<EventLog> {
  if (file === undefined) return createEventLog();
  const { appendFileSync } = await import('node:fs');
  return createEventLog({
    sink: lineSink((line) => appendFileSync(file, line)),
    retain: false,
  });
}

/** Re-exported so the CLI entry point can keep its imports in one place. */
export { acquireSlot, createTaskWorktree, pruneTaskWorktrees };
export type { EventLog, WorktreeHandle };
