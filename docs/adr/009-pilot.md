# ADR-009: The Pilot (one tick, driven by an external scheduler)

- **Date**: 2026-09-18
- **Status**: Accepted (implemented: `runPilotTick`, `takumi pilot --once`)
- **Related**: ADR-006 (boards), ADR-007 (delivery), ADR-008 (the safety rails)

## Context

ADR-008 built the rails — a slot per item, a closed event vocabulary, a board that
can say which states it cannot express — and left the vehicle open. orbi's remaining
value is exactly here: a process that wakes up, picks work, runs an agent, delivers,
and survives being run twice.

The shape was chosen deliberately rather than invented.

## Decision

### 1. A one-shot process, started by the system

`takumi pilot --once` does ONE tick and exits. Concurrency is the scheduler's
business (two `systemd` timer instances, or two cron entries), and the per-item slot
lock is what keeps two ticks from touching the same item — which means an accidental
overlap is *safe* rather than corrupting.

Why not a resident daemon: nothing to supervise, nothing to leak between ticks, and a
crashed tick is simply a missed tick. This is orbi's deployed shape too, and the one
that fits a self-hosted box where the operator already has a timer.

```ini
# /etc/systemd/system/takumi-pilot@.service
[Unit]
Description=Takumi pilot (one tick, instance %i)
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/srv/takumi-project
ExecStart=/usr/bin/env node /opt/takumi/apps/cli/dist/index.js pilot --once
# The slot lock makes an overlap safe, but a tick that overruns its interval is
# worth knowing about, so a hard timeout turns it into a failed tick.
TimeoutStartSec=50min
```

```ini
# /etc/systemd/system/takumi-pilot@.timer
[Unit]
Description=Takumi pilot tick every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=takumi-pilot@1.service

[Install]
WantedBy=timers.target
```

```cron
# or, without systemd: one tick every 5 minutes, no overlap guarantees needed
*/5 * * * * cd /srv/takumi-project && /opt/takumi/apps/cli/dist/index.js pilot --once >> .takumi/pilot.log 2>&1
```

### 2. One item per tick

A tick picks the first ready item that no other runner holds, and stops there. Two
ticks in parallel therefore work on two items, which is how concurrency is scaled —
never by making one tick juggle several deliveries and lose track of which worktree
belongs to which claim.

### 3. `reviewMode`: who is trusted to judge

- `checks-only` — green checks are enough and the change merges.
- `label` — a human must add the approval label first.

That is a trust decision, so it is explicit configuration with no default that could
quietly merge unreviewed work.

Waiting for that human is **not a defect**: the review hook returns
`{verdict: 'awaiting-human'}` and the loop stops with `awaiting_review` — it does not
consume a review round, does not move the item to `fix_needed`, and does not ask the
agent to "fix" a change nobody has rejected. (Before this, a missing approval was
indistinguishable from a finding, and the agent would have rewritten good code three
times while the human was asleep.)

### 4. The agent is a COMMAND, and its failure is classified

`pilot.agent.command` runs in the task worktree with `TAKUMI_ITEM_ID`, `TAKUMI_RUN_ID`,
`TAKUMI_BRANCH` and `TAKUMI_ROUND` in its environment, so the agent's own logs and
commits can be tied to the run without takumi parsing its output. Its exit code is
classification, not noise:

- `0` — done. Takumi expects a **commit**; it never commits for the agent.
- non-zero — the agent is reporting a real failure (bad task, broken repo, refused
  work). Retrying would hit the same wall, so the item BLOCKS for a human.
- killed / timed out — a transport failure: retriable next tick, never a block.
- a missing binary — transport failure, retriable.

Transport failures retry inside the tick (`agentRetries`, default 2, with a delay)
before the tick gives up.

### 5. Worktrees, and the one that must never be deleted

One worktree per item per run under `pilot.worktreeRoot`, created from the FROZEN
base sha (a delivery must be able to name the commit it started from). Pruning runs at
the START of a tick, so a failing pipeline still cleans up, and it **never removes a
worktree with uncommitted work**: that is somebody's evidence, and a retention window
is not a licence to destroy it. The report names what was kept and why.

### 6. Shutdown, and exit codes

`SIGTERM`/`SIGINT` kills the agent child (TERM, then KILL after a grace period) and
lets the tick end as `retriable`, so the slot is released and the item is picked up
next tick instead of being left claimed by a process that no longer exists.

Exit `0` for `idle`, `delivered`, `awaiting_review`, `busy`, `not_claimed` and
`retriable` — a scheduled process that returns non-zero for "nothing to do" fills a
timer's journal with noise and trains people to ignore it. Exit `1` only for
`blocked`, which is the one outcome a human must look at.

### 7. Every tick leaves a trail

`pilot.eventsFile` appends the run's events (ADR-008's registry) as JSON lines, one
per event, greppable by run id. The pilot emits `pilot.idle`, `pilot.item_selected`,
`pilot.item_skipped`, `pilot.tick_done`, `worktree.created`, `worktree.pruned` and
`agent.retry`; the loop owns the delivery half of the story. One event per fact: the
retry wrapper deliberately does NOT also emit `agent.started`/`agent.finished`.

## Testing

Two levels, because they catch different things:

- **Core** (`packages/core/src/test/pilot.test.ts`) — offline in-file doubles: item
  selection, skipping a held item, `busy`, the approval wait, retry counting with an
  injected sleep, blocked-vs-retriable classification, slot release.
- **CLI** (`apps/cli/src/test/run.test.ts`) — a REAL bare origin, a real checkout, a
  real worktree created from a frozen sha, and a REAL agent child process that commits
  a file, driven through `runOnce`. This is the wiring a deployment uses, and it is
  the test that would catch a git invocation the unit tests model incorrectly.

## Consequences

- takumi can now run unattended: every precondition ADR-008 named is enforced, and a
  tick that overlaps another is safe rather than corrupting.
- The limit this ADR originally recorded — a retriable failure after the claim left the
  item owned by a run that would not continue — is FIXED (see `docs/bugs-fixed.md` #8/#9):
  checks are waited for inside the tick, anything we own is blocked rather than parked,
  and every tick sweeps the in-flight items. With `blockStaleClaims` opted in, a claim
  older than `staleClaimSeconds` is handed back to a human, on the evidence of the slot
  it had to take and with `blocked` as the action — never a silent takeover. An open PR
  is never swept: that is a human's decision.
- Still open (P2): health/metrics export, progress-comment throttling, turning a
  pre-existing CI failure into a filed issue, and epic/milestone scoping (which needs
  a text-search capability on the board port before it can be uniform).
