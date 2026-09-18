/**
 * The task-board delivery state model — a PURE model, no I/O, no dependencies.
 *
 * Takumi's board layer distinguishes two kinds of state, and this module owns
 * exactly one of them:
 *
 * - DELIVERY state (this module): where a work item is in the delivery
 *   lifecycle. It lives on the external board the team already uses (an issue
 *   label, a GitLab label, a Jira status, a Notion select property), so the
 *   board stays the single source of truth for humans.
 * - EXECUTION evidence (ArtifactStore / traceability / events): what takumi
 *   actually did. Never a second copy of the delivery state.
 *
 * The transition table is explicit and small on purpose: an illegal
 * transition fails loudly instead of being silently "corrected", because a
 * board adapter that quietly rewrites state is worse than one that refuses.
 */

/** The six delivery states every board provider maps onto its own vocabulary. */
export type BoardWorkItemState =
  | 'ready'
  | 'claimed'
  | 'pr_open'
  | 'fix_needed'
  | 'merged'
  | 'blocked';

/** Every state, in lifecycle order (stable output for CLIs and reports). */
export const BOARD_WORK_ITEM_STATES: readonly BoardWorkItemState[] = [
  'ready',
  'claimed',
  'pr_open',
  'fix_needed',
  'merged',
  'blocked',
];

/** Terminal states: the automated transition table has no exit from them. */
export const BOARD_TERMINAL_STATES: readonly BoardWorkItemState[] = ['merged', 'blocked'];

/**
 * The allowed automated transitions.
 *
 * `merged` and `blocked` are terminal. A blocked item is released by a HUMAN
 * (they re-label it ready themselves) — takumi never auto-recovers a blocked
 * item, which is the whole point of a state a person owns.
 *
 * `pr_open → blocked` is deliberately present: a pull request can be open and
 * still reach a state no automation may decide from (the review round budget is
 * exhausted, the base branch was reconfigured, the host refuses to merge a
 * conflicting head). Without that edge such a delivery would have nowhere to go
 * and the caller would have to leave the item lying in `pr_open` forever, which
 * is how an unattended loop silently stalls.
 */
export const BOARD_TRANSITIONS: Readonly<Record<BoardWorkItemState, readonly BoardWorkItemState[]>> = {
  ready: ['claimed'],
  claimed: ['pr_open', 'blocked'],
  pr_open: ['merged', 'fix_needed', 'blocked'],
  fix_needed: ['pr_open', 'blocked'],
  merged: [],
  blocked: [],
};

/** Raised for an illegal delivery-state transition. Never swallowed silently. */
export class BoardStateError extends Error {
  readonly from: BoardWorkItemState;
  readonly to: BoardWorkItemState;

  constructor(from: BoardWorkItemState, to: BoardWorkItemState, detail?: string) {
    const allowed = BOARD_TRANSITIONS[from];
    const allowedText = allowed.length === 0 ? '(terminal — no automated exit)' : allowed.join(', ');
    super(
      `illegal board transition ${from} → ${to}: allowed from ${from}: ${allowedText}` +
        (detail ? ` (${detail})` : ''),
    );
    this.name = 'BoardStateError';
    this.from = from;
    this.to = to;
  }
}

/** True when the automated state machine allows `from → to`. */
export function canTransition(from: BoardWorkItemState, to: BoardWorkItemState): boolean {
  return BOARD_TRANSITIONS[from].includes(to);
}

/** Throw a {@link BoardStateError} unless the automated machine allows `from → to`. */
export function assertTransition(
  from: BoardWorkItemState,
  to: BoardWorkItemState,
  detail?: string,
): void {
  if (!canTransition(from, to)) {
    throw new BoardStateError(from, to, detail);
  }
}

/** True when the state is terminal (no automated transition leaves it). */
export function isTerminalState(state: BoardWorkItemState): boolean {
  return BOARD_TERMINAL_STATES.includes(state);
}

/** Type guard for untrusted strings coming from a board's own vocabulary. */
export function isBoardWorkItemState(value: unknown): value is BoardWorkItemState {
  return typeof value === 'string' && (BOARD_WORK_ITEM_STATES as readonly string[]).includes(value);
}
