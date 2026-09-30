/**
 * The reviewdog reporter: our findings, on the host's review surface (ADR-022).
 *
 * WHY A PROCESS, like the semgrep reviewer and for the same reason: reviewdog's job is host-specific
 * — GitHub review comments, GitLab MR discussions, a SARIF artifact, a Check — and that vocabulary
 * changes on someone else's schedule. Its natural boundary is a process boundary, and the format it
 * accepts (`rdjsonl`) is the seam: we translate OUR findings into it and let reviewdog own the host.
 *
 * WHAT THIS FILE IS CAREFUL ABOUT
 *
 *  1. `-diff` is a COMMAND STRING that reviewdog executes. The shas that go into it are ours, and
 *     they are validated as hex before they are interpolated: a "commit" that is `; rm -rf` is not a
 *     commit, and a reporter is not a shell.
 *  2. NOT_RUN is reported, never silently swallowed. A reporter that cannot run means nobody saw the
 *     findings; returning "fine" would make the absence of a report indistinguishable from a clean
 *     review. The caller decides whether that fails a delivery (it does not) — but it decides with
 *     the fact in hand.
 *  3. A finding with no path cannot be posted inline, so it is returned as `unlocated` instead of
 *     being dropped: reviewdog would refuse it, and dropping it ourselves would be the same silence
 *     with fewer steps.
 *  4. Nothing secret ever reaches argv. Host reporters take their credentials from the ENVIRONMENT
 *     (`REVIEWDOG_GITHUB_API_TOKEN`, …), and this package never puts a token anywhere else.
 */

import { execFile } from 'node:child_process';
import { ProviderError, type ReviewFinding, type ReviewSeverity } from '@takumi/core';

/** rdjsonl's vocabulary, which is not ours. */
export type RdjsonSeverity = 'INFO' | 'WARNING' | 'ERROR';

/**
 * Our severities, translated back for the host.
 *
 *   block -> ERROR   — the thing a merge must not proceed past
 *   human -> WARNING — a person must decide, so a person must see it
 *   note  -> INFO    — an observation
 */
export const DEFAULT_RDJSON_SEVERITY: Readonly<Record<ReviewSeverity, RdjsonSeverity>> = {
  block: 'ERROR',
  human: 'WARNING',
  note: 'INFO',
};

export interface RdjsonLine {
  message: string;
  location: { path: string; range: { start: { line: number } } };
  severity: RdjsonSeverity;
  code?: { value: string };
  source?: { name: string; url?: string };
}

/** Runs one process. Injected so every failure path is testable without reviewdog installed. */
export type ReviewdogRunner = (args: {
  argv: readonly string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string;
}) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface ReviewdogReporterOptions {
  /** Where the findings go: `local` prints them, `github-pr-review` comments, … Default `local`. */
  reporter?: string;
  /** Default `added`: only the lines THIS change introduced, which is what a review of a change is. */
  filterMode?: 'added' | 'diff_context' | 'file' | 'nofilter';
  /** The tool name shown on the host. Default `takumi`. */
  name?: string;
  /** The source recorded on every diagnostic. Default `takumi`. */
  sourceName?: string;
  sourceUrl?: string;
  binary?: string;
  timeoutMs?: number;
  runner?: ReviewdogRunner;
  /** Environment for the child (the host token lives here, never in argv). */
  env?: NodeJS.ProcessEnv;
}

export interface ReviewdogReport {
  /** How many diagnostics were handed to reviewdog. */
  posted: number;
  /** Findings with no path: they cannot be an inline comment, and they are not dropped. */
  unlocated: ReviewFinding[];
  /** reviewdog's own output (with `-reporter=local`, this is the filtered list). */
  stdout: string;
}

export interface ReviewdogReporter {
  /** Translate findings, without running anything: the pure half, exported for testing. */
  toRdjsonl: (findings: readonly ReviewFinding[]) => string;
  report: (args: {
    findings: readonly ReviewFinding[];
    baseSha: string;
    headSha: string;
    cwd: string;
  }) => Promise<ReviewdogReport>;
}

/** A 7-40 character hex string: a commit id, and nothing that could be a shell command. */
function assertSha(sha: string, what: string): string {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw new ProviderError(
      'precondition',
      `the ${what} is not a commit id (${JSON.stringify(sha.slice(0, 40))}): reviewdog's -diff is a command string, so anything else would be interpolated into one`,
    );
  }
  return sha;
}

export function createReviewdogReporter(options: ReviewdogReporterOptions = {}): ReviewdogReporter {
  const binary = options.binary ?? 'reviewdog';
  const reporter = options.reporter ?? 'local';
  const filterMode = options.filterMode ?? 'added';
  const name = options.name ?? 'takumi';
  const sourceName = options.sourceName ?? 'takumi';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const runner = options.runner ?? defaultRunner(options.env);

  const toRdjsonl = (findings: readonly ReviewFinding[]): string => {
    const lines: string[] = [];
    for (const finding of findings) {
      if (finding.path === undefined) continue;
      const line: RdjsonLine = {
        message: finding.detail,
        location: {
          path: finding.path,
          // A finding with no line still posts, at line 1: a file-level diagnostic is real, and
          // inventing a line number is not.
          range: { start: { line: finding.line ?? 1 } },
        },
        severity: DEFAULT_RDJSON_SEVERITY[finding.severity],
        code: { value: finding.rule },
        source: { name: sourceName, ...(options.sourceUrl === undefined ? {} : { url: options.sourceUrl }) },
      };
      lines.push(JSON.stringify(line));
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  };

  const report = async ({
    findings,
    baseSha,
    headSha,
    cwd,
  }: {
    findings: readonly ReviewFinding[];
    baseSha: string;
    headSha: string;
    cwd: string;
  }): Promise<ReviewdogReport> => {
    const unlocated = findings.filter((finding) => finding.path === undefined);
    const located = findings.filter((finding) => finding.path !== undefined);
    const stdin = toRdjsonl(located);
    if (stdin === '') {
      // Nothing to post: reviewdog is not started at all. (A reporter that cannot run is only a
      // problem when there is something to report.)
      return { posted: 0, unlocated, stdout: '' };
    }

    const base = assertSha(baseSha, 'frozen base');
    const head = assertSha(headSha, 'reviewed head');
    const argv = [
      binary,
      '-f=rdjsonl',
      `-name=${name}`,
      `-reporter=${reporter}`,
      `-filter-mode=${filterMode}`,
      // reviewdog runs this itself, in `cwd`. Both shas are validated hex above.
      `-diff=git diff ${base} ${head}`,
    ];
    const run = await runner({ argv, cwd, timeoutMs, stdin });
    if (run.code !== 0) {
      const tail = run.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      throw new ProviderError(
        'transport',
        `reviewdog exited ${run.code}, so the findings were NOT reported (an absent report is not a clean review): ${tail}`,
      );
    }
    return { posted: located.length, unlocated, stdout: run.stdout };
  };

  return { toRdjsonl, report };
}

function defaultRunner(env?: NodeJS.ProcessEnv): ReviewdogRunner {
  return async ({ argv, cwd, timeoutMs, stdin }) => {
    const [file, ...args] = argv;
    if (file === undefined) throw new ProviderError('precondition', 'no reviewdog command was given');
    return await new Promise((resolve, reject) => {
      const child = execFile(
        file,
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...(env ?? {}) } },
        (error, stdout, stderr) => {
          if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(
              new ProviderError(
                'transport',
                `${file} is not installed (or not on PATH): the findings were NOT reported`,
              ),
            );
            return;
          }
          const code = (error as { code?: unknown } | null)?.code;
          if (error !== null && typeof code === 'number') {
            resolve({ code, stdout, stderr });
            return;
          }
          if (error !== null) {
            reject(new ProviderError('transport', `${file} did not finish within ${timeoutMs}ms`));
            return;
          }
          resolve({ code: 0, stdout, stderr });
        },
      );
      if (stdin !== undefined && child.stdin !== null) {
        child.stdin.end(stdin);
      }
    });
  };
}
