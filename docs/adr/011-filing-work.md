# ADR-011: Filing Work (a failure becomes a task, once)

- **Date**: 2026-09-18
- **Status**: Accepted (`createWork` on the task-board port; `fileIssueOnExhaustedChecks`)
- **Related**: ADR-006 (boards), ADR-008 (rails), ADR-009 (the pilot), ADR-010 (observability)

## Context

The pilot can now run unattended, and it had one blind spot: **it could not create work.**
When a delivery ended with checks that stayed red through every fix round, the loop
blocked the item and left a comment. That is honest, and it is also how a repository
rots: the failure has an owner only if a human happens to read the comment, and the same
red pipeline will be hit again by the next item that touches the same code.

orbi files an issue for exactly this case. takumi had no way to, because the port had
`listWork` / `getWork` / `claim` / `transition` / `comment` / `writeState` and nothing
that creates.

## Decision

### 1. `createWork` is a port method, with an honest capability

```ts
createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult>;
canCreateWork: boolean;
```

All six adapters implement it, because every one of these boards can file an item
through its API; the capability stays in the contract because that is not true of boards
in general, and a caller must be able to tell "I did not file that" from "that board
cannot file". An adapter that declares `false` must **fail closed** as `unsupported` —
never pretend, never return a fabricated item.

### 2. Idempotency is the point, not a detail

A tick is retried; a filing must not become a second issue. No board here offers a native
idempotency key, so the key travels as a machine-readable marker
(`<!-- takumi:created=<key> -->`, the same HTML-comment trick as the run marker) written
into the item, and every adapter **searches for it before creating**. Second call with the
same key → `created: false` and the FIRST item.

Per board, the marker lives where the board can search and the adapter can read back:

| Board | Marker lives in | Search before create |
|---|---|---|
| GitHub | issue body | `GET /search/issues?q=repo:…"marker"` |
| GitLab | issue description | project issue search |
| Notion | the state `rich_text` property | database query with a `contains` filter |
| Jira | the ADF description | JQL text search |
| Redmine | the description | `/search.json`, then a local marker check |
| fake | the body | in-memory scan |

Where a search index can lag behind a write (Redmine, Notion), the adapter verifies the
candidate locally and the lag is stated as a known limit rather than hidden.

### 3. What an adapter refuses to guess

A create is a WRITE, so it is stricter than a read:

- **Redmine** refuses a `labels` request (core issues have none) instead of dropping it,
  and refuses to file in a status it cannot resolve — naming the available statuses, which
  is what lets an operator fix `statusMap`.
- **Jira** refuses to guess an issue type (it has no safe default) and refuses a state
  whose workflow status is not configured.
- **GitHub** turns a 422 on a missing state label into "run `takumi board --bootstrap`",
  which ties ADR-008's bootstrap to the first write that needs it.
- **Notion** puts the marker in the property the adapter already owns, rather than
  inventing a second place to look.

### 4. `fileIssueOnExhaustedChecks` — the reason this exists

Off by default. When on, the loop's "checks stayed red and no fix round is left" path
files an item (title names the item and the failing checks; body carries the PR url, the
check names and the run id) under the key `ci-red:<item>:<pr>`. So:

- The first run files one item.
- A later attempt at the same item and pull request returns the first item, `created: false`.
- A board that cannot file, or a filing that fails, leaves the item BLOCKED with the reason
  in the step timeline — **filing is a side channel, and a side channel never changes the
  delivery's conclusion** (the ADR-008 rule, applied to the second thing that needed it).

## Consequences

- A red pipeline becomes somebody's task instead of a comment nobody reads, and repeated
  attempts cannot spam the board.
- The port is now six methods wide with an explicit capability matrix, which is the
  pattern every future extension should copy: a required method + a truthful flag + suite
  coverage of the failure case.
- A port method cannot land half-way — this change touches all six adapters at once
  because a required method is atomic. That is a real cost of the abstraction, and it is
  the price of the guarantee that `capabilities()` can be trusted.
- Still open: epic/milestone scoping, which needs a text-search capability on the same
  port before it can be uniform across these boards.
