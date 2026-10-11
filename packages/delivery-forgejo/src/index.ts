/**
 * Forgejo/Gitea delivery adapter — local git for the branch, the Forgejo REST v1
 * API for the pull request, the commit statuses and the merge (ADR-007).
 *
 * WHY an adapter and not a driver: the delivery port (see `delivery.ts` in core)
 * encodes three rules a code-generating agent must never be trusted to follow on
 * its own — the agent's boundary is the COMMIT, pushing is PLAIN and never
 * forced, and a merge targets EXACTLY the reviewed commit. Every rule is
 * implemented here as a check that can FAIL, not as a convention:
 *
 *   1. `deliver()` refuses a worktree that is not on the task branch, refuses an
 *      uncommitted worktree, refuses a head that is not descended from the frozen
 *      base, and never stages or commits anything itself.
 *   2. `deliver()` pushes with `git push <remote> <branch>` and NOTHING else — no
 *      `--force`, no `--force-with-lease`, no rebase — and reports
 *      `push.mode: 'plain'` so the caller can prove it. An advanced base is
 *      absorbed with a PLAIN merge of the remote base into the task branch; a
 *      conflict aborts the merge and stops, because a conflict is the review
 *      session's business, not a silent rewrite.
 *   3. `merge()` sends `head_commit_id=<expectedHeadSha>` to Forgejo, so **the
 *      host itself** refuses to merge a head that is not the reviewed one. The
 *      guard is deliberately NOT a client-side sha comparison: a local check
 *      alone cannot stop a racing push between our read and the merge, whereas
 *      `head_commit_id` is evaluated by Forgejo at merge time.
 *
 * TWO INJECTED SEAMS, and nothing else is allowed to do I/O:
 *
 *   - {@link GitRunner} — every git operation goes through it (branch, status,
 *     ancestry, fetch, merge, push). The default is core's `spawn`-based runner.
 *   - {@link BoardRequestFn} (from `@takumi/core`) — every HTTP call goes through
 *     it. The default is `curl` carrying the `Authorization: token <PAT>` header.
 *
 * Both are why this adapter is provable with ZERO network and ZERO credentials:
 * the contract suite injects a recorded git runner and a recorded request
 * function, and the default transports are never constructed.
 *
 * HONEST LIMITS (stated, not hidden):
 *
 *   1. Forgejo's merge API has no per-request choice beyond `Do`:
 *      `merge`/`squash`/`rebase`. The requested method is echoed back honestly in
 *      the {@link MergeOutcome}; Forgejo applies its own project policy for the
 *      rest.
 *   2. `checks()` reads the COMBINED commit status of the pull request's head
 *      (`GET /commits/{sha}/status`). A repository with no CI returns an empty
 *      list — never a synthesised green check.
 *   3. One page per list call: the request seam exposes a status and a body but
 *      no response headers, so pagination cannot be followed. Open pull requests
 *      are read at the host's maximum page (`limit=50`), and the newest ones are
 *      checked, never a silently empty list.
 */

import {
  DeliveryError,
  DeliveryUnsupportedError,
  gitFailure,
  renderBoardStateRecord,
  renderRunMarker,
  unconfiguredGitRunner,
  type BoardHttpResponse,
  type BoardRequestFn,
  type CheckConclusion,
  type CheckSummary,
  type DeliveryBase,
  type DeliveryCapabilities,
  type DeliveryMergeMethod,
  type DeliveryOutcome,
  type DeliveryProvider,
  type DeliveryProviderMetadata,
  type DeliveryRequest,
  type GitResult,
  type GitRunner,
  type MergeOutcome,
  type PullRequestRef,
  type PullRequestStatus,
} from '@takumi/core';

import {
  forgejoJson,
  repoUrl,
  resolveForgejoTarget,
  snip,
  type ForgejoTarget,
  type ForgejoTargetOptions,
} from './transport.js';
import {
  commentOnForgejoPullRequest,
  openForgejoIssue,
  type ForgejoCommentRef,
  type ForgejoIssueInput,
  type ForgejoIssueRef,
} from './issues.js';

// Re-exported so one import gives a caller the provider AND the issue surface.
export { renderRunMarker } from '@takumi/core';
// The real git runner, re-exported so a caller can inject it without importing core.
export { createGitRunner, unconfiguredGitRunner } from '@takumi/core';
export {
  createForgejoTransport,
  readTokenFromEnv,
  resolveForgejoTarget,
  FORGEJO_DEFAULT_API_BASE,
  FORGEJO_PROVIDER_LABEL,
} from './transport.js';
export type { ForgejoTarget, ForgejoTargetOptions, ForgejoTransportOptions } from './transport.js';
export { openForgejoIssue, commentOnForgejoPullRequest } from './issues.js';
export type { ForgejoIssueInput, ForgejoIssueRef, ForgejoCommentRef } from './issues.js';

/** `metadata().id` — the id this provider answers to in the contract suite. */
export const FORGEJO_DELIVERY_ID = 'forgejo';

const PROVIDER_VERSION = '0.1.0';
const DEFAULT_REMOTE = 'origin';

/** Forgejo's maximum page size for the list endpoints this adapter reads. */
const PAGE_SIZE = 50;

/**
 * How many times a TRANSIENT merge refusal (`405 Please try again later`, Forgejo
 * recomputing mergeability) is retried, and the linear backoff base. A real
 * refusal (409 head out of date, or a plain 405 "not mergeable") is never retried.
 */
const MERGE_ATTEMPTS = 5;
const MERGE_RETRY_BASE_MS = 700;

/** Forgejo's "not yet" answer while it recomputes a pull request's mergeability. */
function isTransientMergeRefusal(res: BoardHttpResponse): boolean {
  return res.status === 405 && /please try again later/i.test(res.body);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- the payloads ----------------------------------------------------------

/** The subset of Forgejo's pull-request JSON this adapter reads. */
interface ForgejoPullPayload {
  number?: number;
  html_url?: string | null;
  state?: string | null;
  merged?: boolean | null;
  mergeable?: boolean | null;
  head?: { ref?: string | null; sha?: string | null } | null;
  base?: { ref?: string | null; sha?: string | null } | null;
}

/** The subset of Forgejo's combined commit-status JSON this adapter reads. */
interface ForgejoCombinedStatusPayload {
  state?: string | null;
  statuses?: Array<{ context?: string | null; status?: string | null; target_url?: string | null }> | null;
}

/**
 * Commit-status state → check conclusion.
 *
 * The mapping is EXHAUSTIVE for the states Forgejo documents
 * (`pending`/`success`/`error`/`failure`) and `unknown` for everything else: a
 * state this adapter does not model must never be read as green, because "the
 * gate has not run" and "the gate passed" are different facts. `warning` is the
 * one non-green-but-not-failing state Forgejo's UI shows, mapped to `neutral`.
 */
const COMMIT_STATUS_CONCLUSION: Readonly<Record<string, CheckConclusion>> = {
  success: 'success',
  failure: 'failure',
  error: 'failure',
  pending: 'pending',
  warning: 'neutral',
};

// --- the provider ----------------------------------------------------------

export interface ForgejoDeliveryOptions extends ForgejoTargetOptions {
  /** Injected git runner (tests). Without it core's default spawn runner is used. */
  git?: GitRunner;
  /** Default remote name when the request does not name one (default `origin`). */
  remote?: string;
  /**
   * Capability overrides. Forgejo has pull requests, commit statuses and a merge
   * API, so all four are true by default; the override exists so the capability
   * gate itself is testable.
   */
  capabilities?: Partial<DeliveryCapabilities>;
}

/**
 * Forgejo/Gitea pull requests as a {@link DeliveryProvider}.
 *
 * Construct it with `{ owner, repo, request, git }` for an offline run: no token
 * is read and no process is spawned.
 */
export class ForgejoDeliveryProvider implements DeliveryProvider {
  private readonly target: ForgejoTarget;
  private readonly targetOptions: ForgejoTargetOptions;
  private readonly git: GitRunner;
  private readonly defaultRemote: string;
  private readonly caps: DeliveryCapabilities;

  constructor(options: ForgejoDeliveryOptions) {
    this.target = resolveForgejoTarget(options);
    this.targetOptions = {
      owner: this.target.owner,
      repo: this.target.repo,
      apiBase: this.target.apiBase,
      request: this.target.request,
    };
    // Fail closed: with no injected runner, every git operation is an explicit
    // `unsupported` error instead of a push to whatever remote happens to be
    // configured. A real caller injects `createGitRunner()`.
    this.git = options.git ?? unconfiguredGitRunner();
    this.defaultRemote = options.remote ?? DEFAULT_REMOTE;
    this.caps = {
      canPushBranch: true,
      canOpenPullRequest: true,
      canRunChecks: true,
      canMerge: true,
      ...options.capabilities,
    };
  }

  metadata(): DeliveryProviderMetadata {
    return {
      id: FORGEJO_DELIVERY_ID,
      name: 'Forgejo Delivery',
      version: PROVIDER_VERSION,
      description: 'Local git plus the Forgejo/Gitea REST v1 API: branch, pull request, commit statuses, merge.',
    };
  }

  capabilities(): DeliveryCapabilities {
    return { ...this.caps };
  }

  /**
   * Rule 1 → 2: verify the commit boundary, absorb an advanced base with a PLAIN
   * merge, push the task branch PLAINLY, and open exactly one pull request.
   */
  async deliver(req: DeliveryRequest, base: DeliveryBase): Promise<DeliveryOutcome> {
    if (!this.capabilities().canPushBranch) {
      throw new DeliveryUnsupportedError(
        'canPushBranch',
        FORGEJO_DELIVERY_ID,
        'a delivery that cannot push cannot reach any host',
      );
    }
    if (base.baseSha.length === 0) {
      throw new DeliveryError('precondition', 'the frozen base sha is required to verify the commit boundary', {
        item: req.itemId,
      });
    }
    const remote = req.remote ?? this.defaultRemote;
    const cwd = req.worktree;
    const notes: string[] = [];

    // Rule 1a: the worktree must be the TASK branch. Delivering whatever happens
    // to be checked out is how an unrelated branch reaches a host unreviewed.
    const branch = (
      await this.requireGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'precondition', 'read the checked-out branch', req.itemId)
    ).trim();
    if (branch !== req.branch) {
      throw new DeliveryError(
        'precondition',
        `the worktree at ${cwd} is on '${branch}', not the task branch '${req.branch}'`,
        { item: req.itemId },
      );
    }

    // Rule 1b: a clean worktree. The agent's boundary is the commit, so an
    // uncommitted change is a refusal — never a `git add -A` and a commit here.
    const porcelain = (
      await this.requireGit(['status', '--porcelain'], cwd, 'precondition', 'read the worktree status', req.itemId)
    ).trim();
    if (porcelain.length !== 0) {
      throw new DeliveryError(
        'precondition',
        `the worktree at ${cwd} has uncommitted changes (${snip(porcelain)}); the runner never commits them`,
        { item: req.itemId },
      );
    }

    // Rule 1c: there must be a commit beyond the frozen base.
    let head = (await this.requireGit(['rev-parse', 'HEAD'], cwd, 'precondition', 'read HEAD', req.itemId)).trim();
    if (head.length === 0) {
      throw new DeliveryError('transport', `git rev-parse HEAD returned nothing in ${cwd}`, { item: req.itemId });
    }
    if (head === base.baseSha) {
      throw new DeliveryError(
        'precondition',
        `no commit on ${req.branch}: HEAD is still the frozen base ${snip(base.baseSha, 12)}`,
        { item: req.itemId },
      );
    }

    // Rule 1d: HEAD must be DESCENDED from the frozen base. A rewritten base
    // means the reviewed diff and the pushed diff are not the same diff.
    if (!(await this.isAncestor(base.baseSha, 'HEAD', cwd, req.itemId))) {
      throw new DeliveryError(
        'precondition',
        `HEAD (${snip(head, 12)}) is not descended from the frozen base ${snip(base.baseSha, 12)}: either the base branch moved past this branch's fork point, or the branch was rewritten (takumi never rewrites a branch; a human must decide which happened)`,
        { item: req.itemId },
      );
    }

    // Rule 2: absorb an advanced base with a PLAIN merge. The fetch is not
    // optional — without it a stale local ref would make the ancestry test below
    // answer about a base that no longer exists on the host.
    const remoteBaseRef = `${remote}/${req.baseBranch}`;
    const fetch = await this.runGit(['fetch', remote, req.baseBranch], cwd);
    if (fetch.exitCode !== 0) {
      throw new DeliveryError(
        'transport',
        `git fetch ${remote} ${req.baseBranch} failed (exit ${fetch.exitCode}): ${snip(fetch.stderr)}`,
        { item: req.itemId },
      );
    }
    if (!(await this.isAncestor(remoteBaseRef, 'HEAD', cwd, req.itemId))) {
      const merge = await this.runGit(['merge', '--no-edit', remoteBaseRef], cwd);
      if (merge.exitCode !== 0) {
        // A conflict is a decision, not a hiccup: abort the half-done merge and
        // stop. Resolving it here would rewrite the agent's reviewed change.
        await this.runGit(['merge', '--abort'], cwd);
        throw new DeliveryError(
          'precondition',
          `merging the advanced base ${remoteBaseRef} into ${req.branch} conflicted (exit ${merge.exitCode}): the merge was aborted, and a human resolves the conflict`,
          { item: req.itemId },
        );
      }
      // The plain merge added a merge commit: the delivered head is that commit.
      head = (await this.requireGit(['rev-parse', 'HEAD'], cwd, 'precondition', 'read HEAD after the base merge', req.itemId)).trim();
      const afterMerge = (
        await this.requireGit(['status', '--porcelain'], cwd, 'precondition', 'read the worktree status after the base merge', req.itemId)
      ).trim();
      if (afterMerge.length !== 0) {
        throw new DeliveryError(
          'precondition',
          `the base merge left the worktree at ${cwd} dirty (${snip(afterMerge)}); refusing to push a working tree that is not the committed change`,
          { item: req.itemId },
        );
      }
      notes.push(`absorbed the advanced base ${remoteBaseRef} with a plain merge; the delivered head is ${snip(head, 12)}`);
    }

    // Rule 2: a PLAIN push. `--force`/`--force-with-lease` are never passed: a
    // forced push rewrites history a reviewer already read.
    const pushArgs = ['push', remote, req.branch];
    const push = await this.runGit(pushArgs, cwd);
    if (push.exitCode !== 0) {
      const rejected = /non-fast-forward|\[rejected\]|fetch first/i.test(push.stderr);
      throw new DeliveryError(
        rejected ? 'precondition' : 'transport',
        rejected
          ? `git push ${remote} ${req.branch} was rejected because the remote branch moved; the push is plain and is never forced, so this is for a human to resolve (${gitFailure(pushArgs, push)})`
          : gitFailure(pushArgs, push),
        { item: req.itemId },
      );
    }
    const pushedHead = (await this.requireGit(['rev-parse', 'HEAD'], cwd, 'precondition', 'read the pushed head', req.itemId)).trim();

    // Exactly one pull request: reuse the open one for this source branch.
    const open = await this.listOpenPulls();
    const existing = open.find((pull) => pull.head?.ref === req.branch);
    let created: boolean;
    let pull: ForgejoPullPayload;
    if (existing !== undefined) {
      pull = existing;
      created = false;
      notes.push(`reused the open pull request #${String(existing.number ?? '?')} for ${req.branch}`);
    } else {
      if (!this.capabilities().canOpenPullRequest) {
        throw new DeliveryUnsupportedError(
          'canOpenPullRequest',
          FORGEJO_DELIVERY_ID,
          'the branch was pushed but no pull request can be opened',
        );
      }
      pull = await forgejoJson<ForgejoPullPayload>(
        this.target,
        {
          method: 'POST',
          url: `${repoUrl(this.target)}/pulls`,
          body: {
            head: req.branch,
            base: req.baseBranch,
            title: req.title ?? `takumi run ${req.runId}: ${req.itemId}`,
            body: renderPullRequestBody(req),
          },
        },
        `create the pull request for ${req.branch}`,
        req.itemId,
      );
      created = true;
    }

    const number = pull.number;
    if (typeof number !== 'number' || !Number.isInteger(number)) {
      throw new DeliveryError(
        'transport',
        `Forgejo answered with a pull request that carries no number: ${snip(JSON.stringify(pull))}`,
        { item: req.itemId },
      );
    }
    return {
      created,
      pr: { number: String(number), url: pull.html_url ?? '', headSha: pushedHead, baseSha: req.baseBranch },
      push: { mode: 'plain', branch: req.branch, head: pushedHead },
      notes,
    };
  }

  /** Current state of the pull request, including the head that would be merged. */
  async status(ref: PullRequestRef): Promise<PullRequestStatus> {
    const pull = await this.getPull(ref.number);
    return {
      state: pullState(pull, ref.number),
      // Tri-state on purpose: an unknown mergeability is not a yes.
      mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
      headSha: pull.head?.sha ?? '',
      baseSha: pull.base?.ref ?? '',
    };
  }

  /** The combined commit status of the pull request's head. */
  async checks(ref: PullRequestRef): Promise<CheckSummary[]> {
    if (!this.capabilities().canRunChecks) return [];
    const head = ref.headSha.length > 0 ? ref.headSha : (await this.getPull(ref.number)).head?.sha ?? '';
    if (head.length === 0) {
      throw new DeliveryError('precondition', `pull request ${ref.number} reports no head sha, so its commit statuses cannot be read`, {
        item: ref.number,
      });
    }
    const combined = await forgejoJson<ForgejoCombinedStatusPayload>(
      this.target,
      { method: 'GET', url: `${repoUrl(this.target)}/commits/${encodeURIComponent(head)}/status` },
      `read the commit status of ${head}`,
      ref.number,
    );
    const statuses = combined.statuses ?? [];
    return statuses.map((status) => toCheckFromStatus(status));
  }

  /**
   * Merge the REVIEWED head, and nothing else.
   *
   * The guard is the HOST's: `head_commit_id` is evaluated by Forgejo at merge
   * time, so a racing push between our read and the merge cannot land unreviewed
   * code. We deliberately do NOT short-circuit on a local sha comparison — a
   * client-side check alone is not the guarantee this port needs — and we confirm
   * the pull request is actually merged afterwards instead of trusting an empty
   * 200 body.
   */
  async merge(
    ref: PullRequestRef,
    opts: { expectedHeadSha: string; method?: DeliveryMergeMethod },
  ): Promise<MergeOutcome> {
    if (!this.capabilities().canMerge) throw new DeliveryUnsupportedError('canMerge', FORGEJO_DELIVERY_ID);
    if (opts.expectedHeadSha.length === 0) {
      throw new DeliveryError('precondition', 'merge requires the reviewed head sha', { item: ref.number });
    }
    const method = opts.method ?? 'merge';
    const pull = await this.getPull(ref.number);
    if (pull.merged === true) {
      throw new DeliveryError('precondition', `pull request ${ref.number} is already merged`, { item: ref.number });
    }
    if (pull.state !== 'open') {
      throw new DeliveryError(
        'precondition',
        `pull request ${ref.number} is ${String(pull.state ?? 'unknown')}, not open`,
        { item: ref.number },
      );
    }

    const res = await this.postMerge(ref.number, method, opts.expectedHeadSha);
    if (res.status < 200 || res.status >= 300) {
      // 405 (not mergeable) and 409 (head out of date) are DECISIONS about this
      // request, never "unsupported": the host evaluated the exact head and said
      // no, which is exactly the guarantee the port asks for.
      const kind = res.status === 405 || res.status === 409 ? 'precondition' : undefined;
      const detail = snip(res.body, 300);
      throw new DeliveryError(
        kind ?? (res.status === 404 ? 'not_found' : res.status === 401 || res.status === 403 ? 'auth' : 'transport'),
        `Forgejo refused to merge pull request ${ref.number} at ${snip(opts.expectedHeadSha, 12)} (HTTP ${res.status})` +
          (detail ? `: ${detail}` : ''),
        { item: ref.number },
      );
    }

    // 200 means Forgejo merged the commit it was told to merge. Confirm the pull
    // request is actually merged rather than trusting the empty body.
    const after = await this.getPull(ref.number);
    if (after.merged !== true) {
      throw new DeliveryError(
        'transport',
        `Forgejo answered ${res.status} for the merge of pull request ${ref.number} but the pull request is not merged`,
        { item: ref.number },
      );
    }
    return { merged: true, method, headSha: opts.expectedHeadSha, url: ref.url.length > 0 ? ref.url : after.html_url ?? '' };
  }

  // --- the issue surface (extra capability, NOT part of the delivery port) ---

  /**
   * Open an issue on the same host.
   *
   * This is NOT a `DeliveryProvider` operation (see `issues.ts` for why); it is
   * an extra method that delegates to the standalone {@link openForgejoIssue} so
   * a caller holding the provider does not need a second handle.
   */
  async openIssue(input: ForgejoIssueInput): Promise<ForgejoIssueRef> {
    return openForgejoIssue(this.targetOptions, input);
  }

  /** Comment on the pull request this provider opened (delegates to the standalone function). */
  async commentOnPullRequest(ref: Pick<PullRequestRef, 'number'> | { number: string }, body: string): Promise<ForgejoCommentRef> {
    return commentOnForgejoPullRequest(this.targetOptions, ref, body);
  }

  // --- internals -------------------------------------------------------------

  private async getPull(number: string): Promise<ForgejoPullPayload> {
    return forgejoJson<ForgejoPullPayload>(
      this.target,
      { method: 'GET', url: `${repoUrl(this.target)}/pulls/${encodeURIComponent(number)}` },
      `pull request ${number}`,
      number,
    );
  }

  /**
   * Send the merge request, retrying ONLY Forgejo's transient refusal.
   *
   * MEASURED on the live instance (Forgejo 10.0.3 / Gitea 1.22): immediately
   * after a refused merge, the merge endpoint can answer `405 {"message":"Please
   * try again later"}` while it recomputes the pull request's mergeability. That
   * is not a decision about the head — it is the host saying "not yet" — so it is
   * retried a bounded number of times. Every OTHER 405 (an unmergeable pull
   * request) and every 409 (head out of date) is returned at once.
   */
  private async postMerge(number: string, method: DeliveryMergeMethod, expectedHeadSha: string): Promise<BoardHttpResponse> {
    let res = await this.sendMerge(number, method, expectedHeadSha);
    for (let attempt = 1; attempt < MERGE_ATTEMPTS && isTransientMergeRefusal(res); attempt += 1) {
      await delay(MERGE_RETRY_BASE_MS * attempt);
      res = await this.sendMerge(number, method, expectedHeadSha);
    }
    return res;
  }

  private async sendMerge(number: string, method: DeliveryMergeMethod, expectedHeadSha: string): Promise<BoardHttpResponse> {
    return this.target.request({
      method: 'POST',
      url: `${repoUrl(this.target)}/pulls/${encodeURIComponent(number)}/merge`,
      // `head_commit_id` is the host-side guard: Forgejo refuses the merge when
      // the head is no longer this commit, so a racing push can never land
      // unreviewed code.
      body: { Do: method, head_commit_id: expectedHeadSha },
    });
  }

  private async listOpenPulls(): Promise<ForgejoPullPayload[]> {
    return forgejoJson<ForgejoPullPayload[]>(
      this.target,
      { method: 'GET', url: `${repoUrl(this.target)}/pulls?state=open&limit=${PAGE_SIZE}` },
      'list open pull requests',
    );
  }

  /**
   * Every git call goes through here, so a failure of the seam itself (no runner
   * configured, git missing, timeout) surfaces as a `DeliveryError` like any
   * other failure of this port — a caller never has to catch two error families.
   */
  private async runGit(args: string[], cwd: string): Promise<GitResult> {
    try {
      return await this.git.run(args, { cwd });
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      // A transport failure from the git seam (ProviderError) is re-classified
      // into this port's vocabulary.
      const kind = typeof (e as { kind?: unknown }).kind === 'string' ? ((e as { kind: string }).kind as DeliveryError['kind']) : 'transport';
      const message = e instanceof Error ? e.message : String(e);
      throw new DeliveryError(kind, message, { cause: e });
    }
  }

  private async requireGit(
    args: string[],
    cwd: string,
    kind: 'precondition' | 'transport',
    what: string,
    item: string,
  ): Promise<string> {
    const result = await this.runGit(args, cwd);
    if (result.exitCode !== 0) {
      throw new DeliveryError(kind, `${what} failed: ${gitFailure(args, result)}`, { item });
    }
    return result.stdout;
  }

  /** `true`/`false` from git's own answer; anything else is an error, never a silent `false`. */
  private async isAncestor(maybeAncestor: string, descendant: string, cwd: string, item: string): Promise<boolean> {
    const result = await this.runGit(['merge-base', '--is-ancestor', maybeAncestor, descendant], cwd);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new DeliveryError(
      'precondition',
      `could not compare ${snip(maybeAncestor, 12)} with ${snip(descendant, 12)}: ${snip(result.stderr)}`,
      { item },
    );
  }
}

// --- the pull request text --------------------------------------------------

/**
 * The pull request body: the caller's text, the item cross-reference, the
 * machine-readable run marker and the versioned state record.
 *
 * The state record is what makes a delivery resumable from the host alone (the
 * same block the board adapters write), and the run marker is what ties this pull
 * request back to exactly one run.
 */
export function renderPullRequestBody(req: DeliveryRequest): string {
  const lines: string[] = [];
  if (req.body !== undefined && req.body.trim().length > 0) lines.push(req.body.trim());
  // Numeric ids can be closed natively by Forgejo; every id is also stated in
  // plain text so a non-numeric board id (Jira key, Notion page) stays readable.
  if (/^\d+$/.test(req.itemId)) lines.push(`Fixes #${req.itemId}`);
  lines.push(`Item: ${req.itemId}`);
  lines.push(`Run: ${req.runId}`);
  lines.push(renderRunMarker(req.runId));
  lines.push(
    renderBoardStateRecord({
      schema: 1,
      runId: req.runId,
      item: req.itemId,
      baseBranch: req.baseBranch,
      branch: req.branch,
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
    }),
  );
  return lines.join('\n\n');
}

/** Forgejo's pull-request state → the port's state. An unknown state is a refusal, not a guess. */
function pullState(pull: ForgejoPullPayload, number: string): PullRequestStatus['state'] {
  if (pull.merged === true) return 'merged';
  if (pull.state === 'open') return 'open';
  if (pull.state === 'closed') return 'closed';
  throw new DeliveryError('precondition', `pull request ${number} reports an unknown state: ${String(pull.state)}`, {
    item: number,
  });
}

function toCheckFromStatus(status: {
  context?: string | null;
  status?: string | null;
  target_url?: string | null;
}): CheckSummary {
  const name = status.context ?? 'status';
  const conclusion = status.status === null || status.status === undefined ? 'unknown' : COMMIT_STATUS_CONCLUSION[status.status] ?? 'unknown';
  return {
    name,
    conclusion,
    ...(status.target_url === null || status.target_url === undefined || status.target_url.length === 0
      ? {}
      : { url: status.target_url }),
  };
}

/** Build a provider from plain options — the factory the manifest names. */
export function createForgejoDeliveryProvider(options: ForgejoDeliveryOptions): ForgejoDeliveryProvider {
  return new ForgejoDeliveryProvider(options);
}
