# ADR-027: The Confirmation Is a Bounded Choice, Recorded in the Document

- **Date**: 2026-10-01
- **Status**: Accepted (`takumi requirement confirm` / `--dry-run` in
  `apps/cli/src/requirement-command.ts`; the `confirmation:` block and the `chosen:` writes in the
  requirement document; tests in `apps/cli/src/test/requirement-confirm.test.ts`)
- **Related**: ADR-025 (the confirmed requirement and the acceptance bound to it), ADR-026 (the forged
  judge, whose DOC-001 check refuses a document with an undecided decision), ADR-018 (a name is not an
  identity). Design: `docs/design/blackbox-acceptance-scout.md` Change 8.

## Context

The mode's promise is that a human touches exactly two things: a confirmed requirement at the start
and an acceptance at the end. PoC-2 and PoC-3 built the second one. The first one was still a
ceremony: a human read a document and then copied a digest token out of `takumi requirement digest`.

Two things made that the weakest link rather than a detail:

1. **The ask was never a form.** The original request was explicit about the shape — "the human only
   confirms: by CHECKING boxes and TYPING NUMBERS". A document plus a token is neither: it leaves the
   decisions the intake found open to be answered by editing a file, which is exactly the free-form
   work the mode is supposed to remove.
2. **Any confirmation built on the workflow's approval step auto-approves in a pipeline.** The CLI's
   `interactiveApprove` returns true when stdin is not a TTY (`apps/cli/src/commands.ts:28-33`) and the
   engine defaults to true when no callback is supplied (`packages/core/src/workflow-engine.ts:396`),
   so a requirement confirmation wired through the approval step would be a rubber stamp in CI. The
   design's rule 2 says a requirement confirmation must refuse to run without an explicit human
   decision; only a command that is not an approval can guarantee that.

## Decision

1. **Every open decision is put as a numbered, bounded choice, one question at a time.**
   `takumi requirement confirm <ref>` walks the document's `AMB-nnn` entries: the question, then the
   2-4 options with the current (or default) choice marked, then a prompt accepting a NUMBER, `[enter]`
   to keep the current choice, `[s]` to leave a non-blocking decision undecided, `[q]` to abort. An
   answer that is not one of the options is named and the question is put again — it is never guessed.
2. **The answer is written into the DOCUMENT, and the document's digest is the token.**
   `chosen: "<option>"` goes into the decision's own block, and a `confirmation:` block
   (`by`, `at`, `method: bounded-choice`) is appended. The document is therefore the single place that
   records what was decided, its digest is the token ADR-025's acceptance binds to, and editing a
   decision after a run invalidates that acceptance by name — the property PoC-2 demonstrated.
3. **The writes are textual, and validated before they land.** The requirement document is a
   hand-written, commented artefact; re-serialising the YAML would delete every comment in it. So the
   `chosen:` line is replaced in place (or inserted into its own block) with its indentation preserved,
   the `confirmation:` block is appended once and replaced after that, and the result is parsed before
   it is written: a document that would become invalid YAML is a refusal, and nothing is written.
4. **It refuses in all four ways that matter.** A NON-INTERACTIVE invocation (stdin is not a TTY) is
   refused with the CI alternative, because a confirmation nobody read is not a confirmation. A
   BLOCKING decision left undecided refuses and writes nothing — and prints no token. `[q]` exits 2
   with nothing written. A document with no `AMB-nnn` entries refuses and points at `takumi requirement
   digest <ref>` instead of pretending there was something to confirm.
5. **`--dry-run` is the read-only, CI-readable form.** It lists each decision, its state, and the
   options; it exits non-zero while a blocking decision has neither a default nor a choice, and it
   never writes and never prints a token. This is what a pipeline may do — the human's part stays a
   terminal.
6. **The confirmation record names the operator, and that name is not an identity.** `by` is the
   repository's `git config user.name` (falling back to `$USER`). ADR-018's rule applies: a label says
   somebody approved, not who. What binds is the token.

## Rejected, and honest limits

- **No choices on the workflow's `approval` step.** The scout's Change 8 proposed extending
  `ApprovalRequest.options` and returning a chosen option from the approval callback. That would create
  a SECOND place where the human decides, with a different lifetime from the document: the document is
  what the acceptance hashes, so a decision recorded only in an approval callback would be a decision
  the acceptance does not cover. The approval step stays "approve this digest", and the forged judge's
  DOC-001 check already refuses a document whose decisions are unrecorded. If a future workflow needs
  in-run questions, the honest shape is a step that WRITES BACK into the requirement document and
  re-emits a token — not a parallel answer path.
- **The judge does not check that the chosen options MATCH the implementation.** DOC-001 checks that
  every decision is recorded; the relations (ADR-026) check invariants. Nothing yet derives a check
  from a `chosen` value — so a document that chose "first row wins" and an implementation that keeps
  the last row would pass on the relations the document declares. The judge's vocabulary is the
  measure of what an acceptance covers, and this is a real gap in it.
- **No multi-language rendering.** The questions are shown as they are written in the document. The
  intake skill is English (repository policy); the `jp-*` skills are a separate flow. A Chinese or
  Japanese requirement document would render as written and be judged the same way — nothing in this
  command is language-specific, and nothing verifies the language either.

## Consequences

- The human's confirmation action is now the shape the request asked for: numbers and a keyboard
  return, one bounded question at a time, with the decision recorded where the acceptance can see it.
- The token a run needs and the document a human edited cannot diverge silently: the token is a
  function of the text that the command just wrote, and `takumi requirement digest` recomputes it for
  anyone who wants to check.
- `--dry-run` gives CI a way to fail on an undecided requirement without ever approving one.
