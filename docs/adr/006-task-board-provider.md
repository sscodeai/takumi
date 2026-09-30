# ADR-006: Task-Board Abstraction (TaskBoardProvider)

- **Date**: 2026-09-18
- **Status**: Accepted (M1 implemented: port, contract suite, fake + GitHub/GitLab/Jira/Notion adapters)
- **Related**: ADR-001 (technology stack), ADR-002 (runtime abstraction), ADR-004 (event model), ADR-005 (artifact & traceability)

## Context

Takumi orchestrates agent runtimes behind one contract (`AgentRuntimeAdapter`,
ADR-002) precisely so the core never learns a harness's internals. The same
question was left unanswered on the other side of the loop: **where does work
come from, and where does its delivery state live?**

Two forces make this a decision rather than an implementation detail:

1. **The boards teams already use are not one shape.** A GitHub issue carries
   labels, comments and a pull request. A Notion database carries a `select`
   property as its column and has no notion of a pull request at all. A Jira
   issue has a status workflow and issue properties. A GitLab issue has labels
   and merge requests. A board = "issues with labels" is an assumption that
   silently excludes half of the market — and the assumption is invisible until
   someone plugs in a second board.
2. **A run must be resumable from the board alone.** A resuming process needs to
   know which item, which run, which delivery, which review round. If that state
   lives only in takumi's local files, a lost machine loses the run; if it lives
   in human-written board text, anyone who can comment can steer the automation.

A reference implementation of a delivery loop (`orbi-build/orbi`) solves both
problems in a deliberately narrow way: GitHub Issues ARE the state machine, and a
constitution article forbids a second task board, database or queue. That
discipline is worth copying; its single-provider assumption is not.

## Decision

### 1. Two ports, not one

- **`TaskBoardProvider`** (this ADR, M1): where work comes from and where its
  delivery state lives.
- **`DeliveryProvider`** (M2, not implemented yet): how a change is delivered —
  branch, push, pull request, checks, merge.

They are separate because the capability sets do not overlap: GitHub/GitLab can
do both, Jira and Notion can only be the board. M1 therefore declares the
delivery surface as **capabilities** (`delivery.canOpenPullRequest`,
`canRunChecks`, `canMerge`) instead of pretending a second port exists, so M2 can
add the port under an already-honest contract.

### 2. State ownership is explicit

- The **board owns the delivery state** (label, status, column). Humans read and
  change it there, and it must remain correct if takumi is uninstalled.
- **Takumi owns the execution evidence** (runs, artifacts, traceability, events)
  — see ADR-004/ADR-005. It is never duplicated onto the board.
- The **only** resumable facts written back to the board are a single versioned
  record (`BoardStateRecord`, `schema: 1`) carrying `runId`, `item`,
  `baseBranch`, `deliveryRef` and `reviewRound`.

### 3. The six-state delivery model is pure and shared

`ready → claimed → pr_open → merged`, with `pr_open → fix_needed → pr_open`
(the review/fix loop stays on the same item and PR), `claimed|pr_open|fix_needed
→ blocked`, and `merged`/`blocked` terminal for the automated machine.
`pr_open → blocked` is not decoration: an open pull request can still reach a
decision no automation may take (review rounds exhausted, base branch
reconfigured, the host refusing a conflicting head), and without that edge the
item would sit in `pr_open` forever. The table
lives in `packages/core/src/board-state.ts` with no I/O; illegal transitions
throw `BoardStateError` and an adapter must never "correct" a state on its own. A
A board that cannot express a state says so through `capabilities().states`.

Corollary, learned from the Redmine adapter: an item whose state an adapter cannot
map is a CONFIGURATION GAP, never a filter outcome. `listWork` reports it (naming
the status and the fix) instead of skipping it — a silently dropped item makes a
board missing its `statusMap` look exactly like a board with no work, which is how
an unattended runner idles forever while its queue is full.

### 4. Capability negotiation, fail-closed

Every adapter declares what it can actually do, and callers validate before
acting (`validateBoardCapabilities`, `assertBoardCapability`). A gated operation
raises `BoardUnsupportedError` — never a silent no-op, never a silent success.
Measured differences this ADR is designed around:

| Board | Column | Comments | Editable comment | Machine-readable record | Author trust signal | Atomic claim | PR / CI / merge |
|---|---|---|---|---|---|---|---|
| GitHub Issues | label | yes | yes | hidden comment block | `author_association` | no (read-then-write + re-read) | yes |
| GitLab Issues | label | yes (notes) | yes | hidden note block | none per note (allowlist only) | no | yes (MR + pipeline) |
| Jira | status | yes | yes | **issue property** | none (allowlist only) | no | no |
| Notion database | `select`/`status` property | yes (append-only) | **no** | **rich-text property** | none (`created_by` only) | no | no |

Notion is the heterogeneous case that keeps the abstraction honest: it has no
labels, no editable comments, no pull requests and no author roles. If the port
survived only GitHub-shaped boards, it would be a GitHub adapter wearing an
interface.

### 5. State is derived, never trusted from public text

- The resumable record is a **versioned, machine-readable block**
  (`renderBoardStateRecord` / `parseBoardStateRecord`) whose surrounding
  human-readable text is display only. A present-but-corrupt block throws
  `BoardStateRecordError` — it must never look like a fresh item.
- Where the board offers a trust signal (GitHub's `author_association`), records
  written by untrusted authors are ignored on READ. Where it does not (GitLab,
  Jira, Notion), the adapter declares `trustedAuthorFilter: false` rather than
  inventing a signal, and prefers a channel only takumi can write (a Jira issue
  property, a Notion property).
- A claim is never silently duplicated: a second claim of the same item by
  another run either throws `precondition` or returns `claimed: false` with a
  reason. Where the board cannot do this atomically (`atomicClaim: false`
  everywhere today) the adapter re-reads after writing and reports a lost race.

### 6. Errors are classified once, centrally

`auth | transport | precondition | not_found | unsupported`, mapped from HTTP
status in `packages/core/src/board-transport.ts`. `transport` (429/5xx) is the
only retriable kind; the rest are decisions, not failures to retry.

### 7. Adapters are extensions, and tests never touch a network

Adapters live in `boards/<name>/` as workspace packages with a `manifest.yaml`
(`kind: board`), discovered like every other extension. Each takes an injected
request seam (`BoardRequestFn`); the default is curl-based. Consequence: every
adapter runs the SAME contract suite (`runTaskBoardProviderContractSuite`)
offline, with zero credentials, which is what makes "the abstraction holds" a
test result rather than a claim.

## Adapter order (and why)

1. **Fake** — the reference implementation; proves the suite itself.
2. **GitHub** — the board the project is developed on.
3. **Notion** — the heterogeneous proof (the step most likely to break the
   abstraction, taken early while changing the port is still cheap).
4. **GitLab / Jira** — the boards enterprise teams actually run; same family as
   GitHub, so they must NOT be what proves the abstraction.
5. **One MCP / REST adapter** for the long tail (Backlog, Redmine, Plane,
   in-house systems) — deliberately ONE generic adapter, not N bespoke ones.

## Alternatives considered

- **Hardcode GitHub** — rejected: repeats the pre-ADR-002 mistake on the work
  side; makes the "board is the single source of truth" story a vendor story.
- **Adopt a tracker SDK (Octokit etc.)** — rejected: adds a runtime dependency
  per board, contradicts the zero-dependency posture, and hides the request shape
  the operator needs when a tick fails.
- **One generic "REST board" adapter only** — rejected: a mapping DSL cannot
  express a pull request, a status workflow AND a select property without
  becoming a programming language, and it would hide each board's real
  capability gaps behind configuration.
- **Store run state in takumi's own database** — rejected: reintroduces the
  second state store that makes an unattended loop unattributable, and breaks
  resumption after a lost machine.

## Consequences

- Costs: each real board is genuine work (auth, pagination, mapping, error
  taxonomy), and the six-state model is now a compatibility surface.
- Gains: a team keeps its existing board; a new board is one adapter that must
  pass one shared suite; capability gaps are visible before wiring, not after an
  incident; and the resumable record is board-agnostic.
- Open for M2: the `DeliveryProvider` port (branch/push/PR/checks/merge), its
  own contract suite, and how a delivery-capable board composes with a
  non-delivery board (e.g. Jira board + GitHub delivery).
