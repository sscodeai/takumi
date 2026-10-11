/**
 * The delivery worktree: who creates it, and what qualifies as one.
 *
 * WHY THIS EXISTS (docs/bugs-fixed.md #43, found by the live run i9): the `publish` step's
 * delivery port refuses a worktree whose HEAD is not DESCENDED from the frozen base — correctly,
 * because a rewritten (or unrelated) history must never reach a host. A worktree created by hand as
 * a fresh `git init` repository therefore fails at publish, but only AFTER a full run has spent its
 * work. Two fixes live here:
 *
 *   (C) With a `delivery:` section configured, `takumi run` CREATES the worktree itself: it clones
 *       the configured repository (the clone URL comes from the provider-generic derivation — see
 *       `deliveryCloneUrl`) and creates the task branch FROM THE BASE, so the ancestry the
 *       publish step checks holds by construction, and the implementer sees the target repository's
 *       real content rather than an empty one. `--worktree` stays an explicit override.
 *
 *   (B) With `--worktree` supplied, `takumi run` REFUSES BEFORE THE RUN STARTS unless the named
 *       checkout qualifies: it exists and is a git repository, it is on a branch (not a detached
 *       HEAD), its working tree is clean, and its HEAD is descended from `<remote>/<baseBranch>`
 *       after a fetch. A run that spends an hour and only then discovers it cannot publish is the
 *       failure this refusal prevents.
 *
 * Every git call goes through core's {@link GitRunner} seam, so a test observes the exact argv
 * instead of trusting a shell string.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createGitRunner, gitFailure, type GitRunner } from '@takumi/core';

import { deliveryCloneUrl, type DeliverySection } from './delivery-command.js';

/** One-line, length-bounded description of a failed git command, for an error message. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/**
 * `takumi/run-<UTC timestamp>-<8 hex random>` — a task branch two runs cannot share.
 *
 * WHY A TIMESTAMP PLUS RANDOM: a branch name must be unique or a second run would collide with the
 * first (git refuses to create a branch that exists, and a resumed/rewritten branch is exactly the
 * thing the publish boundary forbids). A timestamp alone collides when two runs start in the same
 * millisecond; a random suffix alone is unreadable in `git branch`. Together: the timestamp makes
 * the branch orderable and human-readable in `git branch`/`git log`, and the 8 hex characters
 * (4 random bytes) make a collision between two runs a 1-in-2^32 event even within the same
 * millisecond. Both parts are injectable so a test can pin the shape.
 */
export function deliveryBranchName(
  now: () => Date = () => new Date(),
  randomHex: () => string = () => randomBytes(4).toString('hex'),
): string {
  // `2026-10-06T12:00:00.123Z` → `20261006T120000123Z` (git-ref-safe, no punctuation).
  const stamp = now().toISOString().replace(/[-:.]/g, '');
  return `takumi/run-${stamp}-${randomHex()}`;
}

/** The single path segment a branch maps to (`takumi/run-…` → `takumi-run-…`). */
export function deliveryWorktreeDirName(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Where a run's own (self-created) delivery worktree lives under the project directory. */
export function deliveryWorktreeRoot(cwd: string): string {
  return join(cwd, '.takumi', 'worktrees');
}

export interface CreateDeliveryWorktreeRequest {
  /** The project directory; the worktree is created under `<cwd>/.takumi/worktrees/`. */
  cwd: string;
  /** The `delivery:` section the repository and base branch come from. */
  section: DeliverySection;
  /** Override the generated branch name (tests). */
  branch?: string;
  /** Injected git runner (tests). Without it core's default spawn runner is used. */
  git?: GitRunner;
}

export interface DeliveryWorktree {
  path: string;
  branch: string;
  /** The URL that was cloned (never carries a credential — the operator's git credential helper does). */
  cloneUrl: string;
  baseBranch: string;
  remote: string;
}

/**
 * Create the delivery worktree: clone the configured repository, then create the task branch FROM
 * THE BASE.
 *
 * The clone is REAL (`git clone` of the configured repo), never a `git init` shortcut, and the task
 * branch is created from the base branch the clone checked out — so the publish step's ancestry
 * rule holds by construction, and there is no detached HEAD. A clone or branch-creation failure
 * FAILS LOUDLY: the run must never continue in a worktree it did not actually create.
 */
export async function createDeliveryWorktree(
  request: CreateDeliveryWorktreeRequest,
): Promise<DeliveryWorktree> {
  const git = request.git ?? createGitRunner();
  // The clone URL comes from the provider's own target resolution — not a second derivation.
  const cloneUrl = await deliveryCloneUrl(request.section);
  const branch = request.branch ?? deliveryBranchName();
  const baseBranch = request.section.baseBranch ?? 'main';
  const remote = request.section.remote ?? 'origin';
  const path = join(deliveryWorktreeRoot(request.cwd), deliveryWorktreeDirName(branch));

  if (existsSync(path)) {
    throw new Error(
      `refusing to create the delivery worktree at ${path}: it already exists. A fresh branch name ` +
        `is generated per run, so this path should not exist — remove it, or pass --worktree to run ` +
        `in an existing checkout.`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });

  // `--branch <base>` checks out the base branch, so the task branch created next descends from it.
  const cloneArgs = ['clone', '--branch', baseBranch, cloneUrl, path];
  const clone = await git.run(cloneArgs, { cwd: request.cwd });
  if (clone.exitCode !== 0) {
    throw new Error(
      `could not clone ${cloneUrl} into ${path} (${gitFailure(cloneArgs, clone)}): the run cannot ` +
        `continue in a worktree it did not create. Check the \`delivery:\` section's repo/apiBase and ` +
        `that the host is reachable.`,
    );
  }

  const branchArgs = ['switch', '-c', branch];
  const created = await git.run(branchArgs, { cwd: path });
  if (created.exitCode !== 0) {
    throw new Error(
      `cloned ${cloneUrl} into ${path} but could not create the task branch ${branch} from ` +
        `${baseBranch} (${gitFailure(branchArgs, created)}): the run cannot continue in a worktree ` +
        `whose branch was not created.`,
    );
  }

  // `git clone` names the remote `origin`; if the `delivery:` section named another one, rename it so
  // the publish step (which pushes to that remote) finds it. Without this the clone would be correct
  // and the push would still fail on a remote that does not exist.
  if (remote !== 'origin') {
    const renameArgs = ['remote', 'rename', 'origin', remote];
    const renamed = await git.run(renameArgs, { cwd: path });
    if (renamed.exitCode !== 0) {
      throw new Error(
        `cloned ${cloneUrl} into ${path} but could not name its remote ${remote} (${gitFailure(renameArgs, renamed)}).`,
      );
    }
  }

  return { path, branch, cloneUrl, baseBranch, remote };
}

export interface WorktreeCheckRequest {
  /** The checkout named by `--worktree`. */
  worktree: string;
  /** The remote the base is fetched from (from the `delivery:` section, default `origin`). */
  remote: string;
  /** The base branch HEAD must descend from (from the `delivery:` section, default `main`). */
  baseBranch: string;
  /** Injected git runner (tests). Without it core's default spawn runner is used. */
  git?: GitRunner;
}

/**
 * Refuse a `--worktree` checkout that does not qualify, BEFORE the run starts.
 *
 * The checks run in this order, each with its own message naming the problem and the remedy:
 *
 *   1. the path exists and is a git repository;
 *   2. it is on a branch, not a detached HEAD;
 *   3. its working tree is clean;
 *   4. its HEAD is descended from `<remote>/<baseBranch>` after a fetch.
 */
export async function assertWorktreeQualifies(request: WorktreeCheckRequest): Promise<void> {
  const git = request.git ?? createGitRunner();
  const path = request.worktree;

  // 1. exists and is a git repository.
  if (!existsSync(path)) {
    throw new Error(
      `--worktree ${path} does not exist: a run must start in a checkout of the repository it will ` +
        `deliver. Clone the target repository and branch from its base, or drop --worktree and let ` +
        `the configured \`delivery:\` section create the worktree.`,
    );
  }
  const gitDirArgs = ['rev-parse', '--git-dir'];
  const gitDir = await git.run(gitDirArgs, { cwd: path });
  if (gitDir.exitCode !== 0) {
    throw new Error(
      `--worktree ${path} is not a git repository (${gitFailure(gitDirArgs, gitDir)}): a delivery ` +
        `must be able to name the branch and history it pushes. Clone the target repository and ` +
        `branch from its base, or drop --worktree and let the configured \`delivery:\` section ` +
        `create the worktree.`,
    );
  }

  // 2. on a branch, not a detached HEAD. `symbolic-ref` is the precise test: it succeeds on a
  // branch (even an unborn one) and fails on a detached HEAD.
  const symbolicArgs = ['symbolic-ref', '-q', '--short', 'HEAD'];
  const symbolic = await git.run(symbolicArgs, { cwd: path });
  if (symbolic.exitCode === 1) {
    throw new Error(
      `--worktree ${path} is on a DETACHED HEAD, not a branch: a delivery must name the branch it ` +
        `pushes, and a detached HEAD has none. Check out the task branch (git switch <branch>) ` +
        `before running.`,
    );
  }
  if (symbolic.exitCode !== 0) {
    throw new Error(
      `--worktree ${path}: could not read the checked-out branch (${gitFailure(symbolicArgs, symbolic)}).`,
    );
  }

  // 3. a clean working tree: the run must START from a clean state.
  // NOTE: this is NOT the same check the delivery port makes at deliver() time. There the
  // implementer has ALREADY committed, and the port's rule is that the commit is the boundary
  // (an uncommitted change at deliver() time is refused). Here the run has not started, so the
  // requirement is the weaker and earlier one: nothing uncommitted before the work begins.
  const statusArgs = ['status', '--porcelain'];
  const status = await git.run(statusArgs, { cwd: path });
  if (status.exitCode !== 0) {
    throw new Error(`--worktree ${path}: could not read the worktree state (${gitFailure(statusArgs, status)}).`);
  }
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `--worktree ${path} has uncommitted changes (${firstLine(status.stdout)}): the run must start ` +
        `from a clean state. Commit or stash them first — takumi never commits for you.`,
    );
  }

  // 4. HEAD must be DESCENDED from the remote base, after a fetch (so the answer is about the
  // ref that exists on the host now, not a stale local one).
  const remoteRef = `${request.remote}/${request.baseBranch}`;
  const fetchArgs = ['fetch', request.remote, request.baseBranch];
  const fetch = await git.run(fetchArgs, { cwd: path });
  if (fetch.exitCode !== 0) {
    throw new Error(
      `--worktree ${path}: could not fetch ${request.remote} ${request.baseBranch} to check the ` +
        `base (${gitFailure(fetchArgs, fetch)}): without it the ancestry of ${remoteRef} cannot be ` +
        `verified. Check the remote and the base branch in the \`delivery:\` section.`,
    );
  }
  const ancestorArgs = ['merge-base', '--is-ancestor', remoteRef, 'HEAD'];
  const ancestor = await git.run(ancestorArgs, { cwd: path });
  if (ancestor.exitCode === 1) {
    throw new Error(
      `--worktree ${path} HEAD is not descended from ${remoteRef} (git merge-base --is-ancestor ` +
        `${remoteRef} HEAD failed): a delivery from this worktree would be refused AFTER the work ` +
        `is done. Branch the task branch from ${remoteRef} (or fetch and merge/rebase it) before ` +
        `running.`,
    );
  }
  if (ancestor.exitCode !== 0) {
    throw new Error(
      `--worktree ${path}: could not compare ${remoteRef} with HEAD (${gitFailure(ancestorArgs, ancestor)}).`,
    );
  }
}
