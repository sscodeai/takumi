/**
 * The event registry: what a run DID, in a vocabulary that cannot drift.
 *
 * This is the piece orbi's `journal.py` provides and takumi was missing. The
 * failure classification (auth / transport / precondition / not_found /
 * unsupported) answers "why did this fail"; an event log answers "what happened",
 * which is what an operator needs at 3am and what an audit needs a year later.
 *
 * Three rules, learned the hard way from orbi's journal:
 *
 *   1. **The vocabulary is a closed registry.** An event kind that is not declared
 *      here is a programming error and FAILS — the alternative is a log full of
 *      one-off names nobody can grep or alert on.
 *   2. **Every event carries the run id.** Without it the entries cannot be tied
 *      back to the board comment and the pull request that the same run produced.
 *   3. **Emission is a SIDE CHANNEL.** A sink that throws must not change the
 *      outcome of the delivery: losing a log line is bad, failing a merge because
 *      the log line could not be written is worse.
 *
 * One line of JSON per event, so `grep takumi:run=c0ffee01` finds a whole run and a
 * log shipper needs no parser beyond `JSON.parse`.
 */

import { ProviderError } from './provider-error.js';

/**
 * The registry. `<domain>.<action>`, past tense for things that happened, and the
 * domains map to the layers: slot, claim, agent, deliver, checks, review, merge,
 * board, bootstrap.
 */
export const EVENT_KINDS = [
  // Slots (A runner per repo/item — see slot-lock.ts)
  'slot.acquired',
  'slot.busy',
  'slot.stale_taken_over',
  'slot.released',
  // Claiming
  'claim.acquired',
  'claim.refused',
  // The agent's turn
  'agent.started',
  'agent.finished',
  'agent.failed',
  'agent.retry',
  // Delivery
  'deliver.pushed',
  'deliver.pr_opened',
  'deliver.pr_reused',
  'deliver.refused',
  // Checks and review
  'checks.read',
  'checks.waited',
  /**
   * Mergeability was not known yet and is being re-read: a host that computes it
   * asynchronously (GitLab) answers "unknown" for a moment after a merge request opens.
   */
  'merge.mergeability_waited',
  /**
   * A tick took an item that already had a delivery in flight (same branch, same pull request)
   * instead of starting fresh work on it.
   */
  'pilot.resumed',
  'check.failed',
  // Turning a failure into work, and the honest refusal when a board cannot file
  'issue.filed',
  'issue.skipped',
  'review.clean',
  'review.findings',
  'review.awaiting_human',
  // Merge
  'merge.done',
  'merge.refused',
  // The board itself
  'board.transitioned',
  'board.commented',
  'board.blocked',
  // The run itself
  'run.failed',
  'run.retriable',
  // The pilot tick (one pass over the ready items)
  'pilot.idle',
  'pilot.item_selected',
  'pilot.item_skipped',
  'pilot.in_flight',
  'pilot.stale_claim_blocked',
  'pilot.tick_done',
  // Worktrees
  'worktree.created',
  'worktree.pruned',
  // State bootstrap (which labels/statuses the board was missing)
  'bootstrap.reported',
  'bootstrap.applied',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** A value a reader can compare without parsing: strings, numbers, booleans. */
export type EventValue = string | number | boolean | null;

export interface RunEvent {
  /** ISO timestamp, injected by the emitter (never read from the clock inside a formatter). */
  at: string;
  kind: EventKind;
  /** The run this event belongs to. Required: an unexplained event is noise. */
  runId: string;
  /** The work item, when the event concerns one. */
  itemId?: string;
  /** The pull request, when the event concerns one. */
  pr?: string;
  /** Short human sentence, single line. */
  message: string;
  /** Extra structured facts. Values are primitives so a line stays parseable. */
  fields?: Record<string, EventValue>;
}

export interface EventLogOptions {
  /** Where events go. Omitted = an in-memory log a test can read back. */
  sink?: EventSink;
  /** Clock, injectable so tests are deterministic. */
  now?: () => number;
  /** Also keep the events in memory (default true when no sink is given). */
  retain?: boolean;
}

/** Where events are written. A sink must never throw in a way that escapes (see `emit`). */
export interface EventSink {
  write(event: RunEvent): void;
}

export interface EventLog {
  /** Record one event. Unknown kinds and missing run ids throw; sink failures do not. */
  emit(event: Omit<RunEvent, 'at'> & { at?: string }): RunEvent;
  /** Everything retained so far (empty when the log was built with `retain: false`). */
  events(): RunEvent[];
  /** Retained events of one kind, in order — the reader a test or an operator uses. */
  of(kind: EventKind): RunEvent[];
  /** A sink that appends to an array — handy for a caller that keeps its own trail. */
  sink: EventSink;
}

/** True when `kind` is in the registry (the check every emitter must pass). */
export function isEventKind(kind: string): kind is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * JSON Lines: one event per line, stable key order, and a message that round-trips
 * (JSON escapes the newline, so the line stays single while the value survives). */
export function formatEventLine(event: RunEvent): string {
  const ordered: Record<string, unknown> = {
    at: event.at,
    kind: event.kind,
    runId: event.runId,
    ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
    ...(event.pr === undefined ? {} : { pr: event.pr }),
    message: event.message,
    ...(event.fields === undefined ? {} : { fields: event.fields }),
  };
  return JSON.stringify(ordered);
}

/** An appendable sink factory: `(line) => void`, e.g. `process.stdout.write`. */
export function lineSink(write: (line: string) => void): EventSink {
  return {
    write: (event) => {
      write(`${formatEventLine(event)}\n`);
    },
  };
}

/** A sink that keeps events in one array the caller owns. */
export function arraySink(target: RunEvent[]): EventSink {
  return {
    write: (event) => {
      target.push(event);
    },
  };
}

/**
 * Build an event log.
 *
 * `emit` validates the registry and the run id, then hands the event to the sink
 * inside a try/catch: a broken sink is reported through `onSinkError` (default:
 * swallow, because the delivery's outcome is not the log's business).
 */
export function createEventLog(
  options: EventLogOptions & { onSinkError?: (error: unknown, event: RunEvent) => void } = {},
): EventLog {
  const retained: RunEvent[] = [];
  const retain = options.retain ?? options.sink === undefined;
  const now = options.now ?? (() => Date.now());
  // The default sink writes NOWHERE: retention is the explicit push below, so an
  // event is never stored twice by two mechanisms that both look correct alone.
  const sink = options.sink ?? { write: () => {} };

  return {
    sink,
    emit(input): RunEvent {
      if (!isEventKind(input.kind)) {
        throw new ProviderError(
          'precondition',
          `unregistered event kind: ${JSON.stringify(input.kind)} — add it to EVENT_KINDS (the registry is closed, so a one-off name cannot slip into an audit trail)`,
        );
      }
      if (typeof input.runId !== 'string' || input.runId.length === 0) {
        throw new ProviderError('precondition', `event ${input.kind} must carry a runId`);
      }
      const event: RunEvent = {
        at: input.at ?? new Date(now()).toISOString(),
        kind: input.kind,
        runId: input.runId,
        ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        ...(input.pr === undefined ? {} : { pr: input.pr }),
        message: input.message,
        ...(input.fields === undefined ? {} : { fields: input.fields }),
      };
      if (retain) retained.push(event);
      try {
        sink.write(event);
      } catch (error) {
        // Rule 3: a side channel never decides the outcome. The caller may still
        // hear about it; it just must not propagate as a delivery failure.
        options.onSinkError?.(error, event);
      }
      return event;
    },
    events(): RunEvent[] {
      return [...retained];
    },
    of(kind: EventKind): RunEvent[] {
      return retained.filter((event) => event.kind === kind);
    },
  };
}

/**
 * A log that keeps nothing and writes nothing.
 *
 * The default for a caller that has no interest in events (an existing test, a
 * one-off script), so wiring the loop up never forces an audit trail on anyone.
 */
export function nullEventLog(): EventLog {
  const log = createEventLog({ retain: false, sink: { write: () => {} } });
  return log;
}
