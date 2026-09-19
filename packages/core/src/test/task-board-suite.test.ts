import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBoardCapability,
  assertTransition,
  BOARD_WORK_ITEM_STATES,
  BoardError,
  BoardUnsupportedError,
  renderCreateMarker,
  runTaskBoardProviderContractSuite,
  validateBoardCapabilities,
} from '../index.js';
import type {
  BoardBootstrapAction,
  BoardBootstrapReport,
  BoardCapabilities,
  BoardCommentAuthor,
  BoardCommentRef,
  BoardStateRecord,
  BoardWorkItem,
  BoardWorkItemSpec,
  BoardWorkItemState,
  BoardWorkQuery,
  ClaimResult,
  CreateWorkResult,
  TaskBoardProvider,
} from '../index.js';

/**
 * A deliberately MINIMAL reference provider, defined here (not imported from a
 * board package) so the core suite is proven to be about the CONTRACT and not
 * about one implementation. `opts.break*` switches make it lie in specific
 * ways: a contract suite that cannot fail is not a contract.
 */
class ProbeProvider implements TaskBoardProvider {
  private readonly items = new Map<string, { item: BoardWorkItem; claim?: string }>();
  private readonly comments = new Map<string, { body: string; seq: number }>();
  private readonly records = new Map<string, { record: BoardStateRecord; trusted: boolean }>();
  /** States this probe has already created (bootstrap is idempotent). */
  private readonly bootstrapped = new Set<BoardWorkItemState>();
  private seq = 0;

  constructor(
    private readonly opts: {
      id?: string;
      breakSilentReclaim?: boolean;
      breakSilentCommentUpdate?: boolean;
      caps?: Omit<Partial<BoardCapabilities>, 'delivery'> & { delivery?: Partial<BoardCapabilities['delivery']> };
    } = {},
  ) {
    const item: BoardWorkItem = {
      id: 'T-1',
      title: 'a task',
      body: 'do the thing',
      url: 'https://board.example/T-1',
      state: 'ready',
      labels: ['takumi-ready'],
      assignees: [],
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    this.items.set(item.id, { item });
  }

  private caps: BoardCapabilities = {
    states: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'],
    comments: true,
    editableComment: true,
    trustedAuthorFilter: true,
    machineReadableState: true,
    atomicClaim: true,
    canBootstrapStates: true,
    canCreateWork: true,
    delivery: { canOpenPullRequest: true, canRunChecks: true, canMerge: true },
  };

  /**
   * The probe's createWork: idempotent on the marker, exactly as an adapter must be. The
   * suite's createWork assertions run against THIS, so a suite that stopped checking the
   * key would be visible here rather than at an adapter.
   */
  async createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult> {
    assertBoardCapability(this, 'canCreateWork');
    const finding = (): { item: BoardWorkItem; claim?: string } | undefined =>
      spec.idempotencyKey === undefined
        ? undefined
        : [...this.items.values()].find((entry) => entry.item.body.includes(renderCreateMarker(spec.idempotencyKey ?? '')));
    const existing = finding();
    if (existing !== undefined) return { item: { ...existing.item }, created: false };
    this.seq += 1;
    const id = `T-${this.seq + 1}`;
    const marker = spec.idempotencyKey === undefined ? '' : `\n\n${renderCreateMarker(spec.idempotencyKey)}`;
    const item: BoardWorkItem = {
      id,
      title: spec.title,
      body: `${spec.body ?? ''}${marker}`,
      url: `https://board.example/${id}`,
      state: spec.state ?? 'ready',
      labels: [...(spec.labels ?? [])],
      assignees: [],
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    this.items.set(id, { item });
    return { item: { ...item }, created: true };
  }

  metadata() {
    return { id: this.opts.id ?? 'probe', name: 'Probe Board', version: '0.1.0' };
  }

  capabilities(): BoardCapabilities {
    return { ...this.caps, ...this.opts.caps, delivery: { ...this.caps.delivery, ...this.opts.caps?.delivery } };
  }

  private must(id: string) {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    return entry;
  }

  async listWork(query?: BoardWorkQuery): Promise<BoardWorkItem[]> {
    const limit = query?.limit ?? Number.POSITIVE_INFINITY;
    return [...this.items.values()].slice(0, limit).map((e) => e.item);
  }

  async getWork(id: string): Promise<BoardWorkItem> {
    return this.must(id).item;
  }

  async claim(id: string, runId: string): Promise<ClaimResult> {
    const entry = this.must(id);
    if (entry.claim !== undefined) {
      if (this.opts.breakSilentReclaim) return { item: id, runId, claimed: true };
      return { item: id, runId, claimed: false, reason: `already claimed by ${entry.claim}` };
    }
    entry.claim = runId;
    entry.item.state = 'claimed';
    return { item: id, runId, claimed: true };
  }

  async transition(id: string, to: BoardWorkItemState): Promise<void> {
    const entry = this.must(id);
    assertTransition(entry.item.state, to);
    entry.item.state = to;
  }

  async comment(id: string, body: string, opts: { runId: string }): Promise<BoardCommentRef> {
    // Adapters gate BEFORE acting: a provider that declares comments=false and
    // still posts is a contract violation, not a convenience.
    assertBoardCapability(this, 'comments');
    this.must(id);
    const key = `${id}:${opts.runId}`;
    const existing = this.comments.get(key);
    if (existing) {
      existing.body = body;
      return { item: id, comment: `c${existing.seq}`, runId: opts.runId };
    }
    this.seq += 1;
    this.comments.set(key, { body, seq: this.seq });
    return { item: id, comment: `c${this.seq}`, runId: opts.runId };
  }

  async updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    assertBoardCapability(this, 'editableComment');
    const entry = this.comments.get(`${ref.item}:${ref.runId}`);
    if (!entry || `c${entry.seq}` !== ref.comment) {
      if (this.opts.breakSilentCommentUpdate) return;
      throw new BoardError('not_found', `no such comment: ${ref.comment}`, { item: ref.item });
    }
    entry.body = body;
  }

  async readState(id: string): Promise<BoardStateRecord | null> {
    assertBoardCapability(this, 'machineReadableState');
    this.must(id);
    const entry = this.records.get(id);
    if (!entry) return null;
    return entry.trusted ? entry.record : null;
  }

  async writeState(id: string, record: BoardStateRecord, opts?: { author?: BoardCommentAuthor }): Promise<void> {
    assertBoardCapability(this, 'machineReadableState');
    this.must(id);
    this.records.set(id, { record, trusted: opts?.author?.trusted !== false });
  }

  /**
   * The probe can create its own states (it owns them), so the suite exercises the
   * creation path here: dry run says would-create, the real call creates, the second
   * call reports exists.
   */
  async bootstrapStates(
    desired: readonly BoardWorkItemState[],
    opts: { dryRun?: boolean } = {},
  ): Promise<BoardBootstrapReport> {
    const actions: BoardBootstrapAction[] = [];
    let created = false;
    for (const state of desired) {
      const name = `state:${state}`;
      if (this.bootstrapped.has(state)) {
        actions.push({ state, name, outcome: 'exists' });
      } else if (opts.dryRun === true) {
        actions.push({ state, name, outcome: 'would-create' });
      } else {
        this.bootstrapped.add(state);
        created = true;
        actions.push({ state, name, outcome: 'created' });
      }
    }
    return {
      provider: this.metadata().id,
      applied: created,
      actions,
      unsupported: BOARD_WORK_ITEM_STATES.filter((s) => !this.capabilities().states.includes(s)),
    };
  }
}

test('suite: an honest provider passes the shared Task-Board Contract Suite', async () => {
  const out = await runTaskBoardProviderContractSuite(new ProbeProvider(), {
    id: 'probe',
    itemId: 'T-1',
    // The reference provider can simulate a foreign write, so the trust boundary
    // is actually exercised here instead of being skipped.
    writeUntrustedRecord: (provider, record) =>
      provider.writeState('T-1', record, { author: { login: 'drive-by', trusted: false } }),
  });
  assert.equal(out.gate, 'task-board-contract');
  assert.equal(out.result, 'PASS');
  assert.ok(out.notes.some((n) => n.startsWith('claim: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('stateRecord: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('terminal: PASS')));
});

test('suite: a provider that silently re-claims the same item FAILS', async () => {
  const provider = new ProbeProvider({ breakSilentReclaim: true });
  await assert.rejects(
    () => runTaskBoardProviderContractSuite(provider, { id: 'probe', itemId: 'T-1' }),
    /second claim of the same item must NOT succeed/,
  );
});

test('suite: an id mismatch is caught from metadata, not assumed', async () => {
  const provider = new ProbeProvider({ id: 'something-else' });
  await assert.rejects(
    () => runTaskBoardProviderContractSuite(provider, { id: 'probe', itemId: 'T-1' }),
    /metadata\.id must be probe/,
  );
});

test('suite: a provider that accepts an unknown comment ref FAILS', async () => {
  const provider = new ProbeProvider({ breakSilentCommentUpdate: true });
  await assert.rejects(
    () => runTaskBoardProviderContractSuite(provider, { id: 'probe', itemId: 'T-1' }),
    /updateComment on an unknown ref must fail/,
  );
});

test('suite: capability-gated parts report PASS_WITH_NOT_RUN instead of pretending', async () => {
  const provider = new ProbeProvider({
    caps: { comments: false, editableComment: false, machineReadableState: false, trustedAuthorFilter: false },
  });
  const out = await runTaskBoardProviderContractSuite(provider, { id: 'probe', itemId: 'T-1' });
  assert.equal(out.result, 'PASS_WITH_NOT_RUN');
  assert.ok(out.notes.some((n) => n.includes('comment: NOT_RUN')));
  assert.ok(out.notes.some((n) => n.includes('stateRecord: NOT_RUN')));
});

test('validateBoardCapabilities: reports exactly what is missing', () => {
  const provider = new ProbeProvider({
    caps: { comments: false, delivery: { canMerge: false } },
  });
  assert.deepEqual(validateBoardCapabilities(provider, { comments: true, delivery: { canMerge: true } }), {
    ok: false,
    missing: ['comments', 'delivery.canMerge'],
  });
  assert.deepEqual(validateBoardCapabilities(provider, { states: ['ready', 'claimed'] }), { ok: true });
  assert.deepEqual(validateBoardCapabilities(provider, { states: ['merged', 'unknown' as BoardWorkItemState] }), {
    ok: false,
    missing: ['state:unknown'],
  });
});

test('assertBoardCapability: fails closed for a gated operation', () => {
  const provider = new ProbeProvider({ caps: { machineReadableState: false, delivery: { canOpenPullRequest: false } } });
  assert.doesNotThrow(() => assertBoardCapability(provider, 'comments'));
  assert.throws(() => assertBoardCapability(provider, 'machineReadableState'), BoardUnsupportedError);
  assert.throws(() => assertBoardCapability(provider, 'delivery.canOpenPullRequest'), /does not support delivery\.canOpenPullRequest/);
});

test('BoardError: only transport failures are retriable', () => {
  assert.equal(new BoardError('transport', 'network down').retriable, true);
  for (const kind of ['auth', 'precondition', 'not_found', 'unsupported'] as const) {
    assert.equal(new BoardError(kind, 'x').retriable, false, `${kind} must not be retriable`);
  }
  const withItem = new BoardError('not_found', 'x', { item: 'T-9' });
  assert.equal(withItem.item, 'T-9');
  assert.equal(withItem.name, 'BoardError');
});
