# ADR-012: Scoping a Tick (search, and the refusal to widen)

- **Date**: 2026-09-18
- **Status**: Accepted (`BoardWorkQuery.query`, `canTextSearch`, `pilot.policy.scopeQuery`)
- **Related**: ADR-006 (boards), ADR-009 (the pilot), ADR-011 (filing work)

## Context

A pilot on a real repository does not want "everything that is ready". It wants the
items of one epic, one milestone, one component, one customer — the human's own notion of
a slice, which every board expresses differently: GitHub has milestones and sub-issues,
Jira has epics and components, GitLab has epics and milestones, Redmine has trackers,
Notion has relations.

Teaching takumi each of those models would be five different concepts behind one name, and
every board would then have a filter the others could not honour. The last item on the
P2 list was exactly this, and the honest version of it turned out to be much smaller than
the plan.

## Decision

### 1. The scope is TEXT, and the board's own search is what runs

`BoardWorkQuery.query?: string` — "only items whose text matches this". A milestone, an
epic, a component name, a customer: all of them are words the board already indexes, and
each adapter translates the scope into its own search:

| Board | How the scope is expressed | What it searches |
|---|---|---|
| GitHub | `GET /search/issues?q=repo:… is:issue "<term>"` | issue title and body |
| GitLab | `search=<term>` on the project issues request | title and description |
| Jira | `text ~ "<term>"` inside the SAME JQL as the state filter | summary and description |
| Redmine | `GET /search.json?issues=1&q=<term>`, then one read per candidate | subject and description |
| Notion | a `title.contains` filter on the database query | **titles only** — page bodies are not searchable through this API |
| fake | substring over title and body | the reference behaviour |

Two things are deliberately NOT claimed: takumi does not model epics, and it does not
pretend a board searches more than it does. Notion's restriction is written in its
capability comment, because a caller who assumes "search" means "search everything" will
scope a tick that then quietly does the wrong thing.

### 2. `canTextSearch`, and a refusal instead of a wider net

A board that cannot search declares `canTextSearch: false` and must **fail closed** as
`unsupported` when asked for a scope. This is the strongest form of the rule the whole
port is built on, because the failure mode is not "less capable": an ignored scope filter
means the runner works on precisely the items the operator excluded. The shared suite
enforces it in both directions — a `true` board must find an item whose text carries a
distinctive term and must NOT return it for a term nothing carries.

### 3. The tick asserts the capability before it starts

`pilot.policy.scopeQuery` narrows a tick. If the board cannot search, the tick throws
BEFORE listing anything: an unhonourable scope is a configuration error, not a reason to
process the whole board. The test asserts that nothing was claimed or transitioned.

### 4. The in-flight sweep is NOT scoped

Deliberate asymmetry: the sweep exists to hand stranded items back to a human, and an item
stranded *outside* today's scope is exactly the one nobody would notice. Tidying is not
work, so the scope does not apply to it.

## Consequences

- "Only this epic" works on every board with one configuration line, and fails loudly on a
  board that cannot honour it.
- A scope costs what the board's search costs: one request on GitHub/GitLab/Jira, a search
  plus one read per candidate on Redmine (Redmine's search answers no status, so a hit is
  not work until it has been read — that cost is in the adapter's comment and in a test that
  asserts the exact request sequence).
- Still not modelled, on purpose: epic membership as a first-class relationship, and
  parent/child items. Both would be per-board models, which is what this ADR avoids; a
  caller who needs them composes a scope string or adds a board-specific adapter.
