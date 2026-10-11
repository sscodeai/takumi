# ADR-028: A Decision Is Only Real If It Is Checked

- **Date**: 2026-10-01
- **Status**: Accepted (`decides:` in the requirement document; the decision layer of
  `extensions/judges/metamorphic-forge.sh`; the `DEC-nnn` lines in the forged judge; tests in
  `packages/core/src/test/judge-forge-decisions.test.ts`)
- **Related**: ADR-026 (the forged judge), ADR-027 (the bounded-choice confirmation, whose "honest
  limits" section names this exact gap), ADR-025 (the confirmed requirement and the acceptance bound
  to it), ADR-013 (the vacuous green this exists to prevent)

## Context

ADR-027 gave the human a bounded choice and wrote the answer into the document, whose digest is the
token the acceptance binds to. The forged judge (ADR-026) then checked two things about that:
DOC-001, that every decision has a `chosen` option, and the relations, that declared invariants hold.

Neither of them read the answers. The judge's fixtures and expectations were written as PROSE
ASSUMPTIONS inside the forge — the duplicate fixture appended a row with a later `start_date` and a
comment said "AMB-002 chose the latest start_date wins". So:

1. **A recorded decision could be implemented backwards and still be accepted.** A document that chose
   "first row wins" and an implementation that keeps the last row passed every relation the document
   declared, because the relation was written around an assumption rather than around the answer.
2. **The expectation and the human's answer lived in different files, written by different authors.**
   One was in `metamorphic-forge.sh`, the other in `docs/requirements/*.yaml`, and nothing tied them
   together. A decision could therefore be recorded without being covered, and the coverage could be
   claimed without the decision.

That is the difference between a decision that binds an implementation and a decision that decorates a
document.

## Decision

1. **A check declares the decision it exercises.** A relation or a differential anchor may carry
   `decides: AMB-nnn`. The document's `deliverable` block is already the contract a judge is forged
   from, so this is where the binding belongs — not in the workflow manifest, which is not what the
   acceptance hashes.
2. **A blocking decision no check exercises is a REFUSAL, not a warning.** The forge refuses to build a
   judge at all, naming the decision: *"a blocking decision nothing checks does not bind the
   implementation"*. There is no judge, so there is no acceptance, so the run cannot be delivered.
3. **The answer, not the forge, decides the expectation.** Each relation has a vocabulary of
   mechanisable answers for the decision it exercises; the fixture it builds and the values it expects
   are functions of the `chosen` option. A `chosen` value outside the vocabulary is a refusal that
   names the values the forge can decide: an answer nobody can check is not an answer.
4. **The judge computes its own expectations from its own fixtures.** `aggregate` (awk, in the judge)
   recomputes counts and totals from the fixture under the chosen duplicate rule and the chosen
   rounding rule; the duplicate check and the differential anchor both compare against that
   recomputation. No expected number is hard-coded, so an expectation cannot drift from the fixture it
   is checked against — a hard-coded number is a second bug report waiting to happen.
5. **Every exercised decision is reported as its own line.** After the relations, the judge emits
   `DEC-nnn <AMB-id> honoured: "<the chosen option>" (checked by REL-nnn)`, derived from the verdict of
   the check bound to it. A decision that is NOT exercised is printed as
   `# not mechanised (non-blocking decision): …` and is never counted `ok` — an unmechanised decision
   reported as a pass is the vacuous green ADR-013 exists to prevent.
6. **Two duplicate fixtures, because one cannot separate two answers.** `dup-late-date` (a repeated id
   with a LATER start_date: file order and date order agree) separates "latest start_date" from "first
   row". `dup-early-date` (the repeat carries an EARLIER start_date: the two orders disagree) separates
   "latest start_date" from "last row". A judge that cannot tell two of its own answers apart is not
   checking either of them.
7. **The forge refuses to invent a rounding rule.** If no relation or anchor exercises a rounding
   decision, the judge would have to assume one, and an assumed rounding rule is an invented
   requirement. It refuses and says what to bind.
8. **The vocabulary is stated in the forge, and it is the honest scale of coverage.** The forge lists
   exactly which answers it can mechanise per relation
   (`duplicate-resolution`: latest-start-date / first-row / last-row / error;
   `malformed-row-accounting`: skip-and-count / stop-with-an-error;
   `independent-aggregation`: half-up / truncate). Anything else is refused, so the forge can never
   quietly claim more coverage than it has.

## Evidence, from real invocations

Acceptance runs of the real workflow (`extensions/workflows/blackbox-acceptance/workflow.yaml`,
`fake` runtime, the reference deliverable hand-placed as in PoC-3) with the SAME implementation and
only the human's answer changed:

| the document chose | the same implementation | verdict |
| --- | --- | --- |
| the row with the latest start_date wins | keeps the latest start_date | `9/9 ok`, `ACCEPT_VERDICT: pass` |
| First row wins | keeps the latest start_date | `not ok REL-003 … late-date total 537 want 428`, `not ok DEC-002` |
| Treat it as an error | summarises instead of failing | `not ok REL-003: the chosen option is "treat it as an error" and the tool exited 0` |
| Stop with an error (malformed rows) | skips and counts them | `not ok REL-004`, `not ok DEC-001` |
| Truncate, no currency printed | rounds half-up | `not ok DIFF-001 (rounding: truncate)`, `not ok DEC-003` |

And the defect ADR-026 exists for — an implementation whose own tests are green but which keeps the
LAST row — still fails: `not ok DEC-002 AMB-002 NOT honoured`. The decisions a run accepted are visible
in the ACCEPT artifact, one line per decision, with the check that bound it.

The refusals are all demonstrated by real invocations and pinned by regression tests: the uncovered
blocking decision, the `decides:` naming a decision the document does not contain, the chosen option
outside the vocabulary, and the rounding rule nothing decides.

## Rejected, and honest limits

- **Not a general "prove the implementation matches every decision" mechanism.** This binds decisions
  to checks WITHIN the vocabulary of the relations that exist (four relations and one anchor). It
  closes the specific hole ADR-027 recorded — an answer that is recorded and then contradicted — it
  does not make prose criteria mechanisable. The 50,000-row performance criterion, the printed
  duplicate count and the optional output-file argument are still reported as `# not mechanised`.
- **A "decoration binding" is not caught.** The mapping from a decision to a check is declared by a
  human in the document, and nothing verifies that the check really exercises the decision it claims:
  a relation could say `decides: AMB-001` and check something else. What IS enforced is the two ends —
  a blocking decision cannot be left without a check, and an answer outside the vocabulary cannot be
  checked at all. Verifying that a check exercises what it claims would need the counterfactual
  implementation the forge deliberately never reads.
- **Matching is on the option's TEXT** (normalised: lower-cased, whitespace collapsed). Re-wording an
  option in the document without touching the forge makes the forge refuse rather than silently
  mis-check. Refusal is the intended failure mode, but it is a maintenance cost shared by the document
  and the forge, and it is why the refusal names the mechanisable values.
- **AMB-003 is not mechanised.** "Where does the summary go" is a decision the judge reports as
  non-mechanised (it is non-blocking, so this is allowed). An implementation that writes a file when
  the document chose stdout-only is therefore still accepted. Recorded here rather than papered over.
- The fixture rows are still fixed in the forge; the ALGEBRA around them (which row wins, how it is
  rounded, what a malformed row does) is what the answer drives. More fixture shapes would widen what
  the answers can discriminate.

## Consequences

- A recorded decision can no longer be implemented backwards without the acceptance failing: the
  human's answer is now an input to the judge, not a comment above it.
- The ACCEPT artifact becomes legible from the human's side: the checks list now says which decision
  each check settled, so "what did my two answers actually buy" has an answer in the artifact.
- Adding a decision to a document now has a cost the intake must pay: a blocking decision needs a
  relation that exercises it, or the forge refuses. That is the intended pressure — an unanswered
  decision is no longer cheaper than an answered one.
- The forge is longer, and its vocabulary needs maintaining alongside the requirements it serves.
