/**
 * The pilot: one tick of an unattended runner.
 *
 * ADR-008 built the rails (a slot per item, an event trail, a board that can say
 * what it is missing). This is the vehicle: a single pass that picks ONE ready item,
 * excludes other runners from it, prepares a worktree, runs the agent, and drives
 * the delivery loop to its end state.
 *
 * WHY one item per tick, with an external scheduler: orbi's shape, and the right one
 * for a self-hosted box — a `systemd` timer (or cron) starts a one-shot process
 * every N minutes, the process exits, and nothing leaks between runs. Concurrency is
 * then a matter of timer instances, and the slot lock is what keeps two of them from
 * touching the same item.
 *
 * The pilot owns no judgement of its own: it selects, it excludes, it survives
 * failures. Whether a change may merge is `reviewMode` — `checks-only` (green checks
 * are enough) or `label` (a human adds the approval label). Waiting for that human is
 * NOT a defect, so it does not consume a review round.
 */

import type { BoardWorkItem, TaskBoardProvider } from './task-board.js';
import type { DeliveryProvider, PullRequestRef } from './delivery.js';
import {
  runDeliveryLoop,
  type DeliveryLoopResult,
  type LoopStep,
  type ReviewContext,
  type ReviewOutcome,
} from './delivery-loop.js';
import { createEventLog, nullEventLog, type EventLog } from './events.js';
import { ProviderError } from './provider-error.js';
import { acquireSlot } from './slot-lock.js';
import type { WorktreeHandle } from './worktree.js';

export interface PilotPolicy {
  /**
   * `checks-only` merges as soon as the checks are green; `label` waits for the
   * approval label a human adds. The difference is who is trusted to judge, so it is
   * a policy decision, never a default buried in code.
   */
  reviewMode: 'checks-only' | 'label';
  /** The label that means "a human approved this" — required for `reviewMode: 'label'`. */
  approvalLabel?: string;
  maxReviewRounds?: number;
  /** Worktrees untouched for this long are pruned at the end of a tick. 0 disables. */
  retainWorktreesHours?: number;
  /** Extra agent attempts after a TRANSPORT failure (default 2). */
  agentRetries?: number;
  agentRetryDelaySeconds?: number;
}

export interface PilotTickDeps {
  board: TaskBoardProvider;
  delivery: DeliveryProvider;
  /** The repository the worktrees are created from (the main checkout). */
  repo: string;
  /** Where task worktrees live. */
  worktreeRoot: string;
  baseBranch: string;
  remote?: string;
  /** The branch tip to freeze as the base for this tick (read from the repo). */
  resolveBaseSha: () => Promise<string>;
  /** Create the task worktree for one item (injected: a test needs no git). */
  prepareWorktree: (item: BoardWorkItem, runId: string) => Promise<WorktreeHandle>;
  /** Remove a worktree at the end of a tick (injected for the same reason). */
  releaseWorktree?: (handle: WorktreeHandle, outcome: string) => Promise<void>;
  /** Run the agent in the worktree. Must COMMIT its work: the loop never commits. */
  agent: (ctx: { item: BoardWorkItem; worktree: string; branch: string; round: number; runId: string }) => Promise<void>;
  /** Optional extra review signal (a second reader, a lint pass). */
  review?: (ctx: ReviewContext & { item: BoardWorkItem }) => Promise<ReviewOutcome>;
  changedFiles?: (ctx: { worktree: string; baseSha: string }) => Promise<string[]>;
  policy: PilotPolicy;
  /** Where the tick's events go. */
  events?: EventLog;
  /** The slot directory: one lock per item, so two pilots never race. */
  slotDir: string;
  staleAfterSeconds?: number;
  now?: () => number;
  /** Injectable sleep, so a retry test does not wait in real time. */
  sleep?: (seconds: number) => Promise<void>;
}

export type PilotTickOutcome =
  /** Nothing was ready to work on. */
  | 'idle'
  /** Every ready item is already held by another runner. */
  | 'busy'
  /** This tick delivered and merged one item. */
  | 'delivered'
  /** The pull request is open, waiting for a human (reviewMode: 'label'). */
  | 'awaiting_review'
  /** The item needs a human: a failed check with no round left, a conflict, a bug. */
  | 'blocked'
  /** A transport failure before anything was owned: try again next tick. */
  | 'retriable'
  /** An attempt lost the race for the item (another runner claimed it first). */
  | 'not_claimed';

export interface PilotTickResult {
  outcome: PilotTickOutcome;
  detail: string;
  itemId?: string;
  runId?: string;
  pr?: PullRequestRef;
  /** The full step timeline of the delivery, when one ran. */
  steps?: LoopStep[];
}

/**
 * Run one tick.
 *
 * Returns rather than throws for every ordinary outcome: a scheduled process must
 * be able to journal "nothing to do" or "someone else is on it" and exit 0.
 */
export async function runPilotTick(deps: PilotTickDeps): Promise<PilotTickResult> {
  const events = deps.events ?? nullEventLog();
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)));
  const policy = deps.policy;
  if (policy.reviewMode === 'label' && (policy.approvalLabel ?? '').length === 0) {
    throw new ProviderError('precondition', "reviewMode 'label' needs an approvalLabel to look for");
  }

  // --- 1. what is ready? ------------------------------------------------------
  const ready = await deps.board.listWork({ states: ['ready'] });
  if (ready.length === 0) {
    events.emit({ kind: 'pilot.idle', runId: 'pilot000', message: 'no ready work' });
    return { outcome: 'idle', detail: 'no ready work' };
  }

  // --- 2. the first item nobody else is on ------------------------------------
  let item: BoardWorkItem | undefined;
  let runId = '';
  let handle: Awaited<ReturnType<typeof acquireSlot>> | undefined;
  for (const candidate of ready) {
    const runCandidate = pilotRunId(now());
    const acquisition = acquireSlot({
      dir: deps.slotDir,
      key: candidate.id,
      owner: { runId: runCandidate, itemId: candidate.id },
      ...(deps.staleAfterSeconds === undefined ? {} : { staleAfterSeconds: deps.staleAfterSeconds }),
    });
    if (acquisition.acquired && acquisition.handle !== undefined) {
      item = candidate;
      runId = runCandidate;
      handle = acquisition;
      break;
    }
    events.emit({
      kind: 'pilot.item_skipped',
      runId: runCandidate,
      itemId: candidate.id,
      message: acquisition.reason ?? 'held by another runner',
    });
  }
  if (item === undefined || handle?.handle === undefined) {
    return { outcome: 'busy', detail: `all ${ready.length} ready item(s) are held by other runners` };
  }
  const slot = handle.handle;
  slot.startHeartbeat();
  events.emit({
    kind: 'pilot.item_selected',
    runId,
    itemId: item.id,
    message: `selected ${item.id} (${ready.length} ready)`,
  });

  let pr: PullRequestRef | undefined;
  try {
    // --- 3. the worktree the agent will work in --------------------------------
    const baseSha = await deps.resolveBaseSha();
    const worktree = await deps.prepareWorktree(item, runId);
    events.emit({
      kind: 'worktree.created',
      runId,
      itemId: item.id,
      message: `worktree ${worktree.path} on ${worktree.branch}`,
      fields: { base: baseSha },
    });

    // --- 4. the agent, with retries on transport failures only -----------------
    const retries = policy.agentRetries ?? 2;
    const delay = policy.agentRetryDelaySeconds ?? 30;
    // The retry wrapper emits ONLY what it owns — the retry. The loop already
    // reports `agent.started` / `agent.finished`, and emitting those here too would
    // put two events in the trail for one fact (the class of bug the ledger calls
    // "two mechanisms, one effect").
    const runAgent = async (round: number): Promise<void> => {
      let attempt = 0;
      for (;;) {
        try {
          await deps.agent({ item, worktree: worktree.path, branch: worktree.branch, round, runId });
          return;
        } catch (e) {
          attempt += 1;
          const retriable = e instanceof ProviderError && e.retriable;
          if (!retriable || attempt > retries) throw e;
          events.emit({
            kind: 'agent.retry',
            runId,
            itemId: item.id,
            message: `attempt ${attempt} failed, retrying in ${delay}s: ${e instanceof Error ? e.message : String(e)}`,
            fields: { attempt, delaySeconds: delay },
          });
          await sleep(delay);
        }
      }
    };

    // --- 5. the delivery loop, with the policy's review mode --------------------
    const loop = await runDeliveryLoop({
      board: deps.board,
      delivery: deps.delivery,
      events,
      plan: {
        worktree: worktree.path,
        branch: worktree.branch,
        baseBranch: deps.baseBranch,
        ...(deps.remote === undefined ? {} : { remote: deps.remote }),
        itemId: item.id,
        runId,
        baseSha,
        title: item.title,
        ...(policy.maxReviewRounds === undefined ? {} : { maxReviewRounds: policy.maxReviewRounds }),
      },
      hooks: {
        agent: async ({ round }) => runAgent(round),
        review: async (ctx) => {
          // The policy decides who is trusted to judge, and its answer comes FIRST:
          // a missing human approval must not be mistaken for "fix something".
          if (policy.reviewMode === 'label') {
            const fresh = await deps.board.getWork(item.id);
            const approved = fresh.labels.includes(policy.approvalLabel ?? '');
            if (!approved) {
              return { verdict: 'awaiting-human', note: `waiting for the ${policy.approvalLabel ?? ''} label` };
            }
          }
          if (deps.review !== undefined) return deps.review({ ...ctx, item });
          return { verdict: 'clean' };
        },
        ...(deps.changedFiles === undefined ? {} : { changedFiles: deps.changedFiles }),
      },
    });
    pr = loop.pr;

    const outcome: PilotTickOutcome =
      loop.outcome === 'merged'
        ? 'delivered'
        : loop.outcome === 'awaiting_review'
          ? 'awaiting_review'
          : loop.outcome === 'blocked'
            ? 'blocked'
            : loop.outcome === 'not_claimed'
              ? 'not_claimed'
              : loop.outcome === 'busy'
                ? 'busy'
                : 'retriable';
    return {
      outcome,
      detail: loop.error ?? `${loop.outcome} after ${loop.rounds} round(s)`,
      itemId: item.id,
      runId,
      ...(pr === undefined ? {} : { pr }),
      steps: loop.steps,
    };
  } catch (e) {
    // Anything that escaped before the loop owned the item: a fetch failure, an
    // unusable worktree. Retriable on the next tick; nothing was claimed.
    const retriable = e instanceof ProviderError && e.retriable;
    return {
      outcome: retriable ? 'retriable' : 'blocked',
      detail: e instanceof Error ? e.message : String(e),
      itemId: item.id,
      runId,
    };
  } finally {
    slot.release();
    events.emit({ kind: 'pilot.tick_done', runId, itemId: item.id, message: 'tick finished' });
  }
}

/**
 * A run id for a pilot tick: eight lowercase hex, derived from the clock.
 *
 * The grammar is core's (`renderRunMarker` refuses anything else), so the pilot
 * generates what every reader expects instead of inventing its own id shape.
 */
export function pilotRunId(seed: number = Date.now()): string {
  const mixed = (seed ^ (seed >>> 17)) >>> 0;
  const hex = ((mixed * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return hex.slice(-8);
}

/** Re-exported so a caller can wire a pilot without a second import. */
export type { DeliveryLoopResult };
