import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoardError,
  DeliveryError,
  ProviderError,
  assertTransition,
  runDeliveryLoop,
} from '../index.js';
import type {
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
  async writeState(id: string, record: BoardStateRecord): Promise<void> {
    this.records.set(id, record);
    this.seen.push(`record:round${record.reviewRound}`);
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

test('runDeliveryLoop: a pending check is retriable, not a failure and not a merge', async () => {
  const { board, delivery } = harness();
  delivery.checkRuns = [{ name: 'e2e', conclusion: 'pending' }];
  const result = await runDeliveryLoop({
    board,
    delivery,
    plan,
    hooks: { agent: async () => {}, review: async () => ({ verdict: 'clean' }) },
  });

  assert.equal(result.outcome, 'retriable');
  assert.match(result.error ?? '', /still pending/);
  assert.equal(delivery.merged, false);
  assert.equal((await board.getWork('ITEM-7')).state, 'pr_open', 'the item stays in review for the next tick');
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

test('runDeliveryLoop: a transport failure is retriable, and the item is NOT blocked', async () => {
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
  assert.deepEqual(board.seen.filter((s) => !s.startsWith('record')), ['claimed'], 'a retriable failure does not block');
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
