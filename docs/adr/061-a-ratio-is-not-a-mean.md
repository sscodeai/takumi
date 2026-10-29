# 061 — A ratio is not a mean

## The moment this changes

A correct delivery was refused. The requirement asked for a website-uptime report: per site, the number of
probes, the number of failures, and the availability percentage. The implementer wrote exactly that, and the
forged judge rejected it:

```
id alpha.example mean=25.0  want 0.8
```

The judge was not wrong to compute a number. It was answering a **different question**. The only vocabulary
that could express "one number per site" was `independent-aggregation` — an aggregate of a per-row numeric
measure — so the judge recomputed the mean of the raw measure. The requirement's answer is not a mean. It is
a **quotient**: successes ÷ probes.

Nothing was broken. The requirement was clear, the implementation was correct, the judge did what it was
told. The vocabulary simply had no way to say "this answer is a ratio", and a vocabulary that cannot say so
refuses correct work.

This matters more than one requirement. Availability, hit rate, pass rate, conversion, error rate — a large
share of the business answers people actually ask for are quotients of two counts, not aggregates of a
measure. Before this ADR the chain was structurally unable to judge any of them.

## Decision

1. **`derived-ratio` joins the relation vocabulary.** A document declares it when its answer is a ratio of
   two counts the report itself prints, and declares three field roles on the output line: `numerator`,
   `denominator`, `ratio` (in the order the shape prints them).

2. **The judge checks the ARITHMETIC, not the counts.** It takes the tool's OWN two counts and verifies that
   the printed ratio equals them. That is deliberately narrower than `independent-aggregation`: the counts
   themselves are somebody else's claim (additivity, malformed-row-accounting) and re-deriving them here
   would be a second opinion nobody asked for. What this relation adds is the one thing a `mean` cannot
   express — that a derived value is consistent with its own inputs.

3. **Both conventions are accepted, exactly.** A ratio may be printed as a fraction (0–1) or a percentage
   (0–100); both are legitimate and guessing one would refuse correct work. The judge rounds the quotient at
   BOTH scales under the document's declared rounding decision and accepts a match at either. This is not a
   tolerance: an offset that fits neither scale is a failure, which the tests pin.

4. **A non-numeric ratio is not a wrong number.** `n/a`, `-`, or an empty field means the report declined to
   compute a value — a zero denominator, a case the requirement did not settle. It is counted as a line that
   declared no usable ratio, and if NO line declares one the relation FAILS rather than passing on an empty
   set.

5. **A ratio needs a rounding decision, like an aggregate.** `derived-ratio` requires the world (the judge
   recomputes from records) and a `half-up` / `truncate` decision bound to it — the same demand
   `independent-aggregation` makes, for the same reason: a judge that assumed a rounding rule would be
   inventing a requirement.

## What this deliberately does NOT do

- **It does not make the judge able to judge anything.** It adds ONE relation to a closed vocabulary. The
  next family that is not a record-shape (a parser, a state machine, a protocol) still needs its own
  relation, and that work is honest engineering, not configuration.
- **It does not verify the denominator's meaning.** If a document declares `denominator` for something other
  than "the total the ratio is out of", the ratio check will still pass — it only proves the threshold
  arithmetic. That is a real limit and it is named here rather than implied by a green check.
- **It does not weaken `independent-aggregation`.** Aggregates still use it. This is a second, narrower tool
  for a different question.

## Provenance

The shape is borrowed from nothing: it fell out of a measured failure (run `wf-93a3dd4b`, 2026-10-23, 2 of 2
attempts refused by `REL-003` / `DIFF-001` / `DEC-002` / `DEC-003`). The same run is the reason the failure
taxonomy in `scripts/chain-failures.sh` has a `judge-refused` bucket separate from `document`: this was a
real refusal of a real implementation, and the fix was to the VOCABULARY, not to the model and not to the
document.

## Consequences

- Documents whose answer is a quotient can now be judged, where before they were refused after paying for an
  implementation.
- A document that declares `derived-ratio` without a rounding decision is refused at the front door, before
  any spend.
- The vocabulary is now eight relations. `judge-vocabulary.test.ts` keeps the three declarations (validator,
  forge, intake prompt) in agreement; adding this one required all three, and the test is what caught the
  third being forgotten.
