import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSlot,
  BoardError,
  BoardUnsupportedError,
  createEventLog,
  DeliveryError,
  formatEventLine,
  ProviderError,
  assertTransition,
  runDeliveryLoop,
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
  DeliveryBase,
  DeliveryCapabilities,
  DeliveryOutcome,
  DeliveryProvider,
  DeliveryRequest,
  MergeOutcome,
  PullRequestRef,
  PullRequestStatus,
  TaskBoardProvider,
} from '../index.js';

/**
 * The loop is core logic, so it is tested against in-file doubles rather than
 * against the packages built on top of it — a cycle (core test depending on a
 * board package) would hide exactly the coupling this layer exists to prevent.
 */

const RUN = 'c0ffee01';
const BASE = 'a'.repeat(40);
const COMMIT_1 = `${'b'.repeat(12)}commit000001`;
const COMMIT_2 = `${'b'.repeat(12)}commit000002`;

class LoopBoard implements TaskBoardProvider {
  readonly items = new Map<string, { state: BoardWorkItemState; claim?: string }>();
  readonly seen: string[] = [];
  readonly comments: string[] = [];
  private records = new Map<string, BoardStateRecord>();

  constructor(id: string, state: BoardWorkItemState = 'ready') {
    this.items.set(id, { state });
  }

  metadata() {
    return { id: 'loop-probe', name: 'Loop Probe Board', version: '0.1.0' };
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
      canCreateWork: true,
      canTextSearch: true,
      delivery: { canOpenPullRequest: true, canRunChecks: true, canMerge: true },
    };
  }
  async listWork(): Promise<BoardWorkItem[]> {
    return [...this.items.entries()].map(([id, e]) => ({
      id,
      title: id,
      body: '',
      url: `https://board.example/${id}`,
      state: e.state,
      labels: [],
      assignees: [],
      updatedAt: '2026-09-15T00:00:00.000Z',
    }));
  }
  async getWork(id: string): Promise<BoardWorkItem> {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    return {
      id,
      title: id,
      body: '',
      url: `https://board.example/${id}`,
      state: entry.state,
      labels: [],
      assignees: [],
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
  }
  async claim(id: string, runId: string): Promise<ClaimResult> {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    if (entry.claim !== undefined) return { item: id, runId, claimed: false, reason: `already claimed by ${entry.claim}` };
    if (entry.state !== 'ready') return { item: id, runId, claimed: false, reason: `item is in state ${entry.state}, not ready` };
    entry.claim = runId;
    entry.state = 'claimed';
    this.seen.push('claimed');
    return { item: id, runId, claimed: true };
  }
  async transition(id: string, to: BoardWorkItemState): Promise<void> {
    const entry = this.items.get(id);
    if (!entry) throw new BoardError('not_found', `no such item: ${id}`, { item: id });
    assertTransition(entry.state, to);
    this.seen.push(to);
    entry.state = to;
  }
  async comment(id: string, body: string, opts: { runId: string }): Promise<BoardCommentRef> {
    this.comments.push(body);
    return { item: id, comment: `c${this.comments.length}`, runId: opts.runId };
  }
  async updateComment(): Promise<void> {
    return;
  }
  async readState(id: string): Promise<BoardStateRecord | null> {
    return this.records.get(id) ?? null;
  }
  /** Seed what the board already had before the run: a resumed delivery, with its digest. */
  seedRecord(id: string, record: BoardStateRecord): void {
    this.records.set(id, record);
  }

  async writeState(id: string, record: BoardStateRecord): Promise<void> {
    this.records.set(id, record);
    this.seen.push(`record:round${record.reviewRound}`);
  }
  /** Items this double filed, in order, with the key each was filed under. */
  readonly filed: Array<{ id: string; title: string; body: string; key?: string }> = [];
  /** Set to make filing fail, so the fail-soft rule can be tested. */
  failCreate: Error | null = null;

  async createWork(spec: { title: string; body?: string; state?: BoardWorkItemState; idempotencyKey?: string }): Promise<{ item: BoardWorkItem; created: boolean }> {
    if (!this.capabilities().canCreateWork) {
      throw new BoardUnsupportedError('canCreateWork', this.metadata().id);
    }
    if (this.failCreate !== null) throw this.failCreate;
    const existing = spec.idempotencyKey === undefined ? undefined : this.filed.find((f) => f.key === spec.idempotencyKey);
    if (existing !== undefined) {
      return { item: { id: existing.id, title: existing.title, body: existing.body, url: `https://board.example/${existing.id}`, state: 'ready', labels: [], assignees: [], updatedAt: '2026-09-15T00:00:00.000Z' }, created: false };
    }
    const id = `NEW-${this.filed.length + 1}`;
    const body = spec.body ?? '';
    this.filed.push({ id, title: spec.title, body, ...(spec.idempotencyKey === undefined ? {} : { key: spec.idempotencyKey }) });
    this.items.set(id, { state: spec.state ?? 'ready' });
    return { item: { id, title: spec.title, body, url: `https://board.example/${id}`, state: spec.state ?? 'ready', labels: [], assignees: [], updatedAt: '2026-09-15T00:00:00.000Z' }, created: true };
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

class LoopDelivery implements DeliveryProvider {
  headSha: string;
  dirty = false;
  /** What `checks()` will report (named apart from the port method on purpose). */
  checkRuns: CheckSummary[] = [];
  mergeable: boolean | null = true;
  merged = false;
  pushCount = 0;
  prCount = 0;
  failNextDeliver: ProviderError | undefined;
  private readonly pr: PullRequestRef = { number: '1', url: 'https://host.example/pull/1', headSha: COMMIT_1, baseSha: 'main' };

  constructor(private readonly base: string) {
    this.headSha = COMMIT_1;
  }

  metadata() {
    return { id: 'loop-delivery', name: 'Loop Probe Delivery', version: '0.1.0' };
  }
  capabilities(): DeliveryCapabilities {
    return { canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true };
  }
  async deliver(req: DeliveryRequest, base: DeliveryBase): Promise<DeliveryOutcome> {
    if (this.failNextDeliver !== undefined) {
      const error = this.failNextDeliver;
      this.failNextDeliver = undefined;
      throw error;
    }
    if (this.dirty) throw new DeliveryError('precondition', 'the worktree has uncommitted changes', { item: req.itemId });
    if (this.headSha === base.baseSha) throw new DeliveryError('precondition', 'no commit on the branch', { item: req.itemId });
    this.pushCount += 1;
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
  async status(ref: PullRequestRef): Promise<PullRequestStatus> {
    return { state: this.merged ? 'merged' : 'open', mergeable: this.mergeable, headSha: this.pr.headSha, baseSha: this.pr.baseSha };
  }
  async checks(_ref: PullRequestRef): Promise<CheckSummary[]> {
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

const plan = {
  worktree: '/tmp/takumi-loop-worktree',
  branch: 'takumi/issue-7-c0ffee01',
  baseBranch: 'main',
  itemId: 'ITEM-7',
  runId: RUN,
  baseSha: BASE,
};

function harness(opts: { rounds?: number; board?: LoopBoard; delivery?: LoopDelivery } = {}) {
  const board = opts.board ?? new LoopBoard('ITEM-7');
  const delivery = opts.delivery ?? new LoopDelivery(BASE);
  return { board, delivery };
}

test('runDeliveryLoop: the happy path claims, delivers, reviews and merges', async () => {
  const { board, delivery } = harness();
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    hooks: {
      agent: async () => {
        delivery.headSha = COMMIT_1;
      },
      review: async () => ({ verdict: 'clean' }),
    },
  });

  assert.equal(result.outcome, 'merged');
  assert.equal(result.rounds, 1);
  assert.equal(delivery.pushCount, 1);
  assert.equal(delivery.prCount, 1);
  assert.equal(delivery.merged, true);
  assert.equal((await board.getWork('ITEM-7')).state, 'merged');
  assert.deepEqual(board.seen.filter((s) => !s.startsWith('record')), ['claimed', 'pr_open', 'merged']);
  assert.equal(board.comments.length, 1, 'the merged delivery is announced on the board');
  const steps = result.steps.map((s) => s.step);
  // deliver → the pr_open transition → checks → review → merge → the merged transition
  assert.deepEqual(steps, ['claim', 'agent', 'deliver', 'transition', 'checks', 'review', 'merge', 'transition']);
});

test('runDeliveryLoop: findings cause a fix round, then the merge lands on the new head', async () => {
  const { board, delivery } = harness();
  let reviews = 0;
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    hooks: {
      agent: async ({ round }) => {
        // The fix round produces a NEW commit; only the re-reviewed head may merge.
        delivery.headSha = round === 0 ? COMMIT_1 : COMMIT_2;
      },
      review: async ({ headSha }) => {
        reviews += 1;
        if (reviews === 1) return { verdict: 'findings', note: 'missing null check' };
        assert.equal(headSha, COMMIT_2, 'round 2 must review the NEW head');
        return { verdict: 'clean' };
      },
    },
  });

  assert.equal(result.outcome, 'merged');
  assert.equal(result.rounds, 2);
  assert.equal(result.steps.at(-2)?.detail.includes(COMMIT_2.slice(0, 12)), true, 'the merged head is the re-reviewed one');
  assert.equal(delivery.prCount, 1, 'the fix round reuses the same pull request');
  assert.deepEqual(
    board.seen.filter((s) => !s.startsWith('record')),
    ['claimed', 'pr_open', 'fix_needed', 'pr_open', 'merged'],
    'the fixed delivery returns to review before it may merge',
  );
});

test('runDeliveryLoop: a dirty worktree from the agent blocks the delivery (the loop never commits)', async () => {
  const { board, delivery } = harness();
  delivery.dirty = true;
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked');
  assert.match(result.error ?? '', /uncommitted changes/);
  assert.equal(delivery.pushCount, 0);
  assert.equal((await board.getWork('ITEM-7')).state, 'blocked');
});

test('runDeliveryLoop: a pending check is waited for, and its budget is what ends the run', async () => {
  const { board, delivery } = harness();
  delivery.checkRuns = [{ name: 'e2e', conclusion: 'pending' }];
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan: { ...plan, checksWaitSeconds: 30, checksPollSeconds: 15 },
    sleep: async () => {}, // the wait is poll-counted, so a test never waits in real time
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked');
  assert.match(result.error ?? '', /still pending after 30s/);
  assert.equal(delivery.merged, false);
  // NOT 'pr_open' any more: nothing ever selects an item in review again, so leaving it
  // there was a silent stall. Blocking is visible and the comment says how to resume.
  assert.equal((await board.getWork('ITEM-7')).state, 'blocked');
});

test('runDeliveryLoop: a failed check is fixable work, and only an exhausted budget blocks', async () => {
  const { board, delivery } = harness();
  delivery.checkRuns = [{ name: 'tests', conclusion: 'failure' }];
  const rounds: number[] = [];
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan: { ...plan, maxReviewRounds: 2 },
    hooks: {
      agent: async ({ round }) => {
        rounds.push(round);
      },
      // The review is never reached: the failing check sends the item back to work.
      review: async () => {
        throw new Error('the loop must not review while a check fails');
      },
    },
  });

  assert.equal(result.outcome, 'blocked');
  assert.deepEqual(rounds, [0, 1], 'the agent got the remaining round to fix the check');
  assert.match(result.error ?? '', /check\(s\) failed: tests and no fix round left/);
  assert.equal(delivery.merged, false);
  assert.deepEqual(
    board.seen.filter((s) => !s.startsWith('record')),
    ['claimed', 'pr_open', 'fix_needed', 'pr_open', 'blocked'],
    'the fix round returns to review, the check fails again, and the exhausted budget blocks',
  );
});

test('runDeliveryLoop: a head that moves during the review is never merged', async () => {
  const { board, delivery } = harness();
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan: { ...plan, maxReviewRounds: 1 },
    hooks: {
      agent: async () => {},
      review: async () => {
        // A racing push lands during the review, so the HOST now reports a head
        // that no longer matches the one the review covered.
        delivery.status = async () => ({ state: 'open', mergeable: true, headSha: COMMIT_2, baseSha: 'main' });
        return { verdict: 'clean' };
      },
    },
  });

  assert.equal(result.outcome, 'blocked');
  assert.equal(delivery.merged, false, 'the reviewed head is gone — nothing may be merged');
  assert.match(result.steps.map((s) => s.detail).join(' '), /re-review required|no clean review/);
});

test('runDeliveryLoop: review rounds are bounded and exhaustion blocks', async () => {
  const { board, delivery } = harness();
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan: { ...plan, maxReviewRounds: 2 },
    hooks: {
      agent: async () => {},
      review: async () => ({ verdict: 'findings', note: 'still broken' }),
    },
  });

  assert.equal(result.outcome, 'blocked');
  assert.equal(result.rounds, 2);
  assert.match(result.error ?? '', /consecutive rounds/);
  assert.equal((await board.getWork('ITEM-7')).state, 'blocked');
});

test('runDeliveryLoop: a retriable failure still refuses to strand the item (this used to be the opposite)', async () => {
  // The previous version of this test asserted that a retriable failure leaves the item
  // CLAIMED and nothing else — "the next tick will pick it up". That was the defect: the
  // runner only ever selects `ready` items, so a held claim is not waiting, it is
  // invisible. The outcome stays `retriable` (the tick itself should be retried) while the
  // ITEM is handed to a human, which is the only state automation can come back from.
  const { board, delivery } = harness();
  delivery.failNextDeliver = new ProviderError('transport', 'the connection was reset');
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'retriable');
  assert.match(result.error ?? '', /connection was reset/);
  assert.deepEqual(
    board.seen.filter((s) => !s.startsWith('record')),
    ['claimed', 'blocked'],
    'the item is claimed and then blocked with the instruction that resumes it',
  );
  assert.equal((await board.getWork('ITEM-7')).state, 'blocked');
});

test('runDeliveryLoop: an item another run owns is not claimed and not touched', async () => {
  const { board, delivery } = harness();
  await board.claim('ITEM-7', 'otherrun1');
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'not_claimed');
  assert.match(result.error ?? result.steps.map((s) => s.detail).join(' '), /already claimed by otherrun1/);
  assert.equal(delivery.pushCount, 0);
});

test('runDeliveryLoop: an unsupported capability blocks with the reason, not an exception', async () => {
  const { board, delivery } = harness();
  delivery.merge = async () => {
    throw new DeliveryError('unsupported', 'provider probe does not support canMerge');
  };
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked');
  assert.match(result.error ?? '', /does not support canMerge/);
  assert.equal((await board.getWork('ITEM-7')).state, 'blocked');
});

// --- the P0 rails: an event trail and one runner per item (ADR-008) ---------

test('runDeliveryLoop: emits the documented event trail for a clean delivery', async () => {
  const { board, delivery } = harness();
  const log = createEventLog({ now: () => Date.parse('2026-09-15T02:00:00.000Z') });
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    events: log,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'merged');
  assert.deepEqual(
    log.events().map((e) => e.kind),
    [
      'claim.acquired',
      'agent.started',
      'agent.finished',
      'deliver.pushed',
      'deliver.pr_opened',
      'board.transitioned',
      'checks.read',
      'review.clean',
      'merge.done',
      'board.transitioned',
    ],
  );
  // Every event carries the run id, and every line is one parseable JSON object:
  // that is what makes the trail greppable by run.
  for (const event of log.events()) {
    assert.equal(event.runId, RUN);
    assert.equal(event.itemId, 'ITEM-7');
    assert.equal(formatEventLine(event).includes('\n'), false);
  }
  const merge = log.of('merge.done')[0];
  assert.equal(merge?.pr, '1');
  assert.equal(merge?.fields?.head, COMMIT_1);
});

test('runDeliveryLoop: a findings round and a failure are events too', async () => {
  const { board, delivery } = harness();
  const log = createEventLog();
  let reviews = 0;
  await runDeliveryLoop({
    board,
    delivery,
    plan,
    events: log,
    hooks: {
      agent: async () => {},
      review: async () => (++reviews === 1 ? { verdict: 'findings', note: 'missing case' } : { verdict: 'clean' }),
    },
  });
  assert.deepEqual(
    log.of('review.findings').map((e) => e.message),
    ['round 1: findings — missing case'],
  );
  assert.deepEqual(
    log.of('board.transitioned').map((e) => e.message),
    ['ITEM-7 → pr_open', 'ITEM-7 → fix_needed', 'ITEM-7 → pr_open', 'ITEM-7 → merged'],
  );

  const failing = harness();
  const failLog = createEventLog();
  failing.delivery.dirty = true;
  await runDeliveryLoop({
    board: failing.board,
    delivery: failing.delivery,
    plan,
    events: failLog,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });
  assert.equal(failLog.of('run.failed').length, 1);
  assert.equal(failLog.of('board.blocked').length, 1);
  assert.equal(failLog.of('run.retriable').length, 0);
});

test('runDeliveryLoop: a slot turns a second runner away instead of racing it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-loop-slots-'));
  try {
    const planWithSlot = { ...plan, slot: { dir } };
    const { board, delivery } = harness();
    const log = createEventLog();

    // Hold the slot exactly as another runner would.
    const other = acquireSlot({ dir, key: plan.itemId, owner: { runId: 'otherrun' } });
    assert.equal(other.acquired, true);
    const busy = await runDeliveryLoop({
      board,
      delivery,
      plan: planWithSlot,
      events: log,
      hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
    });
    assert.equal(busy.outcome, 'busy');
    assert.match(busy.error ?? '', /held by run otherrun/);
    assert.equal(log.of('slot.busy').length, 1);
    assert.deepEqual(board.seen, [], 'a busy run must not touch the board at all');
    assert.equal(delivery.pushCount, 0);

    // Once released, the run goes through and the trail says so.
    other.handle?.release();
    const ran = await runDeliveryLoop({
      board,
      delivery,
      plan: planWithSlot,
      events: log,
      hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
    });
    assert.equal(ran.outcome, 'merged');
    assert.equal(log.of('slot.acquired').length, 1);
    assert.equal(log.of('slot.released').length, 1);
    assert.equal(existsSync(join(dir, `${plan.itemId}.lock`)), false, 'the slot file is gone after the run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDeliveryLoop: a failed delivery releases its slot instead of wedging it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-loop-slots-'));
  try {
    const { board, delivery } = harness();
    delivery.dirty = true; // the agent left work uncommitted: a precondition failure
    const failed = await runDeliveryLoop({
      board,
      delivery,
      plan: { ...plan, slot: { dir } },
      hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
    });
    assert.equal(failed.outcome, 'blocked');
    assert.equal(existsSync(join(dir, `${plan.itemId}.lock`)), false, 'the slot must not survive a failure');
    const reacquire = acquireSlot({ dir, key: plan.itemId, owner: { runId: 'another1' } });
    assert.equal(reacquire.acquired, true);
    reacquire.handle?.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDeliveryLoop: an unregistered event kind fails loudly (the registry is closed)', async () => {
  const { board, delivery } = harness();
  const log = createEventLog();
  log.emit = () => {
    throw new ProviderError('precondition', 'unregistered event kind: "made.up"');
  };
  // The trail is a side channel, but a BUG in the emitter is not: it must surface.
  await assert.rejects(
    () =>
      runDeliveryLoop({
        board,
        delivery,
        plan,
        events: log,
        hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
      }),
    /unregistered event kind/,
  );
});

// --- the two defects this slice fixes (see docs/bugs-fixed.md #8 and #9) -----

test('runDeliveryLoop: pending checks are waited for INSIDE the tick, not abandoned', async () => {
  const h = harness();
  const log = createEventLog();
  let polls = 0;
  const original = h.delivery.checks.bind(h.delivery);
  h.delivery.checks = async () => {
    polls += 1;
    // Pending twice, then green: the ordinary case of a CI that is simply slow.
    return polls <= 2 ? [{ name: 'build', conclusion: 'pending' as const }] : [{ name: 'build', conclusion: 'success' as const }];
  };

  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, checksWaitSeconds: 60, checksPollSeconds: 15 },
    events: log,
    sleep: async () => {},
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'merged', result.error);
  assert.equal(polls, 3, 'one read that found pending, then two polls until it settled — the settled list is reused');
  const waited = log.of('checks.waited');
  assert.deepEqual(waited.map((e) => e.message), [
    'still pending after 15s: build',
    'checks settled after 30s: build=success',
  ]);
  // The item ENDED somewhere a human can see it, which is the whole point.
  assert.equal((await h.board.getWork('ITEM-7')).state, 'merged');
  void original;
});

test('runDeliveryLoop: checks that never settle block the item instead of parking it', async () => {
  const h = harness();
  h.delivery.checks = async () => [{ name: 'build', conclusion: 'pending' as const }];
  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, checksWaitSeconds: 45, checksPollSeconds: 15 },
    sleep: async () => {},
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked', 'a run that cannot finish must not leave the item owned');
  assert.match(result.error ?? '', /still pending after 45s/);
  assert.match(result.error ?? '', /checksWaitSeconds/);
  assert.equal((await h.board.getWork('ITEM-7')).state, 'blocked');
});

test('runDeliveryLoop: a retriable failure after the claim blocks the item (it would be invisible otherwise)', async () => {
  const h = harness();
  h.delivery.checks = async () => {
    throw new ProviderError('transport', 'the host closed the connection');
  };
  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'retriable', 'the tick should be retried: the failure itself was transient');
  assert.equal(
    (await h.board.getWork('ITEM-7')).state,
    'blocked',
    'but the item must NOT stay claimed, because no runner ever selects a claimed item again',
  );
  assert.match(h.board.comments.join(' ') + h.board.seen.join(' '), /blocked/);
});

test('runDeliveryLoop: a transport failure BEFORE the claim leaves the item untouched', async () => {
  const h = harness();
  // Patch the INSTANCE, never spread it: a spread class has no prototype methods, and the loop
  // legitimately calls several of them (`readState` reads the prior record before claiming).
  h.board.claim = async () => {
    throw new ProviderError('transport', 'the board is unreachable');
  };
  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });
  assert.equal(result.outcome, 'retriable');
  assert.equal((await h.board.getWork('ITEM-7')).state, 'ready', 'nothing was owned, so nothing may be marked');
});

test('runDeliveryLoop: the progress record is throttled while the loop waits', async () => {
  const h = harness();
  let polls = 0;
  h.delivery.checks = async () => {
    polls += 1;
    return polls <= 4 ? [{ name: 'build', conclusion: 'pending' as const }] : [{ name: 'build', conclusion: 'success' as const }];
  };

  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, checksWaitSeconds: 300, checksPollSeconds: 15, progressIntervalSeconds: 600 },
    now: () => Date.parse('2026-09-15T02:00:00.000Z'), // frozen: every write is "recent"
    sleep: async () => {},
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'merged');
  const writes = h.board.seen.filter((s) => s.startsWith('record:'));
  assert.equal(polls, 5, 'one read that found pending, then four polls until it settled');
  // Two progress writes — the throttle holds for PROGRESS — plus ONE forced write, the review
  // digest: progress may be coalesced, the evidence a merge is allowed to trust may not be
  // (ADR-018). If this count grows again, the question to ask is which of the two is lying.
  assert.equal(
    writes.length,
    3,
    `six checks() calls must not mean six board writes (saw ${writes.length}: ${writes.join(', ')})`,
  );
  assert.match(result.steps.map((s) => s.detail).join('\n'), /throttled \(unchanged/);
});

// --- a red pipeline becomes WORK, not a comment (createWork's reason to exist) ----

test('runDeliveryLoop: exhausted red checks FILE the failure as work, once', async () => {
  const h = harness();
  const log = createEventLog();
  h.delivery.checkRuns = [{ name: 'e2e', conclusion: 'failure' }];
  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, maxReviewRounds: 1, fileIssueOnExhaustedChecks: true },
    events: log,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked');
  assert.equal((await h.board.getWork('ITEM-7')).state, 'blocked');
  assert.equal(h.board.filed.length, 1, 'the failure became exactly one work item');
  assert.match(h.board.filed[0]?.title ?? '', /CI is red: ITEM-7 \(e2e\)/);
  assert.match(h.board.filed[0]?.body ?? '', /https:\/\/host\.example\/pull\/1/);
  assert.equal(log.of('issue.filed')[0]?.fields?.created, true);

  // A human moves the item back to ready (the only way automation resumes it) and the
  // next run hits the same red pipeline. The filing must NOT become a second issue.
  const entry = h.board.items.get('ITEM-7');
  assert.ok(entry !== undefined);
  entry.state = 'ready';
  entry.claim = undefined;
  const again = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, maxReviewRounds: 1, fileIssueOnExhaustedChecks: true },
    events: log,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });
  assert.equal(again.outcome, 'blocked');
  assert.equal(h.board.filed.length, 1, 'the same item and pull request must not file a second issue');
  assert.deepEqual(
    log.of('issue.filed').map((e) => e.fields?.created),
    [true, false],
    'the second attempt reports the first issue rather than creating one',
  );
});

test('runDeliveryLoop: a board that cannot file is told so, and the run still blocks', async () => {
  const h = harness();
  h.board.capabilities = () => ({ ...LoopBoard.prototype.capabilities.call(h.board), canCreateWork: false });
  const log = createEventLog();
  h.delivery.checkRuns = [{ name: 'e2e', conclusion: 'failure' }];
  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, maxReviewRounds: 1, fileIssueOnExhaustedChecks: true },
    events: log,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked', 'the conclusion is unchanged: filing is a side channel');
  assert.equal(h.board.filed.length, 0);
  assert.match(log.of('issue.skipped')[0]?.message ?? '', /cannot file work items/);
});

test('runDeliveryLoop: a filing that FAILS does not change the delivery conclusion', async () => {
  const h = harness();
  const log = createEventLog();
  h.board.failCreate = new ProviderError('transport', 'the board refused the write');
  h.delivery.checkRuns = [{ name: 'e2e', conclusion: 'failure' }];
  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, maxReviewRounds: 1, fileIssueOnExhaustedChecks: true },
    events: log,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked');
  assert.match(result.error ?? '', /no fix round left/);
  assert.match(log.of('issue.skipped')[0]?.message ?? '', /refused the write/);
  assert.equal((await h.board.getWork('ITEM-7')).state, 'blocked', 'the item is still handed to a human');
});

test('runDeliveryLoop: filing stays OFF unless asked for', async () => {
  const h = harness();
  h.delivery.checkRuns = [{ name: 'e2e', conclusion: 'failure' }];
  const log = createEventLog();
  await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, maxReviewRounds: 1 },
    events: log,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });
  assert.equal(h.board.filed.length, 0);
  assert.equal(log.of('issue.filed').length, 0);
  assert.equal(log.of('issue.skipped').length, 0, 'nothing is reported when the feature is off');
});

test('runDeliveryLoop: an unknown mergeability is re-read inside a bounded window, then merged', async () => {
  const { board, delivery } = harness();
  const sleeps: number[] = [];
  const realStatus = delivery.status.bind(delivery);
  let reads = 0;
  delivery.status = async (ref: PullRequestRef) => {
    reads += 1;
    const status = await realStatus(ref);
    // A host that computes mergeability asynchronously (GitLab): unknown at first, an answer
    // a moment later. Reading the first answer as a verdict is what stranded a real item.
    return reads <= 2 ? { ...status, mergeable: null } : status;
  };
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan: { ...plan, mergeabilityReads: 5, mergeabilityReadSeconds: 3 },
    sleep: async (seconds: number) => {
      sleeps.push(seconds);
    },
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'merged');
  assert.equal(reads, 3, 'two unknowns, then the answer');
  assert.deepEqual(sleeps, [3, 3], 'the window waits between reads, and only between them');
  assert.equal(delivery.merged, true);
  assert.equal((await board.getWork('ITEM-7')).state, 'merged');
});

test('runDeliveryLoop: mergeability that stays unknown blocks the item, visibly', async () => {
  const { board, delivery } = harness();
  const sleeps: number[] = [];
  delivery.status = async (ref: PullRequestRef) => ({
    state: 'open',
    mergeable: null,
    headSha: ref.headSha,
    baseSha: ref.baseSha,
  });
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan: { ...plan, mergeabilityReads: 4, mergeabilityReadSeconds: 3 },
    sleep: async (seconds: number) => {
      sleeps.push(seconds);
    },
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked', 'retriable would leave it in pr_open, where nothing looks at it again');
  assert.match(result.error ?? '', /still unknown after 4 reads over 9s/);
  assert.equal(delivery.merged, false, 'a window that ends still ends in "no"');
  assert.deepEqual(sleeps, [3, 3, 3], 'the reads are bounded by the window, not by patience');
  // A blocked item is visible AND the way back is in the trail.
  assert.equal((await board.getWork('ITEM-7')).state, 'blocked');
  assert.match(
    board.comments.join(' '),
    /move the item back to `ready`/,
    'the blocked item must carry the way back in the trail, not just a refusal',
  );
});

// --- ADR-018: a review is evidence about ONE set of inputs --------------------------

test('runDeliveryLoop: an approval that no longer matches the run is REFUSED, by name', async () => {
  const h = harness();
  // What a previous tick left on the board: a delivery, and a review digest computed under a
  // DIFFERENT policy — the case being an operator who edited `reviewMode` between the ticks.
  h.board.seedRecord(plan.itemId, {
    schema: 1,
    runId: 'previous-run',
    item: plan.itemId,
    reviewRound: 0,
    updatedAt: '2026-09-15T00:00:00.000Z',
    deliveryRef: '#7',
    branch: plan.branch,
    reviewed: {
      digest: 'f'.repeat(64),
      head: 'a'.repeat(40),
      base: plan.baseSha,
      policy: '0'.repeat(64),
      ruleset: '0'.repeat(64),
      reviewer: 'reviewer:rules@1',
      at: '2026-09-15T00:00:00.000Z',
    },
  });

  const seen: string[] = [];
  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    // The human gate is what a digest protects: without it, this run's own review is the evidence.
    plan: { ...plan, reviewMode: 'label', approvalLabel: 'approved' },
    now: () => Date.parse('2026-09-15T02:00:00.000Z'),
    sleep: async () => {},
    events: createEventLog({ sink: { write: (e) => seen.push(e.kind) }, retain: false }),
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked', 'a review that does not describe this run may not merge');
  assert.match(String(result.error), /different inputs/);
  assert.ok(seen.includes('review.stale'), `the refusal must be a named fact: ${seen.join(',')}`);
  assert.equal(h.delivery.merged, false, 'nothing may be merged on a stale review');
  assert.equal(h.board.items.get(plan.itemId)?.state, 'blocked', 'and the item says so');
});

test('runDeliveryLoop: a human gate with no record of what was presented is refused', async () => {
  const h = harness();
  // Written before digests existed, or by another tool: "unknown" is not "probably fine".
  h.board.seedRecord(plan.itemId, {
    schema: 1,
    runId: 'ancient-run',
    item: plan.itemId,
    reviewRound: 0,
    updatedAt: '2026-09-15T00:00:00.000Z',
    deliveryRef: '#3',
    branch: plan.branch,
  });

  const result = await runDeliveryLoop({
    board: h.board,
    delivery: h.delivery,
    plan: { ...plan, reviewMode: 'label', approvalLabel: 'approved' },
    now: () => Date.parse('2026-09-15T02:00:00.000Z'),
    sleep: async () => {},
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'blocked');
  assert.match(String(result.error), /no record of what was presented/);
  assert.equal(h.delivery.merged, false);
});
