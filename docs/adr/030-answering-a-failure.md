# ADR-030: Answering a Failure Is a Choice Between Two Repairs

- **Date**: 2026-10-01
- **Status**: Accepted (`packages/core/src/requirement-decisions.ts`,
  `packages/core/src/feedback-brief.ts`; `takumi requirement brief`; the two-sided failure question and
  the coherence gate in `takumi requirement confirm`; `fromFeedback:` in the document and its refusals
  in the forge; the intake's re-pass, `extensions/skills/req-intake/prompts/revise.md`; tests in
  `packages/core/src/test/feedback-brief.test.ts`, `apps/cli/src/test/requirement-feedback.test.ts`,
  `packages/core/src/test/judge-forge-decisions.test.ts`)
- **Related**: ADR-029 (the failure comes back), ADR-028 (a decision is only real if it is checked),
  ADR-027 (the bounded-choice confirmation), ADR-026 (the forged judge)

## Context

ADR-029 closed the loop mechanically: a failed acceptance writes itself back into the requirement
document, the write invalidates the confirmation token, and the next confirmation has to answer the
failure before it can produce a token. Two things were left wanting, and they are the same thing seen
from two sides:

1. **"Resolved" had no content.** The human's bounded choice was "the failure is addressed". The
   document recorded that somebody said so — but a failure has two different repairs, and they are not
   interchangeable: the implementation ignored the answer the human recorded, or the answer itself was
   wrong and the requirement has to change. A record that cannot tell them apart cannot be reviewed
   later, and the human re-decides blind: nothing told them which decision the failing check belonged
   to.
2. **The intake never saw the failure.** The requirement-side intelligence is the one place that may
   propose decisions, and the loop never reached it. After a rejection, the human had to remember which
   checks failed and work out for themselves which decision was implicated — the clerical step that the
   mode exists to remove, and the step where a wrong answer is expensive.

The machine's honest capability here is narrow and worth stating exactly: it can trace a failing check
to the decision that check EXERCISES (the document's own `decides:` bindings, ADR-028), name the answer
recorded for that decision, and offer that decision's OWN alternative options. It cannot decide whether
the implementation or the answer is wrong — that needs semantics it does not have — and it must not
invent a decision where the requirement simply left nothing undecided.

## Decision

1. **A failing check is traced to its decision, deterministically.**
   `packages/core/src/requirement-decisions.ts` parses the document's decisions and its `decides:`
   bindings, and derives the `DEC-nnn` numbering the forge derives (one per exercised decision, in
   document order). `packages/core/src/feedback-brief.ts` then maps each failing check to that decision,
   the answer recorded for it, and the alternatives — the decision's own options minus the recorded
   answer. This is the ONE parser for decisions and bindings: `takumi requirement confirm` uses it too,
   so the CLI, the brief and the tests cannot drift into three opinions about the same file.
2. **A check with no decision behind it is reported as such.** The brief distinguishes
   `decision-not-honoured` (traced, with alternatives) from `no-decision` (a declared check that
   exercises no decision — "the failure is about the implementation, or about a piece of the
   requirement no decision covers") and `undeclared-check` (a line the document cannot account for, or a
   `DEC-nnn` its decisions and bindings do not add up to). No decision is invented to fill the gap, and
   the reason is printed rather than implied.
3. **The brief is the intake's input, and it says what only a human may decide.**
   `takumi requirement brief <ref>` prints a read-only, marked brief
   (`## Acceptance feedback (written back by the machine)`) that states the two repairs, traces each
   failing check, and names what the intake may and may not do. It contains nothing generative: it is
   analysis of the document's own text.
4. **The confirmation asks the question the failure implies.** For an open failure whose checks exercise
   a decision, the bounded choice is:

   ```
   [1] the recorded answer stands and the IMPLEMENTATION changes — mark it resolved
   [2] the answer was wrong — decide that decision again below
   [3] leave it open                                            ← [enter] (the default)
   ```

   Choosing `[2]` and then leaving that decision's answer exactly as it was is REFUSED —
   *"you answered that the answer was wrong, but AMB-002 still reads … — nothing changed"* — because the
   claim has to have content. Choosing `[2]` and actually answering differently records the resolution
   with `resolvedByDecision: AMB-nnn`, so the document says which decision answered the failure. An
   answer is a claim about the document, and the document is right there to check it against.
5. **A decision may cite the failure it came from.** `AMB-nnn` gains an optional `fromFeedback: FB-nnn`.
   A citation that names a failure the document does not record is refused twice: by
   `takumi requirement confirm` (and `--dry-run`, so CI sees it) BEFORE a human is asked anything, and
   by the forged judge at acceptance time from its own line-wise parse. Defence in depth, deliberately
   duplicated the same way `requirementRef` is validated at both ends.
6. **The intake's re-pass is a contract, not a hope.** `prompts/revise.md` (registered in the skill's
   manifest, described in its `SKILL.md`) tells the intake: keep every existing requirement, decision and
   `feedback:` entry; add a decision ONLY for a failure no decision covers; cite it with
   `fromFeedback: FB-nnn`; bind it to a check (`decides:`) because a blocking decision nothing checks is
   refused at acceptance; and if the answer needed is outside the forge's mechanisable vocabulary, SAY
   SO in the requirement text instead of pretending it is checked.
7. **The document's coherence is checked before anything else happens.** `validateRequirementDocument`
   refuses a decision citing a failure the document does not record, and a check claiming to settle a
   decision that is not there. `takumi requirement confirm` refuses such a document outright, in the
   interactive path and in `--dry-run`.

## Evidence, from real invocations

The brief, on the real repository document with a real written-back rejection:

```
$ takumi requirement brief docs/requirements/poc-blackbox-acceptance.yaml
## Acceptance feedback (written back by the machine)

The document docs/requirements/poc-blackbox-acceptance.yaml carries 1 acceptance failure(s), 1 open.
…
### FB-002 — OPEN (run wf-…)
Judged at requirement digest `…` by judge `sha256:c6194d0e7cd8…`.
- **REL-002** — REL-002 additivity: department totals sum to 428 but the report says 214 — sum=428 reported=214
  - REL-002 is a declared check, and it exercises no decision: the failure is about the implementation …
- **REL-003** — REL-003 duplicate-resolution: the chosen option "latest-start-date" does not hold …
  - decision: AMB-002 (blocking) — Which row wins when employee_id repeats?
  - recorded answer: The row with the latest start_date wins
  - the implementation did not honour it. Either the implementation changes, or the answer does:
    - First row wins
    - Last row wins
    - Treat it as an error
```

and the confirmation, from the same document, with the choice recorded and the empty claim refused —
both verbatim in §13 of the verification document, together with the narrative loop it enables: the
failure, the human answering "the answer was wrong", the decision re-decided, the implementation
changed to match, and the acceptance passing on the new answer.

## Rejected, and honest limits

- **No generated content in the brief.** The machine does not propose the CONTENT of a new decision's
  options. It cannot: inventing the alternatives for an undecided point needs the semantics of the
  request, which is exactly the work the intake (and the human confirming it) does. The brief states the
  gap and stops.
- **The trace is only as good as the `decides:` binding.** A "decoration binding" — a check claiming a
  decision it does not really exercise — makes the brief trace the failure to the wrong answer. ADR-028
  records the same limit; it is not fixed here, and it is the reason the trace is printed with its
  evidence (the check text) rather than summarised.
- **The alternatives are the decision's own options.** If the right answer is not among them, neither
  the brief nor the bounded-choice UI can offer it: the intake has to widen the options, and the forge
  has to be able to test them. The forge's vocabulary remains the bottleneck for what a decision may
  say.
- **Nothing verifies that the human's choice was right.** Saying "the implementation changes" and
  changing nothing is caught by the next acceptance, not by the confirmation; saying "the answer was
  wrong" is only checked for having changed the document.
- **The intake's compliance is not verified here.** The re-pass is a contract (prompt + manifest +
  skill) whose output is a document — and a document is checked (coherence, bounded options, the judge's
  refusals) rather than trusted. What is NOT verified is that the intake's *judgement* about whether a
  failure needed a new decision was right; that is the human's confirmation, and later the judge.
- The brief is a snapshot: it is analysis of the document as it is when it runs, with no memory of
  earlier briefs.

## Consequences

- A failure now produces an account of WHICH decision is implicated, so the human's answer ("the
  implementation changes" / "the answer was wrong") is a decision about something specific rather than a
  shrug, and the record says which decision answered a failure.
- The requirement-side intelligence gets the failure as input for the first time, with a contract that
  keeps it honest: cite the failure, bind the check, do not pretend an unmechanisable answer is checked.
- One parser for decisions and bindings means the CLI, the brief, the tests and (by agreement on the
  shape) the shell forge cannot disagree — and a disagreement is a refusal, not a silent mismatch.
