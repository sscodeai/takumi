/**
 * GitLab delivery adapter — local git for the branch, the GitLab merge-request
 * API for the merge request, the pipelines and the merge (ADR-007).
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
 *   3. `merge()` re-reads the merge request, requires its `sha` to be the
 *      reviewed head, and sends that same `sha` to GitLab — so GitLab ITSELF
 *      refuses to merge a head that moved between the read and the merge.
 *
 * TWO INJECTED SEAMS, and nothing else is allowed to do I/O:
 *
 *   - {@link GitRunner} — every git operation goes through it (branch, status,
 *     ancestry, fetch, merge, push). The default is a `spawn`-based runner.
 *   - `BoardRequestFn` (from `@takumi/core`) — every HTTP call goes through it.
 *     The default is `curl` carrying the `PRIVATE-TOKEN` header.
 *
 * Both are why this adapter is provable with ZERO network and ZERO credentials:
 * the contract suite injects a recorded git runner and a recorded request
 * function, and the default transports are never constructed.
 *
 * HONEST LIMITS (stated, not hidden):
 *
 *   1. GitLab's merge-request API has no per-request choice of merge method: the
 *      only per-request control is `squash`. A caller that asks for `'rebase'`
 *      therefore gets a merge commit unless the PROJECT is configured to
 *      fast-forward; the requested method is echoed back honestly in the
 *      {@link MergeOutcome} rather than claimed to have been used.
 *   2. GitLab closes an issue from a merge-request description only when the
 *      merge lands on the project's DEFAULT branch. The item id is therefore
 *      ALSO written as plain text (`Issue: <id>`) next to the `Fixes` line, so
 *      the link survives a delivery into a non-default base branch.
 *   3. `checks()` reports one entry per PIPELINE (GitLab's unit of CI work), not
 *      one per job: the port takes a provider-level view, and a pipeline already
 *      aggregates its jobs into a single status.
 *   4. One page per list call: the request seam exposes a status and a body but
 *      no response headers, so pagination (`X-Next-Page`) cannot be followed.
 *      Merge-request lookups therefore ask for `per_page=100`, and the pipelines
 *      endpoint (which only documents the pagination parameters) is read at
 *      GitLab's default page — a project with more than 20 pipelines has the
 *      newest ones checked, never a silently empty list.
 */

import { spawn } from 'node:child_process';
import {
  assertBoardHttpOk,
  boardErrorFromResponse,
  BOARD_STATE_MARKER_VERSION,
  createCurlRequestFn,
  DeliveryError,
  DeliveryUnsupportedError,
  parseBoardJson,
  ProviderError,
  renderBoardStateRecord,
  unconfiguredRequestFn,
} from '@takumi/core';
// Imported for local use AND re-exported below (a re-export alone creates no binding).
import { createGitRunner, renderRunMarker } from '@takumi/core';
import type {
  BoardHttpRequest,
  BoardHttpResponse,
  BoardRequestFn,
  CheckConclusion,
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
  GitResult,
  GitRunner,
  PullRequestStatus,
} from '@takumi/core';

// The git seam is core's (ADR-007): ONE definition of how git is invoked, so the
// GitHub and GitLab adapters cannot drift into two subtly different contracts.
// Re-exported here because this package's public surface named them before.
export { createGitRunner, unconfiguredGitRunner, gitFailure } from '@takumi/core';
export type { GitRunner, GitRunnerOptions, GitResult } from '@takumi/core';
export { renderRunMarker } from '@takumi/core';

/** `metadata().id` — the same id the board adapter uses for the same host. */
export const GITLAB_DELIVERY_ID = 'gitlab';

const PROVIDER_VERSION = '0.1.0';

/**
 * The name used in fail-closed transport errors. It is the manifest `name`
 * ("gitlab-delivery") rather than the provider id, so an operator reading the
 * error can find the package that produced it.
 */
const PROVIDER_LABEL = 'gitlab-delivery';

const DEFAULT_API_BASE = 'https://gitlab.com/api/v4';
const DEFAULT_REMOTE = 'origin';

/** Environment variable holding the personal/project access token. */
const TOKEN_ENV = 'GITLAB_TOKEN';

/** GitLab's own page limit; also the ceiling of what this adapter looks at. */
const PAGE_SIZE = 100;

// --- the HTTP seam ---------------------------------------------------------

export interface GitLabTransportOptions {
  /** Access token; falls back to `process.env.GITLAB_TOKEN`. */
  token?: string;
  /** Per-request timeout in seconds (default 30, applied by `curl -m`). */
  timeoutSeconds?: number;
  /** Override the curl binary (tests may point at a stub). */
  curlBinary?: string;
}

/**
 * The default transport: `curl` carrying GitLab's `PRIVATE-TOKEN` header.
 *
 * WHY the header is injected here and not by the provider: the provider must stay
 * usable with an injected request function and ZERO credentials, so the token is
 * read at the one place that actually performs I/O. The header is built lazily,
 * so a rotated token is picked up between calls without rebuilding the provider.
 */
export function createGitLabTransport(options: GitLabTransportOptions = {}): BoardRequestFn {
  const token = options.token ?? readTokenFromEnv();
  return createCurlRequestFn({
    ...(token === undefined ? {} : { headers: (): Record<string, string> => ({ 'PRIVATE-TOKEN': token }) }),
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    ...(options.curlBinary === undefined ? {} : { curlBinary: options.curlBinary }),
  });
}

/** Read the token from the environment, treating a blank value as absent. */
function readTokenFromEnv(): string | undefined {
  const raw = process.env[TOKEN_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// --- the merge-request payload --------------------------------------------

/** The subset of GitLab's merge-request JSON this adapter reads. */
interface GitLabMergeRequestPayload {
  iid?: number;
  state?: string | null;
  sha?: string | null;
  target_branch?: string | null;
  web_url?: string | null;
  /**
   * GitLab deprecated `mergeable_status` in favour of `detailed_merge_status`;
   * both are read, and neither is trusted when the value is unrecognised.
   */
  mergeable_status?: string | null;
  detailed_merge_status?: string | null;
  /** The older field `detailed_merge_status` replaced (deprecated in GitLab 15.6). */
  merge_status?: string | null;
  /** GitLab sets this from the cached merge status; a TRUE conflict is a definite no. */
  has_conflicts?: boolean | null;
}

/** The subset of GitLab's pipeline JSON this adapter reads. */
interface GitLabPipelinePayload {
  id?: number;
  name?: string | null;
  status?: string | null;
  web_url?: string | null;
}

/** The subset of GitLab's commit-status JSON this adapter reads. */
interface GitLabCommitStatusPayload {
  name?: string | null;
  description?: string | null;
  status?: string | null;
  target_url?: string | null;
}

/** Statuses that mean "GitLab will merge this merge request as it stands". */
const MERGEABLE_YES: ReadonlySet<string> = new Set(['mergeable', 'can_be_merged']);

/** Statuses that mean "a base conflict has to be resolved first". */
const MERGEABLE_NO: ReadonlySet<string> = new Set([
  'conflict',
  'not_mergeable',
  'cannot_be_merged',
  'cannot_be_merged_recheck',
]);

/**
 * Status → check conclusion. The mapping is deliberately EXHAUSTIVE for the
 * interesting states and `unknown` for everything else: a status this adapter
 * does not model must never be read as green, because "the gate has not run" and
 * "the gate passed" are different facts.
 */
const PIPELINE_CONCLUSION: Readonly<Record<string, CheckConclusion>> = {
  success: 'success',
  failed: 'failure',
  canceled: 'failure',
  running: 'pending',
  pending: 'pending',
  created: 'pending',
  skipped: 'neutral',
  manual: 'neutral',
};

// --- the provider ----------------------------------------------------------

export interface GitLabDeliveryOptions {
  /** URL-encoded project path, e.g. `group/project` (a numeric project id also works). */
  project: string;
  /** Access token; falls back to `process.env.GITLAB_TOKEN`. */
  token?: string;
  /** API base, default `https://gitlab.com/api/v4`. */
  apiBase?: string;
  /** Injected request function (tests). Without it a token is required. */
  request?: BoardRequestFn;
  /** Injected git runner (tests). Without it the default spawn runner is used. */
  git?: GitRunner;
  /** Default remote name when the request does not name one (default `origin`). */
  remote?: string;
  /**
   * Capability overrides. GitLab has merge requests and pipelines, so all four
   * are true by default; the override exists so a caller can run the adapter in
   * a mode where merging is gated, and so the capability gate itself is testable.
   */
  capabilities?: Partial<DeliveryCapabilities>;
}

/**
 * GitLab merge requests as a {@link DeliveryProvider}.
 *
 * Construct it with `{ project, request, git }` for an offline run: no token is
 * read and no process is spawned.
 */
export class GitLabDeliveryProvider implements DeliveryProvider {
  private readonly projectId: string;
  private readonly apiBase: string;
  private readonly request: BoardRequestFn;
  private readonly git: GitRunner;
  private readonly defaultRemote: string;
  private readonly caps: DeliveryCapabilities;

  constructor(options: GitLabDeliveryOptions) {
    const project = options.project.trim().replace(/^\/+|\/+$/g, '');
    if (project.length === 0) {
      throw new Error('GitLabDeliveryProvider: `project` is required (e.g. "group/project")');
    }
    const apiBase = (options.apiBase ?? DEFAULT_API_BASE).trim().replace(/\/+$/g, '');
    if (apiBase.length === 0) {
      throw new Error('GitLabDeliveryProvider: `apiBase` must not be empty');
    }
    this.projectId = encodeURIComponent(project);
    this.apiBase = apiBase;
    this.git = options.git ?? createGitRunner();
    this.defaultRemote = options.remote ?? DEFAULT_REMOTE;
    this.caps = {
      canPushBranch: true,
      canOpenPullRequest: true,
      canRunChecks: true,
      canMerge: true,
      ...options.capabilities,
    };
    // Fail closed: with no injected request and no token there is nothing to
    // authenticate with, and an unconfigured transport is an explicit `auth`
    // error instead of an anonymous call against a private project.
    const token = options.token ?? readTokenFromEnv();
    this.request =
      options.request ??
      (token === undefined ? unconfiguredRequestFn(PROVIDER_LABEL) : createGitLabTransport({ token }));
  }

  metadata(): DeliveryProviderMetadata {
    return {
      id: GITLAB_DELIVERY_ID,
      name: 'GitLab Delivery',
      version: PROVIDER_VERSION,
      description: 'Local git plus the GitLab merge-request API: branch, merge request, pipelines, merge.',
    };
  }

  capabilities(): DeliveryCapabilities {
    return { ...this.caps };
  }

  /**
   * Rule 1 → 2: verify the commit boundary, absorb an advanced base with a PLAIN
   * merge, push the task branch PLAINLY, and open exactly one merge request.
   */
  async deliver(req: DeliveryRequest, base: DeliveryBase): Promise<DeliveryOutcome> {
    if (!this.caps.canPushBranch) {
      throw new DeliveryUnsupportedError('canPushBranch', GITLAB_DELIVERY_ID, 'a delivery that cannot push cannot reach any host');
    }
    const remote = req.remote ?? this.defaultRemote;
    const cwd = req.worktree;
    const notes: string[] = [];

    // Rule 1a: the worktree must be the TASK branch. Delivering whatever happens
    // to be checked out is how an unrelated branch reaches a host unreviewed.
    const branch = (
      await this.requireGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'read the checked-out branch', req.itemId)
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
      await this.requireGit(['status', '--porcelain'], cwd, 'read the worktree status', req.itemId)
    ).trim();
    if (porcelain.length !== 0) {
      throw new DeliveryError(
        'precondition',
        `the worktree at ${cwd} has uncommitted changes (${snip(porcelain)}); the runner never commits them`,
        { item: req.itemId },
      );
    }

    // Rule 1c: there must be a commit beyond the frozen base.
    let head = (await this.requireGit(['rev-parse', 'HEAD'], cwd, 'read HEAD', req.itemId)).trim();
    if (head.length === 0) {
      throw new DeliveryError('transport', `git rev-parse HEAD returned nothing in ${cwd}`, { item: req.itemId });
    }
    if (head === base.baseSha) {
      throw new DeliveryError('precondition', `no commit on ${req.branch}: HEAD is still the frozen base ${snip(base.baseSha, 12)}`, {
        item: req.itemId,
      });
    }

    // Rule 1d: HEAD must be DESCENDED from the frozen base. A rewritten base
    // means the reviewed diff and the pushed diff are not the same diff.
    if (!(await this.isAncestor(base.baseSha, 'HEAD', cwd))) {
      throw new DeliveryError(
        'precondition',
        `HEAD (${snip(head, 12)}) is not descended from the frozen base ${snip(base.baseSha, 12)}: the branch was rebased or rewritten, and takumi never rewrites a branch`,
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
    if (!(await this.isAncestor(remoteBaseRef, 'HEAD', cwd))) {
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
      head = (await this.requireGit(['rev-parse', 'HEAD'], cwd, 'read HEAD after the base merge', req.itemId)).trim();
      const afterMerge = (await this.requireGit(['status', '--porcelain'], cwd, 'read the worktree status after the base merge', req.itemId)).trim();
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
    const push = await this.runGit(['push', remote, req.branch], cwd);
    if (push.exitCode !== 0) {
      throw new DeliveryError(
        'precondition',
        `git push ${remote} ${req.branch} was refused (exit ${push.exitCode}): ${snip(push.stderr)} — the push is plain and is never forced, so a rejected push is for a human to resolve`,
        { item: req.itemId },
      );
    }

    // Exactly one merge request: reuse the open one for this source branch.
    const open = await this.callList<GitLabMergeRequestPayload>(
      {
        method: 'GET',
        url: `${this.mergeRequestCollectionUrl()}?source_branch=${encodeURIComponent(req.branch)}&state=opened&per_page=${PAGE_SIZE}`,
      },
      `list the open merge requests for ${req.branch}`,
      req.itemId,
    );
    let created: boolean;
    let mergeRequest: GitLabMergeRequestPayload;
    const existing = open[0];
    if (existing !== undefined) {
      mergeRequest = existing;
      created = false;
      notes.push(`reused the open merge request !${String(existing.iid ?? '?')} for ${req.branch}`);
    } else {
      if (!this.caps.canOpenPullRequest) {
        throw new DeliveryUnsupportedError('canOpenPullRequest', GITLAB_DELIVERY_ID, 'the branch was pushed but no merge request can be opened');
      }
      const text = renderMergeRequestText(req);
      mergeRequest = await this.call<GitLabMergeRequestPayload>(
        {
          method: 'POST',
          url: this.mergeRequestCollectionUrl(),
          body: {
            source_branch: req.branch,
            target_branch: req.baseBranch,
            title: text.title,
            description: text.description,
          },
        },
        `create the merge request for ${req.branch}`,
        req.itemId,
      );
      created = true;
    }

    const iid = mergeRequest.iid;
    if (typeof iid !== 'number' || !Number.isInteger(iid)) {
      throw new DeliveryError(
        'transport',
        `GitLab answered with a merge request that carries no iid: ${snip(JSON.stringify(mergeRequest))}`,
        { item: req.itemId },
      );
    }
    return {
      created,
      pr: { number: String(iid), url: mergeRequest.web_url ?? '', headSha: head, baseSha: req.baseBranch },
      push: { mode: 'plain', branch: req.branch, head },
      notes,
    };
  }

  /** Current state of the merge request, including the head that would be merged. */
  async status(ref: PullRequestRef): Promise<PullRequestStatus> {
    const mergeRequest = await this.getMergeRequest(ref.number);
    return {
      state: mergeRequestState(mergeRequest, ref.number),
      mergeable: mergeableFrom(mergeRequest),
      headSha: mergeRequest.sha ?? '',
      baseSha: mergeRequest.target_branch ?? '',
    };
  }

  /** Pipelines for the merge request, falling back to the head commit's statuses. */
  async checks(ref: PullRequestRef): Promise<CheckSummary[]> {
    if (!this.caps.canRunChecks) return [];
    const pipelines = await this.callList<GitLabPipelinePayload>(
      { method: 'GET', url: `${this.mergeRequestUrl(ref.number)}/pipelines` },
      `list the pipelines of merge request !${ref.number}`,
      ref.number,
    );
    if (pipelines.length > 0) return pipelines.map(toCheckFromPipeline);
    // No pipelines: a project without CI/CD still publishes per-commit statuses
    // (an external CI posting its result), and those are the host's only signal.
    if (ref.headSha.length === 0) {
      throw new DeliveryError('precondition', `merge request !${ref.number} reports no head sha, so its commit statuses cannot be read`, {
        item: ref.number,
      });
    }
    const statuses = await this.callList<GitLabCommitStatusPayload>(
      { method: 'GET', url: `${this.projectUrl()}/commits/${encodeURIComponent(ref.headSha)}/statuses` },
      `list the commit statuses of ${ref.headSha}`,
      ref.number,
    );
    return statuses.map(toCheckFromCommitStatus);
  }

  /**
   * Rule 3: merge EXACTLY the reviewed commit.
   *
   * Three gates, in this order: the merge request must still point at the
   * reviewed head, it must be open, and it must be mergeable. The `sha`
   * parameter of the merge call then makes GitLab itself refuse a head that
   * moves between the read and the merge — the guard is enforced twice.
   */
  async merge(
    ref: PullRequestRef,
    opts: { expectedHeadSha: string; method?: DeliveryMergeMethod },
  ): Promise<MergeOutcome> {
    if (!this.caps.canMerge) {
      throw new DeliveryUnsupportedError('canMerge', GITLAB_DELIVERY_ID, 'this host cannot merge a merge request');
    }
    const method: DeliveryMergeMethod = opts.method ?? 'merge';
    const mergeRequest = await this.getMergeRequest(ref.number);

    const remoteHead = mergeRequest.sha ?? '';
    if (remoteHead !== opts.expectedHeadSha) {
      throw new DeliveryError(
        'precondition',
        `merge request !${ref.number} head moved: reviewed ${opts.expectedHeadSha}, remote ${remoteHead.length === 0 ? '(unknown)' : remoteHead}`,
        { item: ref.number },
      );
    }
    const state = mergeRequestState(mergeRequest, ref.number);
    if (state !== 'open') {
      throw new DeliveryError('precondition', `merge request !${ref.number} is ${state}, not open`, { item: ref.number });
    }
    const mergeable = mergeableFrom(mergeRequest);
    if (mergeable !== true) {
      throw new DeliveryError(
        'precondition',
        `merge request !${ref.number} is not mergeable (mergeable=${String(mergeable)}${mergeable === null ? ': an unknown is not a yes' : ''})`,
        { item: ref.number },
      );
    }

    const res = await this.send(
      {
        method: 'PUT',
        url: `${this.mergeRequestUrl(ref.number)}/merge`,
        body: {
          // GitLab refuses the merge when this sha is not the current head — the
          // server-side half of the anti-swap guard.
          sha: opts.expectedHeadSha,
          should_remove_source_branch: true,
          squash: method === 'squash',
        },
      },
      `merge merge request !${ref.number}`,
      ref.number,
    );
    if (res.status === 405 || res.status === 406 || res.status === 409) {
      // 405 is GitLab's answer for a merge request that cannot be merged in its
      // current state; 406/409 cover the conflict and moved-sha cases. All three
      // are a precondition for this port, and NONE of them is a merge.
      throw new DeliveryError(
        'precondition',
        `GitLab refused to merge !${ref.number} with HTTP ${res.status}: ${snip(res.body)}`,
        { item: ref.number },
      );
    }
    const merged = await this.parse<GitLabMergeRequestPayload>(res, `merge merge request !${ref.number}`, ref.number);
    if (typeof merged.state === 'string' && merged.state !== 'merged') {
      // A 2xx that did not merge (e.g. a queued merge) must never be reported as
      // a merge: the caller would go on to delete the branch of a live change.
      throw new DeliveryError(
        'precondition',
        `GitLab accepted the merge call for !${ref.number} but reports state '${merged.state}' — not reporting a merge that did not happen`,
        { item: ref.number },
      );
    }
    return { merged: true, method, headSha: opts.expectedHeadSha, url: ref.url };
  }

  // --- request plumbing -----------------------------------------------------

  private projectUrl(): string {
    return `${this.apiBase}/projects/${this.projectId}`;
  }

  private mergeRequestCollectionUrl(): string {
    return `${this.projectUrl()}/merge_requests`;
  }

  private mergeRequestUrl(iid: string): string {
    return `${this.mergeRequestCollectionUrl()}/${encodeURIComponent(iid)}`;
  }

  private async getMergeRequest(iid: string): Promise<GitLabMergeRequestPayload> {
    return this.call<GitLabMergeRequestPayload>(
      { method: 'GET', url: this.mergeRequestUrl(iid) },
      `read merge request !${iid}`,
      iid,
    );
  }

  /** Send one request, classifying an injected-transport failure as a DeliveryError. */
  private async send(req: BoardHttpRequest, what: string, item?: string): Promise<BoardHttpResponse> {
    try {
      return await this.request(req);
    } catch (e) {
      throw toDeliveryError(e, what, item);
    }
  }

  private async call<T>(req: BoardHttpRequest, what: string, item?: string): Promise<T> {
    const res = await this.send(req, what, item);
    try {
      assertBoardHttpOk(res, what, item);
    } catch (e) {
      throw toDeliveryError(e, what, item);
    }
    return this.parse<T>(res, what, item);
  }

  private async callList<T>(req: BoardHttpRequest, what: string, item?: string): Promise<T[]> {
    const body = await this.call<unknown>(req, what, item);
    if (!Array.isArray(body)) {
      // GitLab answers an error with an OBJECT (`{"message": ...}`), so a
      // non-array here means the call did not do what the caller asked for.
      throw new DeliveryError('transport', `${what} returned ${typeof body} instead of a JSON array: ${snip(JSON.stringify(body))}`, {
        ...(item === undefined ? {} : { item }),
      });
    }
    return body as T[];
  }

  private async parse<T>(res: BoardHttpResponse, what: string, item?: string): Promise<T> {
    try {
      return parseBoardJson<T>(res, what);
    } catch (e) {
      throw toDeliveryError(e, what, item);
    }
  }

  // --- git plumbing ---------------------------------------------------------

  /** Run git through the seam; a seam that REJECTS is a transport failure, never a bare Error. */
  private async runGit(args: string[], cwd: string): Promise<GitResult> {
    try {
      return await this.git.run(args, { cwd });
    } catch (e) {
      throw new DeliveryError('transport', `git ${args.join(' ')} could not be run: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
  }

  /** Run git and require exit 0, returning its stdout. */
  private async requireGit(args: string[], cwd: string, what: string, item?: string): Promise<string> {
    const res = await this.runGit(args, cwd);
    if (res.exitCode !== 0) {
      throw new DeliveryError(
        'precondition',
        `${what} failed: git ${args.join(' ')} exited ${res.exitCode}${res.stderr.trim().length === 0 ? '' : ` (${snip(res.stderr)})`}`,
        { ...(item === undefined ? {} : { item }) },
      );
    }
    return res.stdout;
  }

  private async isAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
    const res = await this.runGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    return res.exitCode === 0;
  }
}

/** Build the provider (the factory the manifest names). */
export function createGitLabDeliveryProvider(options: GitLabDeliveryOptions): GitLabDeliveryProvider {
  return new GitLabDeliveryProvider(options);
}

/**
 * The merge-request title and description for one delivery.
 *
 * The description carries three machine-readable things and nothing that only a
 * human can use:
 *
 *   - the run marker, so the merge request is attributable to a run;
 *   - the versioned state record rendered by `renderBoardStateRecord` — the SAME
 *     grammar the board adapters parse, so a resumed run reads the delivery
 *     facts with core's parser instead of a private format;
 *   - the item cross-reference. `Fixes #<id>` is GitLab's closing pattern, but it
 *     only closes an issue when the merge lands on the DEFAULT branch, so the id
 *     is also written as plain text (`Issue: <id>`) for every other base.
 */
export function renderMergeRequestText(req: DeliveryRequest): { title: string; description: string } {
  const record = renderBoardStateRecord({
    schema: BOARD_STATE_MARKER_VERSION,
    runId: req.runId,
    item: req.itemId,
    baseBranch: req.baseBranch,
    deliveryRef: req.branch,
    reviewRound: 0,
    updatedAt: new Date().toISOString(),
  });
  const lines: string[] = [renderRunMarker(req.runId), record, ''];
  if (req.title !== undefined && req.title.trim().length > 0) lines.push(req.title, '');
  if (req.body !== undefined && req.body.trim().length > 0) lines.push(req.body, '');
  lines.push(closesItem(req.itemId), '', `Issue: ${req.itemId}`);
  return { title: req.title ?? `takumi: ${req.itemId} (run ${req.runId})`, description: lines.join('\n') };
}

/** GitLab's issue-closing reference when the id is numeric, plain text otherwise. */
function closesItem(itemId: string): string {
  return /^\d+$/.test(itemId) ? `Fixes #${itemId}` : `Fixes ${itemId}`;
}

/** Map a GitLab merge-request state onto the port's three-value state. */
function mergeRequestState(mergeRequest: GitLabMergeRequestPayload, iid: string): PullRequestStatus['state'] {
  switch (mergeRequest.state) {
    case 'opened':
    // `locked` means the discussion is locked; the merge request is still open.
    case 'locked':
      return 'open';
    case 'closed':
      return 'closed';
    case 'merged':
      return 'merged';
    default:
      // An unknown state must not be guessed: reporting 'open' would let a
      // caller keep waiting on a merge request that will never merge, and
      // reporting 'closed' could reopen work that is done.
      throw new DeliveryError(
        'precondition',
        `merge request !${iid} is in an unknown state '${String(mergeRequest.state ?? '(absent)')}' — refusing to guess`,
        { item: iid },
      );
  }
}

/**
 * Tri-state mergeability.
 *
 * Only the values that positively mean "GitLab will merge this as it stands" are
 * `true`; only the values that positively mean "a conflict blocks it" are
 * `false`; EVERYTHING else (`checking`, `unchecked`, a policy block such as
 * `ci_must_pass`, an unmodelled value) is `null`, because an unknown mergeability
 * that reads as a yes is exactly how an unverified merge lands.
 *
 * All three field names GitLab has used are read, newest first:
 * `detailed_merge_status` (current), `mergeable_status` (the delivery ADR's
 * wording) and `merge_status` (what the API actually returns since GitLab 15.6).
 */
function mergeableFrom(mergeRequest: GitLabMergeRequestPayload): boolean | null {
  for (const raw of [mergeRequest.detailed_merge_status, mergeRequest.mergeable_status, mergeRequest.merge_status]) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (MERGEABLE_YES.has(value)) return true;
    if (MERGEABLE_NO.has(value)) return false;
  }
  // No recognised status, but GitLab says the branches conflict: still a no.
  if (mergeRequest.has_conflicts === true) return false;
  return null;
}

/** One pipeline → one check. A pipeline aggregates its jobs, which is the level a delivery gates on. */
function toCheckFromPipeline(pipeline: GitLabPipelinePayload): CheckSummary {
  const name = pipeline.name !== undefined && pipeline.name !== null && pipeline.name.length > 0
    ? pipeline.name
    : `pipeline #${String(pipeline.id ?? '?')}`;
  return {
    name,
    conclusion: conclusionOf(pipeline.status),
    ...(pipeline.web_url === undefined || pipeline.web_url === null ? {} : { url: pipeline.web_url }),
  };
}

/** One commit status → one check (the fallback when a project publishes no pipelines). */
function toCheckFromCommitStatus(status: GitLabCommitStatusPayload): CheckSummary {
  const name = status.name ?? status.description ?? 'commit status';
  return {
    name,
    conclusion: conclusionOf(status.status),
    ...(status.target_url === undefined || status.target_url === null ? {} : { url: status.target_url }),
  };
}

/** Status → conclusion, with `unknown` as the floor (never `success`). */
function conclusionOf(status: string | null | undefined): CheckConclusion {
  if (typeof status !== 'string') return 'unknown';
  return PIPELINE_CONCLUSION[status.trim().toLowerCase()] ?? 'unknown';
}

/** Re-classify a board-layer failure as a delivery failure, keeping the kind. */
function toDeliveryError(e: unknown, what: string, item?: string): DeliveryError {
  const withItem = item === undefined ? {} : { item };
  if (e instanceof DeliveryError) return e;
  if (e instanceof ProviderError) return new DeliveryError(e.kind, e.message, { ...withItem, cause: e });
  return new DeliveryError('transport', `${what} failed: ${e instanceof Error ? e.message : String(e)}`, {
    ...withItem,
    cause: e,
  });
}

/** Collapse a multi-line tool message into one bounded line for an error or a note. */
function snip(text: string, max = 200): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
