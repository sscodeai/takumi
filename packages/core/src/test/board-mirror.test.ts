import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardError, MirroringBoard, createEventLog, mirrorMarker, type RunEvent } from '../index.js';

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
  /** The ids whose body was COMPLETED by an idempotent re-create. */
  readonly repairs: string[] = [];
  claimCalls = 0;
  failCreate = false;
  failTransition = false;
  /** Like a board with no labels property: it REFUSES a labelled create rather than dropping them. */
  refuseLabels = false;
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
    // Fail closed like the Notion adapter: a board with nowhere to put labels refuses the work
    // rather than filing it without them. A double that accepted anything hid a real bug once
    // (the projection was created at `ready`) — it does not get to do that twice.
    if (this.refuseLabels && (spec.labels ?? []).length > 0) {
      throw new BoardError(
        'precondition',
        `${spec.labels?.length ?? 0} label(s) (e.g. ${JSON.stringify(spec.labels?.[0] ?? '')}) cannot be recorded — this board has no labels property configured`,
      );
    }
    // Idempotency by key, like every real adapter: the same key yields ONE item.
    const key = spec.idempotencyKey ?? spec.title;
    for (const [id, entry] of this.items) {
      if (entry.body.includes(key)) {
        // ...and an idempotent hit COMPLETES a copy that is missing its text, the way the Notion
        // adapter appends a body it never carried. Without this the double would be the only board
        // where a resync could not repair anything, and the repair would go untested.
        const wanted = spec.body ?? '';
        if (wanted.length > 0 && !entry.body.includes(wanted)) {
          entry.body = `${wanted}\n${key}`;
          entry.item = { ...entry.item, body: wanted };
          this.repairs.push(id);
        }
        // Labels are completed the same way — a page that was filed before labels were projected
        // carries none, and a rebuild must not leave it that way. Only an EMPTY field is filled.
        const wantedLabels = spec.labels ?? [];
        if (wantedLabels.length > 0 && entry.item.labels.length === 0) {
          entry.item = { ...entry.item, labels: wantedLabels };
          this.repairs.push(id);
        }
        return { item: entry.item, created: false };
      }
    }
    const id = `m${this.nextId++}`;
    const item: BoardWorkItem = {
      id,
      title: spec.title,
      body: spec.body ?? '',
      url: `recording://${id}`,
      // `spec.state ?? 'ready'` — exactly what all six real adapters do. This double used to hardcode
      // `ready`, which is why it never noticed that the projection created every mirror item as ready
      // and then asked for an illegal `ready -> merged` transition.
      state: spec.state ?? 'ready',
      // The caller's labels, as every real adapter records them. This hardcoded `[]` until labels
      // were projected: a double that ignores a field cannot tell you the field is being dropped.
      labels: spec.labels ?? [],
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
  const { log, seen } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });
  // The mirror's copy exists BEFORE the state change, so this exercises a real TRANSITION on the
  // mirror. (It used to exercise the create path with a `ready` copy, because the copy was always
  // created at `ready` and then walked — a walk that is not legal, which resync finally exposed.)
  const item = await board.createWork({ title: 'real work', body: 'b', labels: [] });
  mirror.failTransition = true; // e.g. the Notion column does not have that option

  // The primary's transition MUST succeed: a decorative board may not block or delay real work.
  await board.transition(item.item.id, 'pr_open', { runId: 'r1' });
  assert.equal(primary.items.get(item.item.id)!.item.state, 'pr_open');
  // And the failure is reported, naming the mirror and the state it could not take.
  const failure = seen.find((l) => l.kind === 'mirror.failed');
  assert.ok(failure !== undefined, `a projection failure must be loud: ${seen.map((l) => l.kind).join(',')}`);
  assert.match(String(failure?.message), /state pr_open not projected onto notion/);
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

test('mirror: a projection OPENS in the state it is projected for (no illegal walk exists)', async () => {
  const primary = new RecordingBoard(caps({ canCreateWork: true, comments: true }));
  primary.items.set('P-1', {
    item: { id: 'P-1', title: 'in flight', body: '', url: 'primary://P-1', state: 'pr_open', labels: [], assignees: [], updatedAt: '2026-09-17T00:00:00.000Z' },
    body: '',
  });
  const mirror = new RecordingBoard(caps({ canCreateWork: true, comments: true }));
  const { log } = lines();
  const board = new MirroringBoard(primary, [{ id: 'mirror-a', board: mirror }], { events: log });

  // A resync is the case that has no history to replay: the mirror starts EMPTY and must reach the
  // item's CURRENT state. `ready -> pr_open` is not a legal transition, so the only honest way there
  // is to create the copy in `pr_open` — which every adapter already supports via `spec.state`.
  const report = await board.resync();
  assert.deepEqual(report, [{ mirror: 'mirror-a', projected: 1, failed: 0 }]);
  const projected = [...mirror.items.values()][0]?.item;
  assert.equal(projected?.state, 'pr_open', 'the projection is in the state the item is actually in');
  assert.equal(log.of('mirror.failed').length, 0);
});

test('mirror: an item that comments reached FIRST is created in its real state, not at ready', async () => {
  const primary = new RecordingBoard(caps({ canCreateWork: true, comments: true }));
  primary.items.set('P-2', {
    item: { id: 'P-2', title: 'already merged', body: '', url: 'primary://P-2', state: 'merged', labels: [], assignees: [], updatedAt: '2026-09-17T00:00:00.000Z' },
    body: '',
  });
  const mirror = new RecordingBoard(caps({ canCreateWork: true, comments: true }));
  const board = new MirroringBoard(primary, [{ id: 'mirror-a', board: mirror }], { events: lines().log });

  // A comment can be the first thing a mirror hears about an item (the mirror was configured while
  // work was in flight). Reading the state from the authority is what keeps the copy from claiming
  // `ready` about work that is already merged.
  await board.comment('P-2', 'delivered and merged: https://example.invalid/pr/2', { runId: 'r0000001' });
  assert.equal([...mirror.items.values()][0]?.item.state, 'merged');
  assert.equal(mirror.comments.length, 1, 'and the comment still lands');
});

// --- labels, and a rebuild that can actually complete a copy -------------------------

test('a mirror carries the labels the authority carries', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'labelled work', body: 'the body', labels: ['flaky', 'p1'] });
  const { log } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });

  await board.transition(item.item.id, 'pr_open', { runId: 'r1' });

  const copy = [...mirror.items.values()][0];
  assert.deepEqual(copy?.item.labels, ['flaky', 'p1'], 'a mirror that drops labels drops part of the item');
  assert.equal(log.of('mirror.failed').length, 0);
});

test('a mirror whose board cannot record labels FAILS LOUDLY rather than filing the item bare', async () => {
  const { primary, mirror } = primaryWithItem();
  mirror.refuseLabels = true;
  const item = await primary.createWork({ title: 'labelled work', body: 'b', labels: ['flaky'] });
  const { log, seen } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });

  await board.transition(item.item.id, 'pr_open', { runId: 'r1' });

  // The delivery is untouched (rule 2) and the refusal is not silent: the operator is told that
  // this board cannot hold labels, which is a configuration answer, not something to work around
  // by filing rows without them.
  assert.equal(primary.items.get(item.item.id)?.item.state, 'pr_open');
  assert.equal([...mirror.items.values()].length, 0, 'nothing is filed bare');
  const failure = seen.find((l) => l.kind === 'mirror.failed');
  assert.ok(failure !== undefined);
  assert.match(String(failure?.message), /could not create the mirror item/);
  assert.match(String(failure?.message), /labels property/);

  // ...and the answer to it is one word of configuration, which then projects the item.
  const optedOut = new MirroringBoard(primary, [{ id: 'notion', board: mirror, labels: false }], { events: lines().log, runId: 'r2' });
  await optedOut.transition(item.item.id, 'pr_open', { runId: 'r2' });
  assert.equal([...mirror.items.values()].length, 1, 'with `labels: false` the row is filed, without its labels');
  assert.deepEqual([...mirror.items.values()][0]?.item.labels, []);
});

test('resync RE-ASSERTS the create, so a copy missing its text or labels is completed', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'real work', body: 'the body', labels: ['p2'] });
  primary.items.get(item.item.id)!.item = { ...item.item, state: 'merged' };
  const { log } = lines();

  // A copy filed by an OLDER version of this code: it exists, it carries the idempotency key, and
  // it has neither the text nor the labels. This is exactly what a Notion page filed before bodies
  // were carried looks like.
  mirror.items.set('m-old', {
    item: {
      id: 'm-old',
      title: 'real work',
      body: '',
      url: 'recording://m-old',
      state: 'merged',
      labels: [],
      assignees: [],
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
    body: `mirror:recording:${item.item.id}`,
  });

  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });
  // The map KNOWS the copy — which is precisely why the re-assert has to happen: an id in a cache
  // cannot tell anyone that the copy is incomplete.
  board.loadIdMap({ [item.item.id]: { notion: 'm-old' } });
  const report = await board.resync();

  assert.deepEqual(report, [{ mirror: 'notion', projected: 1, failed: 0 }]);
  assert.equal([...mirror.items.values()].length, 1, 're-assertion must not file a second copy');
  const copy = mirror.items.get('m-old')!;
  // The copy's text is the item's text plus the identity marker: the mirror wraps what it projects.
  assert.equal(
    copy.item.body,
    `the body\n\n${mirrorMarker(item.item.id)}\n`,
    'the text the copy never got is filled in',
  );
  assert.deepEqual(copy.item.labels, ['p2'], 'and so are its labels');
  assert.ok(
    mirror.calls.filter((c) => c.startsWith('createWork')).length >= 1,
    'resync must go through the create path, not trust the map',
  );
  // Two repairs, one per missing field (the text, then the labels): both are completed in the
  // same re-assert, because a rebuild cannot know which one a particular copy is missing.
  assert.deepEqual(mirror.repairs, ['m-old', 'm-old']);
});

test('resync: an idempotent re-assert reports a creation ONCE, and only when it created', async () => {
  const { primary, mirror } = primaryWithItem();
  const item = await primary.createWork({ title: 'real work', body: 'the body', labels: [] });
  const { log, seen } = lines();
  const board = new MirroringBoard(primary, [{ id: 'notion', board: mirror }], { events: log, runId: 'r1' });

  await board.transition(item.item.id, 'claimed', { runId: 'r1' });
  assert.equal(seen.filter((l) => /created the mirror item/.test(String(l.message))).length, 1);

  await board.resync();
  // "created the mirror item" is a claim about a page appearing on the board. A re-assert creates
  // nothing, so repeating it would be the projection telling its reader about a duplicate that
  // never happened — the mirror side of the honesty rule.
  assert.equal(
    seen.filter((l) => /created the mirror item/.test(String(l.message))).length,
    1,
    'a re-assert must not claim to have created anything',
  );
});
