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
import { DeliveryError, type CheckSummary, type DeliveryProvider, type PullRequestRef } from './delivery.js';
import { createEventLog, nullEventLog, type EventLog } from './events.js';
import { ProviderError } from './provider-error.js';
import { acquireSlot, type SlotHandle } from './slot-lock.js';
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
  /**
   * How long to WAIT for the host's checks before giving up on them, in seconds.
   * Default 300.
   *
   * Checks are the slowest part of a delivery and the most common reason a run ends
   * "fine but not finished". Returning immediately left the item owned by a run that
   * would never come back; waiting inside the tick is what makes the common case
   * finish in one pass.
   */
  checksWaitSeconds?: number;
  /** Poll interval while waiting for checks. Default 15. */
  checksPollSeconds?: number;
  /**
   * Serialise this delivery against other runners (ADR-008).
   *
   * Every board here declares `atomicClaim: false`, so two runners sharing one
   * account can both believe they own an item. Passing a slot directory makes the
   * loop take an exclusive per-item lock before it claims anything and report
   * `busy` instead of racing. Omitting it keeps the old behaviour, and the caller
   * then owns that exclusion itself.
   */
  slot?: { dir: string; key?: string; staleAfterSeconds?: number };
}

export interface ReviewContext {
  round: number;
  pr: PullRequestRef;
  /** The exact head the review must cover — the only head that may later merge. */
  headSha: string;
  changedFiles: string[];
}

export type ReviewOutcome =
  | { verdict: 'clean' }
  | { verdict: 'findings'; note?: string }
  /**
   * The change is ready but a HUMAN has not approved it yet (orbi's human review).
   * Deliberately distinct from `findings`: waiting is not a defect, so it must not
   * consume a review round, must not move the item to `fix_needed`, and must not
   * merge. The item stays in review for a later tick.
   */
  | { verdict: 'awaiting-human'; note?: string };

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

export type DeliveryLoopOutcome = 'merged' | 'blocked' | 'retriable' | 'not_claimed' | 'busy' | 'awaiting_review';

export interface DeliveryLoopResult {
  outcome: DeliveryLoopOutcome;
  /** Seconds spent waiting for the host's checks, when the run had to wait at all. */
  checksWaitedSeconds?: number;
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
  /** Injectable sleep, so a test that waits for checks does not wait in real time. */
  sleep?: (seconds: number) => Promise<void>;
  /**
   * Where the run's events go (ADR-008). Omitting it keeps nothing, so wiring the
   * loop up never forces an audit trail on a caller that does not want one.
   */
  events?: EventLog;
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
  const events = deps.events ?? nullEventLog();
  const steps: LoopStep[] = [];
  const record = (step: string, detail: string): void => {
    steps.push({ step, detail, at: new Date(clock()).toISOString() });
  };
  const maxRounds = plan.maxReviewRounds ?? 3;
  const waitSeconds = plan.checksWaitSeconds ?? 300;
  let checksWaited = 0;
  const pollSeconds = plan.checksPollSeconds ?? 15;
  const sleep = deps.sleep ?? ((seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)));
  let rounds = 0;
  let pr: PullRequestRef | undefined;

  // The exclusion rail, before anything is claimed: every board here is
  // non-atomic, so a second runner must be turned away before it can believe it
  // owns the item. `busy` is an outcome, not an error — a scheduled runner
  // journals it and exits 0.
  let slot: SlotHandle | undefined;
  if (plan.slot !== undefined) {
    const acquisition = acquireSlot({
      dir: plan.slot.dir,
      key: plan.slot.key ?? plan.itemId,
      owner: { runId: plan.runId, itemId: plan.itemId },
      ...(plan.slot.staleAfterSeconds === undefined ? {} : { staleAfterSeconds: plan.slot.staleAfterSeconds }),
    });
    if (!acquisition.acquired || acquisition.handle === undefined) {
      const reason = acquisition.reason ?? 'another runner holds this slot';
      events.emit({ kind: 'slot.busy', runId: plan.runId, itemId: plan.itemId, message: reason });
      record('slot', `busy: ${reason}`);
      return { outcome: 'busy', itemId: plan.itemId, rounds: 0, steps, error: reason };
    }
    slot = acquisition.handle;
    slot.startHeartbeat();
    events.emit({
      kind: 'slot.acquired',
      runId: plan.runId,
      itemId: plan.itemId,
      message: `slot ${plan.slot.key ?? plan.itemId} acquired`,
      fields: { path: slot.path },
    });
    record('slot', `acquired ${slot.path}`);
  }

  /** Move the item, tolerating a board that cannot express the target state. */
  const transition = async (to: BoardWorkItemState, note: string): Promise<void> => {
    await board.transition(plan.itemId, to, { runId: plan.runId, note });
    events.emit({
      kind: to === 'blocked' ? 'board.blocked' : 'board.transitioned',
      runId: plan.runId,
      itemId: plan.itemId,
      ...(pr === undefined ? {} : { pr: pr.number }),
      message: `${plan.itemId} → ${to}`,
      fields: { note },
    });
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

  /**
   * Wait for the host's checks to settle, INSIDE the tick.
   *
   * Returns the seconds waited when no check is pending any more, or `null` when the
   * budget ran out. The loop is deliberately deterministic about time — elapsed is
   * counted in polls, not read from a clock — so a test drives it with an instant
   * sleep and gets the same answer the real thing would after `polls * pollSeconds`.
   */
  const waitForChecks = async (
    prRef: PullRequestRef,
  ): Promise<{ waitedSeconds: number; checks: CheckSummary[] } | null> => {
    for (let waited = 0; waited + pollSeconds <= waitSeconds; waited += pollSeconds) {
      await sleep(pollSeconds);
      const now = await delivery.checks(prRef);
      const stillPending = now.filter((c) => c.conclusion === 'pending');
      // The settled list is RETURNED, not re-read: the caller already has the answer,
      // and a second read would be one more API call for information we hold.
      if (stillPending.length === 0) {
        checksWaited += waited + pollSeconds;
        return { waitedSeconds: waited + pollSeconds, checks: now };
      }
      // Only the WAITING is reported here; the settlement is reported by the caller,
      // which is the one that knows which checks settled. Two emits for one fact is the
      // duplication the ledger already names.
      events.emit({
        kind: 'checks.waited',
        runId: plan.runId,
        itemId: plan.itemId,
        pr: prRef.number,
        message: `still pending after ${waited + pollSeconds}s: ${stillPending.map((c) => c.name).join(', ')}`,
        fields: { seconds: waited + pollSeconds, pending: stillPending.length },
      });
    }
    return null;
  };

  // Ownership matters in the failure path: an item WE claimed must never be left in a
  // state automation cannot pick up again (the pilot only ever selects `ready`).
  let owned = false;
  const run = async (): Promise<DeliveryLoopResult> => {
  try {
    // --- 1. claim -------------------------------------------------------------
    const claim = await board.claim(plan.itemId, plan.runId);
    if (!claim.claimed) {
      const reason = claim.reason ?? 'no reason given';
      events.emit({ kind: 'claim.refused', runId: plan.runId, itemId: plan.itemId, message: reason });
      record('claim', `refused: ${reason}`);
      return { outcome: 'not_claimed', itemId: plan.itemId, rounds: 0, steps };
    }
    owned = true;
    events.emit({ kind: 'claim.acquired', runId: plan.runId, itemId: plan.itemId, message: `${plan.itemId} claimed` });
    record('claim', `${plan.itemId} claimed by run ${plan.runId}`);
    await writeRecord(0);

    // --- 2. rounds of work → deliver → review ---------------------------------
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;

      events.emit({
        kind: 'agent.started',
        runId: plan.runId,
        itemId: plan.itemId,
        message: `round ${round + 1} starting`,
        fields: { worktree: plan.worktree },
      });
      await hooks.agent({ round, worktree: plan.worktree, branch: plan.branch });
      events.emit({
        kind: 'agent.finished',
        runId: plan.runId,
        itemId: plan.itemId,
        message: `round ${round + 1} finished; a commit is expected`,
      });
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
      events.emit({
        kind: 'deliver.pushed',
        runId: plan.runId,
        itemId: plan.itemId,
        pr: pr.number,
        message: `pushed ${delivered.push.mode} ${delivered.push.branch} at ${pr.headSha.slice(0, 12)}`,
        fields: { mode: delivered.push.mode, head: pr.headSha },
      });
      events.emit({
        kind: delivered.created ? 'deliver.pr_opened' : 'deliver.pr_reused',
        runId: plan.runId,
        itemId: plan.itemId,
        pr: pr.number,
        message: delivered.created ? `opened PR #${pr.number}` : `reused PR #${pr.number}`,
      });
      const current = (await board.getWork(plan.itemId)).state;
      if (current === 'fix_needed' || (round === 0 && delivered.created)) {
        await transition('pr_open', `PR #${pr.number} ready for review${round === 0 ? '' : ` (round ${round + 1})`}`);
      }
      await writeRecord(round);

      // --- checks: a failure blocks, a pending waits, and neither is a success --
      const checks = await delivery.checks(pr);
      const failed = checks.filter((c) => c.conclusion === 'failure');
      const pending = checks.filter((c) => c.conclusion === 'pending');
      events.emit({
        kind: 'checks.read',
        runId: plan.runId,
        itemId: plan.itemId,
        pr: pr.number,
        message: checks.length === 0 ? 'no checks reported' : checks.map((c) => `${c.name}=${c.conclusion}`).join(' '),
        fields: { total: checks.length, failed: failed.length, pending: pending.length },
      });
      for (const check of failed) {
        events.emit({
          kind: 'check.failed',
          runId: plan.runId,
          itemId: plan.itemId,
          pr: pr.number,
          message: `check ${check.name} failed`,
          fields: { check: check.name },
        });
      }
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
        // Not a failure: the host has not finished. Wait for it INSIDE this tick —
        // returning here used to leave the item owned by a run that never came back,
        // because the runner only ever selects `ready` items (the comment that used to
        // sit here claimed "another tick will read it again"; no tick ever did).
        const waited = await waitForChecks(pr);
        if (waited === null) {
          const detail = `check(s) still pending after ${waitSeconds}s: ${pending.map((c) => c.name).join(', ')}`;
          await transition('blocked', detail);
          return {
            outcome: 'blocked',
            itemId: plan.itemId,
            pr,
            rounds,
            steps,
            error: `${detail} — raise checksWaitSeconds or look at the pipeline`,
          };
        }
        // The waiting check finished: either it passed (the review path continues with
        // a re-read below) or it failed, and the failure branch is the same test.
        events.emit({
          kind: 'checks.waited',
          runId: plan.runId,
          itemId: plan.itemId,
          pr: pr.number,
          message: `checks settled after ${waited.waitedSeconds}s: ${waited.checks.map((c) => `${c.name}=${c.conclusion}`).join(' ')}`,
          fields: { seconds: waited.waitedSeconds },
        });
        record('checks', `waited ${waited.waitedSeconds}s for the host to settle the checks`);
        const nowFailed = waited.checks.filter((c) => c.conclusion === 'failure');
        if (nowFailed.length > 0) {
          const detail = `check(s) failed: ${nowFailed.map((c) => c.name).join(', ')}`;
          await writeRecord(round);
          if (round + 1 >= maxRounds) {
            await transition('blocked', `${detail} and no fix round left`);
            return { outcome: 'blocked', itemId: plan.itemId, pr, rounds, steps, error: `${detail} and no fix round left` };
          }
          await transition('fix_needed', detail);
          continue;
        }
      }

      // --- review: the only verdict that unlocks the merge ----------------------
      const changedFiles =
        hooks.changedFiles === undefined
          ? []
          : await hooks.changedFiles({ worktree: plan.worktree, baseSha: plan.baseSha });
      const review = await hooks.review({ round, pr, headSha: pr.headSha, changedFiles });
      if (review.verdict === 'awaiting-human') {
        events.emit({
          kind: 'review.awaiting_human',
          runId: plan.runId,
          itemId: plan.itemId,
          pr: pr.number,
          message: `round ${round + 1}: waiting for a human${review.note === undefined ? '' : ` — ${review.note}`}`,
          fields: { round, head: pr.headSha },
        });
        record('review', `round ${round + 1}: awaiting a human${review.note === undefined ? '' : ` — ${review.note}`}`);
        return {
          outcome: 'awaiting_review',
          itemId: plan.itemId,
          pr,
          rounds,
          steps,
          error: review.note ?? 'waiting for a human approval',
        };
      }
      events.emit({
        kind: review.verdict === 'clean' ? 'review.clean' : 'review.findings',
        runId: plan.runId,
        itemId: plan.itemId,
        pr: pr.number,
        message:
          review.verdict === 'clean'
            ? `round ${round + 1}: clean at ${pr.headSha.slice(0, 12)}`
            : `round ${round + 1}: findings${review.note === undefined ? '' : ` — ${review.note}`}`,
        fields: { round, head: pr.headSha },
      });
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
      events.emit({
        kind: 'merge.done',
        runId: plan.runId,
        itemId: plan.itemId,
        pr: pr.number,
        message: `PR #${pr.number} merged at ${merged.headSha.slice(0, 12)}`,
        fields: { method: merged.method, head: merged.headSha },
      });
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
    events.emit({
      kind: retriable ? 'run.retriable' : 'run.failed',
      runId: plan.runId,
      itemId: plan.itemId,
      ...(pr === undefined ? {} : { pr: pr.number }),
      message,
      fields: { kind, retriable },
    });
    record('failed', `${kind}: ${message}`);
    // AN ITEM WE OWN IS NEVER LEFT WHERE AUTOMATION CANNOT FIND IT AGAIN. The runner
    // only ever selects `ready` items, so a claim held by a run that has stopped is
    // invisible — not "waiting", not "retrying": invisible. A retriable failure we
    // cannot finish therefore blocks the item with the one instruction that resumes it.
    const resumeNote = `${kind}: ${message}`;
    if (!retriable || owned) {
      // Best effort: record the block even when the board itself was the failure.
      try {
        await transition(
          'blocked',
          retriable ? `${resumeNote} (retriable, but no runner can resume a held claim — move back to ready)` : resumeNote,
        );
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
  };

  try {
    const outcome = await run();
    // Reported as a FIELD, not parsed out of a step's text: a counter that depends on a
    // human-readable string breaking is a counter that silently goes to zero.
    return checksWaited === 0 ? outcome : { ...outcome, checksWaitedSeconds: checksWaited };
  } finally {
    // Released whatever happened: a crashed or failed delivery must not wedge the
    // slot until the stale window expires.
    if (slot !== undefined) {
      slot.release();
      events.emit({
        kind: 'slot.released',
        runId: plan.runId,
        itemId: plan.itemId,
        message: `slot ${plan.slot?.key ?? plan.itemId} released`,
      });
    }
  }
}

/** Re-exported so a caller can branch on the delivery error family without a second import. */
export { DeliveryError };
