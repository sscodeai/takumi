# 060 — An unattended delivery must be REVIEWABLE, not merely finished

## The moment this changes

Takumi's whole proposition is that a person can accept an agent's work without reading every line,
because the judge and the gates stand in for that reading. The chain has now delivered end to end
unattended — repeatedly, including to a fresh repository — and every one of those deliveries answered
decisions **nobody read**: the standing authorization took the document's own `default:` for each open
decision (ADR-045), and listed them in the document's `defaulted:` front matter so a reviewer *could*
check them afterwards.

In practice nobody does. The morning after an unattended run, the operator holds:

- a merged pull request, whose behaviour is partly the machine's guess,
- a `defaulted:` list naming the decisions that were guessed,
- and **no path from one to the other.**

Finding out which lines implement `AMB-002` means re-reading the document, re-reading the diff, and
reconstructing the decision in your head. That cost is paid on every delivery, and it is why a run that
"completed successfully overnight" still needs someone to sit with it in the morning. A delivery nobody
can review cheaply is not autonomous — it is deferred work.

## Decision

1. **Every machine-answered decision must be findable in the delivery itself.** The implementer writes
   `docs/decisions.md`: one row per `AMB-nnn`, the question in one line, the answer, and `file:line`
   anchors for where it is honoured. Where a decision genuinely has no code behind it (a document
   choice, an ordering convention), the row says so rather than inventing an anchor.

2. **Every decision carries a greppable marker in the source.** One line above the code that enacts it:
   `// AMB-001 (skip-count): a malformed row is excluded and counted`. The property that matters is
   `grep -rn 'AMB-002' .` **lands** on the decision — one command from "the machine chose this" to
   "here is what it changes".

3. **The rule is needed, so it is enforced.** `decision-anchor` (severity `block`) fires once per
   decision that is missing from `docs/decisions.md` or missing its marker. The review reads the
   confirmed document for its ids; a document that cannot be read supplies none, and the rule stays
   silent rather than guessing.

4. **The rule checks LOCATABILITY, not correctness.** It does not try to verify that an anchor points at
   the right line: a comment can lie, and a gate that passes because it was satisfied rather than
   because it was true is the defect this repository has recorded repeatedly (ledger #87's family). What
   it buys is that the reviewer's search is O(1) instead of O(the run).

## Why `block` and not `human`

`human` would mean "a person must decide", which **stops an unattended run** — the opposite of the
intent. The fix here is entirely mechanical and entirely the agent's: add a table row, add a one-line
comment. Handing that to a person is asking them to do the typing, which is the work this ADR exists to
remove. `human` is for changes that are real and legitimate and that an agent must never be told to
revert (a dependency bump, a CI tweak); a missing anchor is neither.

## What this deliberately does NOT do

- **It does not remove the human from the loop.** It makes the human's loop cheap. The approval, the
  merge decision on a failure, and the adjudication of `answer-wrong` / `check-at-fault` all stay human
  (ADR-045 §2).
- **It does not let a run resolve a genuine disagreement by guessing.** A decision the document does not
  carry a `default:` for still refuses: a machine has no argument to make (ADR-036). What this ADR adds
  is that a decision it *did* answer leaves a trail a reviewer can follow.
- **It does not bound how much is deferred.** `MAX_OPEN_DECISIONS` (5) still applies, and it is the
  right bound: a document that leaves more than five things open has not decided what it is about.
  Anchors make deferral *visible*; they do not make unlimited deferral safe.

## Consequences

- A delivery now fails its review when a decision is unfindable, in the same round, as the agent's own
  work — before anything is published.
- The cost is one table and a handful of one-line comments per delivery, paid by the implementer, which
  is the cheapest place to pay it.
- The traceability matrix gains a second kind of "covered": a decision is covered by a check (ADR-028)
  AND by its implementation being locatable. Those are different claims and both are now recorded.
