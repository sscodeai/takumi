import {
  assertBoardCapability,
  BOARD_WORK_ITEM_STATES,
  BoardError,
  assertTransition,
  parseBoardStateRecord,
  renderBoardStateRecord,
} from '@takumi/core';
import type {
  BoardBootstrapAction,
  BoardBootstrapReport,
  BoardCapabilities,
  BoardCommentAuthor,
  BoardCommentRef,
  BoardDeliveryCapabilities,
  BoardStateRecord,
  BoardTransitionEvidence,
  BoardWorkItem,
  BoardWorkItemState,
  BoardWorkQuery,
  ClaimResult,
  TaskBoardProvider,
  BoardProviderMetadata,
} from '@takumi/core';

/**
 * FakeBoardProvider — a deterministic, in-memory task board.
 *
 * Contract-identical to a real board adapter: same TaskBoardProvider surface,
 * same versioned state record, same fail-closed errors. It exists so the shared
 * Task-Board Contract Suite can run with ZERO credentials and ZERO network, and
 * so vertical slices (CLI, workflows, board views) can be developed before a
 * real board is wired. Real boards plug in by config — no core change.
 *
 * It deliberately mirrors how a real board behaves, including the awkward
 * parts: one comment per (item, runId), a claim that refuses a second taker,
 * and state records that carry an author trust flag.
 */

export interface FakeBoardProviderOptions {
  /** Items the board starts with (only `id` is required). */
  items?: FakeBoardItemSeed[];
  /** Narrow or widen the declared capabilities (narrowing is how gating is tested). */
  capabilities?: FakeBoardCapabilities;
  /** Injectable clock so tests are deterministic (default: `Date.now`). */
  clock?: () => number;
}

/** A seeded item: the provider fills in every field the caller leaves out. */
export type FakeBoardItemSeed = Partial<BoardWorkItem> & { id: string };

/** Capability override, with the delivery sub-object also partial. */
export type FakeBoardCapabilities = Omit<Partial<BoardCapabilities>, 'delivery'> & {
  delivery?: Partial<BoardDeliveryCapabilities>;
};

const DEFAULT_CAPABILITIES: BoardCapabilities = {
  states: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'],
  comments: true,
  editableComment: true,
  trustedAuthorFilter: true,
  machineReadableState: true,
  atomicClaim: true,
  canBootstrapStates: true,
  delivery: { canOpenPullRequest: true, canRunChecks: true, canMerge: true },
};

interface FakeItem {
  item: BoardWorkItem;
  claim?: string;
}

interface FakeComment {
  item: string;
  runId: string;
  seq: number;
  body: string;
}

export class FakeBoardProvider implements TaskBoardProvider {
  private readonly items = new Map<string, FakeItem>();
  private readonly comments = new Map<string, FakeComment>();
  private readonly records = new Map<string, Array<{ record: BoardStateRecord; trusted: boolean }>>();
  /** States this board has already created (so bootstrap is idempotent). */
  private readonly bootstrapStates_ = new Set<BoardWorkItemState>();
  private readonly capabilities_: BoardCapabilities;
  private readonly clock: () => number;
  private commentSeq = 0;

  constructor(opts: FakeBoardProviderOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.capabilities_ = {
      ...DEFAULT_CAPABILITIES,
      ...opts.capabilities,
      delivery: { ...DEFAULT_CAPABILITIES.delivery, ...opts.capabilities?.delivery },
    };
    for (const item of opts.items ?? []) this.seed(item);
  }

  /** Add (or replace) one item. Returns the provider so tests can chain. */
  seed(item: FakeBoardItemSeed): FakeBoardProvider {
    const existing = this.items.get(item.id);
    const full: BoardWorkItem = {
      id: item.id,
      title: item.title ?? `Item ${item.id}`,
      body: item.body ?? '',
      url: item.url ?? `https://board.example/${item.id}`,
      state: item.state ?? 'ready',
      labels: item.labels ?? [],
      assignees: item.assignees ?? [],
      updatedAt: item.updatedAt ?? new Date(this.clock()).toISOString(),
      ...(item.raw === undefined ? {} : { raw: item.raw }),
    };
    // Re-seeding an item keeps an existing claim: the claim is board state, not
    // a field of the snapshot the caller passed.
    this.items.set(full.id, existing?.claim === undefined ? { item: full } : { item: full, claim: existing.claim });
    return this;
  }

  /** Current items, for assertions in tests and slices. */
  snapshot(): BoardWorkItem[] {
    return [...this.items.values()].map((e) => ({ ...e.item }));
  }

  metadata(): BoardProviderMetadata {
    return {
      id: 'fake',
      name: 'Fake Board',
      version: '0.1.0',
      description: 'Deterministic in-memory task board for tests and development.',
    };
  }

  capabilities(): BoardCapabilities {
    return this.capabilities_;
  }

  async listWork(query: BoardWorkQuery = {}): Promise<BoardWorkItem[]> {
    const limit = query.limit ?? Number.POSITIVE_INFINITY;
    return [...this.items.values()]
      .filter((e) => (query.states === undefined ? true : query.states.includes(e.item.state)))
      .filter((e) =>
        query.labels === undefined ? true : query.labels.every((label) => e.item.labels.includes(label)),
      )
      .slice(0, limit)
      .map((e) => ({ ...e.item }));
  }

  async getWork(id: string): Promise<BoardWorkItem> {
    return { ...this.must(id).item };
  }

  async claim(id: string, runId: string): Promise<ClaimResult> {
    const entry = this.must(id);
    if (entry.claim !== undefined) {
      return { item: id, runId, claimed: false, reason: `already claimed by ${entry.claim}` };
    }
    if (entry.item.state !== 'ready') {
      return { item: id, runId, claimed: false, reason: `item is in state ${entry.item.state}, not ready` };
    }
    entry.claim = runId;
    this.applyState(entry, 'claimed');
    return { item: id, runId, claimed: true };
  }

  async transition(id: string, to: BoardWorkItemState, _evidence: BoardTransitionEvidence): Promise<void> {
    const entry = this.must(id);
    assertTransition(entry.item.state, to);
    this.applyState(entry, to);
  }

  async comment(id: string, body: string, opts: { runId: string; author?: BoardCommentAuthor }): Promise<BoardCommentRef> {
    assertBoardCapability(this, 'comments');
    this.must(id);
    const key = `${id}:${opts.runId}`;
    const existing = this.comments.get(key);
    if (existing && this.capabilities_.editableComment) {
      existing.body = body;
      return { item: id, comment: `c${existing.seq}`, runId: opts.runId, url: `${this.must(id).item.url}#c${existing.seq}` };
    }
    if (existing) {
      throw new BoardError('precondition', `a progress comment for run ${opts.runId} already exists on ${id}`);
    }
    this.commentSeq += 1;
    const created: FakeComment = { item: id, runId: opts.runId, seq: this.commentSeq, body };
    this.comments.set(key, created);
    return { item: id, comment: `c${created.seq}`, runId: opts.runId, url: `${this.must(id).item.url}#c${created.seq}` };
  }

  async updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    assertBoardCapability(this, 'editableComment');
    const entry = this.comments.get(`${ref.item}:${ref.runId}`);
    if (!entry || `c${entry.seq}` !== ref.comment) {
      throw new BoardError('not_found', `no such comment: ${ref.comment} on ${ref.item}`, { item: ref.item });
    }
    entry.body = body;
  }

  async readState(id: string): Promise<BoardStateRecord | null> {
    assertBoardCapability(this, 'machineReadableState');
    this.must(id);
    const entries = this.records.get(id) ?? [];
    // Public text never drives control flow: untrusted records stay physically
    // on the board (they were written by someone else) but are never read back.
    const trusted = entries.filter((e) => e.trusted);
    if (trusted.length === 0) return null;
    return trusted.reduce((newest, e) =>
      Date.parse(e.record.updatedAt) >= Date.parse(newest.record.updatedAt) ? e : newest,
    ).record;
  }

  /**
   * The fake board owns its states, so it can create them — the reference
   * behaviour the real adapters are measured against: a dry run reports what it
   * would do, the real call creates, a second call reports `exists`.
   */
  async bootstrapStates(
    desired: readonly BoardWorkItemState[],
    opts: { dryRun?: boolean } = {},
  ): Promise<BoardBootstrapReport> {
    const actions: BoardBootstrapAction[] = [];
    let applied = false;
    for (const state of desired) {
      const name = `takumi-${state}`;
      if (this.bootstrapStates_.has(state)) {
        actions.push({ state, name, outcome: 'exists' });
      } else if (opts.dryRun === true) {
        actions.push({ state, name, outcome: 'would-create' });
      } else {
        this.bootstrapStates_.add(state);
        applied = true;
        actions.push({ state, name, outcome: 'created' });
      }
    }
    return {
      provider: this.metadata().id,
      applied,
      actions,
      unsupported: BOARD_WORK_ITEM_STATES.filter((state) => !this.capabilities().states.includes(state)),
    };
  }

  async writeState(id: string, record: BoardStateRecord, opts?: { author?: BoardCommentAuthor }): Promise<void> {
    assertBoardCapability(this, 'machineReadableState');
    this.must(id);
    if (record.item !== id) {
      throw new BoardError('precondition', `state record names item ${record.item} but was written to ${id}`, { item: id });
    }
    const trusted = opts?.author?.trusted !== false;
    const entries = this.records.get(id) ?? [];
    // A trusted write is an upsert ("one record per item"); an untrusted write
    // can only append — it must not be able to erase takumi's own record.
    const next = trusted ? [...entries.filter((e) => !e.trusted), { record, trusted: true }] : [...entries, { record, trusted: false }];
    this.records.set(id, next);
  }

  /** The comment bodies on one item (newest last) — for tests that read progress. */
  commentsOf(id: string): string[] {
    return [...this.comments.values()].filter((c) => c.item === id).map((c) => c.body);
  }

  /** Every state record physically present on one item, trusted or not. */
  rawStateComments(id: string): string[] {
    return (this.records.get(id) ?? []).map((e) => renderBoardStateRecord(e.record));
  }

  private must(id: string): FakeItem {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    return entry;
  }

  private applyState(entry: FakeItem, to: BoardWorkItemState): void {
    entry.item = { ...entry.item, state: to, updatedAt: new Date(this.clock()).toISOString() };
  }
}

/** Parse a state record out of a raw comment body (used by board views). */
export { parseBoardStateRecord };
