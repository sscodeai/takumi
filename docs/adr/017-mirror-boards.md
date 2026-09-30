# ADR-017: Mirror Boards — One Authority, N Write-Only Projections

- **Date**: 2026-09-19
- **Status**: Accepted and **WIRED** (2026-09-25): `MirroringBoard` in `packages/core`, plus
  `pilot.boardMirrors` in `takumi.yaml`, `takumi pilot --resync`, and a persisted id map. Verified
  through the command against the fake board; the live check against a real Notion database is the
  remaining step (it needs a token).
- **Related**: ADR-006/007 (the two ports), ADR-008 (the event registry), the "progress write-back
  is a bypass" invariant, and the ledger's "a field nobody reads" class

## Context

Teams rarely have one board for one reality. They have the board takumi works from — the one that
owns the work and where the pull request happens (GitHub, GitLab, Jira, Redmine) — and the board
other people actually look at (Notion, a second Redmine project, a dashboard board). Those are not
alternatives to choose between; the second is an **extension** of the first, for readers.

ADR-007's "multi-host fan-out" was left open, and the question that surfaced it was concrete: *can
Notion and Redmine be viewers while GitHub and GitLab do the work and the pull requests?* Yes — as
one authority plus projections. Not as several equal boards, which is a different (and much worse)
thing to build.

## Decision

**A `TaskBoardProvider` decorator: one primary, N write-only mirrors.**

1. **Exactly one authority.** Reading, claiming, the state record, bootstrap and every decision go
   to the primary. A mirror is never read for control flow — someone editing the Notion page must
   not be able to change what takumi does. This is the "control flow only follows trusted authors"
   rule applied one level up.
2. **A mirror failure never fails the work, and is never silent.** Projection runs after the primary
   has recorded the fact, best-effort, and any failure emits `mirror.failed` with the mirror's own
   reason. Failing the tick would let a decorative board block real work; dropping the failure
   silently would leave a board people trust going stale. Both are wrong, so it is loud and
   non-fatal. (The same shape as the existing bypass rule for progress comments.)
3. **Projections are rebuildable.** `resync()` re-derives every mirror item's state from the
   primary, so a mirror that drifted or was unreachable can be brought back without touching the
   primary. The id map is a **cache**: losing it costs API calls, never correctness, and
   `readMirrorIdMap` tolerates absence and damage.
4. **Identity is carried by a marker, not by hope.** A mirror item is created with
   `<!-- takumi:mirror:<primaryId> -->` in its body and an idempotency key derived from the primary
   item, so a re-run — or a `resync` after a restart — cannot duplicate it.
5. **What is mirrored is what a PERSON reads**: the delivery state, the item's TITLE and TEXT, its
   LABELS and the comments (ADR-023 added the text and the labels; the state record is still the
   control-flow surface and is deliberately **not** mirrored). A mirror that carries only some of
   those is a CONFIGURATION (`labels: false` for a board with no labels column), never a runtime
   decision made by guessing what someone else's error meant.
6. **Outbound only.** Nothing in a mirror creates work or drives state. An inbound path (someone
   files an idea in Notion and it becomes a real issue in the primary) is a different feature with
   different semantics — who is allowed, dedupe, what the created item looks like — and is
   deliberately not part of this. It is a new ingress, and it needs its own trust decision.

## Consequences

- **Zero changes** to the six board adapters, the pilot, the delivery loop, or any delivery
  adapter: the port boundary is the seam, and that is the point of having had one.
- Two new registered events (`mirror.written`, `mirror.failed`) — the registry kept its promise
  from ADR-008: a new fact has to be named before it can be emitted.
- The decorator declares the PRIMARY's capabilities (it *is* the primary to every caller) and
  reports its mirrors separately via `mirrorsList()`, so a CLI check can print what is being
  projected where and what each mirror can represent (Notion: append-only comments, no state
  creation).
- A mirror that cannot create work is reported once per attempt and skipped, never silently absent.
- **WIRED (2026-09-25)**, which is what the line above asked for: `pilot.boardMirrors` in the config,
  the decorator built where the board is built (through the same provider factory `takumi board`
  uses), `takumi pilot --resync` (a resync is not a tick, and asking for one with no mirrors says so
  instead of printing nothing), the id map persisted next to the slot dir (loaded tolerantly, written
  after the work, and a write failure reported rather than thrown — a cache must not be able to fail a
  tick that already happened), and what is projected WHERE printed on every tick. The whole wiring is
  driven through the COMMAND in tests, not the class.
- **CLOSED OUT (2026-09-25, second pass)**: the projection is verified against a LIVE Notion database:
  a real GitLab item delivered end to end appeared as a page (created at claim, `pr_open`, `merged`,
  plus the merge comment), and `pilot --resync` projected all eight items with `failed 0` — twice, with
  the page count unchanged, so identity holds. `resync` now RE-ASSERTS the create (ADR-023): trusting
  the id map meant a copy that existed but was MISSING its text or labels could never be completed, and
  the eight pages filed before bodies were carried were completed exactly that way.
- **CORRECTION (2026-09-25)**:"projections are rebuildable" was **false** until bug #21.
  item was created at `ready` and then walked to the projected state — but the only edge out of `ready`
  is `claimed`, so a resync of anything in flight died with `projected 1, failed 1`. The port already
  carried the answer (`BoardWorkItemSpec.state`, honoured by all six adapters); the mirror never passed
  it. The double in core's suite hardcoded `state: 'ready'` too, so it agreed with the bug: only a real
  CALLER could expose it, which is the argument for wiring a capability in the slice that builds it.
