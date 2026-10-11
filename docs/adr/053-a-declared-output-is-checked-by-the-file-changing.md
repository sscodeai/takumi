# ADR-053: A Declared Output Is Checked By The File Changing, Not By The File Existing

- **Date**: 2026-10-11
- **Status**: Accepted. Implemented in `packages/core/src/workflow-engine.ts` (the `produces` check on an
  agent step), `packages/core/src/workflow.ts` (the field and its load-time refusal),
  `extensions/workflows/request-intake/workflow.yaml` and `runtimes/pi/src/index.ts` (a truncated turn is
  a failure). Tests in `packages/core/src/test/produced-output.test.ts` and
  `runtimes/pi/src/test/adapter.test.ts`.
- **Related**: ADR-013 (the vacuous green), ADR-025 (the confirmation token), ADR-048 (a declaration
  that is never executed reads as compliance), ADR-052 (a per-run directory), docs/bugs-fixed.md #64

## Context

On 2026-10-11 17:56Z the FRONT of the chain was driven on a real machine for the first time: one sentence
in, a structured requirement document out, nobody at the keyboard (`request-intake`, run `wf-5beb034f`).

It reported success in 74 seconds:

```
  workflow[req_intake]: attempt 1/1
  workflow[intake_shape]: quality gate PASSED (0 failing)
  workflow[ambiguity_confirmation]: approval required
  [auto] ambiguity_confirmation approved (non-interactive)
✓ workflow "request-intake" completed
```

The agent had produced **nothing**. Three measurements, each independent:

- `docs/requirements/intake.yaml` — the document the shape gate read and reported as
  `ok 1 - the intake wrote docs/requirements/intake.yaml` (11553 bytes, digest
  `sha256:429164787fa9db54…`) — was a file **committed six hours earlier** (`7ee6d1e`, ADR-045), mtime
  `2026-10-11 21:02:51 +0900` against a run that started at `17:56:33Z`. It was even about the same
  subject (station temperatures), because the earlier request had been similar — so the gate's output
  read as plausible to anyone glancing at it.
- The step's own artifact was 34 bytes: `agent turn finished`.
- The pi transcript for the run holds five events, one of them the assistant's:
  `stopReason: "length"`, usage `output: 8192, reasoning: 8192`, content types `["thinking"]`. The model
  (`deepseek/deepseek-v4-flash`, `maxTokens: 8192` in `~/.pi/agent/models.json`) spent its ENTIRE output
  budget on reasoning and never emitted an answer. No text, no tool calls, no document.

So a run that produced nothing was **indistinguishable from a run that produced the document**. The shape
gate checks the document's SHAPE and never its PROVENANCE; the engine accepts any agent turn that ends as
a completed step; and the adapter turned a truncated turn into the reassuring phrase "agent turn
finished". Every check downstream then reads whatever happens to be on disk — and the approval step that
follows would have had a human confirm a document that predates their own request.

## Decision

**A step that declares what it produces is held to it.** `produces: [path, …]` on an agent step:

1. The engine snapshots each declared path BEFORE the step runs (mtime, and absence) and, when the step
   reports success, checks that the file CHANGED during the step. A file that was already there is not
   this step's output. The refusal names the path and the fact:
   `the step declares it produces docs/requirements/intake.yaml and that was not written during this step:
   a file that was already there is not this step's output, so the step produced nothing (a run that
   produces nothing must not be graded on what it found)`.
   The step FAILS (and a `retry` would retry it) — the run cannot be read as green.
2. Only an AGENT step may declare outputs. Any other step type declaring `produces` is refused BY NAME at
   load, because the check is implemented where an agent step's result is read: elsewhere the declaration
   would be a check nobody runs — the defect class of ADR-048 and #54. Paths are refused if absolute, if
   they escape the project (`..`), or if the list is empty.
3. `request-intake`'s `req_intake` declares `docs/requirements/intake.yaml`, so an intake whose agent
   writes nothing fails AT THE STEP that was supposed to write it, instead of leaving the shape gate to
   grade a file it did not produce.

**A truncated turn is a failure, not a finished turn.** The pi adapter records each assistant message's
`stopReason`; when a turn ends with no captured assistant text AND `stopReason === 'length'`, it emits
`task.failed` (and reports the task's status as failed) with the reason and the fix:
`the turn hit the model's output limit before answering (stopReason "length"): the model spent its whole
output budget on reasoning and produced no answer… Raise the model's output limit (maxTokens) or use a
model that answers within it`. A turn that stops normally, or one whose stop reason is unreported, is left
alone — silence is only a failure when the evidence says it was truncation.

## Consequences

- The failure is now at the right place and in the right words: a run whose agent produces nothing stops
  at `req_intake` with the path named. The 74-second green is not reproducible without a real document.
- The rule is general: any workflow can declare what an agent step must write, and the check is the same
  one. It is deliberately NOT a general "every agent step must write something" rule — an agent step that
  only edits existing files legitimately produces no new path, and a rule that cannot tell those apart
  would be a rule that cries wolf.
- The measured model limit is NOT fixed by this ADR. `maxTokens: 8192` for a reasoning-heavy model on a
  document-writing prompt means the turn can spend the whole budget thinking: the runtime now fails
  honestly and names the reason, and the fix is configuration (`maxTokens`) or another model — a choice
  for the operator, not a silent change by the engine.

## What this does NOT fix (named rather than worked around)

- **The shape gate still checks shape, not provenance.** `intake-shape-tap.sh` grades whatever file is at
  the path. The binding to this run now lives one step earlier, in the step's own `produces` declaration —
  so a workflow that forgets to declare its output is not covered by anything.
- **The two policies on a non-interactive confirmation still disagree.** The `approval` step auto-approves
  when stdin is not a TTY (documented in the CLI as deliberate for pipelines and CI), while
  `requirement confirm` refuses a non-interactive confirmation outright (ADR-025/045). The binding
  mechanism is the confirmation TOKEN, not this checkpoint — but the checkpoint is vacuous in exactly the
  environment where nobody is watching, and that remains a stated disagreement rather than a resolved one.
- **The artifact store root is still one per project** (`acceptance/ACCEPT-001.md` is overwritten by a
  second run), the open item ADR-052 names.
- Still unmodelled, as before: no sandbox, no process supervision, assertions limited to status codes and
  substrings, TLS/auth/egress unmodelled, a deliverable that calls `setsid` escapes the process-group
  teardown, and hard-coded ports give up isolation.
