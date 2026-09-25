/**
 * Task worktrees: where an agent does its work, and how they are cleaned up.
 *
 * A pilot that runs for months creates one worktree per item, and a worktree is
 * expensive: a full checkout, plus a branch that may still be needed to explain
 * what happened. orbi keeps them for a configurable window and then prunes. This
 * module does the same thing through the {@link GitRunner} seam, so a test can
 * assert the exact git commands instead of trusting a shell string.
 *
 * The rule that matters: **pruning never removes a worktree with uncommitted
 * work.** A retained worktree is evidence; a pruned one is gone. When git reports
 * a dirty tree, the prune skips it and says so, and the caller decides.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGitRunner, gitFailure, type GitRunner } from './git-runner.js';
import { ProviderError } from './provider-error.js';

export interface WorktreeRequest {
  /** The repository the worktrees belong to (the main checkout). */
  repo: string;
  /** Directory the task worktrees live under. Created if absent. */
  root: string;
  /** The item this worktree is for. */
  itemId: string;
  /** The run id, so two runs on one item cannot collide. */
  runId: string;
  /** Branch to create (or reuse) for the task. */
  branch: string;
  /** The branch the work was frozen from. */
  baseBranch: string;
  /** The frozen base sha, checked out as the starting point. */
  baseSha: string;
  /**
   * Resume a branch that already exists on the remote, instead of creating one.
   *
   * The worktree is checked out ON that branch (its work is what the delivery already pushed),
   * and the frozen base becomes the merge base with it. Set by a tick that is finishing a
   * delivery an earlier run started; never set for fresh work.
   */
  resumeBranch?: string;
  /** Remote the base is fetched from (default `origin`). */
  remote?: string;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseSha: string;
}

export interface WorktreeManagerOptions {
  git?: GitRunner;
}

export interface PruneOptions {
  root: string;
  /** Remove worktrees not modified for this long. */
  retainHours: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export interface PruneResult {
  removed: string[];
  /** Worktrees kept because they hold uncommitted work — never deleted silently. */
  keptDirty: string[];
  /** Worktrees kept because they are younger than the retention window. */
  keptRecent: string[];
}

/** `takumi/<item>-<run>` — unique per run, and readable in `git worktree list`. */
export function worktreeBranchName(itemId: string, runId: string): string {
  const slug = itemId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `takumi/${slug}-${runId}`;
}

/** `takumi/<itemId>` is the worktree branch; this derives it from an item id. */
export function worktreeDirName(itemId: string, runId: string): string {
  const slug = itemId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug}-${runId}`;
}

/**
 * Create (or reuse) the task worktree.
 *
 * The base is fetched first and the worktree is created FROM THE FROZEN SHA, not
 * from whatever the base branch happens to be now: a delivery must be able to say
 * exactly which commit it started from, and "the base moved while we were starting"
 * is a real event that a compare-and-merge would otherwise hide.
 */
export async function createTaskWorktree(
  request: WorktreeRequest,
  options: WorktreeManagerOptions = {},
): Promise<WorktreeHandle> {
  const git = options.git ?? createGitRunner();
  const remote = request.remote ?? 'origin';
  const path = join(request.root, worktreeDirName(request.itemId, request.runId));
  mkdirSync(request.root, { recursive: true });

  if (request.resumeBranch !== undefined) {
    // RESUMING a delivery that is already on the host: the branch exists on the remote (an
    // earlier run pushed it) and holds the work the review must cover. It is fetched into a
    // local branch of the same name and CHECKED OUT — never re-created from the base, which
    // would redo work that was already reviewed — and the frozen base becomes the MERGE BASE of
    // the two, so the review's diff is exactly what the delivery adds no matter what the base
    // branch has done since.
    await requireGit(
      git,
      ['fetch', '--force', remote, `${request.resumeBranch}:refs/heads/${request.resumeBranch}`],
      request.repo,
      'transport',
    );
    await requireGit(git, ['worktree', 'add', '--force', path, request.resumeBranch], request.repo, 'precondition');
    const mergeBase = await requireGit(git, ['merge-base', request.baseSha, request.resumeBranch], request.repo, 'precondition');
    return { path, branch: request.resumeBranch, baseSha: mergeBase.trim() };
  }

  await requireGit(git, ['fetch', remote, request.baseBranch], request.repo, 'transport');
  await requireGit(git, ['worktree', 'add', '--force', '-b', request.branch, path, request.baseSha], request.repo, 'precondition');
  return { path, branch: request.branch, baseSha: request.baseSha };
}

/** Remove one worktree and its branch. Refuses when the worktree holds changes. */
export async function removeTaskWorktree(
  handle: WorktreeHandle,
  request: { repo: string; branch?: string },
  options: WorktreeManagerOptions = {},
): Promise<void> {
  const git = options.git ?? createGitRunner();
  const dirty = await git.run(['status', '--porcelain'], { cwd: handle.path });
  if (dirty.exitCode === 0 && dirty.stdout.trim().length > 0) {
    throw new ProviderError(
      'precondition',
      `refusing to remove ${handle.path}: it holds uncommitted work (${dirty.stdout.trim().split('\n')[0] ?? ''})`,
    );
  }
  await requireGit(git, ['worktree', 'remove', '--force', handle.path], request.repo, 'precondition');
  if (request.branch !== undefined) {
    // A branch that was already merged deletes cleanly; one that was not is kept,
    // because deleting it would delete the only pointer to the delivered commit.
    await git.run(['branch', '-d', request.branch], { cwd: request.repo });
  }
}

/**
 * Prune worktrees older than the retention window.
 *
 * Never deletes a worktree with uncommitted work: that is somebody's evidence, and
 * a retention policy is not a licence to destroy it.
 */
export async function pruneTaskWorktrees(options: PruneOptions, manager: WorktreeManagerOptions = {}): Promise<PruneResult> {
  const git = manager.git ?? createGitRunner();
  const now = options.now ?? (() => Date.now());
  const result: PruneResult = { removed: [], keptDirty: [], keptRecent: [] };
  if (!existsSync(options.root)) return result;

  const cutoff = now() - options.retainHours * 3600 * 1000;
  const { readdirSync, statSync } = await import('node:fs');
  for (const entry of readdirSync(options.root)) {
    const path = join(options.root, entry);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > cutoff) {
      result.keptRecent.push(path);
      continue;
    }
    const dirty = await git.run(['status', '--porcelain'], { cwd: path });
    if (dirty.exitCode !== 0) {
      // Not a worktree we can read (already gone, or never one): leave it alone.
      result.keptRecent.push(path);
      continue;
    }
    if (dirty.stdout.trim().length > 0) {
      result.keptDirty.push(path);
      continue;
    }
    const removed = await git.run(['worktree', 'remove', '--force', path], { cwd: options.root });
    if (removed.exitCode === 0) result.removed.push(path);
  }
  // Drop the bookkeeping entries too, so `git worktree list` does not grow forever.
  await git.run(['worktree', 'prune'], { cwd: options.root });
  return result;
}

/** The branch a worktree is on, read from git rather than assumed. */
export async function currentBranch(path: string, git: GitRunner = createGitRunner()): Promise<string> {
  const out = await requireGit(git, ['rev-parse', '--abbrev-ref', 'HEAD'], path, 'precondition');
  return out.trim();
}

/** The commit a worktree is on — what a delivery will push. */
export async function currentHead(path: string, git: GitRunner = createGitRunner()): Promise<string> {
  const out = await requireGit(git, ['rev-parse', 'HEAD'], path, 'precondition');
  return out.trim();
}

/** Read the branch's tip from a ref file-free source: `git rev-parse <ref>`. */
export async function resolveRef(repo: string, ref: string, git: GitRunner = createGitRunner()): Promise<string> {
  return (await requireGit(git, ['rev-parse', ref], repo, 'precondition')).trim();
}

/** The frozen base recorded for a worktree (written by `createTaskWorktree`). */
export function readFrozenBase(path: string): string | null {
  const file = join(path, '.takumi-base-sha');
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  return value.length === 0 ? null : value;
}

async function requireGit(
  git: GitRunner,
  args: string[],
  cwd: string,
  kind: 'precondition' | 'transport',
): Promise<string> {
  const result = await git.run(args, { cwd });
  if (result.exitCode !== 0) {
    throw new ProviderError(kind, gitFailure(args, result));
  }
  return result.stdout;
}
