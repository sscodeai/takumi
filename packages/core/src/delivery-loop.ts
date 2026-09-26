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
import {
  DeliveryError,
  deliveryRefFor,
  type CheckSummary,
  type DeliveryProvider,
  type PullRequestRef,
} from './delivery.js';
import { createEventLog, nullEventLog, type EventLog } from './events.js';
import { ProviderError } from './provider-error.js';
import { acquireSlot, type SlotHandle } from './slot-lock.js';
import type { TaskBoardProvider } from './task-board.js';
import type { BoardStateRecord } from './board-state-record.js';
import {
  REVIEWER_DETERMINISTIC_RULES,
  policyHash,
  reviewDigest,
  rulesetHash,
} from './review-digest.js';

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
   * The review policy this run is judged under (ADR-018). The loop binds its evidence to this: the
   * digest of a clean review covers the mode and the rule options, so an operator editing
   * `reviewMode` after a review makes the recorded evidence stale — and merging it is then refused
   * by name instead of proceeding quietly.
   */
  reviewMode?: 'checks-only' | 'label' | 'rules';
  approvalLabel?: string;
  reviewRules?: unknown;
  /**
   * File a work item when the checks stay red after every fix round. Default false.
   *
   * A red pipeline that nobody owns is how a repository rots: the item blocks, a comment
   * says why, and the failure never becomes anyone's task. Filing it (idempotently, so a
   * retried tick cannot duplicate it) turns the failure into work.
   */
  fileIssueOnExhaustedChecks?: boolean;
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
  /** How many times to re-read mergeability before it counts as unknown (default 5). */
  mergeabilityReads?: number;
  /** Seconds between mergeability re-reads (default 3). */
  mergeabilityReadSeconds?: number;
  /**
   * Rewrite the board's progress record at most this often when nothing material
   * changed, in seconds. Default 30. Every write is an API call against a host that
   * rate-limits, and a record that says the same thing twice is pure cost.
   */
  progressIntervalSeconds?: number;
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
  /** The review surface, when the delivery has one (a bare branch has none). */
  pr?: PullRequestRef;
  /** The exact head the review must cover — the only head that may later merge. */
  headSha: string;
  changedFiles: string[];
  /**
   * The worktree and the frozen base, so a reviewer can read the change itself.
   *
   * `changedFiles` alone is a list of names: enough to say "the CI config changed", not
   * enough to say "this test lost three assertions". A reviewer that has to reconstruct the
   * base from somewhere else is a reviewer with a second source of truth, so the loop hands
   * over the two things it already knows.
   */
  worktree: string;
  baseSha: string;
}

export type ReviewOutcome =
  /**
   * `clean` unlocks the merge. A NOTE is allowed on a clean verdict because an observation
   * is not a defect: "only the tests changed" belongs on the record, and forcing it into
   * `findings` would spend a fix round on work that may be exactly what the item asked for.
   */
  | { verdict: 'clean'; note?: string }
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
/** The review-relevant rule options a digest binds to. */
function rulesetOptions(reviewRules: unknown): { protectedPaths?: readonly string[] } {
  if (reviewRules === null || typeof reviewRules !== 'object') return {};
  const paths = (reviewRules as { protectedPaths?: unknown }).protectedPaths;
  return Array.isArray(paths) ? { protectedPaths: paths.filter((p): p is string => typeof p === 'string') } : {};
}

/**
 * Why the review on record cannot justify a merge — or null when it can.
 *
 * Fail-closed in both directions that matter: a delivery on record with NO digest is "unknown
 * provenance" (not "probably fine"), and a digest that no longer matches the run's inputs is stale.
 * Both mean re-review, which is cheap; merging something the review does not describe is not.
 */
export function staleReviewReason(
  onRecord: BoardStateRecord | null,
  current: BoardStateRecord['reviewed'],
  opts: { requiresApproval: boolean },
): string | null {
  if (current === undefined) {
    return 'this run has no review digest, which means the merge was reached without a clean review';
  }
  // Nothing was delivered before this run: there is no prior evidence to distrust.
  if (onRecord === null || onRecord.deliveryRef === undefined) return null;
  // Every merge is justified by the review THIS run performed, under the policy in force now — the
  // loop always reviews before it merges. So a digest on record is not grounds for refusal by
  // itself: an earlier tick may simply have ended in `fix_needed`, which writes no digest, and
  // refusing it would break the ordinary fix round. What the digest binds is the HUMAN's approval,
  // which is given in an earlier run and can name a head or a policy that no longer exists.
  if (!opts.requiresApproval) return null;
  if (onRecord.reviewed === undefined) {
    return 'this delivery needs a human approval, and there is no record of what was presented for it (the record predates digests, or was written elsewhere): re-review, then approve that version';
  }
  if (onRecord.reviewed.digest === current.digest) return null;
  const what: string[] = [];
  if (onRecord.reviewed.head !== current.head) what.push(`head ${onRecord.reviewed.head.slice(0, 12)} -> ${current.head.slice(0, 12)}`);
  if (onRecord.reviewed.base !== current.base) what.push('the base moved');
  if (onRecord.reviewed.policy !== current.policy) what.push('the review policy changed');
  if (onRecord.reviewed.ruleset !== current.ruleset) what.push('the rule set changed');
  if (onRecord.reviewed.reviewer !== current.reviewer) what.push('the reviewer changed');
  return `the review on record covers different inputs (${onRecord.reviewed.digest.slice(0, 12)} vs ${current.digest.slice(0, 12)}: ${what.join(', ') || 'unknown difference'})`;
}

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
  // A fresh merge request can answer "mergeability unknown" for a moment (GitLab computes it
  // asynchronously), and that moment is not a verdict. Bounded on purpose: the window is a
  // courtesy to an asynchronous host, not a license to wait forever for a yes.
  const mergeabilityReads = plan.mergeabilityReads ?? 5;
  const mergeabilityReadSeconds = plan.mergeabilityReadSeconds ?? 3;
  const sleep = deps.sleep ?? ((seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)));
  let rounds = 0;
  let pr: PullRequestRef | undefined;
  /**
   * The reference every delivery step works against: the pull request when the delivery has one
   * and the pushed branch when it does not. Port calls go through this, so a provider with no
   * review surface is never asked to invent one.
   */
  let ref: PullRequestRef | undefined;
  // The branch this run delivers on: the plan's branch until the delivery confirms it, and the
  // delivered branch afterwards (a resumed run adopts the branch it is finishing).
  let deliveredBranch: string | undefined;
  /**
   * What the clean review covered, on record (ADR-018). Set right after a clean verdict, carried in
   * the state record, and re-checked immediately before the merge: a review is evidence about ONE
   * set of inputs, and a merge is only allowed while the inputs still match it.
   */
  let reviewedBlock: BoardStateRecord['reviewed'];
  /** A human's approval, bound to the digest it approved (label mode). */
  let approvalBlock: BoardStateRecord['approval'];

  /**
   * What the board said BEFORE this run touched it (ADR-018).
   *
   * Read here rather than at merge time on purpose: this run overwrites the record as it goes (a
   * claim writes ownership, a delivery writes the branch and the review writes the digest), so a
   * digest compared against our own fresh write would always agree and would check nothing at all.
   * The question the check answers is "does the review that was already on record still describe
   * THIS run?", and only a read taken before we start can answer it.
   */
  const priorRecord = await board.readState(plan.itemId).catch(() => null);

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

  let lastProgressAt = 0;
  let lastProgressSignature = '';
  /**
   * The inputs a review covers. Computed in ONE place so that the version a human is asked to
   * approve and the version a later tick merges are compared with the same arithmetic — two
   * computations of "what was reviewed" is how a check passes while being wrong.
   */
  const reviewInputsFor = (head: string): NonNullable<BoardStateRecord['reviewed']> => {
    const policyDigest = policyHash({
      reviewMode: plan.reviewMode,
      approvalLabel: plan.approvalLabel,
      maxReviewRounds: plan.maxReviewRounds,
      reviewRules: plan.reviewRules,
    });
    const ruleDigest = rulesetHash(rulesetOptions(plan.reviewRules));
    return {
      digest: reviewDigest({
        head,
        base: plan.baseSha,
        policy: policyDigest,
        ruleset: ruleDigest,
        reviewer: REVIEWER_DETERMINISTIC_RULES,
      }),
      head,
      base: plan.baseSha,
      policy: policyDigest,
      ruleset: ruleDigest,
      reviewer: REVIEWER_DETERMINISTIC_RULES,
      at: new Date(clock()).toISOString(),
    };
  };

  const writeRecord = async (reviewRound: number, opts: { force?: boolean } = {}): Promise<void> => {
    const signature = `${plan.runId}|${reviewRound}|${pr === undefined ? '-' : pr.number}`;
    const nowMs = clock();
    const interval = (plan.progressIntervalSeconds ?? 30) * 1000;
    if (opts.force !== true && signature === lastProgressSignature && nowMs - lastProgressAt < interval) {
      // Nothing material changed and we wrote recently: the host does not need to hear
      // it twice. The FIRST write of a signature is never skipped, so the record on
      // the board always reflects the latest round.
      record('progress', `throttled (unchanged, ${Math.round((nowMs - lastProgressAt) / 1000)}s since the last write)`);
      return;
    }
    lastProgressAt = nowMs;
    lastProgressSignature = signature;
    const record_: BoardStateRecord = {
      schema: 1,
      runId: plan.runId,
      item: plan.itemId,
      reviewRound,
      updatedAt: new Date(clock()).toISOString(),
      baseBranch: plan.baseBranch,
      ...(pr === undefined ? {} : { deliveryRef: `#${pr.number}` }),
      branch: deliveredBranch ?? plan.branch,
      ...(reviewedBlock === undefined ? {} : { reviewed: reviewedBlock }),
      ...(approvalBlock === undefined ? {} : { approval: approvalBlock }),
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
    roundRef: number,
  ): Promise<{ waitedSeconds: number; checks: CheckSummary[] } | null> => {
    for (let waited = 0; waited + pollSeconds <= waitSeconds; waited += pollSeconds) {
      await sleep(pollSeconds);
      const now = await delivery.checks(prRef);
      const stillPending = now.filter((c) => c.conclusion === 'pending');
      // A human watching the board should see that we are still here. The throttle in
      // `writeRecord` is what keeps that from being one API call per poll — this is the
      // churn the throttle exists for, so the two are tested together.
      await writeRecord(roundRef);
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
  /**
   * Block the item AND file the failure as work — best effort, like the event trail.
   *
   * The rule from ADR-008 applies to this too: a side channel must never change the
   * delivery's conclusion. A board that cannot file, or a filing that fails, leaves the
   * item blocked with the reason in the step timeline; it does not fail the run, and it
   * does not quietly succeed either.
   */
  const blockOnRedChecks = async (detail: string, failing: readonly CheckSummary[]): Promise<DeliveryLoopResult> => {
    await transition('blocked', detail);
    if (plan.fileIssueOnExhaustedChecks !== true) return { outcome: 'blocked', itemId: plan.itemId, pr, rounds, steps, error: detail };

    if (!board.capabilities().canCreateWork) {
      events.emit({
        kind: 'issue.skipped',
        runId: plan.runId,
        itemId: plan.itemId,
        ...(pr === undefined ? {} : { pr: pr.number }),
        message: 'fileIssueOnExhaustedChecks is on, but this board cannot file work items',
      });
      record('issue', 'not filed: this board declares canCreateWork=false');
      return { outcome: 'blocked', itemId: plan.itemId, ...(pr === undefined ? {} : { pr }), rounds, steps, error: detail };
    }

    const names = failing.map((c) => c.name).join(', ');
    // The key is derived from the ITEM and the DELIVERY, not from the clock or the run:
    // that is what makes the second attempt return the first issue instead of a copy.
    const key = `ci-red:${plan.itemId}:${pr?.number ?? 'none'}`;
    try {
      const filed = await board.createWork({
        title: `CI is red: ${plan.itemId}${names.length === 0 ? '' : ` (${names})`}`,
        body:
          `${detail}\n\n` +
          `${pr === undefined ? 'No pull request was opened.' : `Pull request: ${pr.url}`}\n` +
          `Failing checks: ${names.length === 0 ? '(none named)' : names}\n` +
          `Detected by run ${plan.runId}. Filed so the failure becomes work instead of a comment.`,
        state: 'ready',
        idempotencyKey: key,
      });
      events.emit({
        kind: 'issue.filed',
        runId: plan.runId,
        itemId: plan.itemId,
        ...(pr === undefined ? {} : { pr: pr.number }),
        message: filed.created ? `filed ${filed.item.id}: CI is red` : `${filed.item.id} already filed for this delivery`,
        fields: { key, created: filed.created },
      });
      record('issue', filed.created ? `filed ${filed.item.id} for the red checks` : `already filed as ${filed.item.id}`);
    } catch (e) {
      events.emit({
        kind: 'issue.skipped',
        runId: plan.runId,
        itemId: plan.itemId,
        ...(pr === undefined ? {} : { pr: pr.number }),
        message: `could not file the failure: ${e instanceof Error ? e.message : String(e)}`,
        fields: { key },
      });
      record('issue', `not filed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { outcome: 'blocked', itemId: plan.itemId, pr, rounds, steps, error: detail };
  };

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
      ref = deliveryRefFor(delivered, plan.baseSha);
      // Narrowed once for the rest of this round: every delivery step below works against the
      // reference (the pull request, or the pushed branch when the delivery has no review surface).
      const thisRef: PullRequestRef = ref;
      deliveredBranch = delivered.push.branch;
      record(
        'deliver',
        `round ${round + 1}: ${
          pr === undefined ? 'pushed' : delivered.created ? 'opened' : 'reused'
        } ${pr === undefined ? delivered.push.branch : `PR #${pr.number}`} ` +
          `push=${delivered.push.mode} head=${ref.headSha.slice(0, 12)}` +
          (delivered.notes.length === 0 ? '' : ` (${delivered.notes.join('; ')})`),
      );
      // The item returns to review after every round: on the first one it enters
      // pr_open, and after a fix round it leaves fix_needed — without this move a
      // fixed delivery could never legally reach merged.
      events.emit({
        kind: 'deliver.pushed',
        runId: plan.runId,
        itemId: plan.itemId,
        ...(pr === undefined ? {} : { pr: pr.number }),
        message: `pushed ${delivered.push.mode} ${delivered.push.branch} at ${ref.headSha.slice(0, 12)}`,
        fields: { mode: delivered.push.mode, head: thisRef.headSha },
      });
      // A delivery with no review surface has no pull request to announce: emitting an event that
      // claims one would put a pull request in the trail that does not exist.
      if (pr !== undefined) {
        events.emit({
          kind: delivered.created ? 'deliver.pr_opened' : 'deliver.pr_reused',
          runId: plan.runId,
          itemId: plan.itemId,
          pr: pr.number,
          message: delivered.created ? `opened PR #${pr.number}` : `reused PR #${pr.number}`,
        });
      }
      // After delivering, the item is DELIVERED AND UNDER REVIEW — the state must say so.
      // Reading it off `delivered.created` instead was wrong for a REUSED delivery in round 0: a
      // resumed delivery (its branch and pull request already exist) would stay in `claimed`, and
      // `claimed → merged` is not a legal move — so finishing an interrupted delivery blocked on
      // the state machine rather than on anything real.
      const current = (await board.getWork(plan.itemId)).state;
      if (current !== 'pr_open') {
        await transition(
          'pr_open',
          pr === undefined
            ? `branch ${delivered.push.branch} pushed for review${round === 0 ? '' : ` (round ${round + 1})`}`
            : `PR #${pr.number} ready for review${round === 0 ? '' : ` (round ${round + 1})`}`,
        );
      }
      await writeRecord(round);

      // --- checks: a failure blocks, a pending waits, and neither is a success --
      const checks = await delivery.checks(thisRef);
      const failed = checks.filter((c) => c.conclusion === 'failure');
      const pending = checks.filter((c) => c.conclusion === 'pending');
      events.emit({
        kind: 'checks.read',
        runId: plan.runId,
        itemId: plan.itemId,
        ...(pr === undefined ? {} : { pr: pr.number }),
        message: checks.length === 0 ? 'no checks reported' : checks.map((c) => `${c.name}=${c.conclusion}`).join(' '),
        fields: { total: checks.length, failed: failed.length, pending: pending.length },
      });
      for (const check of failed) {
        events.emit({
          kind: 'check.failed',
          runId: plan.runId,
          itemId: plan.itemId,
          ...(pr === undefined ? {} : { pr: pr.number }),
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
          return await blockOnRedChecks(`${detail} and no fix round left`, failed);
        }
        await transition('fix_needed', detail);
        continue;
      }
      if (pending.length > 0) {
        // Not a failure: the host has not finished. Wait for it INSIDE this tick —
        // returning here used to leave the item owned by a run that never came back,
        // because the runner only ever selects `ready` items (the comment that used to
        // sit here claimed "another tick will read it again"; no tick ever did).
        const waited = await waitForChecks(thisRef, round);
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
          ...(pr === undefined ? {} : { pr: pr.number }),
          message: `checks settled after ${waited.waitedSeconds}s: ${waited.checks.map((c) => `${c.name}=${c.conclusion}`).join(' ')}`,
          fields: { seconds: waited.waitedSeconds },
        });
        record('checks', `waited ${waited.waitedSeconds}s for the host to settle the checks`);
        const nowFailed = waited.checks.filter((c) => c.conclusion === 'failure');
        if (nowFailed.length > 0) {
          const detail = `check(s) failed: ${nowFailed.map((c) => c.name).join(', ')}`;
          await writeRecord(round);
          if (round + 1 >= maxRounds) {
            return await blockOnRedChecks(`${detail} and no fix round left`, nowFailed);
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
      // The reviewer works against the delivered HEAD; the pull request, when there is one, is
      // context it may use (the rules reviewer reads the diff instead, which is why a delivery
      // with no review surface can still be reviewed).
      const review = await hooks.review({
        round,
        ...(pr === undefined ? {} : { pr }),
        headSha: thisRef.headSha,
        changedFiles,
        worktree: plan.worktree,
        baseSha: plan.baseSha,
      });
      if (review.verdict === 'awaiting-human') {
        events.emit({
          kind: 'review.awaiting_human',
          runId: plan.runId,
          itemId: plan.itemId,
          ...(pr === undefined ? {} : { pr: pr.number }),
          message: `round ${round + 1}: waiting for a human${review.note === undefined ? '' : ` — ${review.note}`}`,
          fields: { round, head: thisRef.headSha },
        });
        // The version being PRESENTED for approval is recorded now. The approval a human gives
        // names this version, and a later tick compares its own digest against it — so an approval
        // can never be carried onto a head or a policy the human never saw, which is the only
        // thing a review digest is really protecting (every merge is backed by a review this run
        // just performed; a human's judgement is not).
        reviewedBlock = reviewInputsFor(thisRef.headSha);
        await writeRecord(round, { force: true });
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
        ...(pr === undefined ? {} : { pr: pr.number }),
        message:
          review.verdict === 'clean'
            ? // A note on a clean verdict is an observation ("only the tests changed"), and
              // dropping it here would lose the one place a human would have seen it.
              `round ${round + 1}: clean at ${thisRef.headSha.slice(0, 12)}${review.note === undefined ? '' : ` — note: ${review.note}`}`
            : `round ${round + 1}: findings${review.note === undefined ? '' : ` — ${review.note}`}`,
        fields: { round, head: thisRef.headSha },
      });
      record('review', `round ${round + 1}: ${review.verdict}${review.note ? ` — ${review.note}` : ''}`);

      if (review.verdict === 'findings') {
        if (round + 1 >= maxRounds) {
          const detail = `review found issues in ${maxRounds} consecutive rounds; a human must decide`;
          await transition('blocked', detail);
          return { outcome: 'blocked', itemId: plan.itemId, ...(pr === undefined ? {} : { pr }), rounds, steps, error: detail };
        }
        await transition('fix_needed', review.note ?? 'review findings');
        continue; // the next round's agent hook fixes them in the same worktree/PR
      }

      // --- what this review is evidence ABOUT (ADR-018) ------------------------
      // A clean review covers ONE set of inputs: that head, off that base, by that reviewer, under
      // that policy and rule set. So it is bound to a digest here, carried in the state record, and
      // RE-CHECKED immediately below — because the case that happens is a tick interrupted at
      // exactly this point with `reviewMode` edited before the next one. Without the digest, the
      // next tick (resuming, which is what resuming is for) would merge the OLD review under the
      // NEW policy, and nothing anywhere would say so.
      reviewedBlock = reviewInputsFor(thisRef.headSha);
      if (plan.reviewMode === 'label') {
        // A label says somebody approved; on most boards it does not say WHO. The identity is
        // recorded as null rather than invented, and the label is kept as the reference.
        approvalBlock = {
          by: null,
          at: new Date(clock()).toISOString(),
          digest: reviewedBlock.digest,
          ref: plan.approvalLabel ?? '',
          note: 'the board reported the approval label; a label carries no author on this board',
        };
      }
      // FORCED: the throttled write above is right for progress, and wrong for evidence. The digest
      // has to be on the board before the merge reads it back, or the read would see the previous
      // write and refuse a merge that is actually fine.
      await writeRecord(round, { force: true });

      const stale = staleReviewReason(priorRecord, reviewedBlock, {
        requiresApproval: plan.reviewMode === 'label',
      });
      if (stale !== null) {
        events.emit({
          kind: 'review.stale',
          runId: plan.runId,
          itemId: plan.itemId,
          ...(pr === undefined ? {} : { pr: pr.number }),
          message: `refusing to merge: ${stale}`,
          fields: {
            head: thisRef.headSha,
            digest: reviewedBlock.digest,
            recorded: priorRecord?.reviewed?.digest ?? null,
          },
        });
        const detail = `refusing to merge: ${stale}`;
        await transition('blocked', detail);
        return { outcome: 'blocked', itemId: plan.itemId, ...(pr === undefined ? {} : { pr }), rounds, steps, error: detail };
      }

      // --- merge EXACTLY the reviewed head -------------------------------------
      // Re-read first: if the branch moved after the review, the reviewed head is
      // no longer what would land, and merging would be merging unreviewed code.
      // GitLab computes mergeability ASYNCHRONOUSLY: a merge request that was just opened
      // legitimately answers "unknown" for a moment, and reading that as a verdict stranded a
      // real item in `pr_open` — where no later tick would look at it again, because the pilot
      // selects `ready` work. So the unknown is given a BOUNDED window to become an answer.
      //
      // It is still never read as a yes: once the window is spent the item is handed on as
      // `retriable` exactly as before, only later, and the message says how long we looked.
      // The head is re-read on every attempt, because a head that moves is a decision rather
      // than a transient — it ends the window and falls through to the check below.
      let status = await delivery.status(thisRef);
      for (
        let attempt = 1;
        attempt < mergeabilityReads && status.mergeable === null;
        attempt += 1
      ) {
        await sleep(mergeabilityReadSeconds);
        status = await delivery.status(thisRef);
        if (status.headSha !== thisRef.headSha) break;
        events.emit({
          kind: 'merge.mergeability_waited',
          runId: plan.runId,
          itemId: plan.itemId,
          ...(pr === undefined ? {} : { pr: pr.number }),
          message: `mergeability still unknown after ${attempt * mergeabilityReadSeconds}s (attempt ${attempt + 1}/${mergeabilityReads})`,
          fields: { attempt: attempt + 1, reads: mergeabilityReads },
        });
      }
      if (status.headSha !== thisRef.headSha) {
        const detail = `the head moved after the review (reviewed ${thisRef.headSha.slice(0, 12)}, now ${status.headSha.slice(0, 12)}); re-review required`;
        await transition('fix_needed', detail);
        if (round + 1 >= maxRounds) {
          await transition('blocked', detail);
          return { outcome: 'blocked', itemId: plan.itemId, ...(pr === undefined ? {} : { pr }), rounds, steps, error: detail };
        }
        continue;
      }
      if (status.mergeable === null) {
        // BLOCKED, not `retriable`. The window above already gave the host its chance, and
        // nothing re-selects an item left in `pr_open`: returning `retriable` would strand the
        // item exactly the way the pending-checks budget refuses to (see the note on that
        // path). A block is visible — the watchdog reports it, a human sees it — and the
        // message carries the way back, which the claim rule now actually honours.
        const detail = `mergeability is still unknown after ${mergeabilityReads} reads over ${(mergeabilityReads - 1) * mergeabilityReadSeconds}s — an unknown is not a yes`;
        await transition('blocked', detail);
        await board.comment(
          plan.itemId,
          `Could not merge: ${detail}. The branch and merge request are untouched — move the item back to \`ready\` to have a runner finish the delivery.`,
          { runId: plan.runId },
        );
        return { outcome: 'blocked', itemId: plan.itemId, ...(pr === undefined ? {} : { pr }), rounds, steps, error: detail };
      }

      // One name for the thing that was merged, so the trail reads the same for a pull request
      // and for a bare branch.
      const what = pr === undefined ? `branch ${delivered.push.branch}` : `PR #${pr.number}`;
      const merged = await delivery.merge(thisRef, { expectedHeadSha: thisRef.headSha, method: 'merge' });
      events.emit({
        kind: 'merge.done',
        runId: plan.runId,
        itemId: plan.itemId,
        ...(pr === undefined ? {} : { pr: pr.number }),
        message: `${what} merged at ${merged.headSha.slice(0, 12)}`,
        fields: { method: merged.method, head: merged.headSha },
      });
      record('merge', `${what} merged at ${merged.headSha.slice(0, 12)} (${merged.method})`);
      await transition('merged', `merged ${merged.headSha.slice(0, 8)}`);
      await board.comment(
        plan.itemId,
        pr === undefined
          ? `Delivered and merged onto the base branch: branch ${delivered.push.branch}, commit ${merged.headSha} (this delivery has no review surface).`
          : `Delivered and merged: ${pr.url}`,
        { runId: plan.runId },
      );
      return {
        outcome: 'merged',
        itemId: plan.itemId,
        ...(pr === undefined ? {} : { pr }),
        rounds,
        steps,
      };
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
