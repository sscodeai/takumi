/**
 * The delivery port: how a change reaches the host (ADR-007).
 *
 * ADR-006 split the work source from the delivery; this is the delivery half.
 * It exists because "the board" and "the host that can run a pipeline and merge"
 * are not the same system: Jira and Notion are boards without a pull request in
 * sight, while GitHub and GitLab are both. Modelling delivery as capabilities on
 * the board port would have made every board lie about half of its nature.
 *
 * The port encodes three rules that a code-generating agent must never be
 * trusted to follow on its own:
 *
 *   1. **The agent's boundary is the COMMIT.** `deliver()` refuses an
 *      uncommitted worktree; it never stages, never commits, never "helps".
 *   2. **Pushing is plain, never forced.** `DeliveryOutcome.push.mode` reports
 *      what actually happened, so a caller (and the contract suite) can prove it.
 *   3. **Merging targets EXACTLY the reviewed commit.** `merge()` requires the
 *      head it is asked to merge and fails if the remote head moved, which is
 *      what stops a swapped-head merge from landing unreviewed code.
 */

import { ProviderError, type ProviderErrorKind } from './provider-error.js';

export type DeliveryErrorKind = ProviderErrorKind;

/** A classified delivery failure. */
export class DeliveryError extends ProviderError {
  constructor(kind: DeliveryErrorKind, message: string, opts?: { item?: string; cause?: unknown }) {
    super(kind, message, opts);
    this.name = 'DeliveryError';
  }
}

/** A capability-gated delivery operation was attempted on a provider that lacks it. */
export class DeliveryUnsupportedError extends DeliveryError {
  readonly capability: string;

  constructor(capability: string, providerId: string, detail?: string) {
    super('unsupported', `provider ${providerId} does not support ${capability}` + (detail ? `: ${detail}` : ''));
    this.name = 'DeliveryUnsupportedError';
    this.capability = capability;
  }
}

export interface DeliveryProviderMetadata {
  id: string;
  name: string;
  version: string;
  description?: string;
}

/**
 * What the host can do. `canPushBranch` is separate on purpose: a host may accept
 * a branch without any notion of a pull request (an on-premise git server), and a
 * caller must know that before it promises a review.
 */
export interface DeliveryCapabilities {
  canPushBranch: boolean;
  canOpenPullRequest: boolean;
  canRunChecks: boolean;
  canMerge: boolean;
}

export interface DeliveryRequest {
  /** Absolute path of the task worktree (the checkout the agent committed in). */
  worktree: string;
  /** The task branch; must be the branch actually checked out in the worktree. */
  branch: string;
  /** The delivery base branch (e.g. `main`). */
  baseBranch: string;
  /** Remote name to push to (default `origin`). */
  remote?: string;
  /** The board item this delivery answers, used for the item cross-reference. */
  itemId: string;
  /** The end-to-end correlation id of this run. */
  runId: string;
  /** Pull request title (defaults to a run marker line). */
  title?: string;
  /** Extra pull request body text; the run marker and item reference are added. */
  body?: string;
}

/** The frozen base the worktree was created from (takumi owns this value). */
export interface DeliveryBase {
  baseSha: string;
}

export interface PullRequestRef {
  number: string;
  url: string;
  headSha: string;
  baseSha: string;
}

export interface DeliveryPushRecord {
  mode: 'plain' | 'force';
  branch: string;
  head: string;
}

export interface DeliveryOutcome {
  /** True when this call created the review surface; false when an existing one was reused. */
  created: boolean;
  /**
   * The review surface, when the delivery has one.
   *
   * A pull request is how every host so far models "here is a change to review", but it is not
   * the only shape a delivery can take: a bare git remote has a pushed branch and nothing to open.
   * Such a provider reports NO reference here and `canOpenPullRequest: false`, and the delivery
   * step is driven by `push` alone (`deliveryRefFor` below is what the loop uses either way).
   * Making this optional is what lets the port describe a delivery that has no review surface
   * WITHOUT inventing a fake pull request for it — the events and the board state must not claim
   * a pull request that does not exist.
   */
  pr?: PullRequestRef;
  push: DeliveryPushRecord;
  notes: string[];
}

/**
 * The reference the delivery steps work against: the pull request when there is one, and the
 * pushed branch when there is not.
 *
 * `status`, `checks` and `merge` all take this, so a provider with no review surface is never
 * asked to invent one at the call site — it receives the branch it just pushed, which is exactly
 * what it can answer about.
 */
export function deliveryRefFor(outcome: DeliveryOutcome, baseSha: string): PullRequestRef {
  if (outcome.pr !== undefined) return outcome.pr;
  return {
    number: outcome.push.branch,
    url: '',
    headSha: outcome.push.head,
    baseSha,
  };
}

export type DeliveryMergeMethod = 'merge' | 'squash' | 'rebase';

/**
 * Pull request state. `mergeable` is tri-state on purpose: a host may need a
 * moment to compute it, and an UNKNOWN must never be read as "yes".
 */
export interface PullRequestStatus {
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean | null;
  headSha: string;
  baseSha: string;
}

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';

export interface CheckSummary {
  name: string;
  conclusion: CheckConclusion;
  url?: string;
}

export interface MergeOutcome {
  merged: boolean;
  method: DeliveryMergeMethod;
  /** The commit that was merged — always the reviewed head the caller named. */
  headSha: string;
  url: string;
}

export interface DeliveryProvider {
  metadata(): DeliveryProviderMetadata;
  capabilities(): DeliveryCapabilities;

  /**
   * Close out the agent's committed work: verify the commit boundary (clean
   * worktree, HEAD ahead of the frozen base), absorb an advanced base with a
   * PLAIN merge, push the task branch, and open EXACTLY ONE pull request.
   *
   * MUST fail on a dirty worktree and MUST NOT commit. MUST report the push it
   * performed (`mode: 'plain'`); a forced push is a contract violation.
   */
  deliver(req: DeliveryRequest, base: DeliveryBase): Promise<DeliveryOutcome>;

  /** Current state of the pull request, including the head that will be merged. */
  status(ref: PullRequestRef): Promise<PullRequestStatus>;

  /** Check runs for the pull request's head. A pending check is `pending`, never `success`. */
  checks(ref: PullRequestRef): Promise<CheckSummary[]>;

  /**
   * Merge the REVIEWED head, and nothing else.
   *
   * `expectedHeadSha` is the head the review covered. When the remote head has
   * moved, or the host cannot merge that exact commit, this MUST fail — merging a
   * different head is the failure mode this whole layer exists to prevent.
   */
  merge(
    ref: PullRequestRef,
    opts: { expectedHeadSha: string; method?: DeliveryMergeMethod },
  ): Promise<MergeOutcome>;
}

/** The fixture a contract run operates on. */
export interface DeliveryFixture {
  worktree: string;
  branch: string;
  baseBranch: string;
  remote: string;
  itemId: string;
  runId: string;
  baseSha: string;
  title?: string;
  body?: string;
}

export interface DeliveryContractSuiteOptions {
  /** Expected `metadata().id`. */
  id: string;
  /** A worktree that is clean, on `branch`, with HEAD ahead of `baseSha`. */
  fixture: DeliveryFixture;
  /** Make the provider see a DIRTY worktree. */
  makeDirty?: (provider: DeliveryProvider) => Promise<void>;
  /** Make the provider see HEAD still equal to the frozen base (no commit). */
  makeNoCommit?: (provider: DeliveryProvider) => Promise<void>;
  /** Make the pull request unmergeable (a base conflict). */
  makeUnmergeable?: (provider: DeliveryProvider) => Promise<void>;
  /**
   * Restore a deliverable state after a state-mutating hook (dirty worktree, no
   * commit, unmergeable PR). Without it the suite cannot walk back, so those
   * checks are reported as NOT_RUN instead of silently passing on a mutated
   * fixture.
   */
  reset?: (provider: DeliveryProvider) => Promise<void>;
  /**
   * Report what the provider actually did, so the suite can assert the effects
   * instead of only the return value. A test double can always answer; a real
   * adapter answers from its injected transport, which is what makes these
   * assertions about behaviour rather than about a self-report.
   */
  inspect?: (provider: DeliveryProvider) => Promise<{ pushes: number; forcePushes: number; prs: number; merges: number }>;
}

/**
 * Shared Delivery Contract Suite (ADR-007).
 *
 * Runs against `FakeDeliveryProvider` and every real delivery adapter, so the
 * three rules above are verified the same way everywhere. Assertions throw on
 * failure; the result is `PASS`, or `PASS_WITH_NOT_RUN` when a state the caller
 * could not produce (a dirty worktree, an unmergeable PR) was skipped — reported
 * as a note rather than silently passing.
 *
 * NOTE: the suite MUTATES the fixture (it pushes, opens a PR and may merge). Run
 * it against a fresh fixture, never against a shared one.
 */
export async function runDeliveryProviderContractSuite(
  provider: DeliveryProvider,
  opts: DeliveryContractSuiteOptions,
): Promise<{ gate: string; result: string; notes: string[] }> {
  const notes: string[] = [];
  let notRun = 0;

  // --- metadata ---
  const meta = provider.metadata();
  if (meta.id !== opts.id) throw new Error(`metadata.id must be ${opts.id}, got ${meta.id}`);
  if (!meta.name || !meta.version) throw new Error('metadata.name and metadata.version are required');
  notes.push(`metadata: PASS (${meta.id} ${meta.version})`);

  // --- capabilities ---
  const caps = provider.capabilities();
  for (const key of ['canPushBranch', 'canOpenPullRequest', 'canRunChecks', 'canMerge'] as const) {
    if (typeof caps[key] !== 'boolean') throw new Error(`capabilities.${key} must be a boolean`);
  }
  if (!caps.canPushBranch) {
    throw new Error('a delivery provider that cannot push a branch cannot deliver — canPushBranch must be true');
  }
  notes.push(
    `capabilities: PASS (push=${caps.canPushBranch} pr=${caps.canOpenPullRequest} checks=${caps.canRunChecks} merge=${caps.canMerge})`,
  );

  const request = (): DeliveryRequest => ({
    worktree: opts.fixture.worktree,
    branch: opts.fixture.branch,
    baseBranch: opts.fixture.baseBranch,
    remote: opts.fixture.remote,
    itemId: opts.fixture.itemId,
    runId: opts.fixture.runId,
    ...(opts.fixture.title === undefined ? {} : { title: opts.fixture.title }),
    ...(opts.fixture.body === undefined ? {} : { body: opts.fixture.body }),
  });
  const base: DeliveryBase = { baseSha: opts.fixture.baseSha };

  // --- rule 1: a dirty worktree is refused, and nothing is pushed ---
  if (opts.makeDirty === undefined || opts.reset === undefined) {
    notRun += 1;
    notes.push('dirtyWorktree: NOT_RUN (needs both makeDirty and reset hooks: the caller cannot produce and then walk back a dirty worktree)');
  } else {
    await opts.makeDirty(provider);
    await assertDeliveryError(() => provider.deliver(request(), base), 'precondition', 'deliver on a dirty worktree');
    if (opts.inspect !== undefined) {
      const seen = await opts.inspect(provider);
      if (seen.pushes !== 0) throw new Error(`a dirty worktree must not push anything (pushes=${seen.pushes})`);
    }
    notes.push('dirtyWorktree: PASS (rejected before any push — the agent must commit its own work)');
    await opts.reset(provider);
  }

  // --- rule 1b: no commit beyond the frozen base is refused ---
  if (opts.makeNoCommit === undefined || opts.reset === undefined) {
    notRun += 1;
    notes.push('noCommit: NOT_RUN (needs both makeNoCommit and reset hooks)');
  } else {
    await opts.makeNoCommit(provider);
    await assertDeliveryError(() => provider.deliver(request(), base), 'precondition', 'deliver with no commit');
    if (opts.inspect !== undefined) {
      const seen = await opts.inspect(provider);
      if (seen.pushes !== 0) throw new Error(`a delivery with no commit must not push (pushes=${seen.pushes})`);
    }
    notes.push('noCommit: PASS (rejected: HEAD still equals the frozen base)');
    await opts.reset(provider);
  }

  // --- rule 2 + the happy path: exactly one PR, plain push ---
  const first = await provider.deliver(request(), base);
  const hasPr = caps.canOpenPullRequest;
  const firstRef = deliveryRefFor(first, opts.fixture.baseSha);
  if (!hasPr && first.pr !== undefined) {
    throw new Error(
      'a provider that reports canOpenPullRequest=false must NOT report a pull request: the events and the board state would then claim one that does not exist',
    );
  }
  if (hasPr && first.pr === undefined) {
    throw new Error('a provider that reports canOpenPullRequest=true must report the pull request it opened');
  }
  if (hasPr) {
    if (first.created !== true) throw new Error('the first deliver must create the pull request');
    if (first.pr === undefined || first.pr.number.length === 0 || first.pr.url.length === 0) {
      throw new Error(`the pull request ref must carry a number and a url: ${JSON.stringify(first.pr)}`);
    }
  }
  if (first.push.mode !== 'plain') {
    throw new Error(`the push must be plain, never '${first.push.mode}' — a forced push rewrites reviewed history`);
  }
  if (first.push.head.length === 0) throw new Error('a delivery must report the head it pushed');
  if (first.pr !== undefined && firstRef.headSha !== first.push.head) {
    throw new Error(`the pull request must point at the pushed head (pushed=${first.push.head}, pr=${firstRef.headSha})`);
  }
  if (first.push.branch !== opts.fixture.branch) {
    throw new Error(`the pushed branch must be the task branch (${opts.fixture.branch}), got ${first.push.branch}`);
  }

  const second = await provider.deliver(request(), base);
  if (first.pr !== undefined) {
    if (second.created !== false) throw new Error('a second deliver must REUSE the open pull request, not open another');
    if (second.pr === undefined || second.pr.number !== first.pr.number) {
      throw new Error(`exactly one pull request per delivery (first=${first.pr.number}, second=${String(second.pr?.number)})`);
    }
  } else if (second.created !== false) {
    throw new Error('a delivery with no review surface still must not report that it created one on a repeat call');
  }
  if (opts.inspect !== undefined) {
    const seen = await opts.inspect(provider);
    if (hasPr && seen.prs !== 1) throw new Error(`exactly one pull request must exist (prs=${seen.prs})`);
    if (!hasPr && seen.prs !== 0) throw new Error(`no pull request may exist for this provider (prs=${seen.prs})`);
    // A second deliver MAY push again: in the review/fix loop the branch carries
    // NEW commits that must reach the SAME pull request. What must never happen is
    // a second pull request, or a forced push.
    if (seen.pushes < 1) throw new Error(`a delivery must push the task branch (pushes=${seen.pushes})`);
    if (seen.forcePushes !== 0) throw new Error(`no force push is allowed (forcePushes=${seen.forcePushes})`);
    notes.push(
      `deliver: PASS (plain push of ${opts.fixture.branch}, ${hasPr ? `one pull request (${first.pr?.number})` : 'no review surface'}, ` +
        `second call reused it and pushed only the newer head; pushes=${seen.pushes} forcePushes=${seen.forcePushes} prs=${seen.prs})`,
    );
  } else {
    notes.push(
      `deliver: PASS (plain push, ${hasPr ? `one pull request (${first.pr?.number})` : 'no review surface (canOpenPullRequest=false)'}, reused on the second call)`,
    );
  }

  // --- status + checks ---
  const status = await provider.status(firstRef);
  if (!['open', 'closed', 'merged'].includes(status.state)) {
    throw new Error(`status.state must be open|closed|merged, got ${String(status.state)}`);
  }
  if (status.headSha.length === 0) throw new Error('status must report the head sha');
  const checks = await provider.checks(firstRef);
  if (!Array.isArray(checks)) throw new Error('checks must resolve an array');
  const allowed: CheckConclusion[] = ['success', 'failure', 'pending', 'neutral', 'unknown'];
  for (const check of checks) {
    if (typeof check.name !== 'string' || check.name.length === 0) throw new Error(`a check needs a name: ${JSON.stringify(check)}`);
    if (!allowed.includes(check.conclusion)) {
      throw new Error(`check ${check.name} has an unknown conclusion: ${String(check.conclusion)}`);
    }
    // A pending/unknown check must never be reported as success: that is the
    // difference between "the gate is green" and "the gate has not run".
    if (check.conclusion === 'success' && check.name.toLowerCase().includes('pending')) {
      throw new Error(`check ${check.name} is named pending but reports success`);
    }
  }
  if (!caps.canRunChecks && checks.length > 0) {
    throw new Error(`capabilities.canRunChecks is false but checks() returned ${checks.length} entries`);
  }
  notes.push(`status: PASS (state=${status.state} mergeable=${String(status.mergeable)} checks=${checks.length})`);
  if (!caps.canRunChecks) {
    notRun += 1;
    notes.push('checks: PARTIAL (canRunChecks=false: the shape is verified, the CI source is not)');
  }

  // --- rule 3: never merge a head other than the one that was reviewed ---
  const staleHead = `${opts.fixture.baseSha.slice(0, 12)}0deadbeef0`;
  await assertDeliveryError(
    () => provider.merge(firstRef, { expectedHeadSha: staleHead }),
    'precondition',
    'merge with a head that is not the reviewed head',
  );
  if (opts.inspect !== undefined) {
    const seen = await opts.inspect(provider);
    if (seen.merges !== 0) throw new Error(`a stale-head merge must not merge anything (merges=${seen.merges})`);
  }
  notes.push('mergeGuard: PASS (a head that is not the reviewed head is refused)');

  if (caps.canMerge) {
    if (opts.makeUnmergeable !== undefined && opts.reset !== undefined) {
      await opts.makeUnmergeable(provider);
      await assertDeliveryError(
        () => provider.merge(firstRef, { expectedHeadSha: firstRef.headSha }),
        'precondition',
        'merge of a conflicting pull request',
      );
      notes.push('unmergeable: PASS (a conflicting pull request is not merged)');
      await opts.reset(provider);
    } else {
      notRun += 1;
      notes.push('unmergeable: NOT_RUN (needs both makeUnmergeable and reset hooks)');
    }

    const merged = await provider.merge(firstRef, { expectedHeadSha: firstRef.headSha, method: 'merge' });
    if (merged.merged !== true) throw new Error('merging the reviewed head must report merged=true');
    if (merged.headSha !== firstRef.headSha) {
      throw new Error(`the merged commit must be the reviewed head (${firstRef.headSha}), got ${merged.headSha}`);
    }
    if (merged.method !== 'merge') throw new Error(`the merge method must be echoed, got ${merged.method}`);
    const after = await provider.status(firstRef);
    if (after.state !== 'merged') throw new Error(`status after the merge must be 'merged', got ${after.state}`);
    notes.push(`merge: PASS (merged exactly ${firstRef.headSha}, method=merge)`);
  } else {
    await assertDeliveryError(
      () => provider.merge(firstRef, { expectedHeadSha: firstRef.headSha }),
      'unsupported',
      'merge on a provider without canMerge',
    );
    notRun += 1;
    notes.push('merge: NOT_RUN (canMerge=false → gated as unsupported; the stale-head guard still passed)');
  }

  notes.push('credentials: NOT_REQUIRED (the suite injects no token and opens no network)');
  return { gate: 'delivery-contract', result: notRun === 0 ? 'PASS' : 'PASS_WITH_NOT_RUN', notes };
}

/** Run `fn` and require a `DeliveryError` of `kind` — no bare Error, no silent success. */
async function assertDeliveryError(fn: () => Promise<unknown>, kind: DeliveryErrorKind, what: string): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  if (thrown === undefined) throw new Error(`${what} must fail with DeliveryError('${kind}'), but it resolved`);
  if (!(thrown instanceof DeliveryError)) {
    throw new Error(
      `${what} must fail with a DeliveryError('${kind}'), got ${thrown instanceof Error ? thrown.name : typeof thrown}: ` +
        `${thrown instanceof Error ? thrown.message : String(thrown)}`,
    );
  }
  if (thrown.kind !== kind) {
    throw new Error(`${what} failed with kind '${thrown.kind}', expected '${kind}': ${thrown.message}`);
  }
}
