# ADR-008: The Pilot Safety Rails (slot lock · event registry · state bootstrap)

- **Date**: 2026-09-18
- **Status**: Accepted (implemented in core; all six board adapters declare their bootstrap capability)
- **Related**: ADR-006 (task-board abstraction), ADR-007 (delivery abstraction)

## Context

An honest comparison against orbi — the system this whole layer is modelled on —
put the gap in one place. orbi is 22,902 lines of Python whose bulk is the
*unattended* part: a scheduler that wakes every five minutes, exclusive slots, an
event journal, agent process recovery, health metrics, label bootstrap. takumi had
the provider abstraction (better than orbi's, which is GitHub-only) and no
unattended part at all.

Three of orbi's pieces are not features but **preconditions**. Without them an
unattended runner is not merely less capable — it is wrong:

1. **Exclusive slots.** Every board adapter here declares `atomicClaim: false`,
   because none of GitHub, GitLab, Jira, Notion or Redmine offers a conditional
   claim. The documentation said the lock was "the caller's job", which is a
   euphemism: exclusion needs a primitive that survives a crash, and a caller
   cannot be expected to invent one. Two runners sharing one account would both
   believe they own an item.
2. **A closed event vocabulary.** The error taxonomy says *why* something failed;
   nothing said *what happened*. Without a structured trail there is no audit, no
   `grep` for one run, and no way to alert on "the loop has been retrying for six
   hours".
3. **State bootstrap.** A fresh repository has no `takumi-ready` label, a Jira
   project has no `Fix Needed` status, and a Redmine instance has neither. The
   adapter then fails before it can claim anything, with a message that teaches the
   operator nothing.

## Decision

### 1. `slot-lock.ts` — exclusion that survives a crash

An `O_EXCL` lock file holding the owner's identity, with **two independent**
abandonment rules: the owner's process is provably gone (signal 0 → `ESRCH`), or
nobody has refreshed the lock within `staleAfterSeconds` (a healthy holder
heartbeats). The second rule covers the two cases a liveness check alone gets
wrong: a hung owner and a recycled pid.

**Difference from orbi, stated rather than hidden:** orbi uses `fcntl.flock`, which
the kernel releases the instant the process dies. Node exposes no flock, and adding
a native dependency to a zero-dependency project is the wrong trade — so here a
dead runner's slot is freed the instant someone *notices*, not by the kernel. With
a heartbeat, that window only ever opens for a dead or wedged runner, which is
exactly the case the rule exists for.

`withSlot(options, fn)` reports `busy` as a **result**, not an exception: a
scheduled runner must be able to journal "someone else is working on this" and
exit 0.

### 2. `events.ts` — a registry, not a log format

`EVENT_KINDS` is a closed list (`deliver.pushed`, `review.findings`,
`slot.busy`, …). An unregistered kind **throws** — the alternative is a trail full
of one-off names nobody can grep or alert on. Every event carries the run id, and
one event is one line of JSON with a stable key order.

Emission is a **side channel** with one exception: a sink that throws does not
change the outcome of the delivery (losing a log line must never fail a merge), but
a *programming* error in the emitter — an unregistered kind — surfaces, because
that is a bug in our code, not a degraded environment.

### 3. `bootstrapStates()` — a required port method

Every board answers the same question: which of the six states can you express, and
what should a human do about the ones you cannot? A new capability,
`canBootstrapStates`, distinguishes *reports* from *creates*:

- `true` — GitHub and GitLab create their labels through the API, and the fake board
  models it.
- `false` — Jira, Notion and Redmine declare it false and report instead, because
  statuses live in a workflow or in administration, out of the API's reach.

`not-creatable` **must** carry an instruction; without it the report is the "no such
label" error renamed, and the contract suite rejects it. The method must be
idempotent, and a dry run must change nothing — both enforced by the shared suite,
so a new adapter cannot ship a bootstrap that "mostly" works.

Operators reach it through `takumi board --check` (read-only) and `takumi board
--bootstrap` (apply, exit 1 when a state needs a human).

### 4. The loop uses both

`runDeliveryLoop` takes an optional `slot` and an optional `events` log: a slot
turns a racing second runner into a `busy` outcome before it touches the board, and
the trail records the run's whole story (`claim.acquired` → `slot.released`), one
line per event, greppable by run id. Both are optional, so an existing caller is
unaffected.

## Consequences

- An unattended runner is now *safe* to run twice, which was not true before: the
  lock is the difference between "two runners" and "two runners fighting".
- A failed delivery never wedges a slot (released in a `finally`), and the trail
  still records it (`run.failed` vs `run.retriable`).
- Costs: a lock file per item in the state directory, and a heartbeat timer per
  held slot (unref'd, so it never keeps a process alive).
- Deliberately still open (the P1/P2 work): the scheduler itself, graceful
  shutdown, worktree retention, model-wait/retry, health metrics, progress-comment
  throttling, and turning a failed CI check into a filed issue. ADR-008 makes the
  rails; a pilot still needs the vehicle.
