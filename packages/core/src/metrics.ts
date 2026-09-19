/**
 * Pilot metrics: a counter file a scheduler's monitoring can scrape.
 *
 * Deliberately NOT a server. A self-hosted box already runs an exporter, and a
 * Prometheus textfile in a directory is the shape that needs no port, no daemon and no
 * auth — `node_exporter --collector.textfile.directory` picks it up, and so does any
 * script with `cat`.
 *
 * The counters are the outcomes a tick can have, so the question an operator actually
 * asks ("is it delivering, or is it quietly blocking everything?") is one subtraction
 * away. Counters only ever go up; `last_tick_timestamp_seconds` is the freshness signal.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PilotTickOutcome, PilotTickResult } from './pilot.js';

/** The outcome counters, one per {@link PilotTickOutcome}. */
export type PilotOutcomeCounters = Record<PilotTickOutcome, number> & {
  /** Attempts that had to be retried by the agent wrapper (a health signal, not an outcome). */
  agentRetries: number;
  /** Seconds spent waiting for checks, summed over all ticks. */
  checksWaitedSeconds: number;
};

export interface PilotMetrics {
  /** Increments once per tick, whatever it did. */
  ticks: number;
  outcomes: PilotOutcomeCounters;
  /** Unix seconds of the last tick, or null when none has run yet. */
  lastTickAtSeconds: number | null;
  /** The last outcome, so a human reading the file sees it without arithmetic. */
  lastOutcome: PilotTickOutcome | null;
}

export function emptyMetrics(): PilotMetrics {
  return {
    ticks: 0,
    outcomes: {
      idle: 0,
      busy: 0,
      delivered: 0,
      awaiting_review: 0,
      blocked: 0,
      retriable: 0,
      not_claimed: 0,
      agentRetries: 0,
      checksWaitedSeconds: 0,
    },
    lastTickAtSeconds: null,
    lastOutcome: null,
  };
}

/**
 * Fold one tick into the counters. Pure: the caller decides where the result is written,
 * which is what makes this testable without a filesystem.
 */
export function bumpMetrics(
  metrics: PilotMetrics,
  tick: PilotTickResult,
  extra: { atSeconds: number; agentRetries?: number; checksWaitedSeconds?: number } = {
    atSeconds: Math.floor(Date.now() / 1000),
  },
): PilotMetrics {
  return {
    ticks: metrics.ticks + 1,
    outcomes: {
      ...metrics.outcomes,
      [tick.outcome]: metrics.outcomes[tick.outcome] + 1,
      agentRetries: metrics.outcomes.agentRetries + (extra.agentRetries ?? 0),
      checksWaitedSeconds: metrics.outcomes.checksWaitedSeconds + (extra.checksWaitedSeconds ?? 0),
    },
    lastTickAtSeconds: extra.atSeconds,
    lastOutcome: tick.outcome,
  };
}

/** Read the counter file, or start from zero when it is absent or unreadable. */
export function readMetricsFile(path: string): PilotMetrics {
  if (!existsSync(path)) return emptyMetrics();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PilotMetrics>;
    const base = emptyMetrics();
    return {
      ticks: parsed.ticks ?? base.ticks,
      outcomes: { ...base.outcomes, ...(parsed.outcomes ?? {}) },
      lastTickAtSeconds: parsed.lastTickAtSeconds ?? null,
      lastOutcome: parsed.lastOutcome ?? null,
    };
  } catch {
    // A corrupt counter file must not stop the runner. Losing a counter is cheaper than
    // losing a tick, and the metric says so by resetting rather than by lying.
    return emptyMetrics();
  }
}

/** Write the counters, JSON for us and Prometheus text for whatever scrapes it. */
export function writeMetricsFile(path: string, metrics: PilotMetrics, textfile?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Write-and-rename: a scraper must never read a half-written file.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metrics, null, 2)}\n`);
  renameSync(temporary, path);
  if (textfile !== undefined) {
    mkdirSync(dirname(textfile), { recursive: true });
    const temporaryText = `${textfile}.tmp`;
    writeFileSync(temporaryText, renderPrometheus(metrics));
    renameSync(temporaryText, textfile);
  }
}

/** The Prometheus text exposition of the counters. Stable series names, no labels. */
export function renderPrometheus(metrics: PilotMetrics): string {
  const lines: string[] = [];
  const counter = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  };
  const gauge = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };

  counter('takumi_pilot_ticks_total', 'Ticks the pilot has run, whatever they did.', metrics.ticks);
  for (const outcome of [
    'delivered',
    'blocked',
    'awaiting_review',
    'retriable',
    'idle',
    'busy',
    'not_claimed',
  ] as const) {
    counter(`takumi_pilot_outcome_${outcome}_total`, `Ticks that ended in ${outcome}.`, metrics.outcomes[outcome]);
  }
  counter(
    'takumi_pilot_agent_retries_total',
    'Agent attempts that had to be retried after a transport failure.',
    metrics.outcomes.agentRetries,
  );
  counter(
    'takumi_pilot_checks_waited_seconds_total',
    'Seconds spent waiting for the host to settle checks.',
    metrics.outcomes.checksWaitedSeconds,
  );
  gauge(
    'takumi_pilot_last_tick_timestamp_seconds',
    'Unix time of the last tick (0 when none has run): the freshness signal.',
    metrics.lastTickAtSeconds ?? 0,
  );
  return `${lines.join('\n')}\n`;
}
