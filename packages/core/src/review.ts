/**
 * The rule-based reviewer: read what actually changed between the frozen base and the
 * delivered head, then let the deterministic rules in `review-rules.ts` judge it.
 *
 * WHY THIS FILE EXISTS SEPARATELY: the rules are pure (two strings in, findings out) and
 * the plumbing is I/O (git, and the failure semantics that come with it). Keeping them
 * apart is what makes the rules exhaustively testable and the failure behaviour reviewable
 * on its own.
 *
 * THE FAILURE CONTRACT — the part that matters most:
 *
 *   A reviewer that cannot run must NEVER be read as `clean`.
 *
 * So a git failure here throws `ProviderError('transport')`. The delivery loop does not
 * catch it, the tick's outer handler records the item as `retriable` and the item is
 * retried on the next tick — with nothing merged. That is the honest direction: an
 * unverifiable delivery waits, rather than an unverified one shipping. (A throwing hook is
 * the existing seam for this; no new outcome was invented.)
 */

import { ProviderError } from './provider-error.js';
import { gitFailure, type GitRunner } from './git-runner.js';
import {
  describeFindings,
  hasBlockingFinding,
  hasHumanFinding,
  type ReviewFinding,
  isTestPath,
  runReviewRules,
  type ReviewFileChange,
  type ReviewInput,
  type ReviewRules,
} from './review-rules.js';
import type { ReviewContext, ReviewOutcome } from './delivery-loop.js';

export interface CollectReviewInputOptions {
  worktree: string;
  baseSha: string;
  headSha: string;
  /**
   * Which paths need their CONTENT read. Default: every changed file.
   *
   * The reviewer narrows this to the files a rule actually reads (test files): a change
   * list is cheap on any repository, while `git show` per file is not, and reading content
   * nothing uses is how a reviewer becomes the slowest part of a tick.
   */
  contentFor?: (path: string) => boolean;
  /** Stop after this many changed files and fail closed instead (a runaway diff). */
  maxChangedFiles?: number;
}

/** One `git diff --name-status -M` line: `M\tpath`, `R100\told\tnew`, ... */
function parseNameStatus(
  stdout: string,
): Array<{ status: ReviewFileChange['status']; path: string; previousPath?: string }> {
  const out: Array<{ status: ReviewFileChange['status']; path: string; previousPath?: string }> = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (code.startsWith('R')) {
      const from = parts[1];
      const to = parts[2];
      if (to !== undefined) out.push({ status: 'renamed', path: to, ...(from === undefined ? {} : { previousPath: from }) });
      continue;
    }
    const path = parts[1];
    if (path === undefined) continue;
    if (code.startsWith('A')) out.push({ status: 'added', path });
    else if (code.startsWith('D')) out.push({ status: 'deleted', path });
    else if (code.startsWith('M') || code.startsWith('T')) out.push({ status: 'modified', path });
    // Anything else (unmerged, unknown) is not something a rule can judge, and pretending
    // otherwise would produce findings about a state nobody described.
  }
  return out;
}

/**
 * Read the change set the rules judge.
 *
 * `git show <rev>:<path>` failing is EXACTLY what a deleted (or added) file looks like, so
 * the expected absences are decided by the recorded status and never by the exit code —
 * otherwise a genuine git failure would be mistaken for "the file was not there", which is
 * the one mistake that would silently weaken every rule that reads content.
 */
/**
 * The rules' verdicts, as a delivery outcome. Exported so that anything REASONING about the review
 * (the gate-fire bench, an audit) reaches the same answer the live reviewer does — a bench that
 * re-implements the mapping is a bench that can pass while the reviewer is broken.
 */
export function verdictFromFindings(
  findings: readonly ReviewFinding[],
  notes: readonly ReviewFinding[] = [],
): ReviewOutcome {
  if (hasBlockingFinding(findings)) {
    return { verdict: 'findings', note: describeFindings(findings.filter((f) => f.severity === 'block')) };
  }
  if (hasHumanFinding(findings)) {
    return {
      verdict: 'awaiting-human',
      note: `${describeFindings(findings.filter((finding) => finding.severity === 'human'))} — this delivery waits for a person`,
    };
  }
  return notes.length === 0 ? { verdict: 'clean' } : { verdict: 'clean', note: describeFindings(notes) };
}

export async function collectReviewInput(
  git: GitRunner,
  options: CollectReviewInputOptions,
): Promise<ReviewInput> {
  const { worktree, baseSha, headSha } = options;
  const contentFor = options.contentFor ?? ((): boolean => true);
  const maxChangedFiles = options.maxChangedFiles ?? 5000;

  const diff = await git.run(['diff', '--name-status', '-M', baseSha, headSha], { cwd: worktree });
  if (diff.exitCode !== 0) {
    throw new ProviderError('transport', `the reviewer could not read the change set: ${gitFailure(['diff'], diff)}`);
  }
  const listed = parseNameStatus(diff.stdout);
  if (listed.length > maxChangedFiles) {
    throw new ProviderError(
      'transport',
      `the reviewer refuses to judge a change set of ${listed.length} files (limit ${maxChangedFiles}): that is a human's diff, not a review rule's`,
    );
  }

  const changes: ReviewFileChange[] = [];
  for (const entry of listed) {
    const needsContent = contentFor(entry.path);
    const absentAtBase = entry.status === 'added';
    const absentAtHead = entry.status === 'deleted';
    let baseContent: string | null = null;
    let headContent: string | null = null;

    if (needsContent && !absentAtBase) {
      // A rename's base content is at the OLD path; asking for the new one there fails.
      baseContent = await showFile(git, worktree, baseSha, entry.previousPath ?? entry.path);
    }
    if (needsContent && !absentAtHead) {
      headContent = await showFile(git, worktree, headSha, entry.path);
    }
    changes.push({
      path: entry.path,
      status: entry.status,
      baseContent,
      headContent,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
    });
  }
  return { baseSha, headSha, changes };
}

/** One file's content at one revision; a failure here is a failure, not an absence. */
async function showFile(git: GitRunner, worktree: string, rev: string, path: string): Promise<string> {
  const shown = await git.run(['show', `${rev}:${path}`], { cwd: worktree });
  if (shown.exitCode !== 0) {
    throw new ProviderError(
      'transport',
      `the reviewer could not read ${path} at ${rev.slice(0, 12)}: ${gitFailure(['show'], shown)}`,
    );
  }
  return shown.stdout;
}

export interface RuleReviewerOptions {
  git: GitRunner;
  rules?: ReviewRules;
}

/**
 * A review hook (see `DeliveryLoopHooks.review`) that judges the delivered head with the
 * deterministic rules.
 *
 * Verdict mapping, and why each is what it is:
 *  - a `block` finding is a defect the AGENT can answer in a fix round (it weakened a test;
 *    it can put it back), so the verdict is `findings` and the note names every rule;
 *  - a `human` finding is a decision no machine may make and no agent may undo, so the
 *    verdict is `awaiting-human` — which by design burns no round and never merges;
 *  - notes alone are `clean` **with a note**, so an observation reaches the board comment
 *    without pretending to be a defect.
 *
 * Blocking findings win over human findings when both are present: the agent's defect is
 * answerable now, and the human decision is still there afterwards (the next round
 * re-reviews the new head).
 */
export function createRuleReviewer(options: RuleReviewerOptions): (ctx: ReviewContext) => Promise<ReviewOutcome> {
  const { git, rules } = options;
  const contentFor = (path: string): boolean => isTestPath(path, rules?.testPathPatterns ?? []);

  return async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    const input = await collectReviewInput(git, {
      worktree: ctx.worktree,
      baseSha: ctx.baseSha,
      headSha: ctx.headSha,
      contentFor,
    });
    const findings = runReviewRules(input, rules);
    const notes = findings.filter((finding) => finding.severity === 'note');
    return verdictFromFindings(findings, notes);
  };
}
