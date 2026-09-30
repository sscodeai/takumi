import {
  boardErrorFromResponse,
  BoardRequestFn,
  ProviderError,
  createCurlRequestFn,
  DeliveryError,
  DeliveryUnsupportedError,
  gitFailure,
  renderRunMarker,
  requestBoardJson,
  unconfiguredGitRunner,
  unconfiguredRequestFn,
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

/**
 * GitHubDeliveryProvider — local git for the branch, the GitHub REST API for the
 * pull request.
 *
 * This is where "the agent's job ends at the commit" becomes executable:
 *
 *   1. the worktree must be CLEAN and its head must be past the frozen base —
 *      takumi never stages or commits what the agent left behind;
 *   2. an advanced base is absorbed with a PLAIN merge (a conflict is aborted and
 *      handed to the review session, never resolved by rewriting history);
 *   3. the push is plain. A rejected push is a `precondition`, because the only
 *      ways out (`--force`, a rebase) rewrite commits that may already be
 *      reviewed;
 *   4. exactly ONE pull request exists per delivery: an open one for the branch is
 *      reused, so the review/fix loop keeps landing on the same PR;
 *   5. `merge` sends `sha=<expectedHeadSha>`, so **GitHub itself** refuses to merge
 *      anything but the reviewed commit — the guard is enforced by the host, not
 *      only by our own check.
 */

export interface GitHubDeliveryOptions {
  /** `owner/name`. */
  repo: string;
  /** Bearer token; falls back to `process.env.GITHUB_TOKEN`. */
  token?: string;
  /** API base, overridable for GitHub Enterprise and tests. Default `https://api.github.com`. */
  apiBase?: string;
  /** Remote to push to. Default `origin`. */
  remote?: string;
  /** Injected HTTP seam (tests pass a fake). */
  request?: BoardRequestFn;
  /** Injected git seam. Without one, every git operation fails closed. */
  git?: GitRunner;
}

interface GitHubPull {
  number?: number;
  html_url?: string;
  state?: string;
  merged_at?: string | null;
  mergeable?: boolean | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
}

interface GitHubCheckRun {
  name?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
}

interface GitHubCombinedStatus {
  state?: string;
  statuses?: Array<{ context?: string; state?: string; target_url?: string }>;
}

export class GitHubDeliveryProvider implements DeliveryProvider {
  private readonly repo: string;
  private readonly apiBase: string;
  private readonly remote: string;
  private readonly request: BoardRequestFn;
  private readonly git: GitRunner;

  constructor(opts: GitHubDeliveryOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
      throw new DeliveryError('precondition', `repo must be "owner/name", got ${JSON.stringify(opts.repo)}`);
    }
    this.repo = opts.repo;
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.remote = opts.remote ?? 'origin';
    const token = opts.token ?? process.env['GITHUB_TOKEN'];
    this.request =
      opts.request ??
      (token === undefined || token.length === 0
        ? unconfiguredRequestFn('github-delivery')
        : createGitHubTransport({ token, apiBase: this.apiBase }));
    this.git = opts.git ?? unconfiguredGitRunner();
  }

  metadata(): DeliveryProviderMetadata {
    return {
      id: 'github',
      name: 'GitHub Delivery',
      version: '0.1.0',
      description: 'Local git branch + GitHub pull request, checks and merge.',
    };
  }

  capabilities(): DeliveryCapabilities {
    return { canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true };
  }

  async deliver(req: DeliveryRequest, base: DeliveryBase): Promise<DeliveryOutcome> {
    if (base.baseSha.length === 0) {
      throw new DeliveryError('precondition', 'the frozen base sha is required to verify the commit boundary', {
        item: req.itemId,
      });
    }
    const cwd = req.worktree;
    const remote = req.remote ?? this.remote;
    const notes: string[] = [];

    // --- 1. the commit boundary -------------------------------------------------
    const branch = (await this.requireGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'precondition')).trim();
    if (branch !== req.branch) {
      throw new DeliveryError(
        'precondition',
        `the worktree is on ${branch}, not on the task branch ${req.branch}`,
        { item: req.itemId },
      );
    }
    const dirty = (await this.requireGit(['status', '--porcelain'], cwd, 'precondition')).trim();
    if (dirty.length > 0) {
      throw new DeliveryError(
        'precondition',
        `the worktree has uncommitted changes; the runner never commits them (first entry: ${dirty.split('\n')[0] ?? ''})`,
        { item: req.itemId },
      );
    }
    const head = (await this.requireGit(['rev-parse', 'HEAD'], cwd, 'precondition')).trim();
    if (head === base.baseSha) {
      throw new DeliveryError('precondition', `no commit on ${req.branch}: HEAD is still the frozen base`, {
        item: req.itemId,
      });
    }
    await this.requireAncestor(base.baseSha, 'HEAD', cwd, 'the head is not descended from the frozen base');

    // --- 2. base freshness ------------------------------------------------------
    await this.requireGit(['fetch', remote, req.baseBranch], cwd, 'transport');
    const remoteBase = `${remote}/${req.baseBranch}`;
    const upToDate = await this.runGit(['merge-base', '--is-ancestor', remoteBase, 'HEAD'], cwd);
    if (upToDate.exitCode !== 0) {
      const absorbed = await this.runGit(['merge', '--no-edit', remoteBase], cwd);
      if (absorbed.exitCode !== 0) {
        // Leave the worktree exactly as the agent left it: the base is the review
        // session's problem, and a half-merged tree would corrupt the delivery.
        await this.runGit(['merge', '--abort'], cwd);
        throw new DeliveryError(
          'precondition',
          `absorbing the advanced base ${remoteBase} conflicted; the review session must handle it (${gitFailure(['merge', '--no-edit', remoteBase], absorbed)})`,
          { item: req.itemId },
        );
      }
      notes.push(`absorbed advanced base ${remoteBase} with a plain merge`);
    }

    // --- 3. the plain push ------------------------------------------------------
    // Never `--force`, never `--force-with-lease`, never a rebase: the branch may
    // already have been reviewed, and history rewriting is not this layer's call.
    const pushArgs = ['push', remote, req.branch];
    const pushed = await this.runGit(pushArgs, cwd);
    if (pushed.exitCode !== 0) {
      const rejected = /non-fast-forward|\[rejected\]|fetch first/i.test(pushed.stderr);
      throw new DeliveryError(
        rejected ? 'precondition' : 'transport',
        rejected
          ? `the push was rejected because the remote branch moved; takumi never force-pushes (${gitFailure(pushArgs, pushed)})`
          : gitFailure(pushArgs, pushed),
        { item: req.itemId },
      );
    }
    const pushedHead = (await this.requireGit(['rev-parse', 'HEAD'], cwd, 'precondition')).trim();

    // --- 4. exactly one pull request -------------------------------------------
    const owner = this.repo.split('/')[0] ?? '';
    const listed = await requestBoardJson<GitHubPull[]>(
      this.request,
      {
        method: 'GET',
        url: `${this.apiBase}/repos/${this.repo}/pulls?head=${encodeURIComponent(`${owner}:${req.branch}`)}&state=open&per_page=100`,
      },
      'list open pull requests',
    );
    const existing = listed.find((pull) => pull.head?.ref === req.branch);
    let created = false;
    let pull = existing;
    if (pull === undefined) {
      created = true;
      pull = await requestBoardJson<GitHubPull>(
        this.request,
        {
          method: 'POST',
          url: `${this.apiBase}/repos/${this.repo}/pulls`,
          body: {
            title: req.title ?? `takumi: ${req.itemId}`,
            head: req.branch,
            base: req.baseBranch,
            body: pullRequestBody(req),
          },
        },
        'create pull request',
      );
    } else {
      notes.push(`reused open pull request ${String(pull.number ?? '?')}`);
    }

    if (pull.number === undefined || pull.html_url === undefined) {
      throw new DeliveryError('transport', 'GitHub returned a pull request without a number or url', {
        item: req.itemId,
      });
    }
    return {
      created,
      pr: { number: String(pull.number), url: pull.html_url, headSha: pushedHead, baseSha: req.baseBranch },
      push: { mode: 'plain', branch: req.branch, head: pushedHead },
      notes,
    };
  }

  async status(ref: PullRequestRef): Promise<PullRequestStatus> {
    const pull = await this.fetchPull(ref.number);
    return {
      state: pull.merged_at !== undefined && pull.merged_at !== null ? 'merged' : pull.state === 'open' ? 'open' : 'closed',
      // Tri-state on purpose: an unknown mergeability is not a yes.
      mergeable: typeof pull.mergeable === 'boolean' ? pull.mergeable : null,
      headSha: pull.head?.sha ?? '',
      baseSha: pull.base?.ref ?? '',
    };
  }

  async checks(ref: PullRequestRef): Promise<CheckSummary[]> {
    const head = ref.headSha.length > 0 ? ref.headSha : (await this.fetchPull(ref.number)).head?.sha ?? '';
    if (head.length === 0) throw new DeliveryError('precondition', 'no head sha to read checks from', { item: ref.number });

    const runs = await requestBoardJson<{ check_runs?: GitHubCheckRun[] }>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/repos/${this.repo}/commits/${head}/check-runs?per_page=100` },
      'check runs',
    );
    const combined = await requestBoardJson<GitHubCombinedStatus>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/repos/${this.repo}/commits/${head}/status` },
      'commit status',
    );

    const summaries: CheckSummary[] = [];
    for (const run of runs.check_runs ?? []) {
      const name = run.name ?? 'check';
      const conclusion =
        run.status !== 'completed' ? 'pending' : mapCheckConclusion(run.conclusion ?? undefined);
      summaries.push({
        name,
        conclusion,
        ...(run.html_url === undefined ? {} : { url: run.html_url }),
      });
    }
    // Legacy commit statuses are a separate API and a separate list: a build that
    // reports only statuses must not look like "no checks at all".
    for (const status of combined.statuses ?? []) {
      summaries.push({
        name: status.context ?? 'status',
        conclusion: mapCommitStatus(status.state),
        ...(status.target_url === undefined ? {} : { url: status.target_url }),
      });
    }
    return summaries;
  }

  async merge(
    ref: PullRequestRef,
    opts: { expectedHeadSha: string; method?: DeliveryMergeMethod },
  ): Promise<MergeOutcome> {
    if (this.capabilities().canMerge !== true) throw new DeliveryUnsupportedError('canMerge', 'github');
    const pull = await this.fetchPull(ref.number);
    const remoteHead = pull.head?.sha ?? '';
    if (remoteHead !== opts.expectedHeadSha) {
      throw new DeliveryError(
        'precondition',
        `the pull request head moved: reviewed ${opts.expectedHeadSha}, remote ${remoteHead}`,
        { item: ref.number },
      );
    }
    // An unknown mergeability is NOT a yes: GitHub may not have computed it yet.
    if (pull.mergeable === false) {
      throw new DeliveryError('precondition', `pull request ${ref.number} is not mergeable`, { item: ref.number });
    }
    if (pull.mergeable === null || pull.mergeable === undefined) {
      throw new DeliveryError(
        'precondition',
        `mergeability of pull request ${ref.number} is not known yet — an unknown is not a yes`,
        { item: ref.number },
      );
    }

    const method = opts.method ?? 'merge';
    const res = await this.request({
      method: 'PUT',
      url: `${this.apiBase}/repos/${this.repo}/pulls/${ref.number}/merge`,
      // `sha` is the host-side guard: GitHub refuses the merge when the head no
      // longer matches, so a racing push can never land unreviewed code.
      body: { sha: opts.expectedHeadSha, merge_method: method },
    });
    if (res.status < 200 || res.status >= 300) {
      const kind = res.status === 405 || res.status === 409 || res.status === 422 ? 'precondition' : undefined;
      const error = boardErrorFromResponse(res, `merge ${ref.number}`, ref.number);
      throw kind === undefined ? error : new DeliveryError('precondition', error.message, { item: ref.number });
    }
    return { merged: true, method, headSha: opts.expectedHeadSha, url: ref.url };
  }

  private async fetchPull(number: string): Promise<GitHubPull> {
    return requestBoardJson<GitHubPull>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/repos/${this.repo}/pulls/${number}` },
      `pull request ${number}`,
    );
  }

  /**
   * Every git call goes through here, so a failure of the seam itself (no runner
   * configured, git missing, timeout) surfaces as a `DeliveryError` like any other
   * failure of this port — a caller never has to catch two error families.
   */
  private async runGit(args: string[], cwd: string): Promise<GitResult> {
    try {
      return await this.git.run(args, { cwd });
    } catch (e) {
      if (e instanceof DeliveryError) throw e;
      if (e instanceof ProviderError) throw new DeliveryError(e.kind, e.message, { cause: e });
      throw e;
    }
  }

  private async requireGit(args: string[], cwd: string, kind: 'precondition' | 'transport'): Promise<string> {
    const result = await this.runGit(args, cwd);
    if (result.exitCode !== 0) {
      throw new DeliveryError(kind, gitFailure(args, result));
    }
    return result.stdout;
  }

  private async requireAncestor(ancestor: string, descendant: string, cwd: string, message: string): Promise<void> {
    const result = await this.runGit(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    if (result.exitCode !== 0) {
      throw new DeliveryError('precondition', `${message} (${ancestor} is not an ancestor of ${descendant})`);
    }
  }
}

/** The pull request body: the item cross-reference plus the machine-readable run marker. */
export function pullRequestBody(req: DeliveryRequest): string {
  const lines: string[] = [];
  if (req.body !== undefined && req.body.trim().length > 0) lines.push(req.body.trim());
  // Numeric ids can be closed natively by GitHub; every id is also stated in
  // plain text so a non-numeric board id (Jira key, Notion page) stays readable.
  if (/^\d+$/.test(req.itemId)) lines.push(`Fixes #${req.itemId}`);
  lines.push(`Item: ${req.itemId}`);
  lines.push(`Run: ${req.runId}`);
  lines.push(renderRunMarker(req.runId));
  return lines.join('\n\n');
}

function mapCheckConclusion(conclusion: string | undefined): CheckConclusion {
  switch (conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'cancelled':
    case 'action_required':
    case 'startup_failure':
    case 'stale':
      return 'failure';
    case 'neutral':
    case 'skipped':
      return 'neutral';
    default:
      return 'unknown';
  }
}

function mapCommitStatus(state: string | undefined): CheckConclusion {
  switch (state) {
    case 'success':
      return 'success';
    case 'failure':
    case 'error':
      return 'failure';
    case 'pending':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** The default transport: GitHub's REST API over curl. */
export function createGitHubTransport(
  opts: { token?: string; apiBase?: string } & Parameters<typeof createCurlRequestFn>[0] = {},
): BoardRequestFn {
  const token = opts.token ?? process.env['GITHUB_TOKEN'];
  const { token: _token, apiBase: _apiBase, ...curl } = opts;
  void _token;
  void _apiBase;
  return createCurlRequestFn({
    headers: () => {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'takumi-delivery',
      };
      if (token !== undefined && token.length > 0) headers['Authorization'] = `Bearer ${token}`;
      return headers;
    },
    ...curl,
  });
}

export function createGitHubDeliveryProvider(options: GitHubDeliveryOptions): GitHubDeliveryProvider {
  return new GitHubDeliveryProvider(options);
}
