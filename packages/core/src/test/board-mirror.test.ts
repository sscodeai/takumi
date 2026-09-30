import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MirroringBoard, createEventLog, mirrorMarker, type RunEvent } from '../index.js';

/** What the event trail carries, as far as these tests read it. */
type EventLine = { kind: string; message?: string; fields?: Record<string, unknown> };
type Sink = { write(event: RunEvent): void };
import type {
  BoardBootstrapReport,
  BoardCapabilities,
  BoardCommentAuthor,
  BoardCommentRef,
  BoardProviderMetadata,
  BoardStateRecord,
  BoardTransitionEvidence,
  BoardWorkItem,
  BoardWorkItemSpec,
  BoardWorkItemState,
  BoardWorkQuery,
  ClaimResult,
  CreateWorkResult,
  TaskBoardProvider,
} from '../index.js';

/**
 * A board that records what it was asked to do. Deliberately simple and independent of the fake
 * adapter: a mirror's job is to be WRITTEN to, and the tests need to see the writes and to make
 * them fail on demand.
 */
class RecordingBoard implements TaskBoardProvider {
  readonly items = new Map<string, { item: BoardWorkItem; body: string }>();
  readonly comments: Array<{ id: string; body: string }> = [];
  readonly calls: string[] = [];
  claimCalls = 0;
  failCreate = false;
  failTransition = false;
  private nextId = 1;

  constructor(private readonly caps: BoardCapabilities) {}

  metadata(): BoardProviderMetadata {
    return { id: 'recording', name: 'Recording board', version: '0.0.1' };
  }
  capabilities(): BoardCapabilities {
    return this.caps;
  }
  async listWork(query?: BoardWorkQuery): Promise<BoardWorkItem[]> {
    this.calls.push('listWork');
    const states = query?.states ?? [];
    return [...this.items.values()].map((e) => e.item).filter((i) => states.length === 0 || states.includes(i.state));
  }
  async getWork(id: string): Promise<BoardWorkItem> {
    this.calls.push(`getWork:${id}`);
    const entry = this.items.get(id);
    if (entry === undefined) throw new Error(`unknown item ${id}`);
    return entry.item;
  }
  async createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult> {
    this.calls.push(`createWork:${spec.title}`);
    if (this.failCreate) throw new Error('this board refuses to create work');
    // Idempotency by key, like every real adapter: the same key yields ONE item.
    const key = spec.idempotencyKey ?? spec.title;
    for (const [id, entry] of this.items) {
      if (entry.body.includes(key)) return { item: entry.item, created: false };
    }
    const id = `m${this.nextId++}`;
    const item: BoardWorkItem = {
      id,
      title: spec.title,
      body: spec.body ?? '',
      url: `recording://${id}`,
      state: 'ready',
      labels: [],
      assignees: [],
      updatedAt: new Date(0).toISOString(),
    };
    this.items.set(id, { item, body: `${spec.body ?? ''}\n${key}` });
    return { item, created: true };
  }
  async claim(id: string, runId: string): Promise<ClaimResult> {
    this.claimCalls += 1;
    this.calls.push('claim');
    return { item: id, runId, claimed: true };
  }
  async transition(id: string, to: BoardWorkItemState, _evidence: BoardTransitionEvidence): Promise<void> {
    this.calls.push(`transition:${id}:${to}`);
    if (this.failTransition) throw new Error('this board refuses that state (its columns do not have it)');
    const entry = this.items.get(id);
    if (entry !== undefined) entry.item = { ...entry.item, state: to };
  }
  async comment(id: string, body: string, opts: { runId: string; author?: BoardCommentAuthor }): Promise<BoardCommentRef> {
    this.calls.push(`comment:${id}`);
    this.comments.push({ id, body });
    return { item: id, comment: `c${this.comments.length}`, runId: opts.runId, url: `recording://comment/${this.comments.length}` };
  }
  async updateComment(): Promise<void> {
    this.calls.push('updateComment');
  }
  async readState(): Promise<BoardStateRecord | null> {
    this.calls.push('readState');
    return null;
  }
  async writeState(): Promise<void> {
    this.calls.push('writeState');
  }
  async bootstrapStates(desired: readonly BoardWorkItemState[]): Promise<BoardBootstrapReport> {
    return {
      provider: 'recording',
      applied: false,
      actions: desired.map((state) => ({ state, name: `takumi-${state}`, outcome: 'exists' as const })),
      unsupported: [],
    };
  }
}

function caps(overrides: Partial<BoardCapabilities> = {}): BoardCapabilities {
  return {
    states: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'],
    comments: true,
    editableComment: false, // like Notion: append-only, which is why projections append
    trustedAuthorFilter: false,
    machineReadableState: true,
    atomicClaim: false,
    canBootstrapStates: false,
    canCreateWork: true,
    canTextSearch: false,
    delivery: { canOpenPullRequest: false, canRunChecks: false, canMerge: false },
    ...overrides,
  };
}

function lines(): { log: ReturnType<typeof createEventLog>; seen: EventLine[] } {
  const seen: EventLine[] = [];
  return {
    log: createEventLog({
      sink: {
        write: (event) => {
          seen.push(event as unknown as EventLine);
        },
      } satisfies Sink,
      retain: false,
    }),
    seen,
  };
}

function primaryWithItem(): { primary: RecordingBoard; mirror: RecordingBoard } {
  const primary = new RecordingBoard(caps({ canOpenPullRequest: true } as Partial<BoardCapabilities>));
  const mirror = new RecordingBoard(caps());
  return { primary, mirror };
}

test('mirroring: control flow goes to the PRIMARY, and the mirror is never consulted', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'real work', body: 'b', labels: [] });
  primary.items.get(item.item.id)!.item = { ...item.item, state: 'claimed' };
  const { log } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });

  await board.listWork({ states: ['claimed'] });
  const claim = await board.claim(item.item.id, 'r1');
  await board.readState(item.item.id);
  await board.writeState(item.item.id, { schema: 1, runId: 'r1', item: item.item.id, reviewRound: 0, updatedAt: 'x' });

  assert.equal(claim.claimed, true);
  // The mirror was never READ for a decision: no read calls at all.
  assert.deepEqual(mirror.calls.filter((c) => c.startsWith('listWork') || c === 'claim' || c === 'readState'), []);
  assert.equal(primary.calls.includes('claim'), true);
  // And the state record — the control-flow surface — is NOT projected (rule 5).
  assert.equal(mirror.calls.includes('writeState'), false);
});

test('mirroring: a transition and a comment are projected onto the mirror', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'real work', body: 'the body', labels: [] });
  primary.items.get(item.item.id)!.item = { ...item.item, state: 'claimed' };
  const { log } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });

  await board.transition(item.item.id, 'pr_open', { runId: 'r1' });
  await board.comment(item.item.id, 'Delivered and merged: https://forge/pr/1', { runId: 'r1' });

  const mirrorItem = [...mirror.items.values()][0];
  assert.ok(mirrorItem !== undefined, 'the mirror must have been given the item');
  assert.equal(mirrorItem.item.state, 'pr_open', 'the mirror shows the same state');
  assert.match(mirrorItem.body, new RegExp(mirrorMarker(item.item.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(mirror.comments.map((c) => c.body).join('\n'), /Delivered and merged/);
});

test('mirroring: a FAILING mirror does not fail the delivery, and is not silent', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'real work', body: 'b', labels: [] });
  primary.items.get(item.item.id)!.item = { ...item.item, state: 'claimed' };
  mirror.failTransition = true; // e.g. the Notion column does not have that option
  const { log, seen } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });

  // The primary's transition MUST succeed: a decorative board may not block or delay real work.
  await board.transition(item.item.id, 'pr_open', { runId: 'r1' });
  assert.equal(primary.items.get(item.item.id)!.item.state, 'pr_open');
  // And the failure is reported with its reason.
  const failure = seen.find((l) => l.kind === 'mirror.failed');
  assert.ok(failure !== undefined, `a projection failure must be loud: ${seen.map((l) => l.kind).join(',')}`);
  assert.match(String(failure?.message), /columns do not have it/);
});

test('mirroring: a mirror that cannot create work is reported, never silently absent', async () => {
  const { primary, mirror } = primaryWithItem();
  mirror.failCreate = true;
  const { log, seen } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });

  const created = await board.createWork({ title: 'new work', body: 'b', labels: [] });
  assert.equal(created.item.title, 'new work', 'the work is created on the primary regardless');
  const failure = seen.find((l) => l.kind === 'mirror.failed');
  assert.ok(failure !== undefined);
  assert.match(String(failure?.message), /could not create the mirror item/);
});

test('mirroring: resync rebuilds a projection whose map was lost, without duplicating it', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'real work', body: 'the body', labels: [] });
  primary.items.get(item.item.id)!.item = { ...item.item, state: 'merged' };
  const { log } = lines();

  const first = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });
  await first.transition(item.item.id, 'merged', { runId: 'r1' });
  assert.equal([...mirror.items.values()].length, 1);

  // A NEW composite (as after a restart) with an EMPTY map: the projection is rebuilt from the
  // primary, and the marker key keeps it to one item.
  const recovered = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r2' });
  const report = await recovered.resync();
  assert.deepEqual(report, [{ mirror: 'notion', projected: 1, failed: 0 }]);
  assert.equal([...mirror.items.values()].length, 1, 'resync must not create a second mirror item');
  assert.equal([...mirror.items.values()][0]?.item.state, 'merged');
});

test('mirroring: the id map is a cache, and its persistence round-trips', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'real work', body: 'b', labels: [] });
  const { log } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });
  await board.transition(item.item.id, 'claimed', { runId: 'r1' });
  const map = board.idMap();
  assert.equal(typeof map[item.item.id]?.['notion'], 'string');

  const reloaded = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r2' });
  reloaded.loadIdMap(map);
  assert.deepEqual(reloaded.idMap(), map);
});

test('mirroring: a composite without a mirror is refused (it would just be the primary)', () => {
  const { primary } = primaryWithItem();
  assert.throws(() => new MirroringBoard(primary, [], {}), /at least one mirror/);
});
