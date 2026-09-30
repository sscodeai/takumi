# ADR-010: Observability and Pacing for an Unattended Runner

- **Date**: 2026-09-18
- **Status**: Accepted (`renderPrometheus`, `pilot.metricsFile`, `progressIntervalSeconds`)
- **Related**: ADR-008 (event trail), ADR-009 (the pilot)

## Context

ADR-009 made a tick possible. Two things were still missing for running it for weeks
without a person watching:

- **A way to ask "is it healthy?"** The event trail answers *what happened*, one event
  at a time. It does not answer *how many ticks are blocking* without an operator
  counting lines, and a trail is not what monitoring scrapes.
- **A way to stop talking so much.** While a tick waits for checks it polls the host.
  Each poll rewrote the board's progress record, so a five-minute CI wait meant twenty
  API calls to say the same thing — against hosts that rate-limit, on a repository whose
  activity log a human reads.

## Decision

### 1. Metrics are a FILE, not a server

`pilot.metricsFile` holds the counters as JSON, and `<metricsFile>.prom` holds the same
numbers as a Prometheus textfile. `renderPrometheus` emits counters for ticks, for every
tick outcome, for agent retries and for seconds spent waiting, plus a
`last_tick_timestamp_seconds` gauge that is the freshness signal.

Why not a server: a self-hosted box already runs an exporter, so a textfile in a
directory needs no port, no daemon, no auth and no scraping configuration — and
`node_exporter --collector.textfile.directory` is the whole integration. Counters are
read-modify-write per tick (a tick is a separate process; the file is the only memory
between them), written to a temporary file and renamed, so a scraper never reads a
half-written file.

A **corrupt** counter file resets to zero instead of throwing: losing a counter is
cheaper than losing a tick, and a metric that lies is worse than a metric that restarts.

### 2. The loop reports its own pace, as fields

`DeliveryLoopResult.checksWaitedSeconds` and `PilotTickResult.agentRetries` are numbers,
not strings parsed out of a step's human-readable text. A counter that depends on the
wording of a log line silently becomes zero the first time somebody rewords it — so the
CLI's first draft (which parsed `steps[].detail`) was replaced with these fields before
it shipped.

### 3. Progress writes are throttled, never skipped when they matter

`plan.progressIntervalSeconds` (default 30) suppresses a progress write only when the
record's signature — run id, round, pull request — is UNCHANGED and the last write was
recent. The first write of any new signature always happens, so the board always reflects
the latest round; what disappears is the repeated identical write while a tick waits.

The tests pair the two features deliberately: one asserts that five polls produce two
board writes, because that is the churn the throttle exists for.

## Consequences

- An operator can alert on `takumi_pilot_outcome_blocked_total` rising, or on
  `last_tick_timestamp_seconds` going stale — the two failures that matter for a
  background runner (it is stuck on humans, or it stopped running at all).
- Every delivery now spends at most one board write per 30 seconds of waiting, and a
  wait is bounded (`checksWaitSeconds`), so a tick cannot run for ever on a slow pipeline.
- Still open: turning a pre-existing CI failure into a filed issue (needs a
  `createWork` port method across six adapters) and epic/milestone scoping (needs a
  text-search capability on the board port first). Neither is invented here — both are
  port extensions that would have to be uniform to stay honest.
