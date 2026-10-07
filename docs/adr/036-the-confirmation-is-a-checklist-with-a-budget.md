# ADR-036: the confirmation is a checklist with a budget

Status: accepted (implemented; `packages/cli` requirement-confirm/feedback tests, 15 in the feedback file)
Related: ADR-027 (a bounded-choice confirmation), ADR-029 (a failure comes back), ADR-030 (answering a
failure), ADR-031 (a decision says what it means to a judge)

## Context

The confirmation was a single pass: every decision asked once, in order, and the human's answers written
into the document. Two things were wrong with it, and both were visible the moment the flow met a real
document.

First, **it asked the questions in an order that hid the interesting ones**. A document whose answers raise
a further question had no way to be asked again; the human answered what was on the screen and the document
was confirmed, open questions and all. GitHub's spec-kit — the family of "spec first" skills this operator
pointed at — solves this with `[NEEDS CLARIFICATION]` markers, a hard limit of three, and a `/clarify` step
that asks at most five questions **one at a time**, recommends an answer with its reasoning, and stops as
soon as the ambiguity clears. The mechanism that matters is not the marker syntax; it is that a human can be
asked again without the document being re-opened from scratch.

Second, **the summary was a list of facts, not a checklist**. It printed the answers, and nothing said which
of them a reviewer should look at. Spec-kit's `checklists/requirements.md` is explicitly "unit tests for the
spec": a reviewer-facing document where `[x]` means *the reviewer* judged the criterion satisfied — and the
command is forbidden from ticking it itself. That ownership rule is the same idea as `checkedAs` and the
confirmation digest: a document may not certify itself.

## Decision

The confirmation is now a **rounds loop over a checklist**:

1. **Round 1 asks every decision.** A human confirming a document gets to see every answer, including the
   ones the intake defaulted. Nothing is silently inherited.
2. **Later rounds re-ask only what is still open.** A decision written as answered is not asked again; one
   the human marked "the answer was wrong" (ADR-030) is asked again exactly once. The loop stops as soon as
   nothing is open, and at most **3 rounds**: a document whose answers keep raising questions is a document
   to rewrite, not to confirm.
3. **`done` stops the questions early** — and the summary then names what was left open, so the same
   information reaches the confirmation line as would have reached it by answering everything.
   `done` is refused where it would be a lie: an **open acceptance failure** is not a clarification, so that
   question must be answered (a token over a document with an open failure is the one thing the loop refuses
   to produce).
4. **The recommendation is printed with the question**, and `[enter]`/`yes` takes it. A default is an
   argument, not an absence: a human who presses enter is accepting the intake's reasoning, so the reasoning
   has to be on screen.
5. **The budget is enforced where the questions are made.** A document may carry at most **5 decisions**
   (`MAX_OPEN_DECISIONS`); more is refused by the validator before any human sees it, because an intake that
   asks more than five questions has not decided what it is about.
6. **The closing summary is a reviewer checklist**: `[x] AMB-001: <answer>` / `[ ] AMB-002: left undecided`,
   with the undecided count stated before the token. The token is unchanged in meaning — the digest of the
   written document — but what it covers is now visible as a list a person can read.

## Consequences

- The human's answers and the machine's questions live in the same place, and the same round that asks a
  question records its answer in the document textually (comments survive).
- Asking every decision in round 1 makes the confirmation longer for a document with many defaults; the
  answers are all one keystroke (`enter`), and the round number is printed so the cost is visible up front.
- The budget is a document-level rule, not a per-run one: it bounds how much a single delivery may be
  uncertain about, which is what makes "confirmed" mean something.
- What is still missing against spec-kit's version: nested question generation (an answer proposing the next
  question), and a per-decision reviewer-owned checklist separate from the answers. Both would be additions
  to this mechanism, not replacements.

## Evidence

`apps/cli/src/test/requirement-confirm.test.ts` and `apps/cli/src/test/requirement-feedback.test.ts`
(15 tests in the latter): a decision with no default is asked in a printed round with the options listed; the
recommendation is named; `done` stops the questions, the checklist marks `[x]`/`[ ]` and the undecided count
is stated while the token is still produced; answering "the answer was wrong" re-asks exactly that decision
once; a failure left open still refuses.

The budget is covered in `packages/core/src/test/feedback-brief.test.ts`: six decisions is refused with
`carries 6 decisions, over the budget of 5`.

Real-machine demonstration (a copy of `docs/requirements/intake.yaml`, five decisions, scripted answer
stream): `round 1 of at most 3 — 5 decision(s) still open`, each question followed by
`recommended: <the default>` and the `[enter] take the recommendation … [done] stop asking` line, then

```
Confirmed decisions — a checklist a reviewer reads, not the machine (5/5 decided):
  [x] AMB-001: skip-count: …
  [x] AMB-002: first-row: …
  …
sha256:8384aa73d3c970361491d24c4f9e42e6704cc4a9a95e191ec361cd92cd8edf8d
```
