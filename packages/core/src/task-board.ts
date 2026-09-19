/**
 * The single contract every task-board adapter implements (ADR-006).
 *
 * Symmetric to `AgentRuntimeAdapter` (ADR-002) on purpose: takumi already
 * proves that orchestration must not learn a harness's internals, and the same
 * argument holds for WHERE THE WORK COMES FROM. Core owns the lifecycle; an
 * adapter owns one board's vocabulary, API quirks and auth.
 *
 * State ownership, stated once (ADR-006):
 *   - the BOARD owns the DELIVERY state (labels / status / select property),
 *     because humans read and change it there;
 *   - takumi owns the EXECUTION evidence (runs, artifacts, traceability);
 *   - the only resumable facts takumi writes back to the board are the
 *     versioned state record (see `board-state-record.ts`) — never a second
 *     copy of the whole run.
 *
 * Two things a board cannot all do, so the port declares them instead of
 * pretending (capability negotiation, fail-closed):
 *   - running checks / opening a pull request / merging → `delivery.*`. A
 *     Notion database has no idea what a pull request is, and the adapter must
 *     say so rather than silently degrade.
 *   - atomically claiming an item → `atomicClaim`. GitHub label updates are
 *     not transactional either, but the provider can at least detect the race;
 *     a board that cannot must report `atomicClaim: false` and the suite checks
 *     the weaker (still non-silent) guarantee.
 */

import {
  BOARD_WORK_ITEM_STATES,
  BoardStateError,
  isBoardWorkItemState,
  type BoardWorkItemState,
} from './board-state.js';
import type { BoardStateRecord } from './board-state-record.js';
import { ProviderError, type ProviderErrorKind } from './provider-error.js';

export type { BoardWorkItemState };
export type { BoardStateRecord };


/** Static identity of a board adapter. */
export interface BoardProviderMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
}

/** What the provider can do on the DELIVERY side (a board may do none of it). */
export interface BoardDeliveryCapabilities {
  canOpenPullRequest: boolean;
  canRunChecks: boolean;
  canMerge: boolean;
}

/** What the provider can do at all. Adapters must declare honestly. */
export interface BoardCapabilities {
  /** The delivery states this board can represent. */
  states: BoardWorkItemState[];
  /** Item-level comments are supported. */
  comments: boolean;
  /** An existing comment can be edited in place (one progress comment per run). */
  editableComment: boolean;
  /** Comment authors carry a trust signal the adapter can filter on. */
  trustedAuthorFilter: boolean;
  /** A versioned machine-readable state record can be stored out-of-band. */
  machineReadableState: boolean;
  /** `claim` is decided by the provider itself (not read-then-write by us). */
  atomicClaim: boolean;
  /**
   * The adapter can CREATE the states it needs (labels, statuses) rather than only
   * reporting them. False is honest and common: a Jira workflow and a Redmine
   * installation keep their statuses in administration, out of the API's reach.
   * `bootstrapStates()` reports either way.
   */
  canBootstrapStates: boolean;
  /**
   * The adapter can FILE a new item. False is honest for a board whose API cannot, and
   * a caller that needs to file something must check this rather than assume: a failure
   * that cannot be filed is a failure a human has to read somewhere else.
   */
  canCreateWork: boolean;
  delivery: BoardDeliveryCapabilities;
}

/**
 * What is needed to file a new work item.
 *
 * `idempotencyKey` is not optional in spirit: no board here offers a native idempotency
 * guarantee, so the key is written into the item as a machine-readable marker and looked
 * for BEFORE creating. Without it, a retried tick files a second issue for the same
 * failure — which is how a board fills with duplicates nobody dares close.
 */
export interface BoardWorkItemSpec {
  title: string;
  body?: string;
  /** Extra labels, if the board has labels. The state label comes from `state`. */
  labels?: string[];
  /** The state the new item starts in. Default `ready`. */
  state?: BoardWorkItemState;
  /** Makes a repeated create for the same reason return the FIRST item, not a second. */
  idempotencyKey?: string;
}

/** What `createWork` did, and the item either way. */
export interface CreateWorkResult {
  item: BoardWorkItem;
  /** False when the idempotency key was already on the board. */
  created: boolean;
}

/** One state's outcome in a bootstrap report. */
export interface BoardBootstrapAction {
  state: BoardWorkItemState;
  /** What this board calls the state: label name, status name, property option. */
  name: string;
  /**
   * `exists` (already there), `created` (this call made it), `would-create` (a dry
   * run), or `not-creatable` (the operator must do it — see `instruction`).
   */
  outcome: 'exists' | 'created' | 'would-create' | 'not-creatable';
  /** For `not-creatable`: exactly what a human must do, with no hand-waving. */
  instruction?: string;
}

/**
 * What a board was missing, and what was done about it.
 *
 * This is the answer to the first minute of a real deployment: the adapter cannot
 * claim work until the board can express the six states, and a runner that fails
 * with "no such label" teaches nothing. The report names every state, says which
 * are missing, and — when the adapter cannot create them — tells the operator the
 * exact administrative step.
 */
export interface BoardBootstrapReport {
  provider: string;
  /** True when this call changed the board (a dry run never does). */
  applied: boolean;
  actions: BoardBootstrapAction[];
  /** States this board cannot express at all (the complement of `capabilities().states`). */
  unsupported: BoardWorkItemState[];
}

/** One unit of work as the board sees it. */
export interface BoardWorkItem {
  /** Provider-stable id (GitHub/GitLab issue number as string, Jira key, Notion page id). */
  id: string;
  title: string;
  body: string;
  url: string;
  state: BoardWorkItemState;
  labels: string[];
  assignees: string[];
  /** ISO-8601 timestamp from the provider. */
  updatedAt: string;
  /** Adapter-native payload, for debugging and adapter-specific tooling. */
  raw?: unknown;
}

/** Query for {@link TaskBoardProvider.listWork}. */
export interface BoardWorkQuery {
  states?: readonly BoardWorkItemState[];
  labels?: readonly string[];
  limit?: number;
}

/** Identity of an item comment, returned by `comment()` and used by `updateComment()`. */
export interface BoardCommentRef {
  item: string;
  comment: string;
  runId: string;
  url?: string;
}

/** Who wrote something. `trusted` is the board's own verdict (association/role). */
export interface BoardCommentAuthor {
  login: string;
  trusted: boolean;
}

/** Outcome of a claim attempt. `claimed: false` is a legitimate, non-silent answer. */
export interface ClaimResult {
  item: string;
  runId: string;
  claimed: boolean;
  /** Why the claim was refused (already claimed, closed, blocked, ...). */
  reason?: string;
}

/** Evidence attached to a state transition. */
export interface BoardTransitionEvidence {
  runId: string;
  note?: string;
}

/**
 * Error taxonomy: every adapter failure is classified, none is a bare Error.
 *
 * The kinds are shared with the delivery port (`provider-error.ts`) so a caller
 * can react to `auth` / `precondition` / `unsupported` identically whichever
 * provider produced the failure.
 */
export type BoardErrorKind = ProviderErrorKind;

/** A classified board failure. `transport` is retriable next tick; the rest are not. */
export class BoardError extends ProviderError {
  constructor(kind: BoardErrorKind, message: string, opts?: { item?: string; cause?: unknown }) {
    super(kind, message, opts);
    this.name = 'BoardError';
  }
}

/** A capability-gated operation was attempted on a provider that lacks it. */
export class BoardUnsupportedError extends BoardError {
  readonly capability: string;

  constructor(capability: string, providerId: string, detail?: string) {
    super(
      'unsupported',
      `provider ${providerId} does not support ${capability}` + (detail ? `: ${detail}` : ''),
    );
    this.name = 'BoardUnsupportedError';
    this.capability = capability;
  }
}

/** The port. Every task-board adapter implements exactly this. */
export interface TaskBoardProvider {
  /** Static identity of this adapter. */
  metadata(): BoardProviderMetadata;

  /** Declared capabilities; a caller validates against these BEFORE acting. */
  capabilities(): BoardCapabilities;

  /** List work items the board considers available (the provider's own filter scope). */
  listWork(query?: BoardWorkQuery): Promise<BoardWorkItem[]>;

  /**
   * File a new item.
   *
   * With an `idempotencyKey`, creating twice must yield ONE item: the second call returns
   * the first, with `created: false`. Adapters with `canCreateWork === false` must fail
   * `BoardError('unsupported')` — never pretend, and never return a fabricated item.
   */
  createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult>;

  /** Read one item; unknown id → `BoardError('not_found')`. */
  getWork(id: string): Promise<BoardWorkItem>;

  /**
   * Take ownership of one item for `runId`.
   *
   * MUST NOT silently succeed twice: a second claim of an already-claimed item
   * either throws `BoardError('precondition')` or returns `claimed: false`.
   */
  claim(id: string, runId: string): Promise<ClaimResult>;

  /**
   * Move the item's delivery state. Illegal transitions throw
   * {@link BoardStateError} (the pure table in `board-state.ts` decides);
   * the adapter never "corrects" a state on its own.
   */
  transition(id: string, to: BoardWorkItemState, evidence: BoardTransitionEvidence): Promise<void>;

  /**
   * Post a comment. Providers with `editableComment === true` return the SAME
   * ref for repeated calls with the same `runId`, so a long run patches one
   * progress comment instead of spamming the board.
   */
  comment(id: string, body: string, opts: { runId: string; author?: BoardCommentAuthor }): Promise<BoardCommentRef>;

  /** Edit a comment previously returned by `comment()`. Unknown ref → `not_found`. */
  updateComment(ref: BoardCommentRef, body: string): Promise<void>;

  /**
   * Read the versioned state record. When `capabilities().trustedAuthorFilter`
   * is true, records written by an untrusted author are IGNORED (return `null`
   * or the newest trusted record) — public text never drives control flow.
   * A present-but-corrupt block throws `BoardStateRecordError`, never `null`.
   */
  readState(id: string): Promise<BoardStateRecord | null>;

  /** Write the versioned state record (an upsert: one record per item). */
  writeState(id: string, record: BoardStateRecord, opts?: { author?: BoardCommentAuthor }): Promise<void>;

  /**
   * Report (and, where the board allows, create) the states this adapter needs.
   *
   * MUST NOT throw for a state it cannot create: `not-creatable` plus an
   * instruction IS the answer. MUST be idempotent — a second call reports
   * `exists` and changes nothing. A dry run MUST NOT change the board.
   *
   * Only boards with `canBootstrapStates === false` may fail closed here, and
   * only as `BoardError('unsupported')` when called with nothing to report on.
   */
  bootstrapStates(
    desired: readonly BoardWorkItemState[],
    opts?: { dryRun?: boolean },
  ): Promise<BoardBootstrapReport>;
}

/** What a caller needs from a provider before wiring it into a workflow. */
export interface BoardCapabilityRequirement {
  states?: readonly BoardWorkItemState[];
  comments?: boolean;
  editableComment?: boolean;
  machineReadableState?: boolean;
  atomicClaim?: boolean;
  delivery?: Partial<BoardDeliveryCapabilities>;
}

/**
 * Verify a provider satisfies a caller's declared requirements.
 * Mirrors `validateCapabilities` for runtimes: never guess, never degrade.
 */
export function validateBoardCapabilities(
  provider: TaskBoardProvider,
  required: BoardCapabilityRequirement,
): { ok: true } | { ok: false; missing: string[] } {
  const caps = provider.capabilities();
  const missing: string[] = [];

  for (const state of required.states ?? []) {
    if (!caps.states.includes(state)) missing.push(`state:${state}`);
  }
  for (const flag of ['comments', 'editableComment', 'machineReadableState', 'atomicClaim'] as const) {
    if (required[flag] === true && caps[flag] !== true) missing.push(flag);
  }
  for (const [name, value] of Object.entries(required.delivery ?? {})) {
    if (value === true && caps.delivery[name as keyof BoardDeliveryCapabilities] !== true) {
      missing.push(`delivery.${name}`);
    }
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * Fail closed: raise {@link BoardUnsupportedError} before performing an
 * operation the provider declared it cannot do. Adapters call this internally,
 * so a gated operation is never a silent no-op.
 */
export function assertBoardCapability(
  provider: TaskBoardProvider,
  capability:
    | 'comments'
    | 'editableComment'
    | 'machineReadableState'
    | 'atomicClaim'
    | 'canBootstrapStates'
    | 'canCreateWork'
    | 'delivery.canOpenPullRequest'
    | 'delivery.canRunChecks'
    | 'delivery.canMerge',
): void {
  const caps = provider.capabilities();
  const id = provider.metadata().id;
  switch (capability) {
    case 'comments':
    case 'editableComment':
    case 'machineReadableState':
    case 'atomicClaim':
      if (caps[capability] !== true) throw new BoardUnsupportedError(capability, id);
      return;
    case 'canBootstrapStates':
      if (caps[capability] !== true) throw new BoardUnsupportedError(capability, id);
      return;
    case 'canCreateWork':
      // Its own case, NOT the fallthrough group above: grouping it there made every
      // capability in the group check `canCreateWork` instead of its own flag, which
      // silenced four gate checks at once. The contract suite caught it.
      if (caps.canCreateWork !== true) throw new BoardUnsupportedError(capability, id);
      return;
    case 'delivery.canOpenPullRequest':
      if (caps.delivery.canOpenPullRequest !== true) throw new BoardUnsupportedError(capability, id);
      return;
    case 'delivery.canRunChecks':
      if (caps.delivery.canRunChecks !== true) throw new BoardUnsupportedError(capability, id);
      return;
    case 'delivery.canMerge':
      if (caps.delivery.canMerge !== true) throw new BoardUnsupportedError(capability, id);
      return;
  }
}

/** The board contract suite. Any adapter must pass it unchanged. */
export interface BoardContractSuiteOptions {
  /** Expected `metadata().id`. */
  id: string;
  /** An item the provider can see, ready to be claimed. The suite MUTATES it. */
  itemId: string;
  /** An id the provider must not know. */
  unknownItemId?: string;
  /** Two distinct run ids (the second proves claim is not idempotent-by-accident). */
  runId?: string;
  runId2?: string;
  /**
   * Injects a state record as an UNTRUSTED author, so the suite can prove that
   * public text never drives control flow.
   *
   * Only a provider that can simulate a foreign write can offer this (the
   * in-memory fake can; a real adapter writes as itself and therefore cannot —
   * its own test proves the READ filter instead, by feeding the transport a
   * comment from a stranger). Without it the check is reported as NOT_RUN
   * rather than silently passing.
   */
  writeUntrustedRecord?: (provider: TaskBoardProvider, record: BoardStateRecord) => Promise<void>;
}

/**
 * Shared Task-Board Contract Suite (ADR-006).
 *
 * Runs the SAME assertions against `FakeBoardProvider`, the GitHub, GitLab,
 * Jira and Notion adapters, so the abstraction is proven identical across
 * boards — Core never learns a board's internals.
 *
 * Contract surface verified: metadata, capabilities, list/get, claim
 * (non-idempotent, fail-closed), the legal/illegal transition table, comments
 * (one per run, editable when declared), the versioned state record, the
 * trusted-author filter, the capability gate, and the error taxonomy.
 *
 * Assertions throw on failure (like `runRuntimeContractSuite`); the returned
 * `result` is `PASS`, or `PASS_WITH_NOT_RUN` when capability-gated checks were
 * skipped because the provider does not implement that part of the port.
 */
export async function runTaskBoardProviderContractSuite(
  provider: TaskBoardProvider,
  opts: BoardContractSuiteOptions,
): Promise<{ gate: string; result: string; notes: string[] }> {
  const notes: string[] = [];
  const runId = opts.runId ?? 'c0ffee01';
  const runId2 = opts.runId2 ?? 'c0ffee02';
  const unknownItemId = opts.unknownItemId ?? 'takumi-contract-unknown-item';
  let notRun = 0;

  // --- metadata ---
  const meta = provider.metadata();
  if (meta.id !== opts.id) {
    throw new Error(`metadata.id must be ${opts.id}, got ${meta.id}`);
  }
  if (!meta.name || !meta.version) throw new Error('metadata.name and metadata.version are required');
  notes.push(`metadata: PASS (${meta.id} ${meta.version})`);

  // --- capabilities ---
  const caps = provider.capabilities();
  if (!Array.isArray(caps.states) || caps.states.length === 0) {
    throw new Error('capabilities.states must be a non-empty array');
  }
  for (const state of caps.states) {
    if (!isBoardWorkItemState(state)) throw new Error(`capabilities.states contains unknown state: ${String(state)}`);
  }
  for (const key of [
    'comments',
    'editableComment',
    'trustedAuthorFilter',
    'machineReadableState',
    'atomicClaim',
    'canBootstrapStates',
    'canCreateWork',
  ] as const) {
    if (typeof caps[key] !== 'boolean') throw new Error(`capabilities.${key} must be a boolean`);
  }
  for (const key of ['canOpenPullRequest', 'canRunChecks', 'canMerge'] as const) {
    if (typeof caps.delivery[key] !== 'boolean') throw new Error(`capabilities.delivery.${key} must be a boolean`);
  }
  notes.push(
    `capabilities: PASS (states=${caps.states.join(',')} atomicClaim=${caps.atomicClaim} ` +
      `comments=${caps.comments} editableComment=${caps.editableComment} machineReadableState=${caps.machineReadableState} ` +
      `trustedAuthorFilter=${caps.trustedAuthorFilter} canBootstrapStates=${caps.canBootstrapStates} ` +
      `canCreateWork=${caps.canCreateWork} ` +
      `delivery=${JSON.stringify(caps.delivery)})`,
  );

  // --- createWork: filing must be idempotent, or a retried tick duplicates ---
  // A failure that gets filed twice is worse than one that gets filed never: the board
  // fills with copies nobody dares close. The suite therefore requires the IDEMPOTENCY
  // guarantee, not merely that a create succeeds — and requires an honest refusal when
  // the adapter cannot create at all.
  const createKey = `contract:${opts.id}:1`;
  if (caps.canCreateWork) {
    const first = await provider.createWork({
      title: `${opts.id} contract probe`,
      body: 'filed by the shared task-board contract suite',
      state: 'ready',
      idempotencyKey: createKey,
    });
    if (!first.created) throw new Error('the first create with a fresh idempotency key must report created: true');
    if (first.item.state !== 'ready') {
      throw new Error(`a created item must start in the requested state, got ${first.item.state}`);
    }
    const second = await provider.createWork({
      title: `${opts.id} contract probe`,
      body: 'filed by the shared task-board contract suite',
      state: 'ready',
      idempotencyKey: createKey,
    });
    if (second.created) throw new Error('the second create with the same idempotency key must NOT create again');
    if (second.item.id !== first.item.id) {
      throw new Error(`idempotency returned ${second.item.id}, expected ${first.item.id}`);
    }
    const readyNow = await provider.listWork({ states: ['ready'] });
    const copies = readyNow.filter((item) => item.id === first.item.id).length;
    if (copies !== 1) throw new Error(`the created item appeared ${copies} times in listWork, expected once`);
    // A created item must be usable: the caller files work so that work can be done.
    const claim = await provider.claim(first.item.id, runId);
    if (!claim.claimed && !/claim/i.test(claim.reason ?? '')) {
      throw new Error(`a freshly created item could not be claimed: ${claim.reason ?? 'no reason'}`);
    }
    notes.push(`createWork: PASS (idempotent on the key, claimable, ${readyNow.length} ready)`);
  } else {
    const refused = await provider
      .createWork({ title: 'must be refused', idempotencyKey: createKey })
      .then(() => null)
      .catch((e: unknown) => e);
    if (refused === null) throw new Error('createWork must fail when capabilities().canCreateWork is false');
    if (!(refused instanceof BoardError) || refused.kind !== 'unsupported') {
      throw new Error(`createWork must fail closed as unsupported, got ${String(refused)}`);
    }
    notes.push('createWork: PASS (canCreateWork=false, refused as unsupported)');
  }

  // --- state bootstrap: can this board even express the six states? ---
  // This is the first minute of a real deployment: a board that cannot express a
  // state, and does not say what to do about it, strands the runner before it has
  // claimed anything. The suite therefore requires a REPORT in every case, and
  // creation only where the adapter claims it can create.
  const desired = [...caps.states];
  const dry = await provider.bootstrapStates(desired, { dryRun: true });
  assertBootstrapReport(dry, desired, caps.canBootstrapStates, opts.id, 'dry run');
  if (dry.applied) throw new Error('a dry-run bootstrap must not report applied: true');
  const createdInDry = dry.actions.filter((a) => a.outcome === 'created');
  if (createdInDry.length > 0) {
    throw new Error(`a dry run created ${createdInDry.map((a) => a.state).join(', ')} — it must change nothing`);
  }

  const applied = await provider.bootstrapStates(desired);
  assertBootstrapReport(applied, desired, caps.canBootstrapStates, opts.id, 'bootstrap');
  const pending = applied.actions.filter((a) => a.outcome === 'would-create');
  if (pending.length > 0) {
    throw new Error(
      `a real bootstrap reported would-create for ${pending.map((a) => a.state).join(', ')} — that is a dry-run outcome`,
    );
  }
  // What the dry run said it would create, the real run must have created.
  for (const action of dry.actions) {
    if (action.outcome !== 'would-create') continue;
    const real = applied.actions.find((a) => a.state === action.state);
    if (real?.outcome !== 'created') {
      throw new Error(`the dry run promised to create ${action.state} but the real run reported ${String(real?.outcome)}`);
    }
  }

  const again = await provider.bootstrapStates(desired);
  if (again.applied) throw new Error('a second bootstrap changed the board: bootstrapStates must be idempotent');
  if (again.actions.some((a) => a.outcome === 'created')) {
    throw new Error('a second bootstrap reported created: bootstrapStates must be idempotent');
  }
  const notCreatable = applied.actions.filter((a) => a.outcome === 'not-creatable');
  notes.push(
    `bootstrapStates: PASS (canCreate=${caps.canBootstrapStates} ` +
      `created=${applied.actions.filter((a) => a.outcome === 'created').length} ` +
      `exists=${applied.actions.filter((a) => a.outcome === 'exists').length} ` +
      `notCreatable=${notCreatable.length}, idempotent, dry run changed nothing)`,
  );

  // --- listWork ---
  const listed = await provider.listWork();
  if (!Array.isArray(listed)) throw new Error('listWork must resolve an array');
  for (const item of listed) {
    assertWorkItemShape(item);
    if (!caps.states.includes(item.state)) {
      throw new Error(`listWork returned ${item.id} in state ${item.state}, which capabilities().states omits`);
    }
  }
  notes.push(`listWork: PASS (${listed.length} items, all states declared)`);

  // --- getWork: known + unknown ---
  const item = await provider.getWork(opts.itemId);
  assertWorkItemShape(item);
  if (item.id !== opts.itemId) throw new Error(`getWork(${opts.itemId}) returned id ${item.id}`);
  await assertBoardError(
    () => provider.getWork(unknownItemId),
    'not_found',
    `getWork(${unknownItemId})`,
  );
  notes.push(`getWork: PASS (known item + not_found for unknown item), state=${item.state}`);

  // --- claim is NOT idempotent-by-accident ---
  const first = await provider.claim(opts.itemId, runId);
  if (first.claimed !== true) {
    throw new Error(`first claim of ${opts.itemId} must succeed, got claimed=${String(first.claimed)} (${first.reason ?? 'no reason'})`);
  }
  const second = await provider.claim(opts.itemId, runId2);
  if (second.claimed === true) {
    throw new Error(`second claim of the same item must NOT succeed (runId ${runId2} also got claimed=true)`);
  }
  if (second.reason === undefined || second.reason.length === 0) {
    throw new Error('a refused claim must state a reason — a silent refusal is not a contract');
  }
  notes.push(
    `claim: PASS (first claimed=true, second claimed=false reason=${JSON.stringify(second.reason)}, atomicClaim=${caps.atomicClaim})`,
  );

  // --- the transition table, through the provider ---
  const claimedItem = await provider.getWork(opts.itemId);
  if (claimedItem.state !== 'claimed') {
    throw new Error(`after a successful claim the item state must be 'claimed', got '${claimedItem.state}'`);
  }
  await assertRejectsBoardStateError(
    () => provider.transition(opts.itemId, 'claimed', { runId }),
    'claimed → claimed',
  );
  if (caps.states.includes('pr_open')) {
    await provider.transition(opts.itemId, 'pr_open', { runId, note: 'contract suite' });
    const opened = await provider.getWork(opts.itemId);
    if (opened.state !== 'pr_open') {
      throw new Error(`transition to pr_open was accepted but getWork reports '${opened.state}'`);
    }
    if (caps.states.includes('fix_needed')) {
      await provider.transition(opts.itemId, 'fix_needed', { runId });
      await provider.transition(opts.itemId, 'pr_open', { runId });
    }
    notes.push('transition: PASS (claimed→pr_open applied and observable; claimed→claimed rejected)');
  } else {
    notRun += 1;
    notes.push('transition: PARTIAL (claimed→claimed rejected; pr_open not declared by this provider)');
  }
  // Terminal states have no automated exit — provable only when present.
  if (caps.states.includes('merged')) {
    await assertRejectsBoardStateError(
      () => provider.transition(opts.itemId, 'merged', { runId, note: 'contract suite terminal' }),
      'pr_open → merged is a legal transition and must NOT go through this rejection path',
      { expectRejection: false },
    );
    const merged = await provider.getWork(opts.itemId);
    if (merged.state !== 'merged') {
      throw new Error(`transition to merged was accepted but getWork reports '${merged.state}'`);
    }
    await assertRejectsBoardStateError(
      () => provider.transition(opts.itemId, 'claimed', { runId }),
      'merged → claimed (terminal must have no automated exit)',
    );
    notes.push('terminal: PASS (merged reached; merged→claimed rejected)');
  } else {
    notRun += 1;
    notes.push('terminal: NOT_RUN (provider does not declare the merged state)');
  }

  // --- comments: one per run, editable when the provider says so ---
  if (caps.comments) {
    const ref = await provider.comment(opts.itemId, 'progress', { runId });
    if (ref.item !== opts.itemId || ref.runId !== runId || !ref.comment) {
      throw new Error('comment() returned a ref that does not identify (item, comment, runId)');
    }
    if (caps.editableComment) {
      const again = await provider.comment(opts.itemId, 'progress v2', { runId });
      if (again.comment !== ref.comment) {
        throw new Error('editableComment=true must return the SAME comment ref for the same runId');
      }
      await provider.updateComment(ref, 'progress v3');
      await assertBoardError(
        () => provider.updateComment({ ...ref, comment: 'takumi-no-such-comment' }, 'x'),
        'not_found',
        'updateComment on an unknown ref',
      );
      notes.push('comment: PASS (one comment per run, in-place update, unknown ref rejected)');
    } else {
      await assertBoardError(
        () => provider.updateComment(ref, 'x'),
        'unsupported',
        'updateComment on a provider without editableComment',
      );
      notRun += 1;
      notes.push('comment: PARTIAL (post works; editableComment=false → updateComment gated as unsupported)');
    }
  } else {
    await assertBoardError(
      () => provider.comment(opts.itemId, 'x', { runId }),
      'unsupported',
      'comment on a provider without comments',
    );
    notRun += 1;
    notes.push('comment: NOT_RUN (capabilities().comments=false → gated as unsupported)');
  }

  // --- the versioned state record + the trusted-author filter ---
  if (caps.machineReadableState) {
    const written: BoardStateRecord = {
      schema: 1,
      runId,
      item: opts.itemId,
      baseBranch: 'main',
      deliveryRef: '#1',
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
    };
    await provider.writeState(opts.itemId, written);
    const read = await provider.readState(opts.itemId);
    if (read === null) throw new Error('writeState then readState returned null');
    if (read.schema !== 1) throw new Error(`state record schema must round-trip as 1, got ${read.schema}`);
    if (read.runId !== runId) throw new Error(`state record runId must round-trip as ${runId}, got ${read.runId}`);
    if (read.item !== opts.itemId) throw new Error(`state record item must round-trip as ${opts.itemId}, got ${read.item}`);

    if (!caps.trustedAuthorFilter) {
      notRun += 1;
      notes.push('stateRecord: PARTIAL (round-trip PASS; trustedAuthorFilter=false so there is no trust boundary to prove)');
    } else if (opts.writeUntrustedRecord === undefined) {
      notRun += 1;
      notes.push(
        'stateRecord: PARTIAL (round-trip PASS; trustedAuthorFilter=true but no writeUntrustedRecord injection point, ' +
          'so the read filter must be proven by the adapter test with a foreign-authored fixture)',
      );
    } else {
      const hostile: BoardStateRecord = { ...written, runId: runId2, updatedAt: new Date(Date.now() + 60_000).toISOString() };
      await opts.writeUntrustedRecord(provider, hostile);
      const afterHostile = await provider.readState(opts.itemId);
      if (afterHostile !== null && afterHostile.runId === runId2) {
        throw new Error('an untrusted author\'s state record must NOT be readable — public text must never drive control flow');
      }
      notes.push('stateRecord: PASS (round-trip + untrusted write ignored)');
    }
  } else {
    await assertBoardError(
      () => provider.readState(opts.itemId),
      'unsupported',
      'readState on a provider without machineReadableState',
    );
    notRun += 1;
    notes.push('stateRecord: NOT_RUN (capabilities().machineReadableState=false → gated as unsupported)');
  }

  notes.push('credentials: NOT_REQUIRED (the suite injects no token and opens no network)');

  return {
    gate: 'task-board-contract',
    result: notRun === 0 ? 'PASS' : 'PASS_WITH_NOT_RUN',
    notes,
  };
}

function assertWorkItemShape(item: BoardWorkItem): void {
  // `body` may legitimately be empty (an issue with no description); every other
  // field must be present and non-empty or the provider is inventing data.
  for (const field of ['id', 'title', 'url', 'state', 'updatedAt'] as const) {
    if (typeof item[field] !== 'string' || item[field].length === 0) {
      throw new Error(`work item is missing ${field}: ${JSON.stringify(item)}`);
    }
  }
  if (typeof item.body !== 'string') {
    throw new Error(`work item body must be a string (it may be empty): ${JSON.stringify(item)}`);
  }
  if (!isBoardWorkItemState(item.state)) throw new Error(`work item has an unknown state: ${item.state}`);
  if (!Array.isArray(item.labels) || !Array.isArray(item.assignees)) {
    throw new Error('work item labels and assignees must be arrays');
  }
}

/**
 * Validate a bootstrap report without knowing the board: the same shape rules apply
 * to a GitHub label set, a Jira workflow and a Redmine status list.
 */
function assertBootstrapReport(
  report: BoardBootstrapReport,
  desired: readonly BoardWorkItemState[],
  canCreate: boolean,
  providerId: string,
  what: string,
): void {
  if (report === null || typeof report !== 'object') throw new Error(`${what} must resolve a report object`);
  if (report.provider !== providerId) {
    throw new Error(`${what} must name its provider (${providerId}), got ${JSON.stringify(report.provider)}`);
  }
  if (!Array.isArray(report.actions)) throw new Error(`${what} must resolve an actions array`);
  const seen = new Set<string>();
  for (const action of report.actions) {
    if (!desired.includes(action.state)) {
      throw new Error(`${what} reported a state that was not asked for: ${action.state}`);
    }
    if (seen.has(action.state)) throw new Error(`${what} reported ${action.state} twice`);
    seen.add(action.state);
    if (typeof action.name !== 'string' || action.name.length === 0) {
      throw new Error(`${what} reported ${action.state} without the board's own name for it`);
    }
    if (!['exists', 'created', 'would-create', 'not-creatable'].includes(action.outcome)) {
      throw new Error(`${what} reported an unknown outcome for ${action.state}: ${String(action.outcome)}`);
    }
    if (action.outcome === 'not-creatable') {
      if (action.instruction === undefined || action.instruction.trim().length === 0) {
        // Without the instruction this is the "no such label" error we set out to
        // abolish, just with a nicer name.
        throw new Error(
          `${what} reported ${action.state} as not-creatable without telling the operator what to do about it`,
        );
      }
    }
    if (!canCreate && (action.outcome === 'created' || action.outcome === 'would-create')) {
      throw new Error(
        `${what} reported ${action.outcome} for ${action.state} while capabilities().canBootstrapStates is false`,
      );
    }
  }
  for (const state of desired) {
    if (!seen.has(state)) throw new Error(`${what} did not report on ${state}`);
  }
}

/** Run `fn` and require a `BoardError` of `kind` — no bare Error, no silent success. */
async function assertBoardError(
  fn: () => Promise<unknown>,
  kind: BoardErrorKind,
  what: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) {
    throw new Error(`${what} must fail with BoardError('${kind}'), but it resolved`);
  }
  if (!(thrown instanceof BoardError)) {
    throw new Error(
      `${what} must fail with a BoardError('${kind}'), got ${thrown instanceof Error ? thrown.name : typeof thrown}: ` +
        `${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  if (thrown.kind !== kind) {
    throw new Error(`${what} failed with kind '${thrown.kind}', expected '${kind}': ${thrown.message}`);
  }
}

async function assertRejectsBoardStateError(
  fn: () => Promise<unknown>,
  what: string,
  opts: { expectRejection?: boolean } = {},
): Promise<void> {
  const expectRejection = opts.expectRejection ?? true;
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  if (!expectRejection) {
    if (thrown !== undefined) {
      throw new Error(`${what}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
    return;
  }
  if (thrown === undefined) throw new Error(`${what} must be rejected, but it resolved`);
  if (!(thrown instanceof BoardStateError)) {
    throw new Error(
      `${what} must be rejected with BoardStateError, got ${thrown instanceof Error ? thrown.name : typeof thrown}: ` +
        `${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
}

/** Re-exported for adapters/tests that want the canonical state list. */
export { BOARD_WORK_ITEM_STATES };
