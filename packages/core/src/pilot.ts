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

import { assertBoardCapability } from './task-board.js';
import type { ReviewRules } from './review-rules.js';
import type { BoardWorkItem, TaskBoardProvider } from './task-board.js';
import type { BoardStateRecord } from './board-state-record.js';
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
   * Who is trusted to judge a delivery:
   *
   * - `checks-only` — the CI pipeline. Merges as soon as the checks are green, which is
   *   only as good as the checks: a repository with NO pipeline merges unverified, and a
   *   pipeline can be satisfied by weakening the tests it runs.
   * - `label` — a human, who adds the approval label.
   * - `rules` — the deterministic reviewer (ADR-013), which reads the real change set and
   *   refuses a delivery whose tests were weakened or whose protected paths moved. It is
   *   the mode that makes "unattended" defensible, and it still lets CI be CI: failing
   *   checks are handled before the review ever runs.
   */
  reviewMode: 'checks-only' | 'label' | 'rules';
  /** What the `rules` reviewer runs. Absent means its defaults. */
  reviewRules?: ReviewRules;
  /** The label that means "a human approved this" — required for `reviewMode: 'label'`. */
  approvalLabel?: string;
  maxReviewRounds?: number;
  /** Worktrees untouched for this long are pruned at the end of a tick. 0 disables. */
  retainWorktreesHours?: number;
  /** Extra agent attempts after a TRANSPORT failure (default 2). */
  agentRetries?: number;
  agentRetryDelaySeconds?: number;
  /** How long a delivery waits for the host's checks before blocking. Default 300. */
  checksWaitSeconds?: number;
  /** Poll interval while waiting for checks. Default 15. */
  checksPollSeconds?: number;
  /** Re-reads of mergeability before it counts as unknown (default 5). */
  mergeabilityReads?: number;
  /** Seconds between those re-reads (default 3). */
  mergeabilityReadSeconds?: number;
  /** Suppress an unchanged progress write within this window, in seconds. Default 30. */
  progressIntervalSeconds?: number;
  /** File a work item when the checks stay red after every fix round. Default false. */
  fileIssueOnExhaustedChecks?: boolean;
  /**
   * Restrict a tick to items matching this text (an epic, a milestone, a component).
   *
   * The tick refuses to START when the board cannot search rather than ignoring the term:
   * a scope that is silently dropped means the runner works on the items the operator
   * excluded, which is the one failure mode a scope filter exists to prevent. The sweep
   * over in-flight items is deliberately NOT scoped — tidying a stranded item is not work,
   * and leaving it stranded because it fell outside today's scope would be worse.
   */
  scopeQuery?: string;
  /**
   * Hand items left behind by a run that stopped back to a human, instead of leaving
   * them claimed and invisible forever (ADR-009's known limit).
   *
   * OFF by default: acting on an item another run wrote is exactly the kind of thing
   * that must be opted into. When it is on, the evidence is the SLOT — the sweep only
   * touches an item whose slot it could take, which proves no live runner holds it —
   * and the action is `blocked`, never a silent takeover of the claim.
   */
  blockStaleClaims?: boolean;
  /** How stale a claim must be before the sweep touches it, in seconds. Default 900. */
  staleClaimSeconds?: number;
  /** The slot directory the sweep uses for its proof. Defaults to the tick's slotDir. */
  sweepSlotDir?: string;
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
  /**
   * Prepare the worktree this tick works in. `resume` asks for an EXISTING branch to be checked
   * out (a delivery this tick is finishing) instead of a new one cut from the frozen base.
   */
  prepareWorktree: (
    item: BoardWorkItem,
    runId: string,
    resume?: { branch: string },
  ) => Promise<WorktreeHandle>;
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
  /** How many agent attempts were retried (a health signal, reported not guessed). */
  agentRetries?: number;
  /** Seconds the delivery spent waiting for checks, when it waited at all. */
  checksWaitedSeconds?: number;
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

  // --- 0. the sweep: what a stopped run left behind ---------------------------
  //
  // A claim held by a run that no longer exists is not "waiting" — the tick only ever
  // selects `ready` items, so it is INVISIBLE. This reports every in-flight item and,
  // when the operator has opted in, hands a stale claim back to a human. The proof that
  // nobody is working on it is the slot: if we can take it, no live runner holds it.
  const inFlight = await deps.board.listWork({ states: ['claimed', 'pr_open'] });
  for (const parked of inFlight) {
    const record = await deps.board.readState(parked.id);
    const ageSeconds = record === null ? null : Math.max(0, Math.round((now() - Date.parse(record.updatedAt)) / 1000));
    const ageText = ageSeconds === null ? 'age unknown' : `${ageSeconds}s`;
    events.emit({
      kind: 'pilot.in_flight',
      runId: 'pilot000',
      itemId: parked.id,
      message: `${parked.state} for ${ageText}${record === null ? '' : ` (run ${record.runId})`}`,
      fields: { state: parked.state, ...(ageSeconds === null ? {} : { ageSeconds }) },
    });
    if (parked.state !== 'claimed') continue; // an open PR is a human's call, not ours
    if (policy.blockStaleClaims !== true) continue;
    const threshold = policy.staleClaimSeconds ?? 900;
    if (ageSeconds === null || ageSeconds < threshold) continue;

    const sweep = acquireSlot({
      dir: policy.sweepSlotDir ?? deps.slotDir,
      key: parked.id,
      owner: { runId: 'sweep001', itemId: parked.id },
      ...(deps.staleAfterSeconds === undefined ? {} : { staleAfterSeconds: deps.staleAfterSeconds }),
    });
    if (!sweep.acquired || sweep.handle === undefined) {
      events.emit({
        kind: 'pilot.item_skipped',
        runId: 'sweep001',
        itemId: parked.id,
        message: `stale claim, but the slot is held: ${sweep.reason ?? 'unknown'}`,
      });
      continue;
    }
    try {
      await deps.board.transition(parked.id, 'blocked', {
        runId: record?.runId ?? 'unknown',
        note: `stale claim from run ${record?.runId ?? 'unknown'} (${ageText}) — automation cannot resume a held claim, so this is for a human`,
      });
      events.emit({
        kind: 'pilot.stale_claim_blocked',
        runId: 'sweep001',
        itemId: parked.id,
        message: `blocked a stale claim held by run ${record?.runId ?? 'unknown'} for ${ageText}`,
      });
    } catch (e) {
      // A board that will not move the item is not a reason to abandon the tick.
      events.emit({
        kind: 'pilot.item_skipped',
        runId: 'sweep001',
        itemId: parked.id,
        message: `could not block the stale claim: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      sweep.handle.release();
    }
  }

  // --- 1. what is ready? ------------------------------------------------------
  if (policy.scopeQuery !== undefined) {
    // Fail before doing anything: an unhonourable scope is a configuration error, not a
    // reason to quietly process the whole board.
    assertBoardCapability(deps.board, 'canTextSearch');
  }
  const scope = policy.scopeQuery === undefined ? {} : { query: policy.scopeQuery };
  const ready = await deps.board.listWork({ states: ['ready'], ...scope });

  /**
   * Items whose delivery an earlier run left unfinished: the branch and the pull request exist,
   * the review simply never completed.
   *
   * The board is the queue, and it holds two kinds of work. Selecting only the fresh kind is how
   * a transient host hiccup — a network blip during a push, a mergeability answer that had not
   * been computed yet — became a delivery nobody ever finished: the sweep reported it and only a
   * human could act, and a human resetting the item re-ran the agent and pushed a SECOND branch
   * for work that was already reviewed.
   *
   * A record that names a delivery AND the branch it happened on is the evidence this needs, so a
   * record without the branch cannot be resumed — it is skipped rather than guessed at. The
   * review hook still decides whether such an item may merge, so an item parked for a person is
   * re-read and left waiting, never pushed through.
   */
  const findResumable = async (): Promise<Array<{ item: BoardWorkItem; resumeBranch?: string }>> => {
    if (!deps.board.capabilities().machineReadableState) return [];
    const out: Array<{ item: BoardWorkItem; resumeBranch?: string }> = [];
    // Bounded: one record read per candidate, and one tick only ever needs one item.
    for (const entry of (await deps.board.listWork({ states: ['pr_open', 'fix_needed'], ...scope })).slice(0, 10)) {
      let record: BoardStateRecord | null = null;
      try {
        record = await deps.board.readState(entry.id);
      } catch {
        continue;
      }
      if (record === null || record.deliveryRef === undefined || record.branch === undefined) continue;
      out.push({ item: entry, resumeBranch: record.branch });
    }
    return out;
  };

  const candidates: Array<{ item: BoardWorkItem; resumeBranch?: string }> = ready.map((entry) => ({ item: entry }));
  if (candidates.length === 0) candidates.push(...(await findResumable()));
  if (candidates.length === 0) {
    events.emit({ kind: 'pilot.idle', runId: 'pilot000', message: 'no ready work' });
    return { outcome: 'idle', detail: 'no ready work' };
  }

  // --- 2. the first item nobody else is on ------------------------------------
  let item: BoardWorkItem | undefined;
  let resumeBranch: string | undefined;
  let runId = '';
  let handle: Awaited<ReturnType<typeof acquireSlot>> | undefined;
  for (const candidate of candidates) {
    const runCandidate = pilotRunId(now());
    const acquisition = acquireSlot({
      dir: deps.slotDir,
      key: candidate.item.id,
      owner: { runId: runCandidate, itemId: candidate.item.id },
      ...(deps.staleAfterSeconds === undefined ? {} : { staleAfterSeconds: deps.staleAfterSeconds }),
    });
    if (acquisition.acquired && acquisition.handle !== undefined) {
      item = candidate.item;
      resumeBranch = candidate.resumeBranch;
      runId = runCandidate;
      handle = acquisition;
      break;
    }
    events.emit({
      kind: 'pilot.item_skipped',
      runId: runCandidate,
      itemId: candidate.item.id,
      message: acquisition.reason ?? 'held by another runner',
    });
  }
  if (item === undefined || handle?.handle === undefined) {
    return { outcome: 'busy', detail: `all ${candidates.length} item(s) are held by other runners` };
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
    if (resumeBranch !== undefined) {
      events.emit({
        kind: 'pilot.resumed',
        runId,
        itemId: item.id,
        message: `finishing the delivery already on ${resumeBranch} instead of starting new work`,
      });
    }
    const worktree = await deps.prepareWorktree(
      item,
      runId,
      resumeBranch === undefined ? undefined : { branch: resumeBranch },
    );
    events.emit({
      kind: 'worktree.created',
      runId,
      itemId: item.id,
      message: `worktree ${worktree.path} on ${worktree.branch}`,
      fields: { base: baseSha },
    });

    // --- 4. the agent, with retries on transport failures only -----------------
    let agentRetries = 0;
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
          agentRetries += 1;
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
      // Round 0 of a resumed run has no agent work to do; the loop needs to know that, or its
      // event trail reports an agent run that never happened.
      ...(resumeBranch === undefined ? {} : { resumed: true }),
      // The review policy travels WITH the plan (ADR-018): the loop binds its review evidence to
      // it, so a policy edited after a review makes that evidence stale by construction.
      reviewMode: policy.reviewMode,
      ...(policy.approvalLabel === undefined ? {} : { approvalLabel: policy.approvalLabel }),
      ...(policy.reviewRules === undefined ? {} : { reviewRules: policy.reviewRules }),
        baseBranch: deps.baseBranch,
        ...(deps.remote === undefined ? {} : { remote: deps.remote }),
        itemId: item.id,
        runId,
        // The worktree HANDLE is authoritative about what this run is based on. For fresh work that
        // equals `resolveBaseSha()`; for a RESUME it is the merge base of the branch and today's
        // base branch — which is the only value the delivery's descent check can accept, because a
        // delivery that has been sitting in `pr_open` while the base branch moved on is not "based
        // on" today's head. Using the freshly resolved base here stranded a real resume on
        // "HEAD is not descended from the frozen base", for a branch nobody had rewritten.
        baseSha: worktree.baseSha,
        title: item.title,
        // Passed through explicitly: a policy knob the CLI accepts but the pilot drops is
        // the same silent drop as a config option nothing reads.
        ...(policy.maxReviewRounds === undefined ? {} : { maxReviewRounds: policy.maxReviewRounds }),
        ...(policy.checksWaitSeconds === undefined ? {} : { checksWaitSeconds: policy.checksWaitSeconds }),
        ...(policy.checksPollSeconds === undefined ? {} : { checksPollSeconds: policy.checksPollSeconds }),
        ...(policy.mergeabilityReads === undefined ? {} : { mergeabilityReads: policy.mergeabilityReads }),
        ...(policy.mergeabilityReadSeconds === undefined
          ? {}
          : { mergeabilityReadSeconds: policy.mergeabilityReadSeconds }),
        ...(policy.progressIntervalSeconds === undefined ? {} : { progressIntervalSeconds: policy.progressIntervalSeconds }),
        ...(policy.fileIssueOnExhaustedChecks === undefined ? {} : { fileIssueOnExhaustedChecks: policy.fileIssueOnExhaustedChecks }),
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
      ...(agentRetries === 0 ? {} : { agentRetries }),
      ...(loop.checksWaitedSeconds === undefined ? {} : { checksWaitedSeconds: loop.checksWaitedSeconds }),
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
