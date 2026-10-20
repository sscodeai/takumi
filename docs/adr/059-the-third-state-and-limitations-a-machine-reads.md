# 059 — The third state, and limitations a machine reads

## Context

Two honesty problems, both of which had already been paid for twice in this project:

1. **A requirement nothing exercises looks exactly like a requirement that passes.** The traceability
   matrix knew the difference internally (`renderTraceabilityMatrix` computed `uncovered`) but
   expressed it only as a line of Markdown (`> ⚠ Uncovered requirements: …`). On 2026-10-13 two real
   unattended runs produced matrices whose `ACCEPT-001` row covered `REQ-001..005` and `REQ-001..008`
   — requirements were left unexercised and the fact existed only in a rendered report nothing reads.
2. **A named limitation was prose, so it could rot in both directions.** "Named limitations" lived in
   an ADR section and in ledger rows. A limitation that had been closed could sit there looking
   current (and one did: the acceptance step's open-run limitation was closed by the wiring, and only
   a hand edit of the ADR kept the text true), and a limitation stated in an ADR need not appear
   anywhere a machine reads.

Provenance, stated plainly: both shapes are borrowed from a spec-suite repository whose spec carries
a machine-extractable anchor on every normative sentence and whose coverage report has three columns
— `pass`, `fail`, `unsupported` — labelled "implementation coverage, not accepted language
behaviour". **That repository carries no licence at all**, so not one line of its code may be taken:
what is borrowed is the SHAPE of two ideas, and this ADR is where that is written down.

## Decision

1. **The coverage of requirements is DATA.** `traceabilityCoverage(artifacts)` returns
   `{ required, covered, uncovered }`; the Markdown warning is a rendering of it. `uncovered` is the
   third state: not a pass, not a failure, a named gap.
2. **Named limitations live in `docs/limitations.yaml`, and a test consumes them.** Every entry names
   `where` it is stated (`file` + the text that states it), `what` it is, and `closes_when`. The test
   enforces: the statement is really there; an entry without a closure condition is refused; and an
   entry whose `closes_when_path` EXISTS must be deleted.
3. **A limitation closed by a change narrows or moves the statement in the same change.** The
   acceptance-step limitation is the worked example: it went from "runs the delivered project open"
   to "the deliverable cannot write the platform, but can read it" in the commit that wired the
   boundary, and the inventory's entry carries the narrower claim.

## Consequences

- A pass/fail report can no longer stand in for "everything is exercised"; the gap has a name.
- A limitation cannot be quietly forgotten: deleting its statement fails the inventory test, and
  leaving a closed one fails it too.
- The third state is deliberately NOT a failure. A requirement nothing exercises must be *named*, not
  necessarily *blocked* — turning it into a hard gate is a separate decision, because an early
  document legitimately declares surface it will exercise later (the same reason the borrowed report
  counts `unsupported` as progress).
