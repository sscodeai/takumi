/**
 * The semgrep sidecar: a second, independent reviewer behind the SAME `deps.review`
 * seam the deterministic rules use (ADR-021).
 *
 * WHY A PROCESS AND NOT A LIBRARY. semgrep is a large toolchain (~333MB), with its own rule
 * language and its own release cadence. Adopting that as a package dependency inside the merge
 * gate would make "what judged this change?" answerable only by reading a lockfile, and would
 * upgrade the judge whenever someone ran `pnpm update`. Its natural boundary is a PROCESS
 * boundary: we run it, we read a documented format, and the cost of it being absent is that
 * the delivery does not merge.
 *
 * THE FOUR THINGS THIS FILE IS CAREFUL ABOUT
 *
 *  1. There is NO `--config auto`. That form fetches a rule set over the network at review time
 *     and reports usage. The rule set that judges a merge is pinned in the repository, its
 *     content hash is part of the reviewer's IDENTITY, and a rule file edited under a running
 *     reviewer is refused rather than silently applied.
 *  2. A missing binary, an unreadable config, a non-zero exit, unparsable output or a non-empty
 *     `errors` array is NEVER `clean`. Each throws `ProviderError('transport'|'precondition')`,
 *     the loop retries, and nothing merges. "The tool could not tell us" is not an approval.
 *  3. The deterministic rules still run (unless explicitly disabled). A second reader must not be
 *     a downgrade: semgrep knows nothing about a weakened test, and that rule is the reason the
 *     reviewer exists at all.
 *  4. The tool's own severity vocabulary is translated ONCE, in one table, into Takumi's three
 *     severities — so "what does ERROR mean here" has a single answer that a human can read.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  collectReviewInput,
  isTestPath,
  ProviderError,
  REVIEW_RULESET_ID,
  runReviewRules,
  verdictFromFindings,
  type GitRunner,
  type ReviewContext,
  type ReviewFinding,
  type ReviewOutcome,
  type ReviewRules,
  type ReviewSeverity,
} from '@takumi/core';

/** The tool's severity vocabulary, verbatim. */
export type SemgrepSeverity = 'ERROR' | 'WARNING' | 'INFO';

/**
 * How the tool's severities become ours. The default is the honest translation:
 *
 *   ERROR   -> `block` — the rule author said this is a defect. An agent can answer it (remove
 *              the credential, restore the test), so it goes to a fix round.
 *   WARNING -> `human` — a judgement call, not a defect. Telling an agent to "fix" a curl|sh
 *              would mean reverting work a person may have asked for.
 *   INFO    -> `note`  — an observation next to the verdict, gating nothing.
 */
export const DEFAULT_SEVERITY_MAP: Readonly<Record<SemgrepSeverity, ReviewSeverity>> = {
  ERROR: 'block',
  WARNING: 'human',
  INFO: 'note',
};

/** Runs one process. Injected so every failure path is testable without the real toolchain. */
export type SemgrepRunner = (args: {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface SemgrepReviewerOptions {
  /**
   * The PINNED rule set. Required, and there is deliberately no default: a default would have to
   * be either a registry (`--config auto`, network + telemetry) or a path we guessed.
   */
  configPath: string;
  /** The binary. Default `semgrep`. */
  binary?: string;
  /**
   * The tool version this reviewer expects, e.g. `1.177.0`. STRONGLY recommended: a rule set
   * pins the rules, and this pins the engine that interprets them. A mismatch fails closed.
   */
  expectedVersion?: string;
  timeoutMs?: number;
  severityMap?: Partial<Record<SemgrepSeverity, ReviewSeverity>>;
  /** Run the built-in deterministic rules as well (default true) — a sidecar is not a downgrade. */
  composeDeterministic?: boolean;
  rules?: ReviewRules;
  /** Needed only when `composeDeterministic` is on. */
  git?: GitRunner;
  runner?: SemgrepRunner;
  /** More findings than this is a human's diff: refuse rather than truncate. Default 100. */
  maxFindings?: number;
}

export interface SemgrepReviewer {
  /** Goes into the plan, so the state record names the judge that actually ran (ADR-018). */
  id: string;
  /** The rule set's content hash — the half of the identity a commit can change. */
  ruleSetHash: string;
  review: (ctx: ReviewContext) => Promise<ReviewOutcome>;
}

/** `sha256(content)`, first 12 hex characters: long enough to pin, short enough to read. */
function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * The reviewer's identity, as it will be written into the review evidence.
 *
 * The rule set's hash is IN the identity on purpose: the digest of a clean review covers the
 * reviewer, so editing the rule file makes every stored approval stale and forces a re-review
 * instead of carrying a judgement onto a standard it was never given under.
 */
export function semgrepReviewerId(ruleSetHash: string, composeDeterministic: boolean): string {
  return composeDeterministic
    ? `reviewer:${REVIEW_RULESET_ID}+semgrep:${ruleSetHash}`
    : `reviewer:semgrep:${ruleSetHash}`;
}

/** The content hash of a rule file, or a precondition failure if it cannot be read. */
export function readRuleSetHash(configPath: string): string {
  try {
    return contentHash(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ProviderError(
      'precondition',
      `the semgrep rule set could not be read at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function defaultRunner(): SemgrepRunner {
  return async ({ argv, cwd, timeoutMs }) => {
    const [file, ...args] = argv;
    if (file === undefined) throw new ProviderError('precondition', 'no semgrep command was given');
    return await new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          // The tool reports usage by default. A merge gate inside someone's repository does not
          // get to phone home about that repository's code.
          env: { ...process.env, SEMGREP_SEND_METRICS: 'off' },
        },
        (error, stdout, stderr) => {
          if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(
              new ProviderError(
                'transport',
                `${file} is not installed (or not on PATH): the change cannot be verified, so it is not merged`,
              ),
            );
            return;
          }
          const code = (error as { code?: unknown } | null)?.code;
          if (error !== null && typeof code === 'number') {
            // A real exit code: the caller decides what it means, and the stderr travels with it.
            resolve({ code, stdout, stderr });
            return;
          }
          if (error !== null) {
            // A timeout or a killed process: no output to interpret, so this is a failure to run.
            reject(
              new ProviderError(
                'transport',
                `${file} did not finish within ${timeoutMs}ms: an unverified delivery waits rather than shipping`,
              ),
            );
            return;
          }
          resolve({ code: 0, stdout, stderr });
        },
      );
    });
  };
}

interface SemgrepJsonResult {
  check_id?: unknown;
  path?: unknown;
  start?: { line?: unknown };
  extra?: { severity?: unknown; message?: unknown };
}

/**
 * Parse the documented JSON. Every surprise is a FAILURE, not an empty result: a report we cannot
 * read is the "a missing binary read as clean" mistake wearing a different hat.
 */
function parseSemgrepJson(stdout: string): SemgrepJsonResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new ProviderError(
      'transport',
      `semgrep produced output that is not JSON (${error instanceof Error ? error.message : String(error)}): refusing to read that as "no findings"`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProviderError('transport', 'semgrep produced JSON that is not an object');
  }
  const body = parsed as { results?: unknown; errors?: unknown };
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (errors.length > 0) {
    // semgrep reports per-target failures here (unparsable files, a rule it could not compile).
    // A partial scan is not a clean scan, so it does not become one.
    const first = JSON.stringify(errors[0]).slice(0, 200);
    throw new ProviderError(
      'transport',
      `semgrep reported ${errors.length} error(s) while scanning, so the result is partial: ${first}`,
    );
  }
  if (!Array.isArray(body.results)) {
    throw new ProviderError('transport', 'semgrep JSON has no `results` array');
  }
  return body.results as SemgrepJsonResult[];
}

function toFinding(result: SemgrepJsonResult, severityMap: Readonly<Record<SemgrepSeverity, ReviewSeverity>>): ReviewFinding {
  const rawSeverity = typeof result.extra?.severity === 'string' ? result.extra.severity.toUpperCase() : '';
  // An unknown severity is treated as a JUDGEMENT (human), never as gating: a tool that invents a
  // new level must not be able to start blocking deliveries through our translation.
  const severity: ReviewSeverity =
    rawSeverity === 'ERROR' || rawSeverity === 'WARNING' || rawSeverity === 'INFO'
      ? severityMap[rawSeverity]
      : 'human';
  const line = typeof result.start?.line === 'number' ? result.start.line : undefined;
  const path = typeof result.path === 'string' ? result.path : undefined;
  const message = typeof result.extra?.message === 'string' ? result.extra.message : 'semgrep reported a finding';
  return {
    rule: typeof result.check_id === 'string' ? `semgrep:${result.check_id}` : 'semgrep:unknown-rule',
    severity,
    ...(path === undefined ? {} : { path }),
    ...(line === undefined ? {} : { line }),
    detail: message,
  };
}

export function createSemgrepReviewer(options: SemgrepReviewerOptions): SemgrepReviewer {
  const binary = options.binary ?? 'semgrep';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxFindings = options.maxFindings ?? 100;
  const composeDeterministic = options.composeDeterministic ?? true;
  const severityMap: Readonly<Record<SemgrepSeverity, ReviewSeverity>> = {
    ...DEFAULT_SEVERITY_MAP,
    ...(options.severityMap ?? {}),
  };
  const runner = options.runner ?? defaultRunner();
  // Hashed ONCE, at construction: a rule file edited while the reviewer lives is a different
  // standard than the one the identity claims, and the review refuses rather than judging with it.
  const ruleSetHash = readRuleSetHash(options.configPath);
  const id = semgrepReviewerId(ruleSetHash, composeDeterministic);

  const runDet = async (ctx: ReviewContext): Promise<ReviewFinding[]> => {
    if (!composeDeterministic) return [];
    const git = options.git;
    if (git === undefined) {
      throw new ProviderError(
        'precondition',
        'the semgrep reviewer composes the deterministic rules but was given no git runner',
      );
    }
    const testPatterns = options.rules?.testPathPatterns ?? [];
    const input = await collectReviewInput(git, {
      worktree: ctx.worktree,
      baseSha: ctx.baseSha,
      headSha: ctx.headSha,
      // Only the files a rule actually reads: a change list is cheap, `git show` per file is not.
      contentFor: (path: string): boolean => isTestPath(path, testPatterns),
    });
    return runReviewRules(input, options.rules);
  };

  const review = async (ctx: ReviewContext): Promise<ReviewOutcome> => {
    // 1. The standard must not have moved under us.
    const nowHash = readRuleSetHash(options.configPath);
    if (nowHash !== ruleSetHash) {
      throw new ProviderError(
        'precondition',
        `the semgrep rule set changed since this reviewer started (${ruleSetHash} -> ${nowHash}): the review would judge by a standard its own identity does not name`,
      );
    }

    // 2. The tool must be there, and — when asked — be the version this configuration pinned.
    const versionRun = await runner({ argv: [binary, '--version'], cwd: ctx.worktree, timeoutMs: 30_000 });
    if (versionRun.code !== 0) {
      throw new ProviderError(
        'transport',
        `${binary} --version exited ${versionRun.code}: the tool could not be checked, so the change cannot be verified`,
      );
    }
    const version = versionRun.stdout.trim().split(/\s+/).pop() ?? '';
    if (options.expectedVersion !== undefined && version !== options.expectedVersion) {
      throw new ProviderError(
        'precondition',
        `this reviewer pins semgrep ${options.expectedVersion} and the host has ${version}: the engine that interprets the rules changed, so the review is not the one the identity names`,
      );
    }

    // 3. The scan. `--baseline-commit` is what makes this a review OF THE CHANGE rather than a
    //    report on the repository: pre-existing findings are not this delivery's doing, and
    //    reporting them every round buries the finding that is new.
    const argv = [
      binary,
      '--config',
      options.configPath,
      '--json',
      '--baseline-commit',
      ctx.baseSha,
      '--quiet',
    ];
    const scan = await runner({ argv, cwd: ctx.worktree, timeoutMs });
    if (scan.code !== 0) {
      const tail = scan.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      throw new ProviderError(
        'transport',
        `semgrep exited ${scan.code} (a missing or invalid rule set is not a clean review): ${tail}`,
      );
    }

    // 4. Read it, translate it, and let the SAME production predicate the live rules reviewer uses
    //    decide the verdict — one mapping, so an audit and a delivery cannot disagree.
    const fromSemgrep = parseSemgrepJson(scan.stdout).map((result) => toFinding(result, severityMap));
    const fromRules = await runDet(ctx);
    const findings = [...fromRules, ...fromSemgrep];
    if (findings.length > maxFindings) {
      throw new ProviderError(
        'precondition',
        `the reviewers produced ${findings.length} findings (limit ${maxFindings}): that is a human's diff, not a review's`,
      );
    }
    const notes = findings.filter((finding) => finding.severity === 'note');
    const outcome = verdictFromFindings(findings, notes);
    return outcome;
  };

  return { id, ruleSetHash, review };
}
