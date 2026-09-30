import { DeliveryError, DeliveryUnsupportedError } from '@takumi/core';
import type {
  CheckSummary,
  DeliveryBase,
  DeliveryCapabilities,
  DeliveryMergeMethod,
  DeliveryOutcome,
  DeliveryProvider,
  DeliveryProviderMetadata,
  DeliveryRequest,
  MergeOutcome,
  PullRequestRef,
  PullRequestStatus,
} from '@takumi/core';

/**
 * FakeDeliveryProvider — an in-memory git + host simulator.
 *
 * Contract-identical to a real delivery adapter, with zero credentials and zero
 * network, so the shared Delivery Contract Suite can prove the three rules that
 * matter (the agent's boundary is the commit, pushes are never forced, and only
 * the reviewed head is merged) before any real host is wired in.
 *
 * It also records what it DID — pushes, force pushes, pull requests, merges —
 * because "the call returned success" is not evidence that nothing was pushed.
 */

export interface FakeDeliveryState {
  /** The agent left uncommitted changes in the worktree. */
  dirty: boolean;
  /** The worktree's committed head (the delivery). */
  headSha: string;
  /** The remote's base tip (advances to simulate a stale base). */
  remoteBaseSha: string;
  /** The frozen base the worktree was created from (takumi owns this). */
  baseSha: string;
  prNumber?: string;
  prUrl?: string;
  prHeadSha?: string;
  prBaseSha?: string;
  /** `null` models a host that has not finished computing mergeability. */
  mergeable: boolean | null;
  merged: boolean;
  mergeMethod?: DeliveryMergeMethod;
  checks: CheckSummary[];
}

export interface FakeDeliveryEffects {
  pushes: number;
  forcePushes: number;
  prs: number;
  merges: number;
  /** Times an advanced remote base was absorbed with a PLAIN merge. */
  baseMerges: number;
}

export interface FakeDeliveryProviderOptions {
  baseSha: string;
  headSha?: string;
  branch?: string;
  baseBranch?: string;
  remote?: string;
  capabilities?: Partial<DeliveryCapabilities>;
  checks?: CheckSummary[];
  mergeable?: boolean | null;
  dirty?: boolean;
}

const SHORT = (sha: string): string => sha.slice(0, 12);

export class FakeDeliveryProvider implements DeliveryProvider {
  private readonly caps: DeliveryCapabilities;
  private readonly state: FakeDeliveryState;
  private readonly effects: FakeDeliveryEffects = { pushes: 0, forcePushes: 0, prs: 0, merges: 0, baseMerges: 0 };

  constructor(opts: FakeDeliveryProviderOptions) {
    this.caps = {
      canPushBranch: true,
      canOpenPullRequest: true,
      canRunChecks: true,
      canMerge: true,
      ...opts.capabilities,
    };
    this.state = {
      dirty: opts.dirty ?? false,
      headSha: opts.headSha ?? `${SHORT(opts.baseSha)}c0mmit`,
      remoteBaseSha: opts.baseSha,
      baseSha: opts.baseSha,
      mergeable: opts.mergeable === undefined ? true : opts.mergeable,
      merged: false,
      checks: opts.checks ?? [],
    };
  }

  metadata(): DeliveryProviderMetadata {
    return {
      id: 'fake',
      name: 'Fake Delivery',
      version: '0.1.0',
      description: 'In-memory git and host simulator for the delivery contract suite.',
    };
  }

  capabilities(): DeliveryCapabilities {
    return this.caps;
  }

  async deliver(req: DeliveryRequest, base: DeliveryBase): Promise<DeliveryOutcome> {
    // Rule 1: the agent's boundary is the commit. Never stage, never commit.
    if (this.state.dirty) {
      throw new DeliveryError(
        'precondition',
        `the worktree at ${req.worktree} has uncommitted changes; the runner never commits them`,
        { item: req.itemId },
      );
    }
    if (this.state.headSha === base.baseSha) {
      throw new DeliveryError('precondition', `no commit on ${req.branch}: HEAD is still the frozen base`, {
        item: req.itemId,
      });
    }
    if (this.caps.canPushBranch !== true) {
      throw new DeliveryUnsupportedError('canPushBranch', 'fake');
    }

    const notes: string[] = [];
    // An advanced base is absorbed with a PLAIN merge of the base into the task
    // branch — never a rebase, never a force.
    if (this.state.remoteBaseSha !== base.baseSha) {
      this.effects.baseMerges += 1;
      notes.push(`absorbed advanced base ${SHORT(this.state.remoteBaseSha)} with a plain merge`);
    }

    // Rule 2: a plain push, recorded so a caller can prove it was not forced.
    this.effects.pushes += 1;
    const push = { mode: 'plain' as const, branch: req.branch, head: this.state.headSha };

    let created = false;
    if (this.state.prNumber === undefined) {
      if (this.caps.canOpenPullRequest !== true) throw new DeliveryUnsupportedError('canOpenPullRequest', 'fake');
      this.effects.prs += 1;
      created = true;
      this.state.prNumber = String(this.effects.prs);
      this.state.prUrl = `https://host.example/${req.itemId}/pull/${this.state.prNumber}`;
      this.state.prBaseSha = req.baseBranch;
    } else {
      notes.push(`reused open pull request ${this.state.prNumber}`);
    }
    // A push to the same branch moves the pull request's head.
    this.state.prHeadSha = this.state.headSha;
    this.state.prBaseSha = req.baseBranch;

    return {
      created,
      pr: { number: this.state.prNumber, url: this.state.prUrl ?? '', headSha: this.state.headSha, baseSha: req.baseBranch },
      push,
      notes,
    };
  }

  async status(ref: PullRequestRef): Promise<PullRequestStatus> {
    this.mustKnow(ref);
    return {
      state: this.state.merged ? 'merged' : 'open',
      mergeable: this.state.mergeable,
      headSha: this.state.prHeadSha ?? '',
      baseSha: this.state.prBaseSha ?? '',
    };
  }

  async checks(ref: PullRequestRef): Promise<CheckSummary[]> {
    if (this.caps.canRunChecks !== true) return [];
    this.mustKnow(ref);
    return this.state.checks.map((c) => ({ ...c }));
  }

  async merge(ref: PullRequestRef, opts: { expectedHeadSha: string; method?: DeliveryMergeMethod }): Promise<MergeOutcome> {
    this.mustKnow(ref);
    if (this.caps.canMerge !== true) throw new DeliveryUnsupportedError('canMerge', 'fake');
    // Rule 3: merge exactly the reviewed commit.
    if (this.state.prHeadSha !== opts.expectedHeadSha) {
      throw new DeliveryError(
        'precondition',
        `the pull request head moved: reviewed ${opts.expectedHeadSha}, remote ${String(this.state.prHeadSha)}`,
        { item: ref.number },
      );
    }
    if (this.state.mergeable === null) {
      throw new DeliveryError('precondition', 'mergeability is not known yet — an unknown is not a yes', {
        item: ref.number,
      });
    }
    if (this.state.mergeable === false) {
      throw new DeliveryError('precondition', `pull request ${ref.number} is not mergeable`, { item: ref.number });
    }

    const method = opts.method ?? 'merge';
    this.state.merged = true;
    this.state.mergeMethod = method;
    this.effects.merges += 1;
    return { merged: true, method, headSha: opts.expectedHeadSha, url: ref.url };
  }

  // --- test/driver helpers (not part of the port) ---

  /** What this provider actually did — the only honest source for effect assertions. */
  snapshotEffects(): FakeDeliveryEffects {
    return { ...this.effects };
  }

  state_(): FakeDeliveryState {
    return { ...this.state, checks: this.state.checks.map((c) => ({ ...c })) };
  }

  setDirty(dirty: boolean): void {
    this.state.dirty = dirty;
  }

  setHead(headSha: string): void {
    this.state.headSha = headSha;
  }

  /** Simulate the remote base moving (an advanced base the delivery must absorb). */
  setRemoteBase(sha: string): void {
    this.state.remoteBaseSha = sha;
  }

  setMergeable(mergeable: boolean | null): void {
    this.state.mergeable = mergeable;
  }

  setChecks(checks: CheckSummary[]): void {
    this.state.checks = checks;
  }

  private mustKnow(ref: PullRequestRef): void {
    if (this.state.prNumber === undefined || ref.number !== this.state.prNumber) {
      throw new DeliveryError('not_found', `no such pull request: ${ref.number}`, { item: ref.number });
    }
  }
}

/** Build a provider that is ready to deliver: clean, ahead of the base, one PR away. */
export function createFakeDeliveryProvider(opts: FakeDeliveryProviderOptions): FakeDeliveryProvider {
  return new FakeDeliveryProvider(opts);
}
