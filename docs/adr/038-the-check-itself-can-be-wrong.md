# ADR-038: The Check Itself Can Be the Thing That Is Wrong

- **Date**: 2026-10-06
- **Status**: Accepted. Amends ADR-030 (its "two repairs" framing is no longer the whole story; the
  ADR-030 text is left as written, because history is not rewritten). Implemented in
  `packages/core/src/requirement-feedback.ts` (the `resolvedKind` field),
  `packages/core/src/feedback-brief.ts` (the three repairs, the named closure kind),
  `apps/cli/src/requirement-command.ts` (the third bounded choice, the required note, `resolve --kind`);
  tests in `packages/core/src/test/{requirement-feedback,feedback-brief}.test.ts` and
  `apps/cli/src/test/requirement-feedback.test.ts`
- **Related**: ADR-030 (answering a failure), ADR-029 (the failure comes back), ADR-028 (a decision is
  only real if it is checked), ADR-026 (the forged judge), ADR-034 (a refused delivery is repaired
  before it is returned), ADR-020 (the gate fire bench)

## Context

ADR-030 fixed a real defect: "the failure is addressed" recorded that somebody said so, and a failure
has more than one repair, so the record could not be reviewed later. It said, in its own words:

> a failure has two different repairs, and they are not interchangeable: the implementation ignored the
> answer the human recorded, or the answer itself was wrong and the requirement has to change. A record
> that cannot tell them apart cannot be reviewed later, and the human re-decides blind.

and it stated the machine's honest limit exactly:

> It cannot decide whether the implementation or the answer is wrong — that needs semantics it does not
> have.

So ADR-030 turned the human's number into a choice about **which side is wrong**, and offered, for a
failure whose checks exercise a decision:

```
[1] the recorded answer stands and the IMPLEMENTATION changes — mark it resolved
[2] the answer was wrong — decide that decision again below
[3] leave it open                                            ← [enter] (the default)
```

**Both of those repairs blame a party who is not at fault when the check is.** `[1]` blames the
implementer ("you ignored the answer"); `[2]` blames the human ("your earlier answer was wrong"). There
is a third possibility, and it is not exotic: the quality gate or the forged judge could not read what
the deliverer produced and refused a delivery that was in fact complete. ADR-030 could not express it,
and a record that names the wrong cause is worse than a record that names none.

### Run i12, the run that proved the gap

The first live end-to-end run against a NON-EMPTY repository (run **i12**) had a **COMPLETE delivery
refused twice by the quality gate**, with the message `quality gate FAILED (0 failing)` — a message
that says the tests failed while they had not. The implementer wrote its tests with the Python standard
library (`run-tests.sh` runs `python3 -m unittest discover -s tests -p 'test_*.py' -v`), and the gate's
reader recognised TAP, Jest, pytest, Maven, Gradle and CTRF — but not `unittest -v`. It parsed no
report at all, failed closed (correct: an unreadable report is not a green one), and reported the
absence as `0 failing`. The full record is the ledger entry **#45** in `docs/bugs-fixed.md`, where both
faults are repaired: (a) an unreadable report now says so and no longer contains `0 failing`, and
(b) `unittest` is recognised, matched before pytest because pytest's matcher is the loosest in the file
and demonstrably stole a unittest run on the pre-fix build.

i12 happened not to write a `feedback:` entry — the write-back needs an **acceptance** failure, not a
gate failure inside a repair round — so no wrong record was created that time. The next verifier-side
failure may not be so lucky, and this ADR is about that next time.

## Decision

1. **A third bounded choice, worded to deny the other two claims.** For an open failure whose checks
   exercise a decision, the confirmation now offers four options:

   ```
   [1] the recorded answer stands and the IMPLEMENTATION changes — mark it resolved
   [2] the answer was wrong — decide that decision again below
   [3] the CHECK was at fault — the implementation and the recorded answer were right — mark it resolved
   [4] leave it open                                            ← [enter] (the default)
   ```

   `[3]` names the third cause explicitly and denies both of the others in the same sentence, so the
   claim a human is making is unmistakable at the moment they make it. The preamble is amended to match:
   *"Either the implementation ignored that answer, or the answer itself was wrong, or the check that
   failed is itself at fault."*

2. **The closure kind is an explicit field, not a sentence to be re-parsed.** A `feedback:` entry gains
   `resolvedKind`, one of `implementation-changes`, `answer-wrong`, `check-at-fault` — and `addressed`
   for the legacy no-decision path (ADR-029), which is now named rather than implied. The value is read
   back by `parseFeedback` as a field; nothing anywhere re-parses the note to learn what was claimed.
   The three decision-mapped closures record their own kind:

   | choice | `resolvedKind` | re-asks a decision? | `resolvedByDecision` |
   | --- | --- | --- | --- |
   | `[1]` the implementation changes | `implementation-changes` | no | — |
   | `[2]` the answer was wrong | `answer-wrong` | **yes** (and the answer must change) | `AMB-nnn` |
   | `[3]` the check was at fault | `check-at-fault` | **no** — the decisions were right | — |

   `resolvedBy`, `resolvedAt` and `resolvedNote` are recorded with it, exactly as before.

3. **The new closure must NOT re-ask a decision.** `[3]` claims the decisions were right, so it does not
   touch the `mustChange` map — the mechanism that puts a decision back to the human and refuses an
   unchanged answer. The decision is still put once in the ordinary round-1 sweep like every other
   decision (ADR-036); it is not put *because of the failure*, and keeping its recorded answer is
   accepted. `[2]` keeps its current behaviour unchanged, re-ask included.

4. **The note is required, and it is where the BASIS is stated.** `[3]` blames the verifier, so the
   human must say why: the confirmation asks for the note and refuses an empty one, and
   `resolveFeedback` refuses an empty note for **every** kind, so the new closure is not a way to wave a
   failure through. The resolution without a note is refused exactly as it always was; no existing
   refusal is weakened.

5. **The three closures are distinguishable afterwards.** The document records the kind as a field; the
   human-facing brief renders `Resolved by <who> [<kind>]: <note>`; `takumi requirement feedback` prints
   `[<kind>]` on a resolved entry; and the brief states the three repairs, naming the check-at-fault one
   as *a CLAIM by a human, with the basis stated in the resolution note*. A later reader can tell "the
   implementation was at fault" from "the answer was wrong" from "the check was at fault", and by whom.

6. **The scriptable path may name the kind too.** `takumi requirement resolve <ref> --id FB-nnn --note
   "…" [--kind check-at-fault]` records the kind when given; an unknown `--kind` is refused by name.
   Omitted, it records no kind (the legacy behaviour is unchanged).

## Evidence, from real invocations

Driving the real confirm path (the built CLI, a TTY-shaped input stream) against a document whose open
`FB-001` traces to `AMB-001`, choosing `[3]` and stating the basis:

```
  The last acceptance of this document FAILED and wrote FB-001 back into it (2026-10-01T03:00:00.000Z):
    REL-003 duplicate-resolution: the chosen option does not hold

    This failure is about AMB-001, currently answered "The row with the latest start_date wins".
    Either the implementation ignored that answer, or the answer itself was wrong, or the check that failed is itself at fault.

    FB-001: what settles this failure?
      [1] the recorded answer stands and the IMPLEMENTATION changes — mark it resolved
      [2] the answer was wrong — decide that decision again below
      [3] the CHECK was at fault — the implementation and the recorded answer were right — mark it resolved
      [4] leave it open   (recommended)

    FB-001: what did the failing check get wrong?
      Say what the check got wrong. A note is required: it is the basis for the claim, not decoration.
      > the quality gate could not read the deliverer test output (stdlib unittest -v) and refused a complete delivery

  round 1 of at most 3 — 1 decision(s) still open
    Which row wins when employee_id repeats?
      >                                       ← [enter] keeps "The row with the latest start_date wins"

  Confirmed decisions — a checklist a reviewer reads, not the machine (1/1 decided):
    [x] AMB-001: The row with the latest start_date wins
  sha256:e4e4850bc9ba8577f64f736ba42b23563dcfe54004108d0abfadc9cc51f1c1ca     EXIT=0
```

The document gained a resolution whose kind is a field, not a sentence, and whose note carries the
human's basis:

```yaml
    status: resolved
    resolvedAt: "2026-10-06T03:57:17.954Z"
    resolvedBy: "hermes"
    resolvedNote: "the check itself was at fault: the quality gate could not read the deliverer test output (stdlib unittest -v) and refused a complete delivery — a human's claim at re-confirmation, not a machine verdict (2026-10-06T03:57:17.954Z)"
    resolvedKind: "check-at-fault"
```

`AMB-001` is untouched (still "The row with the latest start_date wins"), there is no
`resolvedByDecision`, and no `mustChange` refusal fired: the decision was not re-asked. The brief and
the feedback view name the claim:

```
$ takumi requirement brief feature.yaml
**Answering a failure is a choice between three different repairs, and only a human can make it:**
- the recorded answer stands and the IMPLEMENTATION changes; or
- the answer was wrong and the DECISION changes — the alternatives are listed, and the
  confirmation will ask for one of them; or
- the CHECK itself was at fault — the implementation and the recorded answer were both right,
  and the failing check is what has to be repaired. This one is a CLAIM by a human, with the
  basis stated in the resolution note: it is not a machine verdict, and closing a failure this
  way repairs nothing — the next acceptance still runs the same check.
…
### FB-001 — RESOLVED (run wf-2)
Resolved by hermes [check-at-fault]: the check itself was at fault: …

$ takumi requirement feedback feature.yaml
    resolved by hermes at 2026-10-06T03:57:17.954Z [check-at-fault]: the check itself was at fault: …
```

## What this does and does not license

- **It records a CLAIM, not a machine verdict.** The machine cannot tell whether the check was at fault
  any more than ADR-030 could tell whether the implementation or the answer was; it records that a human
  said so, with a stated basis, and who and when. The kind is the claim's name; the note is its basis.
- **The check is not repaired by it.** Closing a failure as `check-at-fault` changes the requirement
  document and nothing else: the failing check still runs, unchanged, at the next acceptance. If it was
  genuinely at fault, it will fail again — which is the intended signal, not a loophole. Repairing the
  gate is a separate act with its own evidence (for i12, ledger #45 and its tests).
- **It does not weaken any refusal.** A resolution without a note is still refused, for this kind too;
  the coherence gate, the open-failure gate, the `[2]` re-ask and its "nothing changed" refusal, and the
  `resolve` refusals (unknown id, already resolved, empty note) are all unchanged.
- **It does not let a real failure through.** "The check was at fault" is a claim a reviewer can read
  and disagree with; the record now says who claimed it and on what basis, which is more than the old
  undifferentiated "addressed" said.
- **It does not re-open or re-decide anything.** `[3]` asserts the decisions were right, so it changes
  no decision and does not mark one for change.

## Rejected, and honest limits

- **Nothing verifies that the check really was at fault.** This is ADR-030's own limit ("Nothing
  verifies that the human's choice was right") applied to the third choice: the confirmation checks that
  a note exists, not that it is true. The next acceptance is the check on the claim.
- **The basis is prose and is not machine-read.** The kind is machine-readable; the basis is for a human
  reviewer. Parsing the note to decide whether the claim was justified would be exactly the guesswork
  ADR-030 rejected.
- **The kind is only as honest as the human.** A record that can distinguish the three causes is still
  only as good as the person who picks one; what it removes is the excuse that there was no way to say
  it.
- **`addressed` remains for the no-decision path.** A failure that traces to no decision still has one
  undifferentiated closure, now labelled `addressed` rather than implied. Distinguishing
  implementation-at-fault from check-at-fault for a check with no decision behind it is a plausible
  next step and deliberately not this one.
- **No history is rewritten.** ADR-030 is left as written; its two-repair framing is superseded by this
  ADR, not edited out of it.

## Consequences

- The acceptance-failure loop can now record the cause that actually happens: a verifier-side refusal of
  a complete delivery. Run i12's failure has a place to be written down, should a later run meet it at
  the acceptance boundary rather than inside a repair round.
- Every resolution is machine-readable by kind, so "the implementation was at fault" and "the check was
  at fault" are no longer the same record with different prose.
- The `[2]` path is untouched: the answer-wrong closure still re-asks and still refuses an unchanged
  answer, so the new choice adds a possibility without moving an existing one.
