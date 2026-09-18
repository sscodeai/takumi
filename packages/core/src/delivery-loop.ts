/**
 * The delivery loop: the piece that actually runs the two ports in order.
 *
 * ADR-006 gave takumi a work source, ADR-007 a delivery; on their own they are
 * primitives. This is the sequencing that turns them into a delivery:
 *
 *   claim → agent(commit) → deliver → review → (fix → re-deliver)* → merge
 *
 * What this module owns, and what it deliberately does not:
 *
 *   - It owns the ORDER, the state transitions and the fail-fast classification.
 *   - It does NOT do the work (the `agent` hook) and does NOT judge the code (the
 *     `review` hook). Both are injected, so the loop is testable end to end with
 *     the in-memory providers and no model.
 *   - It never writes code, never commits, never force-pushes, and never merges a
 *     head other than the one the review covered: the merge is passed the head
 *     that was frozen for review, and a host that no longer has that head refuses.
 *
 * Failure classification follows the shared taxonomy: `transport` is retriable on
 * a later tick, everything else (`precondition`, `unsupported`, `auth`,
 * `not_found`) is a decision and moves the item to `blocked` for a human.
 */

import type { BoardWorkItemState } from './board-state.js';
import { DeliveryError, type DeliveryProvider, type PullRequestRef } from './delivery.js';
import { ProviderError } from './provider-error.js';
import type { TaskBoardProvider } from './task-board.js';
import type { BoardStateRecord } from './board-state-record.js';

/** What this delivery is about. The caller owns the run id and the frozen base. */
export interface DeliveryLoopPlan {
  worktree: string;
  branch: string;
  baseBranch: string;
  remote?: string;
  itemId: string;
  /** End-to-end correlation id (the same one the board comments carry). */
  runId: string;
  /** The frozen base sha the worktree was created from. */
  baseSha: string;
  title?: string;
  body?: string;
  /** Bounded review/fix rounds. Default 3. */
  maxReviewRounds?: number;
}

export interface ReviewContext {
  round: number;
  pr: PullRequestRef;
  /** The exact head the review must cover — the only head that may later merge. */
  headSha: string;
  changedFiles: string[];
}

export type ReviewOutcome = { verdict: 'clean' } | { verdict: 'findings'; note?: string };

export interface DeliveryLoopHooks {
  /**
   * Do the work and COMMIT it in the worktree. `round > 0` means "fix what the
   * review found". The loop never commits on the hook's behalf: a hook that
   * leaves the worktree dirty ends the delivery as a `blocked` precondition.
   */
  agent: (ctx: { round: number; worktree: string; branch: string }) => Promise<void>;
  /** Review the frozen head. `clean` is the only verdict that unlocks the merge. */
  review: (ctx: ReviewContext) => Promise<ReviewOutcome>;
  /** Optional: what changed since the frozen base, for the review context. */
  changedFiles?: (ctx: { worktree: string; baseSha: string }) => Promise<string[]>;
}

export interface LoopStep {
  step: string;
  detail: string;
  at: string;
}

export type DeliveryLoopOutcome = 'merged' | 'blocked' | 'retriable' | 'not_claimed';

export interface DeliveryLoopResult {
  outcome: DeliveryLoopOutcome;
  itemId: string;
  pr?: PullRequestRef;
  /** Rounds actually used. */
  rounds: number;
  steps: LoopStep[];
  error?: string;
}

export interface DeliveryLoopDeps {
  board: TaskBoardProvider;
  delivery: DeliveryProvider;
  plan: DeliveryLoopPlan;
  hooks: DeliveryLoopHooks;
  /** Injectable clock so the recorded timeline is deterministic in tests. */
  now?: () => number;
}

/**
 * Run one delivery to its end state.
 *
 * Returns rather than throws for the three expected non-happy outcomes, because
 * the caller (a runner tick) must be able to journal them and move on:
 * `not_claimed` (another run owns it), `retriable` (a transport failure — try
 * next tick), `blocked` (a human must decide). A programming error still throws.
 */
export async function runDeliveryLoop(deps: DeliveryLoopDeps): Promise<DeliveryLoopResult> {
  const { board, delivery, plan, hooks } = deps;
  const clock = deps.now ?? (() => Date.now());
  const steps: LoopStep[] = [];
  const record = (step: string, detail: string): void => {
    steps.push({ step, detail, at: new Date(clock()).toISOString() });
  };
  const maxRounds = plan.maxReviewRounds ?? 3;
  let rounds = 0;
  let pr: PullRequestRef | undefined;

  /** Move the item, tolerating a board that cannot express the target state. */
  const transition = async (to: BoardWorkItemState, note: string): Promise<void> => {
    await board.transition(plan.itemId, to, { runId: plan.runId, note });
    record('transition', `${plan.itemId} → ${to} (${note})`);
  };

  const writeRecord = async (reviewRound: number): Promise<void> => {
    const record_: BoardStateRecord = {
      schema: 1,
      runId: plan.runId,
      item: plan.itemId,
      reviewRound,
      updatedAt: new Date(clock()).toISOString(),
      baseBranch: plan.baseBranch,
      ...(pr === undefined ? {} : { deliveryRef: `#${pr.number}` }),
    };
    await board.writeState(plan.itemId, record_);
  };

  try {
    // --- 1. claim -------------------------------------------------------------
    const claim = await board.claim(plan.itemId, plan.runId);
    if (!claim.claimed) {
      record('claim', `refused: ${claim.reason ?? 'no reason given'}`);
      return { outcome: 'not_claimed', itemId: plan.itemId, rounds: 0, steps };
    }
    record('claim', `${plan.itemId} claimed by run ${plan.runId}`);
    await writeRecord(0);

    // --- 2. rounds of work → deliver → review ---------------------------------
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;

      await hooks.agent({ round, worktree: plan.worktree, branch: plan.branch });
      record('agent', `round ${round + 1} finished; expecting a commit in ${plan.worktree}`);

      const delivered = await delivery.deliver(
        {
          worktree: plan.worktree,
          branch: plan.branch,
          baseBranch: plan.baseBranch,
          ...(plan.remote === undefined ? {} : { remote: plan.remote }),
          itemId: plan.itemId,
          runId: plan.runId,
          ...(plan.title === undefined ? {} : { title: plan.title }),
          ...(plan.body === undefined ? {} : { body: plan.body }),
        },
        { baseSha: plan.baseSha },
      );
      pr = delivered.pr;
      record(
        'deliver',
        `round ${round + 1}: ${delivered.created ? 'opened' : 'reused'} PR #${pr.number} ` +
          `push=${delivered.push.mode} head=${pr.headSha.slice(0, 12)}` +
          (delivered.notes.length === 0 ? '' : ` (${delivered.notes.join('; ')})`),
      );
      // The item returns to review after every round: on the first one it enters
      // pr_open, and after a fix round it leaves fix_needed — without this move a
      // fixed delivery could never legally reach merged.
      const current = (await board.getWork(plan.itemId)).state;
      if (current === 'fix_needed' || (round === 0 && delivered.created)) {
        await transition('pr_open', `PR #${pr.number} ready for review${round === 0 ? '' : ` (round ${round + 1})`}`);
      }
      await writeRecord(round);

      // --- checks: a failure blocks, a pending waits, and neither is a success --
      const checks = await delivery.checks(pr);
      const failed = checks.filter((c) => c.conclusion === 'failure');
      const pending = checks.filter((c) => c.conclusion === 'pending');
      record('checks', checks.length === 0 ? 'none reported' : checks.map((c) => `${c.name}=${c.conclusion}`).join(' '));
      if (failed.length > 0) {
        // A failing check is work, not a verdict: the agent gets the remaining
        // rounds to fix it, and only an exhausted budget is a human decision.
        const detail = `check(s) failed: ${failed.map((c) => c.name).join(', ')}`;
        if (round + 1 >= maxRounds) {
          await transition('blocked', `${detail} and no fix round left`);
          return { outcome: 'blocked', itemId: plan.itemId, pr, rounds, steps, error: `${detail} and no fix round left` };
        }
        await transition('fix_needed', detail);
        continue;
      }
      if (pending.length > 0) {
        // Not a failure: the host has not finished. Another tick will read it again.
        return {
          outcome: 'retriable',
          itemId: plan.itemId,
          pr,
          rounds,
          steps,
          error: `check(s) still pending: ${pending.map((c) => c.name).join(', ')}`,
        };
      }

      // --- review: the only verdict that unlocks the merge ----------------------
      const changedFiles =
        hooks.changedFiles === undefined
          ? []
          : await hooks.changedFiles({ worktree: plan.worktree, baseSha: plan.baseSha });
      const review = await hooks.review({ round, pr, headSha: pr.headSha, changedFiles });
      record('review', `round ${round + 1}: ${review.verdict}${review.verdict === 'findings' && review.note ? ` — ${review.note}` : ''}`);

      if (review.verdict === 'findings') {
        if (round + 1 >= maxRounds) {
          const detail = `review found issues in ${maxRounds} consecutive rounds; a human must decide`;
          await transition('blocked', detail);
          return { outcome: 'blocked', itemId: plan.itemId, pr, rounds, steps, error: detail };
        }
        await transition('fix_needed', review.note ?? 'review findings');
        continue; // the next round's agent hook fixes them in the same worktree/PR
      }

      // --- merge EXACTLY the reviewed head -------------------------------------
      // Re-read first: if the branch moved after the review, the reviewed head is
      // no longer what would land, and merging would be merging unreviewed code.
      const status = await delivery.status(pr);
      if (status.headSha !== pr.headSha) {
        const detail = `the head moved after the review (reviewed ${pr.headSha.slice(0, 12)}, now ${status.headSha.slice(0, 12)}); re-review required`;
        await transition('fix_needed', detail);
        if (round + 1 >= maxRounds) {
          await transition('blocked', detail);
          return { outcome: 'blocked', itemId: plan.itemId, pr, rounds, steps, error: detail };
        }
        continue;
      }
      if (status.mergeable === null) {
        return {
          outcome: 'retriable',
          itemId: plan.itemId,
          pr,
          rounds,
          steps,
          error: 'mergeability is not known yet — an unknown is not a yes',
        };
      }

      const merged = await delivery.merge(pr, { expectedHeadSha: pr.headSha, method: 'merge' });
      record('merge', `PR #${pr.number} merged at ${merged.headSha.slice(0, 12)} (${merged.method})`);
      await transition('merged', `merged ${merged.headSha.slice(0, 8)}`);
      await board.comment(plan.itemId, `Delivered and merged: ${pr.url}`, { runId: plan.runId });
      return { outcome: 'merged', itemId: plan.itemId, pr, rounds, steps };
    }

    // The loop only reaches here when every round ended in `continue`.
    const detail = `no clean review after ${maxRounds} rounds`;
    await transition('blocked', detail);
    return { outcome: 'blocked', itemId: plan.itemId, pr, rounds, steps, error: detail };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Fail-fast classification, from the shared taxonomy: a transport failure is
    // worth another tick; anything else is a human decision.
    const retriable = e instanceof ProviderError && e.retriable;
    const kind = e instanceof ProviderError ? e.kind : 'unknown';
    record('failed', `${kind}: ${message}`);
    if (!retriable) {
      // Best effort: record the block even when the board itself was the failure.
      try {
        await transition('blocked', `${kind}: ${message}`);
      } catch {
        // The board is unreachable; the caller still sees the classification.
      }
    }
    return {
      outcome: retriable ? 'retriable' : 'blocked',
      itemId: plan.itemId,
      ...(pr === undefined ? {} : { pr }),
      rounds,
      steps,
      error: message,
    };
  }
}

/** Re-exported so a caller can branch on the delivery error family without a second import. */
export { DeliveryError };
