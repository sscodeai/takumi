# ADR-029: The Failure Comes Back Into the Document It Failed

- **Date**: 2026-10-01
- **Status**: Accepted (`packages/core/src/requirement-feedback.ts`; the rejection path of the
  `acceptance` branch in `packages/core/src/workflow-engine.ts`; `takumi requirement feedback` /
  `resolve` and the open-failure gate in `takumi requirement confirm`; tests in
  `packages/core/src/test/{requirement-feedback,acceptance-feedback}.test.ts` and
  `apps/cli/src/test/requirement-feedback.test.ts`)
- **Related**: ADR-025 (the confirmed requirement and the acceptance bound to it), ADR-026 (the forged
  judge), ADR-027 (the bounded-choice confirmation), ADR-028 (a decision is only real if it is
  checked), ADR-018 (a name is not an identity)

## Context

ADR-028 closed the implementation end of the loop: a decision the human recorded is now an input to
the judge rather than a comment above it. The failure end was still open, and it was the last piece of
manual clerical work in a mode whose whole claim is that the human touches only two things.

When an acceptance failed, three things were true:

1. **The failure existed only in a terminal scroll.** No artifact recorded what was judged, by which
   judge, at which digest, or which checks failed. A rejection nobody can cite is a rejection that
   cannot be argued with later.
2. **The requirement document did not learn anything.** The human had to notice the red output, work
   out which decisions it implicated, edit `docs/requirements/*.yaml` by hand, re-run `takumi
   requirement digest`, and pass the new token to the next run. Every one of those steps is the kind
   of work the mode says it removes — and the one that is easiest to skip is the interesting one.
3. **Nothing forced the loop to close.** A failed run left the confirmation token valid, so the next
   run could be made against the same approval as if the failure had not happened.

## Decision

1. **A rejection the judge produced writes a REJECT artifact.**
   `REJECT-nnn.md` (kind `acceptance-reject`, numbered per run in step order) records the requirement
   ref and digest, the digest the document has *after* the write-back, the head, the worktree, the
   harness, the judge and its digest, the verdict marker, every check with its result, the failing
   checks on their own, and the judge's own output (first 1200 characters). The pair
   `digest` / `digestAfterFeedback` is the record of the ratchet.
2. **It appends a `feedback:` entry to the requirement document itself.**
   `id: FB-nnn`, `at`, `run`, `requirementDigest` (the digest that was judged), `judgeDigest`,
   `status: open`, and the failing checks verbatim. The write is TEXTUAL — the document is
   hand-written and commented, and re-serialising the YAML would delete the comments — numbered after
   any existing entries, validated as YAML before it lands, and idempotent per (run, requirement
   digest) so a retry of the same run does not record the same failure twice.
3. **The write-back is what invalidates the confirmation.** The document's digest is the token a run
   binds to (ADR-025), so a document that has learned something new no longer hashes to the token the
   failed run was given, and the next run is refused by name (`is not the one that was confirmed`).
   The loop closes structurally: nobody has to remember to invalidate anything.
4. **Only a rejection the JUDGE PRODUCED is written back.** A refusal — a stale confirmation, no
   forged judge, an unreadable document, a harness with no `ACCEPT_VERDICT` marker — writes neither an
   artifact nor feedback: the acceptance could not be made, and editing the human's document because of
   a run-configuration mistake is not a loop, it is noise. When the judge ran and produced no failing
   check, the failure summary says exactly that (`reject: not recorded — no failing check came out of a
   judge that ran`).
5. **The human's number is what closes a failure.** `takumi requirement confirm` puts every open entry
   to the human as its own bounded choice before it asks about any decision:

   ```
   The last acceptance of this document FAILED and wrote FB-001 back into it (…):
     DEC-002 AMB-002 NOT honoured: "First row wins" (checked by REL-003, which failed)
     FB-001: what addresses this failure?
       [1] the failure is addressed — mark it resolved
       [2] leave it open   (current)
   ```

   Choosing `leave it open` (which is also what `[enter]` keeps) REFUSES the confirmation: nothing is
   written and no token is printed. Choosing `addressed` resolves the entry, records who said so and a
   note that it was answered at re-confirmation by bounded choice, and the token printed at the end
   covers both writes — the resolution and the decisions. A document carrying a known failure cannot be
   re-confirmed around it.
6. **The failure is visible without a terminal scroll.** `takumi requirement feedback <ref>` lists the
   entries with their status, the run, the digests and the failing checks, and exits non-zero while any
   entry is open. `takumi requirement resolve <ref> --id FB-001 --note "…"` records a resolution and a
   reason (refusals: an unknown id, an already-resolved entry, an empty note — an unrecorded resolution
   is the thing this exists to prevent) and prints the token the document now hashes to.
   `confirm --dry-run` reports open failures and exits non-zero, so CI can gate on an unanswered
   failure without ever approving anything.

## Evidence, from real invocations

The flip run of ADR-028 (the same implementation, the document's answer changed to "First row wins")
now ends like this instead of printing a red line and stopping:

```
$ … run … --confirmed-requirement sha256:8644a79ff4…      # the broken reference deliverable
  step judge_forge: completed — judge forged: …/judge.sh sha256:c6194d0e7cd8 (outside …/worktree)
  step artifact_acceptance: failed — acceptance FAILED: the harness reported a failing verdict
    not ok 2 - REL-002 additivity: department totals sum to 428 but the report says 214 — sum=428 reported=214
    not ok 3 - REL-003 duplicate-resolution: the chosen option "latest-start-date" does not hold
      (headcount 4 want 4, late-date total 269 want 537, early-date total 214 want 428)
    not ok 8 - DEC-002 AMB-002 NOT honoured: "The row with the latest start_date wins"
      (checked by REL-003, which failed)
  rejection: REJECT-001 written (acceptance/REJECT-001.md)
  feedback: FB-001 written into docs/requirements/poc-blackbox-acceptance.yaml (open) — the document now
    hashes to cc157afd540c, so its confirmation no longer matches it and the next run needs a re-confirmation
  failing checks: REL-002, REL-003, DEC-002
  step delivery: skipped — skipped (dependency failed: artifact_acceptance)
✓ workflow "blackbox-acceptance" failed                         EXIT=1

$ … run … --confirmed-requirement sha256:8644a79ff4…      # the SAME token, one entry later
  step artifact_acceptance: failed — the requirement document "…/poc-blackbox-acceptance.yaml" is not the
    one that was confirmed (confirmed 8644a79ff49b at "…/poc-blackbox-acceptance.yaml", the document now
    hashes to cc157afd540c): re-confirm the edited document before it can be accepted
  step delivery: skipped — skipped (dependency failed: artifact_acceptance)     EXIT=1
```

The document gained:

```yaml
feedback:
  - id: FB-001
    at: "2026-10-01T05:05:57.188Z"
    run: "wf-7767a958"
    requirementDigest: "8644a79ff49b72efd234de70e5cbdb1ab450abc481664d3d5c52102b3c95580c"
    judgeDigest: "sha256:c6194d0e7cd8047aaa849aad50e7075cb7e95c7e65cfaeb7abad3310fa49c347"
    status: open
    checks:
      - "REL-002 additivity: department totals sum to 428 but the report says 214 — sum=428 reported=214"
      - "REL-003 duplicate-resolution: the chosen option \"latest-start-date\" does not hold (…)"
      - "DEC-002 AMB-002 NOT honoured: \"The row with the latest start_date wins\" (checked by REL-003, which failed)"
```

`takumi requirement confirm` then opens with that failure and refuses while it is left open (`[enter]`
keeps the current state, which is the safe answer):

```
  The last acceptance of this document FAILED and wrote FB-001 back into it (2026-10-01T05:05:57.188Z):
    FB-001: what addresses this failure?
      [1] the failure is addressed — mark it resolved
      [2] leave it open   (current)
      >                                       ← [enter]
  refused: FB-001 is still open. A document with a known failure in it is not confirmable
```

and answering `[1]` resolves the entry in the same act as the decisions, producing the token
`sha256:966dae0656c65597bfa2e22dd440ab57477b89ffcffa0b474f8b0b5194100971`, with which the corrected
deliverable is accepted: `acceptance PASSED`, nine checks, `delivery bundle ready (7 artifacts)`, `EXIT=0`.

## Rejected, and honest limits

- **Not a command the human has to remember to run.** The write-back happens in the run, because the
  loop's closure would otherwise depend on exactly the clerical care the mode removes. The command form
  exists for the human's side of it (`feedback`, `resolve`), not for the machine's.
- **Not auto-editing the DECISIONS.** The engine records which checks failed; it does not propose a new
  `AMB-nnn` or answer an existing one. What to change is the human's call, and a machine-written
  decision would be a decision nobody made. An intake that reads open feedback and proposes decisions
  is a plausible next step, and deliberately not this one.
- **Nothing verifies that the implementation changed.** A resolved entry is a human statement that the
  failure is addressed, not proof of it; the judge will fail again if it was not addressed. The note is
  where that statement is recorded, which is why `resolve` refuses an empty one.
- **The feedback block is not archived.** It lives in the same document as the decisions and grows with
  each failure; there is no rotation, and no cap. A document with many resolved entries is readable but
  not tidy.
- **One entry per failed run, not per failing check.** Three failing checks produce one entry with
  three checks. The entry is the run's failure, not the check's.
- **Two runs against the same document can interleave writes** (last writer wins). The engine reads,
  appends and writes without a lock. Out of scope for a single-operator repository; recorded here
  because it is a real limit rather than a theoretical one.
- The rejection artifact's copy of the judge's output is capped at 1200 characters, like the step
  summary it mirrors.

## Consequences

- A failed run leaves the repository in a state that forces the loop: the document changed, the old
  token is refused, and the human's next confirmation has to answer the failure. There is no path where
  a rejection is ignored and a stale approval is reused.
- The failure is citable (`REJECT-nnn`) and legible from the human's side (`takumi requirement
  feedback`), which is what makes the two touchpoints — a confirmation and an acceptance — enough.
- The intake's job gets one new input: a document brought back for re-confirmation may carry open
  feedback, which is the machine's account of what went wrong.
