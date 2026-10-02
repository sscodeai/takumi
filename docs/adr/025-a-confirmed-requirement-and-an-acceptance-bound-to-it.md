# ADR-025: A Confirmed Requirement, and an Acceptance Bound to It

- **Date**: 2026-10-01
- **Status**: Accepted (`requirementDigest`/`NO_REQUIREMENT` in `review-digest.ts` and the reviewed
  block; the `acceptance` step type in `workflow.ts` + `workflow-engine.ts`; `parseAcceptVerdict`;
  `takumi requirement digest` and `run --requirement/--confirmed-requirement`; the
  `blackbox-acceptance` workflow extension)
- **Related**: ADR-018 (a review is evidence about ONE set of inputs), ADR-024 (what judges a
  workflow's review — the sibling decision for verdicts), ADR-013 (the deterministic reviewer),
  ADR-017 (mirrors are never a confirmation channel). Ledger #28-#31 (the defects the PoC that
  produced this decision found). Design: `docs/design/blackbox-acceptance-scout.md`, verification:
  `docs/design/blackbox-acceptance-poc1-verification.md`.

## Context

The black-box mode asks for a delivery where a human touches exactly two things: a CONFIRMED
requirement at the start and a behavioural acceptance at the end. Everything between them is the
machine's business. That promise has a load-bearing part that is not about code generation at all:
**the human's confirmation has to be about a document that cannot change under it.**

Two things were missing, and both were invisible while the mode was only a design:

1. **A requirement was not an input anyone could name.** The intake step produced text; nothing
   hashed it, so editing the requirement after a confirmation invalidated nothing — and the review
   digest (ADR-018) did not cover it, which meant a review could be evidence about exactly the right
   code and exactly the wrong requirement.
2. **There was no way to accept an artefact.** The workflow's only gates were a test command
   (`quality_gate`) and reviewers of the change set (`rule_review`, `independent_review`). None of
   them can answer "was the thing that was asked for the thing that was built?", and a passing
   `quality_gate` is satisfied by the implementer's own tests — the party being judged supplying the
   evidence.

Running PoC-1 (the extensions-only workflow) then produced four fail-open defects that would have
made any acceptance decorative: a hard-fail detector that read test NAMES, a parser that read one
test summary block of nineteen, a skip rule that did not propagate (a failed gate let the acceptance
step and the delivery step run), and a CLI that exited 0 on a failed workflow. Those are fixed and
recorded as ledger #28-#31; this ADR is the decision that only makes sense once they are.

## Decision

1. **The requirement document is YAML under `docs/requirements/`, and it is the human's artefact.**
   `requirements[]` carries `REQ-nnn` entries with behavioural descriptions and `acceptance_criteria[]`
   a third party could check without reading the implementation; `ambiguities[]` carries `AMB-nnn`
   entries with a `question`, 2-4 bounded `options`, a `default` and the `chosen` option a human
   decided. Not markdown, not free prose: the format has to be writable by a person and hashable by a
   machine, and "each open decision is a bounded choice" has to be structural rather than a
   convention, because the acceptance harness checks it.
2. **A confirmation is a DIGEST TOKEN.** `takumi requirement digest <ref>` prints `sha256:<hex>` for
   the document's text (`requirementDigest` canonicalises CRLF and trailing whitespace, so a
   different editor is not a different document, while any change of meaning is). The token is what a
   human approves — in a pull request, a review, a chat — and `run --requirement <ref>
   --confirmed-requirement <token>` carries it into the run. Passing one without the other is
   refused, because the point of the token is that the document is COMPARED to what was confirmed
   rather than assumed to be it.
3. **`acceptance` is a first-class step type, and its inputs are required at LOAD.** It takes
   `requirementRef` (the confirmed document) and `acceptanceRef` (the harness). The manifest
   validator refuses either absence: an acceptance that is not bound to a requirement is a machine
   grading its own work, and one with nothing to run has no verdict to give. Refusing at load, with
   the reason, beats discovering it at the end of a long run.
4. **The step refuses, by name, in four ways.** No `requirementRef`/`acceptanceRef` (defence in
   depth); an unreadable document; NO confirmation on record; and a document whose digest is not the
   confirmed digest — that last message carries both digests and the ref, the same "refused by name"
   shape as ADR-018's stale review. A human reading it knows what changed and what to do.
5. **The verdict is a structured marker.** The harness must emit `ACCEPT_VERDICT: pass|fail` (the key
   and value case-insensitive, `=` accepted, decoration around the value tolerated);
   `parseAcceptVerdict` treats a missing, unknown or conflicting marker as an ERROR, which fails the
   step. The harness's prose decides nothing and its exit code is not enough: ADR-024's rule applies
   unchanged, because the party being judged also writes the harness.
6. **Only a passing verdict writes an ACCEPT artifact.** It carries the requirement ref and digest,
   the list of `REQ-nnn` ids the document covers, the delivered head, the harness path, the marker,
   the harness's own `ok`/`not ok` checks verbatim, the confirmed digest, and the rules that
   invalidate it. A failed acceptance writes NO artifact: an artefact named ACCEPT must not exist for
   a run that was not accepted.
7. **The requirement digest is part of the ADR-018 digest.** `ReviewInputs.requirement` holds
   `requirementDigest(document)` or `NO_REQUIREMENT` — a real value, not an absent field, so a
   delivery that later gains a requirement is a CHANGE of inputs and not an absence nobody can
   compare. The digest rides in the `reviewed` state record, so a requirement edited after a review
   or after a human approval makes that evidence stale by name ("the requirement changed"); a record
   written before this change reports that it does not say which requirement it covered, which is
   unknown provenance and not "there was none".
8. **The harness is executed without a shell.** `execFile('bash', [path])` from the project root: a
   manifest path is never re-parsed as a command line, so a path with a space is not an injection
   question.

## Rejected, and honest limits

- **`acceptanceFailClosed?: boolean` (proposed by the design) is NOT implemented.** A boolean whose
  only effect is to switch off the binding between a confirmation and a document is a knob with no
  use case: a caller that wants to re-verify without a human still has to supply the digest, and a
  caller that cannot supply it should not be running an acceptance.
- **The bounded-choice confirmation UI is not in this slice.** The engine's approval callback returns
  a boolean over three hard-coded options, and approval prompts are not interpolated, so the human
  reads the document and approves its token instead. Design change 8 covers the per-question UI.
- **The judge-forge is not in this slice (PoC-3).** Today the harness is a file in the same
  repository, and under the `fake` runtime the agent steps' artifacts are the prompt echoed back: the
  harness's artefact-level checks therefore prove wiring, not intake quality. Nothing here claims
  sandbox isolation — `cwd` is not a permission boundary, and whether a real runtime confines a
  session must be measured before it is asserted.
- **`ACCEPT-nnn` is not added to `extractTraceIds`.** No consumer reads it; an id class with no
  reader is noise. The ACCEPT artifact carries `trace: [REQ-…]` instead, which is the link a reader
  actually follows.

## Consequences

- The human's two touches are now mechanically connected to each other: the acceptance the machine
  runs is bound to the document the human confirmed, and editing that document between the two
  invalidates the acceptance instead of quietly redefining what "done" means.
- A run can no longer accept itself. With no confirmation on record the step fails; the only way to
  a passing acceptance is a document someone approved.
- Adding `requirement` to `ReviewInputs` was a breaking change for every caller of `reviewDigest`; it
  landed in one commit with its callers and tests (ledger rule, and the reason this file exists
  before the workflow uses it).
- What this does NOT buy: stronger verification of the code itself. The third ring — a judge produced
  outside the implementer's context (metamorphic relations first, then differential anchors) — is
  still the open research question, and until it exists the mode is only as honest as the harness.
