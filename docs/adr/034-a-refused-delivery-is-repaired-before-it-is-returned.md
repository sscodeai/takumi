# ADR-034: a refused delivery is repaired before it is returned

Status: accepted (implemented; tests in `packages/core/src/test/repair-rounds.test.ts`)
Related: ADR-025 (acceptance bound to the confirmed document), ADR-026 (the judge is forged outside the
implementer's context), ADR-029 (the failure comes back), ADR-030 (which side was wrong), ADR-033 (the
document declares its own world)

## Context

The first delivery that reached an acceptance on a real runtime was refused, and the refusal did what
ADR-029 promised: `REJECT-001` was written, the failure went back into the requirement document, the old
confirmation was structurally invalidated, `delivery` was skipped and the CLI exited 1. Correct, and — as
a first response — wrong.

The implementer chose the language, the stack and the structure, and nobody read its design or its code.
Being refused once is not a defect in that arrangement; it is the arrangement working. The refusal also
carries exactly the information a second attempt needs: which checks failed, in the judge's own words.
Returning to the human before spending that sentence is spending a person on work the loop can do.

## Decision

A workflow may declare a `repair` step:

```yaml
- id: delivery_attempt
  type: repair
  repairRef: request-to-delivery-attempt   # the chain that produces evidence
  maxRounds: 2                             # 1..5, refused otherwise at load
```

1. **The sub-workflow is the delivery attempt.** `request-to-delivery` is now a `repair` step over
   `request-to-delivery-attempt` (implementation → tests → quality gate → rule review → judge forge →
   acceptance) followed by `delivery`. The attempt chain is what it always was; only who runs it changed.
2. **The next attempt is told what failed, and nothing else.** `{repairFailures}` carries the judge's
   `not ok` lines (and the decisions they touch) verbatim. The fixtures, the expectations and the judge's
   source do not travel: an implementer that could read them could fit them (ADR-026).
3. **Every round re-runs the whole chain.** Gate, deterministic rule review, forge (re-run; the document
   has not changed) and acceptance. A repair is a delivery like any other, so an agent that "fixes" a
   failing relation by weakening the test that covers it is refused by `rule_review` in that same round
   instead of being accepted as a repair.
4. **Exactly one failure comes out of a run.** The context flag `withholdAcceptanceFeedback` is set for
   every round that will be retried, and the acceptance step honours it: a repaired run leaves the human's
   requirement document byte-identical, and a run that spends every attempt writes one `FB-nnn`.
5. **The rounds are visible.** Each attempt emits `attempt N of M` / `repair round N of M` on the event
   stream, its acceptance summary is recorded in the step's own summary, and the sub-run's artifacts and
   tests are surfaced on the step so `delivery` still packages the evidence that was actually produced.

Refusals, at load (before anything runs) and at run time:

- a `repair` with no `repairRef`, or with `maxRounds` outside 1..5: refused at load — a repair budget is a
  number a human chose, and an unbounded one is an unattended agent spending money until it feels done;
- a sub-workflow that does not exist, or that declares no `acceptance` step: the step fails closed with
  the reason — a repair loop with nothing to judge it cannot know when to stop;
- no workflow loader on the run: fails closed, saying so, rather than silently not attempting.

## Consequences

- The two halves of the black-box claim are now the same act: the loop spends its own attempts, and the
  human is asked only when the loop has run out. "Give the criteria, don't read the code" survives a first
  refusal that used to end the run.
- Cost: a refusal now costs up to `maxRounds` full attempts (agent + gate + review + judge). The cheap
  direction only if the first attempt is usually close — which is why the budget is 2 in the shipped
  workflow and capped at 5 by the manifest.
- The repaired delivery is the one that is accepted; there is no comparison of attempts, and the only
  memory across rounds is the worktree itself.
- A failure caused by the DOCUMENT (a decision no implementation can honour, a contract that is not
  satisfiable) still spends the whole budget before it comes back — which is right, but it is paid for.
- Nothing in this loop re-visits intake. Repair changes the implementation, never the requirement.
- **A defect this feature found in itself before it shipped**: the withheld write-back left `appended`
  undefined, which the following `if (appended === undefined)` branch then reported as
  `feedback: COULD NOT be recorded … (unknown error)` — a repair round describing a failure that never
  happened. The branch now yields to the withheld message. Caught by the test that asserts a repaired run
  leaves the document untouched, not by reading the code.

## Evidence

`packages/core/src/test/repair-rounds.test.ts` (4 tests, real harness script whose verdict flips when the
implementation is fixed):

- a refused delivery is repaired: attempt 1 refused with `not ok 1 - REL-001 additivity …`, attempt 2
  accepted, `delivery accepted on attempt 2 of 2`, `delivery` completes, and the requirement document is
  **byte-identical** to before the run; the first attempt's prompt contains no failure (a failure that has
  not happened yet must not be described), the second contains the judge's exact failing line.
- a delivery that spends every attempt: step failed, `delivery` skipped, document carries **exactly one**
  `FB-nnn` with `status: open`.
- a sub-workflow with no acceptance, and a manifest with a missing `repairRef` or `maxRounds` 0/6/1.5:
  refused with the reason.
