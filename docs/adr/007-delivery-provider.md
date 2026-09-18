# ADR-007: Delivery Abstraction (DeliveryProvider)

- **Date**: 2026-09-18
- **Status**: Accepted (implemented: port, contract suite, fake + GitHub/GitLab delivery adapters)
- **Related**: ADR-001 (technology stack), ADR-002 (runtime abstraction), ADR-006 (task-board abstraction)

## Context

ADR-006 gave takumi a provider-agnostic way to find work and to own its delivery
state. What it deliberately did NOT implement was the other half of a delivery
loop: putting a committed change somewhere a human can review it, and merging it
once it has been reviewed. M1 shipped that half as *capabilities*
(`BoardCapabilities.delivery`) on the board port, which was honest but
incomplete: it cannot execute anything, and it quietly implies that a board and a
code host are the same system.

They are not. Jira and Notion are boards with no pull request in sight. GitHub
and GitLab are both a board and a host. Any real deployment mixes them — a Jira
board with a GitHub delivery is the normal shape in an enterprise that keeps its
tickets in Jira.

Meanwhile the reason this layer must exist at all is not convenience but
**boundaries**. An autonomous agent must not be trusted to decide when its work
is committed, when a branch may be rewritten, or which commit may be merged. Those
three decisions are exactly the ones that turn "AI wrote code" into an
unattributable incident.

## Decision

### 1. A second port, with its own capabilities

```text
        Core (state machine · run id · events · capability negotiation)
                    │
     ┌──────────────┴───────────────┐
     ▼                              ▼
TaskBoardProvider               DeliveryProvider
（where work comes from,        （how a committed change
  where its state lives）         reaches a host）
```

`DeliveryCapabilities` is `{ canPushBranch, canOpenPullRequest, canRunChecks,
canMerge }`. `canPushBranch` is separate because a host may accept a branch
without any notion of a review — a caller must know that before it promises one.
The board's `delivery` flags stay, but their meaning is now explicit: they are a
**routing hint about the host type the board implies**. The authoritative,
executable truth is `DeliveryProvider.capabilities()`.

### 2. The three rules the port exists to enforce

1. **The agent's boundary is the commit.** `deliver()` refuses a dirty worktree
   (`precondition`) and never stages, never commits, never "helps".
2. **Pushing is plain, never forced.** `deliver()` returns
   `push: {mode: 'plain' | 'force', branch, head}` — the value is asserted by the
   contract suite, and a rejected push is a `precondition` rather than a reason to
   reach for `--force`.
3. **Only the reviewed commit is merged.** `merge(ref, {expectedHeadSha})` fails
   when the remote head differs, and the GitHub/GitLab adapters pass that same sha
   to the host (`sha=` on GitHub's merge API, `sha:` on GitLab's), so the guarantee
   is enforced by the host as well as by us.

### 3. Exactly one pull request per delivery

`deliver()` reuses the open pull request for the branch when there is one, and
reports `created: false`. The review/fix loop therefore keeps landing on the same
PR: a fresh PR per tick would fragment the review history and lose the reviewed
head. A second `deliver()` may push newer commits (the loop is exactly that), but
must never open a second pull request.

### 4. The state record grammar stays shared

A pull request body carries the same versioned run marker as a board comment
(`renderRunMarker` / `parseRunMarkers`, `<!-- takumi:run=<id> -->`) plus an item
cross-reference: `Fixes #<n>` when the id is numeric (GitHub can close it
natively on the default branch) and always a plain `Item: <id>` line, so a Jira
key or Notion page id stays readable.

### 5. Seams, so nothing is untestable

Two injected seams: `GitRunner` (async git; a test records the argv, which is how
"it never force-pushed" becomes a fact rather than a promise) and the shared
`BoardRequestFn` HTTP seam from ADR-006. Neither adapter calls `child_process` or
`fetch` itself, and both fail closed when a seam is absent (no token / no runner
→ `unsupported`, never an anonymous call on the operator's repository).

### 6. Checks are never coerced to green

`checks()` maps the host's own vocabulary onto
`success | failure | pending | neutral | unknown`, and a `pending` (or
unrecognised) check stays `pending`/`unknown`. Treating "not finished" as "passed"
is the single most expensive lie this layer could tell.

## Adapter order

`fake` (the suite's own proof) → **GitHub** (the project's home, and where the
three rules are testable end to end) → **GitLab** (the enterprise host most teams
here use). A host without a review surface (`deliveries/git` pushing to a bare
remote) is a natural next adapter, not a reason to weaken the port.

## Alternatives considered

- **Keep delivery as board capabilities** — rejected: a Notion database would have
  to declare `canMerge` or be second-class; the two systems genuinely differ.
- **Put git operations in the workflow engine** — rejected: git is a host-specific
  transport; the engine would grow a GitHub-shaped assumption, exactly the mistake
  ADR-002 and ADR-006 were written to avoid.
- **Let the agent push and open the PR (as most harnesses do)** — rejected: it
  makes the delivery boundary unenforceable and unreviewable, and the failure mode
  (an agent force-pushing over a reviewed branch, or merging its own change) is
  silent.
- **Trust our own head check and skip the host-side `sha` parameter** — rejected:
  a check on our side and a race on theirs still merges the wrong commit; passing
  the sha makes the host refuse it.

## Consequences

- Costs: two more adapters to maintain per host, and a `GitRunner` seam to keep
  honest (`git` output is parsed, so a future git version output change is a real
  risk — noted, tested against the shapes we use).
- Gains: the three rules are executable and tested; a board without a review
  surface composes with a host that has one; and the merge of an unreviewed commit
  requires defeating both our check and the host's.
- Deliberately still open: a `deliveries/git` (bare remote, no PR), a
  conflict-resolution policy (today a conflicting base merge is aborted and handed
  to the review session), and multi-host fan-out (one change delivered to several
  hosts) — none of which need a port change.
