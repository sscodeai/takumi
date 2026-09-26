# ADR-019: A Committed Credential Blocks the Delivery

- **Date**: 2026-09-25
- **Status**: Accepted (`review-rules.ts`: `secret/committed`, `secret/suspected`, `ReviewFinding.line`,
  `REVIEW_RULESET_ID = 'rules@2'`)
- **Related**: ADR-013 (the deterministic reviewer), ADR-018 (a review is evidence about one set of
  inputs), ADR-009 (the pilot). Measured against `semgrep` and `reviewdog`, which would have
  contributed this rule had the reviewer been delegated to them.

## Context

ADR-013 built the reviewer to catch one shape of delivery that is worse than no delivery at all: an
agent that turns CI green by weakening the tests CI runs. There are two, and only one was covered.

> An agent commits a credential. The leak is not the merge — it is the push. Removing the line in the
> next commit does not un-leak it, and a reviewer that reports "fixed in a later commit" is reporting
> after the damage.

Reading `semgrep`/`reviewdog` for integration made the gap concrete rather than theoretical: their
rule packs would have contributed exactly this rule. But it is **pure determinism about a diff** —
no model, no network, no clock — so the honest place for it is the engine that already reviews every
delivery, not a 333MB toolchain adopted to run one regex. The tool integration is still worth doing;
it should be a translation of findings we already have, not the only source of them.

## Decision

1. **`secret/committed` — `block`**, on narrow, provable shapes only: vendor prefixes (`glpat-`,
   `ghp_`, `gho_`, `sk-`, `AKIA`, `xox`), private-key headers, and `eyJ`-prefixed JWTs, each with a
   minimum body length so a bare prefix in prose is not a finding. The message asks for
   **rotation**, not removal: this rule exists because the credential is already leaked, and
   deleting the line does not undo the push.
2. **`secret/suspected` — `human`, never `block`.** A long high-entropy token-shaped run that
   matches no known vendor goes to a person (ADR-013's severity model): a heuristic may not stop a
   delivery, because the cost of being wrong is an agent "fixing" a legitimate opaque id. Entropy is
   measured as length plus a mix of upper/lower/digit, so **a hex digest is never suspected** — a
   lockfile `integrity` hash has no case mix. That is the false positive that would have made the
   rule useless, and it is tested in both directions.
3. **The base is not the subject.** A credential already present at the frozen base is not this
   change's doing and is not re-reported every round. The reviewer's subject is the change set
   (ADR-013); noise buries the finding that is new.
4. **`ReviewFinding.line` — findings can point at a line.** A person acting on a finding needs a
   place to look, and every diff-anchored surface (inline review comments, SARIF, a board comment,
   an `/ask <line>` command) needs a coordinate. The semgrep/reviewdog integration would have had to
   add this field anyway; adding it to the engine first means those adapters are a translation.
5. **`REVIEW_RULESET_ID` goes to `rules@2`.** Adding rules changes what a review *means*, so a digest
   computed under `rules@1` is now correctly stale for an approval (ADR-018). The rule set is part of
   the evidence, and its version is how that is said out loud.

## Consequences

- The two ways a delivery can be worse than nothing are now both guarded by pure functions: `block`
  for the shapes a machine can prove, `human` where judgement is required. Neither spends a fix round
  on work that may be exactly what the item asked for.
- **Not covered, and named**: a secret already in the base, a secret split across lines or assembled
  at runtime, a secret inside a binary or an image layer, and entropy heuristics over generated files.
  Ignoring them is a decision, not an oversight — each one either costs a false positive or needs
  context a diff does not carry.
- `REVIEW_RULESET_ID` is a hand-maintained constant, which is a debt with a known due date: the next
  step (making the rules data, with unknown-key validation) has to **derive** this id from the data.
  Forgotten once, it makes every stored digest quietly wrong.
- Findings grew a field; the record `schema: 1` shape absorbed it without a migration.
