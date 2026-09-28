# ADR-023: A Page's Body Is Content (not a field you can drop)

- **Date**: 2026-09-25
- **Status**: Accepted (`bodyBlocks` / `blocksToText` / `readContent` in `boards/notion`, append-only
  repair in `createWork`, `labels` projection + re-asserting `resync` in `packages/core`)
- **Related**: ADR-006 (the board port's `body`), ADR-011 (filing work, and its idempotency marker),
  ADR-017 (mirror boards), ADR-008 (the pilot hands an item's body to the agent). Found while wiring
  the mirror against a live Notion database.

## Context

`BoardWorkItem.body` is part of the port: GitLab and GitHub return an issue's description for free,
the pilot passes it to the agent as `TAKUMI_ITEM_BODY`, and the mirror projects it onto the copy
people read. Notion has no body FIELD — a page's text is CONTENT, a separate blocks endpoint — so the
adapter documented the gap honestly and dropped the text: *"a `createWork` spec's `body` cannot be
stored (page content is a separate blocks API this adapter does not speak)"*.

That was honest, and it was still the wrong shape of answer. The first live projection made the cost
visible: eight pages in the database, every one of them a title and a status, and not one word of
what the work actually WAS. The mirror was showing a list of labels as if it were a board.

The honest-failure rule ("never drop a field quietly") is necessary but not sufficient: it keeps an
adapter from LYING, and it lets a real capability difference stand where the work needed a decision.

## Decision

1. **A body is written as content, exactly.** `createWork` sends `spec.body` as paragraph blocks —
   ONE BLOCK PER LINE, runs of at most Notion's 2000-character rich_text ceiling — in batches of at
   most 100 blocks per request (the first batch rides the create, the rest are appended). Nothing is
   truncated, nothing is reflowed, and the round trip is an INVARIANT with its own test:
   `blocksToText(bodyBlocks(b)) === b` for every body, blank lines, a trailing newline and a
   2500-character line included. A line longer than the ceiling becomes several RUNS of one
   paragraph, never two paragraphs — splitting it would turn one line into two on the way back.

2. **A read reads it back** (`readContent`, default true). One request per page, plus one per 100
   blocks of content, and `listWork` pays it once per ROW, sequentially (Notion rate-limits
   concurrent reads). WHY on by default: an item whose text silently reads as empty is how an agent
   gets sent to work on a description nobody gave it. The option exists because the cost is real, and
   it is documented as what it is — cheaper reads, `body` always `''` — not as "there is no text".

3. **A body is never searched.** `canTextSearch` still means TITLES ONLY: reading a body back is not
   a query condition, and a scope that matched on content would be a different, uncomparable
   promise. The test asserts both halves — the page whose CONTENT carries the scope word is not a
   hit, and its body still reaches the caller.

4. **An idempotent re-create REPAIRS.** A page filed before this adapter carried bodies (or one whose
   appends were cut short) is brought up to the spec: only content that is a strict PREFIX of the
   spec's text is completed, only the MISSING lines are APPENDED, and a page whose content is
   anything else — a person's own writing, another tool's — is returned untouched. A page with NO
   labels gets the spec's labels; a page a human labelled keeps them. Append is the only operation
   this adapter ever uses on content it did not write, in this commit or any other.

5. **That repair is what makes a rebuild real.** `MirroringBoard.resync()` now RE-ASSERTS the create
   for every item instead of trusting the id map: the map knows THAT a copy exists, never that the
   copy is complete, and what is missing lives on the mirror's side. `mirror.written` says "created
   the mirror item" only when something was actually created — a re-assert that claimed a creation
   would be the projection telling its reader about a duplicate that never happened.

6. **Labels are projected, and giving them up is CONFIGURATION.** The mirror now sends the
   authority's labels with the item (it used to send `[]`, which is why Notion's `Labels` column
   stayed empty). A mirror board that cannot record them REFUSES the create — correctly, fail-closed
   — and the projection fails loudly per item rather than filing rows without them. An operator whose
   mirror has no labels column sets `labels: false` on that mirror, once. The alternative — catching
   someone else's `precondition` error, matching its text, and filing the item anyway — would be a
   cross-adapter guess dressed up as resilience, and it is refused on purpose.

## Consequences

- **The refusal message had to grow a second cause.** Notion answers `400` both for a column option
  the database does not have AND for content it refuses. The old message sent the operator to edit a
  column that was fine; it now quotes the host's own message first and names both possibilities.
  (Caught while writing the test for a refused content write — the test was cheaper than the
  operator would have been.)
- **Three existing Notion tests changed**, and only in their arithmetic: a read now costs a page read
  plus a content read, so assertions moved from "request number 1" to "the request of the call that
  just happened". The counts these tests pin are unchanged; the indexing that quietly depended on
  request ORDER was replaced by lookups that do not.
- **A helper was caught not reading its own output.** `plainText` read only `plain_text` (the READ
  shape) and returned `''` for a run this adapter had just written (`text.content`), so the round-trip
  invariant failed for every body passed through the helpers directly. Both shapes are read now. The
  invariant test found this in its first run, which is the reason to state invariants as tests rather
  than as comments.
- **The dual of ADR-017's old rule.** "Never drop a field quietly" was satisfied by DOCUMENTING the
  drop, and documenting it did not stop it from being wrong for the first real user of the projection.
  The rule this ADR adds: a capability difference is a decision to make, not a footnote to write — and
  when the work needs the capability, the adapter implements it rather than explaining why it cannot.
- **Live verification**: the eight existing pages were completed by `pilot --resync` — bodies and
  labels appended, no duplicates (the count stayed at eight), the page's identity marker in its
  machine property and its text — and the whole thing read back through a raw REST client that never
  asks takumi what it thinks it wrote.
- **Not done, and named**: content is not edited, only appended (a changed description on the
  authority does not rewrite a page that already has text); `listWork` still reads one page of items;
  and Notion's own block-level features (headings, to-dos, images) are read as text only, since
  paragraphs are what this adapter writes.
