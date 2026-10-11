# A failed acceptance repairs the delivery, then re-judges it (design)

Status: agreed with the operator, not yet implemented. Slack: none — the design below is the plan of record.

## What is being added

A black-box run today fails closed the moment the forged judge refuses: the failure is written back into
the requirement document and the run stops, and the next move belongs to a human (re-confirm, run again).
That is the right last resort and the wrong first one. The implementer was allowed to be wrong the first
time — nobody read its design, nobody reviewed its code — so the failure list the judge produced is
exactly the input the next attempt needs. The loop should spend it before it spends a human.

So: **when an acceptance fails, the delivery is repaired against the failing checks and re-judged, up to
a declared number of rounds; only when the rounds are exhausted does the failure go back to the document.**

## Design

A new step type, `repair`, whose body is a **sub-workflow** run repeatedly:

```yaml
# extensions/workflows/request-to-delivery/workflow.yaml  (outer)
steps:
  - id: delivery_attempt
    type: repair
    repairRef: request-to-delivery-attempt   # the sub-workflow, loaded like any other
    maxRounds: 2
    dependsOn: [intake]
  - id: delivery
    type: delivery
    dependsOn: [delivery_attempt]
```

```yaml
# extensions/workflows/request-to-delivery-attempt/workflow.yaml  (inner, today's chain)
steps: implementation → unit_and_integration_tests → quality_gate → rule_review
       → judge_forge → artifact_acceptance
```

The engine runs the sub-workflow, and on a failed run re-runs it with the failure list in the prompt:

1. round 1 … N: `executeWorkflow(sub, ctx, { repairFailures })` — the sub-workflow's own steps run in
   the delivery worktree, so the agent's previous attempt is already there to fix.
2. `vars.repairFailures` carries the judge's `not ok` lines and the `DEC-nnn` lines from the run that
   failed, verbatim. The implementer sees WHAT failed; it never sees the judge's source, the fixtures or
   the expectations (they are outside the worktree and outside its context — that property is the whole
   reason the third ring works).
3. The sub-workflow re-runs **every** step each round — gate, deterministic rule review, judge, gate
   again. A repair round is a delivery like any other: an agent that "fixes" a failing relation by
   weakening the tests is caught by `rule_review` in the same round, not after the fact.
4. The judge is **re-run, not re-forged**: the requirement document has not changed, so the forged judge
   and its digest are still the ones bound to the confirmed document.
5. Feedback write-back is **withheld until the last round**: intermediate rounds must not append an
   `FB-nnn` to the requirement document per attempt (a run that succeeds on round 2 leaves the document
   untouched). Implemented as an explicit context flag the repair step sets for non-final rounds.
6. Exhausted rounds: the last round's failure is written back exactly as today (REJECT artifact +
   `FB-nnn` + the document's digest moves, so the old confirmation is void), the `repair` step fails,
   `delivery` is skipped, the CLI exits non-zero. One failure, one entry.
7. Rounds are visible: each round emits `repair round N of M` on the event stream and its own step
   summaries are surfaced under the `repair` step, so a human reading the run sees the attempts, not
   just the end state.

## Refusals (validated at load, before anything runs)

- `repairRef` that does not exist, or whose workflow declares no `acceptance` step: refused — a repair
  loop with nothing to judge it is a loop that cannot know when to stop.
- `maxRounds` below 1 or above 5: refused. A repair budget is a number a human chose, and an unbounded
  one is an unattended agent spending money until it feels done.
- a `repair` step in a workflow that declares no confirmed requirement while the sub-workflow names
  `{requirement}`: refused by the existing ADR-031 guard, at the outer level.

## Tests

- fake runtime: round 1 fails the judge, round 2 passes → the `repair` step completes, `delivery` runs,
  and the requirement document has **no** new feedback entry.
- fake runtime: every round fails → the step fails, `delivery` is skipped, and the document carries
  **exactly one** new `FB-nnn`; the accepted-after-repair case is the pair that pins both halves.
- a repair round whose change weakens a test fails `rule_review` in that round (the deterministic rules
  are not skipped because it is "just a fix").
- `maxRounds: 0` and `maxRounds: 6` are refused at load; a missing `repairRef` is refused at load.

## Honest limitations

- Each round costs a full agent run plus a gate, a review and a judge — the cheap direction only if the
  first attempt is usually close.
- The repaired delivery is the one that is accepted; there is no "which attempt was better" comparison,
  and no memory across rounds other than the worktree itself.
- If the failure is in the DOCUMENT (a decision that cannot be honoured, a contract no implementation
  satisfies) the rounds are wasted, and the last one still lands in the document as a failure — which is
  right, but the run will have spent the full budget getting there.
- Nothing here re-visits intake. Repair changes the implementation, never the requirement.
