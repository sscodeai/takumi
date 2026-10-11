/**
 * The board-projection port (ADR-044): where a black-box run writes its progress for a HUMAN to read.
 *
 * WHY THIS IS ITS OWN PORT, and not `ctx.board: TaskBoardProvider`
 *
 * The task-board port (ADR-006) is how a run FINDS and CLAIMS work: list, get, claim, transition,
 * the state record. A black-box run has no such board — its work comes from a confirmed requirement
 * DOCUMENT, not from a board item — so handing it a `TaskBoardProvider` would be handing it a
 * capability it must not use, on a host it must not read.
 *
 * What the operator actually wants is the other direction: one row in the board people already look
 * at, saying "this delivery exists, its pipeline went green (or red), this commit merged". That is a
 * WRITE-ONLY projection, so this port is write-only by construction: no read, no claim, no state
 * record, no comment. A port with no read cannot be used to make a decision, which is the rule
 * ADR-017 rule 1 states for mirrors ("control flow only follows trusted authors").
 *
 * INJECTED, NEVER DISCOVERED — the same rule as `ctx.delivery` (ADR-037). The engine has no default
 * board and no board configuration of its own; the caller (the CLI, a test) hands one in. A run with
 * no board port projects nowhere, and that is not an error: the projection is for readers, and a run
 * nobody is watching is still a run.
 *
 * ONE DELIVERY = ONE ROW, keyed by the RUN ID. A re-run of the same workflow UPDATES the row it wrote
 * before; it never files a second one. The run id is the identity, and `project` MUST be idempotent
 * on it.
 *
 * THE VOCABULARY IS THE BOARD'S, NOT OURS. The states are takumi's own six, because the operator's
 * board already carries those option names — a port that invented its own words would make an
 * operator add columns for a vocabulary that exists to be read. The MAPPING a run uses (which is not
 * this port's business, but is worth stating where the types are):
 *
 *   publish       -> `claimed`      a run owns this delivery; the pull request is open, no pipeline read yet
 *   await_checks  -> `pr_open`      every check green (+ the board's own `takumi-approved` label)
 *                 -> `fix_needed`   a check failed or timed out (+ the board's `takumi-blocked` label)
 *   merge         -> `merged`       the reviewed head landed (+ `takumi-merged`), the SHA in the detail
 *
 * FAILURE POLICY (ADR-017 rule 2, kept exactly): a projection failure is LOUD and NEVER FATAL. The
 * delivery was accepted by the pipeline, the judge and the host; a decorative board must not be able
 * to un-accept it. The caller reports the failure in the step's own summary, so a reader of the run
 * knows the board is stale — and never has to guess whether it was written.
 */

import type { BoardWorkItemState } from './board-state.js';

/** The state of a delivery row, in the vocabulary the operator's board already carries. */
export type DeliveryBoardState = BoardWorkItemState;

/**
 * The verdict labels the operator's board already carries, defined ONCE.
 *
 * The engine writes these and an adapter must be able to recognise them, so a second literal on either
 * side would drift the day one of them was renamed — and a drifted label is invisible: the row still
 * looks labelled, it just stops matching the filter the operator built. The strings are the board's,
 * not takumi's invention: the operator added these options because they read them.
 */
export const DELIVERY_BOARD_LABELS = {
  /** Every check on the delivered head went green. */
  approved: 'takumi-approved',
  /** A check failed or timed out — the delivery needs a human (or a repair) before it can land. */
  blocked: 'takumi-blocked',
  /** The reviewed head landed on the base branch. */
  merged: 'takumi-merged',
} as const;

/**
 * The state a delivery row takes as each delivery step moves it — the mapping, in one place.
 *
 * This is the MAPPING the port's own doc states, made executable so the engine and a reader cannot
 * disagree about it. It is deliberately NOT part of {@link DeliveryBoardPort}: the port is a seam a
 * board implements, and a board must not be handed a vocabulary it would then have to translate back.
 */
export const DELIVERY_BOARD_STEP_STATES = {
  /** `publish` — a run owns this delivery; the pull request is open, no pipeline read yet. */
  publish: 'claimed',
  /** `await_checks`, every check green. */
  green: 'pr_open',
  /** `await_checks`, a check failed or timed out. */
  red: 'fix_needed',
  /** `merge` — the reviewed head landed. */
  merged: 'merged',
} as const satisfies Record<string, DeliveryBoardState>;

/** What a run tells the board about one delivery. */
export interface DeliveryBoardProjection {
  /** The end-to-end correlation id of the run — the row's identity. One delivery = one row. */
  runId: string;
  /** The row's title (the confirmed requirement's ref, or the workflow's name). */
  title: string;
  /** Where the delivery stands, in the board's own state vocabulary. */
  state: DeliveryBoardState;
  /**
   * The verdict labels this board already uses (`takumi-approved`, `takumi-blocked`, `takumi-merged`).
   * ADDITIVE: an implementation must not clear a label an earlier step set — the row accumulates the
   * verdicts of the steps that moved it, which is what makes a single row readable as a history.
   */
  labels?: string[];
  /**
   * A reader-facing line for the row's machine property: which step moved it, the pull request, the
   * merged commit. Free text on purpose — it is what a person reads, and it is also what makes a
   * merged SHA auditable from the board itself rather than only from the run's artifacts.
   */
  detail?: string;
}

/** What the board answered: the row it wrote, and whether this call created it. */
export interface DeliveryBoardRef {
  /** The board's own identity for the row (a Notion page id, a Jira key, …). */
  id: string;
  /** A URL a person can open, when the board has one. */
  url: string;
  /** True when this call filed the row; false when it updated the row already there. */
  created: boolean;
}

export interface DeliveryBoardMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
}

export interface DeliveryBoardPort {
  metadata(): DeliveryBoardMetadata;

  /**
   * Find the row for `input.runId` and set its title, state, labels and detail — creating it when it
   * is absent.
   *
   * MUST NOT file a second row for the same run. MUST FAIL (never silently drop, never quietly narrow
   * what was asked for) when it cannot write: the caller reports it, and the caller's run is
   * unaffected — a projection failure is loud, not fatal.
   */
  project(input: DeliveryBoardProjection): Promise<DeliveryBoardRef>;
}
