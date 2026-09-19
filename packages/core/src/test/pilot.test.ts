import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireSlot,
  assertTransition,
  BoardError,
  createEventLog,
  DeliveryError,
  ProviderError,
  runPilotTick,
} from '../index.js';
import type {
  BoardBootstrapReport,
  BoardCapabilities,
  BoardCommentRef,
  BoardStateRecord,
  BoardWorkItem,
  BoardWorkItemState,
  ClaimResult,
  CheckSummary,
  DeliveryCapabilities,
  DeliveryOutcome,
  DeliveryProvider,
  DeliveryRequest,
  MergeOutcome,
  PullRequestRef,
  PullRequestStatus,
  TaskBoardProvider,
  WorktreeHandle,
} from '../index.js';

/**
 * The pilot's tests use in-file doubles rather than the packages built on top of
 * core: a cycle (core test importing a board package) would hide the coupling this
 * layer exists to prevent. Everything here is offline and takes milliseconds.
 */

const RUN = 'c0ffee01';
const BASE = 'a'.repeat(40);

class PilotBoard implements TaskBoardProvider {
  readonly items = new Map<string, { state: BoardWorkItemState; labels: string[]; claim?: string }>();
  readonly transitions: string[] = [];
  readonly comments: string[] = [];
  readonly records = new Map<string, BoardStateRecord>();

  constructor(seed: Array<{ id: string; state?: BoardWorkItemState; labels?: string[] }>) {
    for (const entry of seed) {
      this.items.set(entry.id, { state: entry.state ?? 'ready', labels: entry.labels ?? [] });
    }
  }

  metadata() {
    return { id: 'pilot-probe', name: 'Pilot Probe Board', version: '0.1.0' };
  }
  capabilities(): BoardCapabilities {
    return {
      states: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'],
      comments: true,
      editableComment: true,
      trustedAuthorFilter: true,
      machineReadableState: true,
      atomicClaim: true,
      canBootstrapStates: true,
      delivery: { canOpenPullRequest: true, canRunChecks: true, canMerge: true },
    };
  }
  private workItem(id: string): BoardWorkItem {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    return {
      id,
      title: `Item ${id}`,
      body: '',
      url: `https://board.example/${id}`,
      state: entry.state,
      labels: [...entry.labels],
      assignees: [],
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
  }
  /** Seed the state record a previous run left on an item. */
  seedRecord(id: string, runId: string, updatedAt: string, reviewRound = 0): void {
    this.records.set(id, { schema: 1, runId, item: id, reviewRound, updatedAt, baseBranch: 'main' });
  }

  async listWork(query: { states?: readonly BoardWorkItemState[] } = {}): Promise<BoardWorkItem[]> {
    const wanted = query.states ?? (['ready'] as readonly BoardWorkItemState[]);
    return [...this.items.keys()]
      .filter((id) => wanted.includes(this.items.get(id)?.state ?? 'ready'))
      .map((id) => this.workItem(id));
  }
  async getWork(id: string): Promise<BoardWorkItem> {
    return this.workItem(id);
  }
  async claim(id: string, runId: string): Promise<ClaimResult> {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    if (entry.claim !== undefined) return { item: id, runId, claimed: false, reason: `already claimed by ${entry.claim}` };
    entry.claim = runId;
    entry.state = 'claimed';
    return { item: id, runId, claimed: true };
  }
  async transition(id: string, to: BoardWorkItemState): Promise<void> {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    assertTransition(entry.state, to);
    entry.state = to;
    this.transitions.push(to);
  }
  async comment(id: string, body: string, opts: { runId: string }): Promise<BoardCommentRef> {
    this.comments.push(body);
    return { item: id, comment: `c${this.comments.length}`, runId: opts.runId };
  }
  async updateComment(): Promise<void> {}
  async readState(id: string): Promise<BoardStateRecord | null> {
    return this.records.get(id) ?? null;
  }
  async writeState(id: string, record: BoardStateRecord): Promise<void> {
    this.records.set(id, record);
  }
  async bootstrapStates(desired: readonly BoardWorkItemState[]): Promise<BoardBootstrapReport> {
    return {
      provider: this.metadata().id,
      applied: false,
      actions: desired.map((state) => ({ state, name: `state:${state}`, outcome: 'exists' as const })),
      unsupported: [],
    };
  }
}

class PilotDelivery implements DeliveryProvider {
  headSha = `${'b'.repeat(12)}commit000001`;
  dirty = false;
  checkRuns: CheckSummary[] = [];
  mergeable: boolean | null = true;
  merged = false;
  prCount = 0;
  private readonly pr: PullRequestRef = { number: '1', url: 'https://host.example/pull/1', headSha: BASE, baseSha: 'main' };

  metadata() {
    return { id: 'pilot-delivery', name: 'Pilot Probe Delivery', version: '0.1.0' };
  }
  capabilities(): DeliveryCapabilities {
    return { canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true };
  }
  async deliver(req: DeliveryRequest, base: { baseSha: string }): Promise<DeliveryOutcome> {
    if (this.dirty) throw new DeliveryError('precondition', 'the worktree has uncommitted changes', { item: req.itemId });
    if (this.headSha === base.baseSha) throw new DeliveryError('precondition', 'no commit on the branch', { item: req.itemId });
    const created = this.prCount === 0;
    if (created) this.prCount = 1;
    this.pr.headSha = this.headSha;
    return {
      created,
      pr: { ...this.pr },
      push: { mode: 'plain', branch: req.branch, head: this.headSha },
      notes: [],
    };
  }
  async status(): Promise<PullRequestStatus> {
    return { state: this.merged ? 'merged' : 'open', mergeable: this.mergeable, headSha: this.pr.headSha, baseSha: 'main' };
  }
  async checks(): Promise<CheckSummary[]> {
    return this.checkRuns;
  }
  async merge(ref: PullRequestRef, opts: { expectedHeadSha: string; method?: 'merge' | 'squash' | 'rebase' }): Promise<MergeOutcome> {
    if (this.pr.headSha !== opts.expectedHeadSha) {
      throw new DeliveryError('precondition', `the head moved: reviewed ${opts.expectedHeadSha}, remote ${this.pr.headSha}`);
    }
    this.merged = true;
    return { merged: true, method: opts.method ?? 'merge', headSha: opts.expectedHeadSha, url: ref.url };
  }
}

function harness(seed: Array<{ id: string; state?: BoardWorkItemState; labels?: string[] }>, policy: Partial<{ reviewMode: 'checks-only' | 'label'; approvalLabel: string }> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-pilot-'));
  const board = new PilotBoard(seed);
  const delivery = new PilotDelivery();
  const worktrees: string[] = [];
  let slumber = 0;
  const deps = {
    board,
    delivery,
    repo: '/tmp/takumi-pilot-repo',
    worktreeRoot: join(dir, 'worktrees'),
    baseBranch: 'main',
    resolveBaseSha: async () => BASE,
    prepareWorktree: async (item: BoardWorkItem, runId: string): Promise<WorktreeHandle> => {
      const path = join(dir, 'worktrees', `${item.id}-${runId}`);
      worktrees.push(path);
      return { path, branch: `takumi/${item.id}-${runId}`, baseSha: BASE };
    },
    agent: async () => {},
    policy: { reviewMode: policy.reviewMode ?? 'checks-only', ...(policy.approvalLabel === undefined ? {} : { approvalLabel: policy.approvalLabel }) } as const,
    slotDir: join(dir, 'slots'),
    sleep: async (seconds: number) => {
      slumber += seconds;
    },
  };
  return {
    deps,
    board,
    delivery,
    worktrees,
    sleptSeconds: () => slumber,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    dir,
  };
}

test('runPilotTick: nothing ready is `idle`, not an error', async () => {
  const h = harness([]);
  try {
    const log = createEventLog();
    const result = await runPilotTick({ ...h.deps, events: log });
    assert.equal(result.outcome, 'idle');
    assert.deepEqual(log.of('pilot.idle').length, 1);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: selects one ready item, runs the agent, and merges through the loop', async () => {
  const h = harness([{ id: 'ITEM-1' }, { id: 'ITEM-2' }]);
  try {
    const log = createEventLog();
    const rounds: number[] = [];
    const result = await runPilotTick({
      ...h.deps,
      events: log,
      agent: async ({ round, worktree }) => {
        rounds.push(round);
        assert.ok(worktree.includes('ITEM-1'), 'the agent works in the item’s own worktree');
      },
    });

    assert.equal(result.outcome, 'delivered');
    assert.equal(result.itemId, 'ITEM-1', 'the first ready item is taken');
    assert.deepEqual(rounds, [0]);
    assert.equal(h.delivery.merged, true);
    assert.equal((await h.board.getWork('ITEM-1')).state, 'merged');
    assert.equal((await h.board.getWork('ITEM-2')).state, 'ready', 'the second item is left for the next tick');
    assert.deepEqual(log.of('pilot.item_selected').length, 1);
    assert.deepEqual(log.of('worktree.created').length, 1);
    assert.deepEqual(log.of('pilot.tick_done').length, 1);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: skips an item another runner holds and takes the next one', async () => {
  const h = harness([{ id: 'ITEM-1' }, { id: 'ITEM-2' }]);
  try {
    const held = acquireSlot({ dir: h.deps.slotDir, key: 'ITEM-1', owner: { runId: 'otherrun' } });
    const log = createEventLog();
    const result = await runPilotTick({ ...h.deps, events: log });
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.itemId, 'ITEM-2', 'the contended item is skipped, not waited on');
    assert.equal(log.of('pilot.item_skipped').length, 1);
    held.handle?.release();
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: every ready item held means `busy`, and the board is untouched', async () => {
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    const held = acquireSlot({ dir: h.deps.slotDir, key: 'ITEM-1', owner: { runId: 'otherrun' } });
    const result = await runPilotTick(h.deps);
    assert.equal(result.outcome, 'busy');
    assert.deepEqual(h.board.transitions, []);
    assert.equal(h.delivery.prCount, 0);
    held.handle?.release();
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: reviewMode label waits for a human without burning a round', async () => {
  const h = harness([{ id: 'ITEM-1' }], { reviewMode: 'label', approvalLabel: 'takumi-approved' });
  try {
    const log = createEventLog();
    const result = await runPilotTick({ ...h.deps, events: log });

    assert.equal(result.outcome, 'awaiting_review');
    assert.match(result.detail, /takumi-approved/);
    assert.equal(h.delivery.merged, false, 'an unapproved change must not merge');
    assert.equal((await h.board.getWork('ITEM-1')).state, 'pr_open');
    assert.equal(
      h.board.transitions.includes('fix_needed'),
      false,
      'waiting for a human is not a defect, so it must not ask the agent to fix anything',
    );
    assert.equal(log.of('review.awaiting_human').length, 1);
    assert.deepEqual(h.board.transitions, ['pr_open']);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: reviewMode label merges once the human approves', async () => {
  const h = harness([{ id: 'ITEM-1', labels: ['takumi-approved'] }], {
    reviewMode: 'label',
    approvalLabel: 'takumi-approved',
  });
  try {
    const result = await runPilotTick(h.deps);
    assert.equal(result.outcome, 'delivered');
    assert.equal(h.delivery.merged, true);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: a transport failure runs the agent again, after a delay', async () => {
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    const log = createEventLog();
    let attempts = 0;
    const result = await runPilotTick({
      ...h.deps,
      events: log,
      policy: { reviewMode: 'checks-only', agentRetries: 2, agentRetryDelaySeconds: 5 },
      agent: async () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderError('transport', 'the model endpoint reset the connection');
      },
    });

    assert.equal(result.outcome, 'delivered');
    assert.equal(attempts, 3);
    assert.equal(h.sleptSeconds(), 10, 'two retries, two delays');
    assert.equal(log.of('agent.retry').length, 2, 'the retry wrapper reports the retries');
    assert.equal(
      log.of('agent.finished').length,
      1,
      'and ONLY the loop reports the agent finishing: one event per fact',
    );
    assert.equal(log.of('agent.started').length, 1);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: an agent that keeps failing on transport stops retrying', async () => {
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    let attempts = 0;
    const result = await runPilotTick({
      ...h.deps,
      policy: { reviewMode: 'checks-only', agentRetries: 1, agentRetryDelaySeconds: 1 },
      agent: async () => {
        attempts += 1;
        throw new ProviderError('transport', 'still down');
      },
    });

    assert.equal(attempts, 2, 'the first attempt plus one retry');
    assert.equal(result.outcome, 'retriable');
    // A retriable failure BEFORE anything was delivered must not block the item for
    // a human: the next tick can pick it up. It stays claimed, which the detail says.
    assert.match(result.detail, /still down/);
    assert.equal(h.delivery.prCount, 0);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: an agent that fails for a real reason blocks the item', async () => {
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    const result = await runPilotTick({
      ...h.deps,
      agent: async () => {
        throw new ProviderError('auth', 'the agent token expired');
      },
    });
    assert.equal(result.outcome, 'blocked');
    assert.match(result.detail, /token expired/);
    assert.equal((await h.board.getWork('ITEM-1')).state, 'blocked');
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: an agent that commits nothing is a blocked precondition, not a silent idle', async () => {
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    // The delivery refuses because HEAD still equals the frozen base.
    h.delivery.headSha = BASE;
    const result = await runPilotTick(h.deps);
    assert.equal(result.outcome, 'blocked');
    assert.match(result.detail, /no commit/);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: the item slot is released whatever the outcome', async () => {
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    await runPilotTick(h.deps);
    const lockPath = join(h.deps.slotDir, 'ITEM-1.lock');
    assert.equal(existsSync(lockPath), false, 'the lock file must be gone after the tick');
    const reacquire = acquireSlot({ dir: h.deps.slotDir, key: 'ITEM-1', owner: { runId: 'another1' } });
    assert.equal(reacquire.acquired, true);
    reacquire.handle?.release();
  } finally {
    h.cleanup();
  }
});

test('pilotRunId: eight lowercase hex, which is the grammar every reader expects', async () => {
  const { pilotRunId } = await import('../index.js');
  for (const seed of [0, 1, Date.now(), 1757900000000, 999999999999]) {
    assert.match(pilotRunId(seed), /^[0-9a-f]{8}$/, `seed ${seed}`);
  }
});

// --- the sweep: what a stopped run left behind (ADR-009's known limit) -------

test('runPilotTick: a stale claim is handed to a human, and the tick still works', async () => {
  const h = harness([{ id: 'ITEM-1' }, { id: 'ITEM-9', state: 'claimed' }]);
  try {
    h.board.seedRecord('ITEM-9', 'deadbeef', '2026-09-15T00:00:00.000Z');
    const log = createEventLog();
    const at = Date.parse('2026-09-15T00:30:00.000Z'); // half an hour later
    const result = await runPilotTick({
      ...h.deps,
      events: log,
      now: () => at,
      policy: { reviewMode: 'checks-only', blockStaleClaims: true, staleClaimSeconds: 900 },
    });

    // The sweep reports it, blocks it, and does NOT cost the tick its real work.
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.itemId, 'ITEM-1');
    assert.equal((await h.board.getWork('ITEM-9')).state, 'blocked');
    assert.equal(log.of('pilot.in_flight').length, 1);
    assert.match(log.of('pilot.in_flight')[0]?.message ?? '', /claimed for 1800s \(run deadbeef\)/);
    assert.equal(log.of('pilot.stale_claim_blocked').length, 1);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: a fresh claim is reported but never touched', async () => {
  const h = harness([{ id: 'ITEM-9', state: 'claimed' }]);
  try {
    h.board.seedRecord('ITEM-9', 'runnning', '2026-09-15T00:29:00.000Z');
    const log = createEventLog();
    const result = await runPilotTick({
      ...h.deps,
      events: log,
      now: () => Date.parse('2026-09-15T00:30:00.000Z'),
      policy: { reviewMode: 'checks-only', blockStaleClaims: true, staleClaimSeconds: 900 },
    });
    assert.equal(result.outcome, 'idle', 'nothing is ready, and the in-flight item stays in flight');
    assert.equal((await h.board.getWork('ITEM-9')).state, 'claimed');
    assert.equal(log.of('pilot.in_flight').length, 1);
    assert.equal(log.of('pilot.stale_claim_blocked').length, 0);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: a stale claim is left alone unless the operator opts in', async () => {
  const h = harness([{ id: 'ITEM-9', state: 'claimed' }]);
  try {
    h.board.seedRecord('ITEM-9', 'deadbeef', '2026-09-01T00:00:00.000Z');
    const log = createEventLog();
    await runPilotTick({ ...h.deps, events: log, policy: { reviewMode: 'checks-only' } });
    assert.equal((await h.board.getWork('ITEM-9')).state, 'claimed');
    assert.equal(log.of('pilot.in_flight').length, 1, 'still visible in the trail');
    assert.equal(log.of('pilot.stale_claim_blocked').length, 0);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: an open pull request is never swept — that is a human decision', async () => {
  const h = harness([{ id: 'ITEM-8', state: 'pr_open' }]);
  try {
    h.board.seedRecord('ITEM-8', 'deadbeef', '2026-08-01T00:00:00.000Z');
    const log = createEventLog();
    await runPilotTick({
      ...h.deps,
      events: log,
      policy: { reviewMode: 'checks-only', blockStaleClaims: true, staleClaimSeconds: 60 },
    });
    assert.equal((await h.board.getWork('ITEM-8')).state, 'pr_open');
    assert.equal(log.of('pilot.stale_claim_blocked').length, 0);
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: the policy’s pacing knobs reach the delivery loop', async () => {
  // A policy knob the tick accepts and then drops is the same silent drop as a config
  // option nothing reads, so this asserts the EFFECT (the block message names the budget)
  // rather than that the object was passed along.
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    h.delivery.checkRuns = [{ name: 'e2e', conclusion: 'pending' }];
    const result = await runPilotTick({
      ...h.deps,
      policy: { reviewMode: 'checks-only', checksWaitSeconds: 45, checksPollSeconds: 15 },
      sleep: async () => {},
    });
    assert.equal(result.outcome, 'blocked');
    assert.match(result.detail, /still pending after 45s/, 'the pilot must hand checksWaitSeconds to the loop');
    assert.equal(result.checksWaitedSeconds, undefined, 'a run that never settled waited no measurable time');
  } finally {
    h.cleanup();
  }
});

test('runPilotTick: a settled wait is reported as a number, not parsed from text', async () => {
  const h = harness([{ id: 'ITEM-1' }]);
  try {
    let polls = 0;
    h.delivery.checks = async () => {
      polls += 1;
      return polls <= 2 ? [{ name: 'e2e', conclusion: 'pending' as const }] : [{ name: 'e2e', conclusion: 'success' as const }];
    };
    const result = await runPilotTick({
      ...h.deps,
      policy: { reviewMode: 'checks-only', checksWaitSeconds: 60, checksPollSeconds: 15 },
      sleep: async () => {},
    });
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.checksWaitedSeconds, 30);
  } finally {
    h.cleanup();
  }
});
