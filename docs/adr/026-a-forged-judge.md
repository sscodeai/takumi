# ADR-026: A Forged Judge (the criteria come from the requirement, and the judge is produced outside the implementer's context)

- **Date**: 2026-10-01
- **Status**: Accepted (`judge_forge` step type + `parseAcceptVerdict`'s sibling machinery in
  `workflow-engine.ts`; `{judgePath}` binding in the acceptance step; `ctx.worktree` and the
  `--worktree` flag; `extensions/judges/metamorphic-forge.sh`; the `blackbox-acceptance` workflow
  forges and then accepts with the forged judge; `examples/blackbox-poc/`)
- **Related**: ADR-025 (the confirmed requirement and the acceptance bound to it), ADR-018 (a review
  is evidence about one set of inputs), ADR-013 (the deterministic reviewer, and the vacuous green it
  exists to prevent), ADR-024 (a verdict is a field, not a reading of prose), ADR-020 (the gate-fire
  bench). Ledger #32 (a fixture path that stopped a delivery) and #33 (a judge handed an unresolved
  worktree). Design: `docs/design/blackbox-acceptance-scout.md` §4; verification:
  `docs/design/blackbox-acceptance-poc1-verification.md` §9.

## Context

PoC-2 gave the mode an acceptance step bound to a confirmed requirement. Its harness, though, was a
hand-written script inside the same repository as the implementation:

- the implementer's own tests were the only thing a passing `quality_gate` proved (ADR-013's whole
  subject), and
- an acceptance whose judge is a file the implementer can read is an acceptance the implementer can
  fit.

The design's answer was a *judge forge*: produce the judge for a run from the requirement, outside
the implementer's context, and let it judge invariants rather than outputs. That is the third ring of
the mode — the human gives the criteria, the machine implements, an independent mechanism verifies —
and without it the mode is only as honest as the harness.

## Decision

1. **The judge is a deterministic function of the CONFIRMED document.** `judge_forge` (the ninth step
   type) takes a `requirementRef` and a `forgeRef` (both required at load) and runs the generator in a
   run-scoped judge directory, `<project>/.takumi/acceptance/<stepId>/`. The generator receives the
   requirement's ref and digest, the worktree path and the project root — and never the
   implementation. What is frozen BEFORE the implementation is the confirmed document (its digest is
   the human's token) together with the `deliverable` contract inside it; the judge is produced lazily
   so that it is out of the implementer's context.
2. **The judge lives outside the implementation worktree, and the acceptance may only use it.** The
   judge directory is recreated on every run, so a judge from an earlier run can never be reused as
   this run's evidence. The acceptance step resolves `{judgePath}`, REFUSES any other harness when the
   run forged a judge, refuses a reference that did not resolve, and runs the judge from the judge's
   own directory with `TAKUMI_WORKTREE`/`TAKUMI_PROJECT` in the environment; the ACCEPT artifact
   records the judge path, the judge's own digest, the cwd it ran in and the worktree.
3. **The judge path never reaches the implementer through the manifest.** Validation refuses, at LOAD
   time, any step other than the forge and the acceptance whose prompt references `{judge…}`: an agent
   that can name the judge can fit it, and the judge is written after those steps have run, so nothing
   else would notice.
4. **The judge judges INVARIANTS, from fixtures it generates itself.** Relations (row-order
   invariance, additivity, duplicate resolution, malformed-row accounting) plus an independently
   computed differential anchor — compared against the fixture, not against the tool's own arithmetic.
   The criteria it cannot mechanise are printed as `# not mechanised:` diagnostics, NEVER as `ok`: an
   unmechanised criterion reported as a pass is the vacuous green ADR-013 exists to prevent.
5. **A relation the forge cannot implement is a REFUSAL, not a skipped check.** The generator's
   vocabulary is bounded and explicit; a relation id outside it fails the forge step, so a manifest
   cannot buy a judge with a gap nobody notices.
6. **No judge, no acceptance.** A missing marker, a missing `JUDGE_PATH`, a path outside the judge
   directory, a path inside the implementation worktree, an unreadable judge, a non-zero exit, or a
   judge whose verdict marker is missing all fail the step — and the acceptance behind it is SKIPPED,
   so an unverifiable delivery produces no ACCEPT artifact and the CLI exits non-zero.

## Honest limits

- **The separation is structural, not (by itself) a security boundary.** The engine proves the judge is
  written after the implementation, is not in the implementer's prompt, and lives outside the named
  worktree. For an UNCONFINED run it does NOT stop an agent with filesystem access from reading
  `<project>/.takumi/acceptance/…` by guessing the path, and the run's `worktree` is a path property,
  not a permission. As of **ADR-058** a confined run does have a boundary: a `judge_forge`/`acceptance`
  step and a confined delivery agent's tools run inside an unprivileged mount-policy boundary, so
  `<project>/.takumi/acceptance/<runId>` and the platform repository are not reachable from inside. The
  exception is the delivery agent's model egress, which ADR-058 states as a named limitation rather
  than claiming a closed boundary.
- **The forge parses the requirement document line-wise.** That is honest for our own format and
  fails closed on what it cannot read, but a general forge needs a parser.
- **The behavioural strength is the relation vocabulary.** Four relations and one anchor caught the
  demonstration defect; they do not cover the requirement's prose criteria (performance, the optional
  output-file argument, the duplicate count), which the judge reports as not mechanised. That list is
  the honest measure of what an acceptance does not cover.
- **With the `fake` runtime the deliverable had to be placed by hand** in the worktree for the
  PoC-3 demonstration: the agent steps echo their prompts, so the demonstration proves the JUDGE's
  behaviour (it catches a real defect its target's own tests pass), not an agent's. Wiring a real
  runtime into this loop is the next slice.

## Consequences

- The demonstrable property of the mode is now: with the reference deliverable in place the run
  completes and writes ACCEPT-001; with the same deliverable carrying one behavioural defect the
  implementer's OWN tests still pass (`quality_gate PASSED: 0 failing over 2 tests`) while the forged
  judge fails the additivity relation, no ACCEPT artifact is written, delivery is skipped and the CLI
  exits 1. That difference — the gate green, the judge red — is the entire argument for the third ring.
- `rule_review` (ADR-024) remains the deterministic gate over the change set, so a run can be stopped
  by its own diff before the judge is even forged; in the PoC-3 runs it did exactly that on the
  fixture path in ledger #32.
- The forge is a file in this repository, so a future slice can swap the vocabulary (or a
  cross-family model generating relations) without touching the engine: the seam is
  `forgeRef` + the `deliverable` contract.
