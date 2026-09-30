/**
 * The delivery that has no review surface: a bare git remote.
 *
 * WHY THIS EXISTS
 *
 * Every other delivery in this repo is shaped by a host that offers a place to review a change —
 * a pull request with checks and a merge button. A plain git remote offers none of that: it has
 * branches. That is still a real delivery target (a self-hosted server without an API adapter, a
 * mirror, a repository you own end to end), and leaving it out meant the only honest use of takumi
 * was against a forge.
 *
 * WHAT IT DOES AND DOES NOT DO
 *
 * - It pushes the task branch PLAIN (never forced) and then READS THE REMOTE BACK: the head it
 *   reports is the head the remote holds, verified after the push rather than assumed from a zero
 *   exit code. That read-back is what makes "delivered" a fact here.
 * - It reports NO pull request (`canOpenPullRequest: false`): the events, the board state and the
 *   trail then name the branch instead, instead of claiming a review surface that does not exist.
 * - It reports NO checks (`canRunChecks: false`): nothing runs CI for it, so `checks` is empty and
 *   the loop reports "no checks reported" — which is the honest reason a `reviewMode: label`
 *   (a human) or `reviewMode: rules` (the deterministic reviewer, which needs no host) is the way
 *   to gate it.
 * - It merges by moving the base branch FORWARD to exactly the reviewed head: a plain push of
 *   `HEAD:refs/heads/<base>`. A non-fast-forward is refused by git itself, so a diverged base is a
 *   `precondition` failure handed to a human — never a force push, never a rewritten history.
 *   That is the whole of "merge" here, and `squash`/`rebase` are refused as unsupported rather
 *   than silently treated as something they are not.
 */

import {
  DeliveryError,
  createGitRunner,
  type CheckSummary,
  type DeliveryCapabilities,
  type DeliveryMergeMethod,
  type DeliveryOutcome,
  type DeliveryProvider,
  type DeliveryRequest,
  type GitRunner,
  type MergeOutcome,
  type PullRequestRef,
  type PullRequestStatus,
} from '@takumi/core';

export interface GitDeliveryOptions {
  /**
   * A checkout of the same remote, used for the git calls that outlive one worktree
   * (`ls-remote`, `fetch`, the merge push). Any clone of the remote works: nothing is written to
   * it except its own remote-tracking refs.
   */
  repo: string;
  /** The branch a merge moves forward. */
  baseBranch: string;
  /** Remote name (default `origin`). */
  remote?: string;
  /** Injected for tests. */
  git?: GitRunner;
}

export class GitDeliveryProvider implements DeliveryProvider {
  private readonly git: GitRunner;
  private readonly remote: string;

  constructor(private readonly options: GitDeliveryOptions) {
    this.git = options.git ?? createGitRunner();
    this.remote = options.remote ?? 'origin';
  }

  metadata(): { id: string; name: string; version: string } {
    return { id: 'git', name: 'Bare Git Remote Delivery', version: '0.1.0' };
  }

  capabilities(): DeliveryCapabilities {
    return {
      canPushBranch: true,
      // Nothing to open: the review surface a forge gives us does not exist here.
      canOpenPullRequest: false,
      // Nothing runs checks for a bare remote, so pretending to read them would be a lie.
      canRunChecks: false,
      canMerge: true,
    };
  }

  async deliver(request: DeliveryRequest, base: { baseSha: string }): Promise<DeliveryOutcome> {
    const cwd = request.worktree;

    // Rule 1: the agent's boundary is a commit. A worktree it left dirty means "the work is not
    // where I said it is", and the runner never commits on the agent's behalf.
    const dirty = await this.git.run(['status', '--porcelain'], { cwd });
    if (dirty.exitCode !== 0) {
      throw new DeliveryError('precondition', `could not read the worktree state: ${dirty.stderr.trim().split('\n')[0] ?? ''}`);
    }
    if (dirty.stdout.trim().length > 0) {
      throw new DeliveryError(
        'precondition',
        `the worktree has uncommitted changes (${dirty.stdout.trim().split('\n')[0] ?? ''}); the runner never commits them`,
      );
    }

    const branch = (await requireGit(this.git, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, 'precondition')).trim();
    if (branch !== request.branch) {
      throw new DeliveryError('precondition', `the worktree is on ${branch}, not ${request.branch}`);
    }
    const head = (await requireGit(this.git, ['rev-parse', 'HEAD'], cwd, 'precondition')).trim();
    if (head === base.baseSha) {
      throw new DeliveryError('precondition', `no commit on ${request.branch}: HEAD is still the frozen base`);
    }
    if ((await this.isAncestor(base.baseSha, head, cwd)) !== true) {
      throw new DeliveryError('precondition', `the head is not descended from the frozen base ${base.baseSha.slice(0, 12)}`);
    }

    // `created` here means "the remote did not have this branch": there is no review surface to
    // create, and answering anything else would invent one.
    const before = await this.remoteHead(request.branch, cwd);
    await requireGit(this.git, ['push', this.remote, request.branch], cwd, 'transport');

    // VERIFY, do not assume: a zero exit from `git push` is not the same fact as "the remote holds
    // this commit". The head below is read back from the remote.
    const after = await this.remoteHead(request.branch, cwd);
    if (after !== head) {
      throw new DeliveryError(
        'transport',
        `the push did not land: ${this.remote} reports ${String(after)} for ${request.branch}, pushed ${head}`,
      );
    }
    return {
      created: before !== head,
      push: { mode: 'plain', branch: request.branch, head },
      notes: [`pushed ${request.branch} to ${this.remote}; the remote head was read back and matches`],
    };
  }

  async status(ref: PullRequestRef): Promise<PullRequestStatus> {
    const head = await this.remoteHead(ref.number, this.options.repo);
    if (head === null) {
      return { state: 'closed', mergeable: false, headSha: ref.headSha, baseSha: ref.baseSha };
    }
    const baseHead = await this.remoteHead(this.options.baseBranch, this.options.repo);
    if (baseHead === null) {
      throw new DeliveryError('precondition', `the base branch ${this.options.baseBranch} is not on ${this.remote}`);
    }
    if ((await this.isAncestor(head, baseHead, this.options.repo)) === true) {
      return { state: 'merged', mergeable: false, headSha: head, baseSha: ref.baseSha };
    }
    // Fast-forward possible? Read from the refs, not from a merge in the worktree: a merge here
    // would move the base branch as a side effect of ASKING.
    const mergeable = await this.isAncestor(baseHead, head, this.options.repo);
    return { state: 'open', mergeable, headSha: head, baseSha: ref.baseSha };
  }

  async checks(): Promise<CheckSummary[]> {
    // `canRunChecks: false`: there is nothing to read, and an empty list says so without claiming
    // a green one.
    return [];
  }

  async merge(ref: PullRequestRef, options: { expectedHeadSha: string; method?: DeliveryMergeMethod }): Promise<MergeOutcome> {
    if (options.method !== undefined && options.method !== 'merge') {
      throw new DeliveryError(
        'unsupported',
        `a bare remote integrates by moving the base branch forward (fast-forward); '${options.method}' is not available`,
      );
    }
    const head = await this.remoteHead(ref.number, this.options.repo);
    if (head === null) {
      throw new DeliveryError('precondition', `branch ${ref.number} is not on ${this.remote}`);
    }
    // Rule 3: only the head that was reviewed may move the base branch.
    if (head !== options.expectedHeadSha) {
      throw new DeliveryError(
        'precondition',
        `the branch head moved: asked to merge ${options.expectedHeadSha}, the remote has ${head} — re-review required`,
      );
    }
    // A PLAIN push of the head onto the base branch. No `--force`, no `+` refspec: git refuses a
    // non-fast-forward itself, so a base that moved on is a refusal here rather than a rewritten
    // history there.
    await requireGit(this.git, ['push', this.remote, `${head}:refs/heads/${this.options.baseBranch}`], this.options.repo, 'precondition');

    const baseHead = await this.remoteHead(this.options.baseBranch, this.options.repo);
    if (baseHead !== head) {
      throw new DeliveryError('transport', `${this.options.baseBranch} did not move to ${head} (it reports ${String(baseHead)})`);
    }
    return { merged: true, method: 'merge', headSha: head, url: '' };
  }

  /** The sha the remote holds for a branch, or `null` when it does not have it. */
  private async remoteHead(branch: string, cwd: string): Promise<string | null> {
    const out = await requireGit(this.git, ['ls-remote', '--heads', this.remote, `refs/heads/${branch}`], cwd, 'transport');
    const sha = out.trim().split(/\s+/)[0] ?? '';
    return sha.length === 0 ? null : sha;
  }

  /** `true`/`false` from git's own answer; anything else is an error, never a silent `false`. */
  private async isAncestor(maybeAncestor: string, descendant: string, cwd: string): Promise<boolean> {
    const result = await this.git.run(['merge-base', '--is-ancestor', maybeAncestor, descendant], { cwd });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new DeliveryError('precondition', `could not compare ${maybeAncestor.slice(0, 12)} with ${descendant.slice(0, 12)}: ${result.stderr.trim()}`);
  }
}

async function requireGit(git: GitRunner, args: string[], cwd: string, kind: 'precondition' | 'transport'): Promise<string> {
  const result = await git.run(args, { cwd });
  if (result.exitCode !== 0) {
    throw new DeliveryError(kind, `git ${args[0] ?? ''} failed: ${result.stderr.trim().split('\n')[0] ?? `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

export function createGitDeliveryProvider(options: GitDeliveryOptions): GitDeliveryProvider {
  return new GitDeliveryProvider(options);
}
