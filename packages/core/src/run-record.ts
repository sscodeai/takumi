/**
 * The run record: ONE machine-readable file per run, `.takumi/runs/<run-id>.json`.
 *
 * A run already leaves a human trail — the CLI's summary line, the step lines, the
 * artifacts — but none of it is answerable by a program. "What did this cost?", "which
 * step fails most often?", "how often is a delivery accepted?" all require reading logs
 * by eye, so the auto-triage rules that come later would be guessing. This module is the
 * record those questions are answered FROM: a stable, versioned shape written by every
 * workflow run, next to the run's other `.takumi/` output.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   1. COST IS NEVER INVENTED. A runtime that reports no token usage produces
 *      `{"available": false, "why": "..."}` — never a `0` that would read as "free", and
 *      never an omitted field that would read as "not measured". The `cost` key is always
 *      present; its `available` flag is what a reader branches on.
 *   2. AN UNREADABLE RECORD IS NAMED, NOT SWALLOWED. `readRunRecords` reports each file it
 *      could not parse with the reason and carries on, so one damaged file cannot blank the
 *      whole picture (the same rule the artifact store keeps for corrupt metadata).
 *
 * What happens when the record cannot be produced is decided HERE: the writer writes a
 * PARTIAL record marked `"partial": true` with the reason, rather than failing the run. A
 * run's outcome is decided by its steps; a record-keeping failure must not rewrite that
 * outcome, and no file at all would be indistinguishable from a run that never happened —
 * silently dropping the run from every future statistic. If even the partial write fails
 * (a full disk, a read-only tree) the caller is told (`written: false` + `error`) so it can
 * say so LOUDLY on the run's event channel; it is still never fatal.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequirementConfirmation } from './standing-authorization.js';

/** Where every run writes its record, relative to the project directory. */
export const RUN_RECORD_DIR = '.takumi/runs';

/**
 * The run id a record file is named after. The same constraint the run marker needs: a run
 * id is a file name here, so it may not contain a path separator or escape the directory.
 * The workflow engine mints `wf-<8 hex>`; the pattern accepts any id that cannot break the
 * path (see run-marker.ts for why the id is not fixed to one caller's shape).
 */
const RUN_ID_SAFE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A step's outcome in the run's own vocabulary. `completed` is recorded as `done` — the
 * record says what happened, not which enum the engine happens to use — and `cancelled` is
 * kept distinct because a cancellation is neither a failure nor a skip: counting it as a
 * failure would blame a step for a human's decision.
 */
export type RunStepStatus = 'done' | 'failed' | 'skipped' | 'cancelled';

export interface RunRecordStep {
  /** The step's id in the workflow definition. */
  id: string;
  /** The step's declared type (`agent`, `quality_gate`, `publish`, …). */
  kind: string;
  status: RunStepStatus;
  /** Wall-clock milliseconds the engine spent on this step. */
  durationMs: number;
  /** The step's own summary line (its first line is the human-readable one). */
  summary: string;
}

/**
 * What the run cost, as the runtime reported it — or a plain statement that it reported
 * nothing. There is no third shape: a reader never has to guess whether a missing number
 * means zero or means unknown.
 */
export type RunRecordCost =
  | {
      available: true;
      /** The runtime that produced the numbers (the run's runtime id). */
      runtimeId: string;
      /** Every model the runtime named across the run's steps (deduplicated, in order). */
      models: string[];
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      costUsd: number;
      /** How many steps contributed a runtime-reported usage. */
      stepsReporting: number;
    }
  | {
      available: false;
      /** Why there is no cost — stated, never implied. */
      why: string;
    };

/** A published reference, when the run opened one. */
export interface RunRecordPublished {
  /** The pull request this run opened, when the host has a review surface. */
  pullRequest: { number: string; url: string } | null;
  /** The issue this run recorded, when the host can record one. */
  issue: { number: string } | null;
  /** The commit the run landed, when a `merge` step merged it. */
  mergedSha: string | null;
}

export interface RunRecord {
  /** The record's own identity: the same run id the marker and the board row carry. */
  runId: string;
  /** The workflow the run executed. */
  workflow: string;
  /**
   * The requirement this run was confirmed against, how it was confirmed, and its digest. Null when none
   * was on record.
   *
   * The confirmation lives INSIDE this binding deliberately (ADR-045 §4): it is impossible to read which
   * document a run was bound to without also reading whether a human confirmed it or an authorization
   * defaulted it — and, when it was an authorization, WHICH answers nobody read. A sibling top-level
   * field was rejected: a `null` there would be indistinguishable from "forgotten", which is the same
   * reason ADR-025's `NO_REQUIREMENT` is a real value rather than an absent field.
   */
  requirement: { ref: string; digest: string; confirmation: RequirementConfirmation } | null;
  /** ISO-8601 timestamps, and the total wall-clock duration in milliseconds. */
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  steps: RunRecordStep[];
  /** The run's final outcome. */
  outcome: 'completed' | 'failed' | 'cancelled';
  /** The process exit code the outcome maps to (0 for completed, 1 otherwise). */
  exitCode: number;
  /** True exactly when the run reached its end with no failed step. */
  accepted: boolean;
  /** The failure the run ended on: the step, and that step's own message. Null when none. */
  failure: { stepId: string; message: string } | null;
  /** What the run published and merged. Every field is null when nothing was published. */
  published: RunRecordPublished;
  /** The board row this run projected onto, when a board was configured. */
  boardRowId: string | null;
  /** The runtime-reported cost, or a plain statement that none was reported. */
  cost: RunRecordCost;
  /**
   * How this run's step commands were sandboxed (ADR-058): 'unshare' when a boundary was
   * established, 'none' when there was none, and 'none (unsafe override)' when the human-only
   * `TAKUMI_UNSAFE_NO_SANDBOX=1` bypass was in effect. Recorded so a run that skipped the
   * boundary is auditable rather than indistinguishable from one that used it.
   */
  sandbox?: string;
  /** Present and true when this record is incomplete. */
  partial?: boolean;
  /** Why the record is partial; present exactly when `partial` is true. */
  partialWhy?: string;
}

/** A file `readRunRecords` could not read, and why — named rather than skipped silently. */
export interface RunRecordUnreadable {
  /** The file name (not the whole path) that could not be read. */
  file: string;
  reason: string;
}

/** Where a run's record lives. */
export function runRecordPath(cwd: string, runId: string): string {
  if (!RUN_ID_SAFE.test(runId)) {
    throw new Error(`a run id may not be used as a file name: ${JSON.stringify(runId)}`);
  }
  return join(cwd, RUN_RECORD_DIR, `${runId}.json`);
}

/**
 * Write a run's record. Never throws: the caller decides how loud a failure is.
 *
 * The write is atomic (temp file + rename), so a reader — the aggregator, a monitoring
 * script — never sees a half-written record. When the record cannot even be serialized,
 * a PARTIAL record is written instead, marked `partial: true` with the reason; see the
 * module comment for why a partial record beats no record.
 */
export function writeRunRecord(cwd: string, record: RunRecord): { path: string; written: boolean; error?: string } {
  let path: string;
  try {
    path = runRecordPath(cwd, record.runId);
  } catch (e) {
    // The id is not a legal file name. There is nowhere to put the record, so say so.
    return { path: '', written: false, error: e instanceof Error ? e.message : String(e) };
  }
  const dir = join(cwd, RUN_RECORD_DIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { path, written: false, error: e instanceof Error ? e.message : String(e) };
  }

  let body: string;
  try {
    body = `${JSON.stringify(record, null, 2)}\n`;
  } catch (e) {
    // The full record could not be produced. Write what CAN be said — the run happened,
    // and this file says so — with the incompleteness named.
    const why = e instanceof Error ? e.message : String(e);
    const partial: RunRecord = {
      runId: record.runId,
      workflow: record.workflow,
      requirement: record.requirement,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      steps: [],
      outcome: record.outcome,
      exitCode: record.exitCode,
      accepted: record.accepted,
      failure: record.failure,
      published: { pullRequest: null, issue: null, mergedSha: null },
      boardRowId: null,
      cost: { available: false, why: 'the record could not be serialized, so no cost was recorded' },
      partial: true,
      partialWhy: `the full record could not be serialized (${why}); the steps, the published references and the cost are missing`,
    };
    try {
      body = `${JSON.stringify(partial, null, 2)}\n`;
    } catch (e2) {
      return { path, written: false, error: e2 instanceof Error ? e2.message : String(e2) };
    }
  }

  try {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, body, 'utf8');
    renameSync(temporary, path);
    return { path, written: true };
  } catch (e) {
    return { path, written: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True when a parsed value looks like a run record (the fields the aggregator reads). */
function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['runId'] !== 'string' || v['runId'].length === 0) return false;
  if (typeof v['outcome'] !== 'string') return false;
  if (!Array.isArray(v['steps'])) return false;
  return true;
}

/**
 * Read every record in `dir` (default `.takumi/runs` under `cwd`).
 *
 * A file that is not valid JSON, or valid JSON that is not a run record, is reported in
 * `unreadable` with the reason and does not stop the read: one damaged file must not blank
 * the picture the healthy ones still support. An absent directory is not an error — it is
 * a project that has not run anything yet, and it reads as zero records.
 */
export function readRunRecords(
  dir: string,
): { records: RunRecord[]; unreadable: RunRecordUnreadable[] } {
  const records: RunRecord[] = [];
  const unreadable: RunRecordUnreadable[] = [];
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    // No directory (or unreadable): nothing to report, and no crash.
    return { records, unreadable };
  }
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      unreadable.push({ file, reason: `not valid JSON (${e instanceof Error ? e.message : String(e)})` });
      continue;
    }
    if (!isRunRecord(parsed)) {
      unreadable.push({ file, reason: 'valid JSON, but not a run record (no runId / outcome / steps)' });
      continue;
    }
    records.push(parsed);
  }
  return { records, unreadable };
}

/** The step that failed most often across the runs, and how many runs it failed in. */
export interface RunStepFailureCount {
  stepId: string;
  count: number;
}

export interface RunCostAggregate {
  /** True when at least one run reported a cost. */
  available: boolean;
  /** Sum of the reported costs (0 when none was reported). */
  totalCostUsd: number;
  /** Sum of the reported token totals. */
  totalTokens: number;
  /** How many runs reported a cost. */
  runsWithCost: number;
  /** How many runs reported none — said plainly rather than folded into a zero. */
  runsWithoutCost: number;
  /** Present when the total is not the whole story (nothing reported, or some runs silent). */
  why?: string;
}

export interface RunAggregate {
  /** How many records were read. */
  runs: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  /** succeeded / runs, 0 when there are no runs. */
  successRate: number;
  medianDurationMs: number | null;
  worstDurationMs: number | null;
  /** The run id of the worst-duration run (the tie is broken by run id, for determinism). */
  worstRunId: string | null;
  mostFailingStep: RunStepFailureCount | null;
  cost: RunCostAggregate;
  /** The files that could not be read, carried through so the printer can name them. */
  unreadable: RunRecordUnreadable[];
}

/** The median of a list of numbers; null for an empty list. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Fold the records into the numbers an operator asks for. Pure: no filesystem, no clock,
 * so the arithmetic is testable without a run.
 */
export function summarizeRuns(records: readonly RunRecord[], unreadable: RunRecordUnreadable[] = []): RunAggregate {
  const succeeded = records.filter((r) => r.outcome === 'completed').length;
  const failed = records.filter((r) => r.outcome === 'failed').length;
  const cancelled = records.filter((r) => r.outcome === 'cancelled').length;

  const durations = records.map((r) => r.durationMs).filter((d) => Number.isFinite(d));
  const worst = records.reduce<RunRecord | null>((acc, r) => {
    if (!Number.isFinite(r.durationMs)) return acc;
    if (acc === null || r.durationMs > acc.durationMs) return r;
    if (r.durationMs === acc.durationMs && r.runId < acc.runId) return r;
    return acc;
  }, null);

  const failureCounts = new Map<string, number>();
  for (const record of records) {
    for (const step of record.steps) {
      if (step.status === 'failed') failureCounts.set(step.id, (failureCounts.get(step.id) ?? 0) + 1);
    }
  }
  const mostFailing = [...failureCounts.entries()]
    .map(([stepId, count]) => ({ stepId, count }))
    .sort((a, b) => b.count - a.count || a.stepId.localeCompare(b.stepId))[0] ?? null;

  const withCost = records.filter((r) => r.cost.available);
  const withoutCost = records.length - withCost.length;
  const totalCostUsd = withCost.reduce((sum, r) => sum + (r.cost.available ? r.cost.costUsd : 0), 0);
  const totalTokens = withCost.reduce((sum, r) => sum + (r.cost.available ? r.cost.totalTokens : 0), 0);
  const cost: RunCostAggregate = {
    available: withCost.length > 0,
    totalCostUsd,
    totalTokens,
    runsWithCost: withCost.length,
    runsWithoutCost: withoutCost,
    ...(withCost.length === 0
      ? { why: records.length === 0 ? 'there are no runs to cost' : 'the runtime reports no token usage for any run' }
      : withoutCost > 0
        ? { why: `${withoutCost} of ${records.length} run(s) reported no token usage, so the total is over the ${withCost.length} that did` }
        : {}),
  };

  return {
    runs: records.length,
    succeeded,
    failed,
    cancelled,
    successRate: records.length === 0 ? 0 : succeeded / records.length,
    medianDurationMs: median(durations),
    worstDurationMs: worst === null ? null : worst.durationMs,
    worstRunId: worst === null ? null : worst.runId,
    mostFailingStep: mostFailing,
    cost,
    unreadable,
  };
}

/** `1.2s`, `2m 03s` — a duration a person reads without arithmetic. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

/**
 * Render the aggregate as the lines `takumi runs` prints. The unreadable files are named
 * LAST and always, so a summary computed from a partial set can never be mistaken for one
 * computed from everything.
 */
export function renderRunAggregate(aggregate: RunAggregate): string {
  const lines: string[] = [];
  if (aggregate.runs === 0) {
    lines.push('runs: none found (no run records in .takumi/runs)');
  } else {
    lines.push(
      `runs: ${aggregate.runs} (${aggregate.succeeded} completed, ${aggregate.failed} failed, ${aggregate.cancelled} cancelled) — success rate ${(aggregate.successRate * 100).toFixed(1)}%`,
    );
    const median = aggregate.medianDurationMs;
    lines.push(
      `duration: median ${median === null ? 'unknown' : formatDuration(median)}, worst ${aggregate.worstDurationMs === null ? 'unknown' : formatDuration(aggregate.worstDurationMs)}${aggregate.worstRunId === null ? '' : ` (${aggregate.worstRunId})`}`,
    );
    lines.push(
      `most-failing step: ${aggregate.mostFailingStep === null ? 'none — no step failed in any run' : `${aggregate.mostFailingStep.stepId} (${aggregate.mostFailingStep.count})`}`,
    );
  }
  if (aggregate.cost.available) {
    lines.push(
      `cost: $${aggregate.cost.totalCostUsd.toFixed(4)} over ${aggregate.cost.runsWithCost} run(s) (${aggregate.cost.totalTokens} tokens)${aggregate.cost.why === undefined ? '' : ` — ${aggregate.cost.why}`}`,
    );
  } else {
    lines.push(`cost: unavailable — ${aggregate.cost.why ?? 'the runtime reports no token usage'}`);
  }
  if (aggregate.unreadable.length > 0) {
    lines.push(`unreadable: ${aggregate.unreadable.length} file(s) skipped`);
    for (const bad of aggregate.unreadable) lines.push(`  - ${bad.file}: ${bad.reason}`);
  }
  return lines.join('\n');
}
