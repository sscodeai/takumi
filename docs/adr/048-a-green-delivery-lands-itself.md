# ADR-048: A Green Delivery Lands Itself

- **Date**: 2026-10-11
- **Status**: Accepted. The decision is recorded here and pinned by a REFUSAL in
  `packages/core/src/workflow.ts` (`APPROVAL_FIELDS`, refused by name inside `validateWorkflowManifest`).
  Tests in `packages/core/src/test/green-lands-itself.test.ts`. The landing itself is unchanged and is
  already asserted in `packages/core/src/test/merge-step.test.ts` ('the accepted head is merged…',
  'when await_checks fails, the merge step is SKIPPED').
- **Related**: ADR-013 (the vacuous green), ADR-034 (a bounded repair budget), ADR-037 (a pending
  pipeline fails the run closed), ADR-038 (the check itself can be wrong), ADR-040 (a merge lands the
  reviewed head), ADR-045 (a standing authorization), ADR-046 (a service-shaped delivery is bounded and
  asserted), docs/bugs-fixed.md #54 (a declaration that is never executed reads as compliance)

## Context

The operator was asked which checks a machine may close without a person, and answered: **when all the
checks are green, merge**. That answer is not a new mechanism. It is the mechanism the chain already
has, and the honest thing is to say so rather than to build a second one beside it:

- `request-to-delivery/workflow.yaml` declares `merge` with `dependsOn: [await_checks]`. A red or
  still-pending host pipeline fails `await_checks` (ADR-037) and the landing is then SKIPPED
  STRUCTURALLY — the engine's dependency skip, asserted in `merge-step.test.ts`, with
  `provider.mergeCalls.length === 0` on a red pipeline.
- `merge` lands exactly the head the acceptance judged and the pull request `publish` opened, both read
  from the run and neither a field of the step (ADR-040). A moved head is refused before the host is
  called.
- The live evidence is the run of 2026-10-11 07:50: `await_checks` 4 of 4 on the published head, then
  `merge`, then the base branch moved — with no person in the loop.

So the run's own two gates are: the forged judge ACCEPTS the delivery (`artifact_acceptance` inside
`request-to-delivery-attempt`), and the HOST's pipeline goes green on the published head. Neither is a
person, and neither was ever meant to be.

What was missing was not the behaviour but the READABILITY of the decision. Nothing refused a step that
declares a field reading as a human gate: a manifest could declare `merge` with
`requiresApproval: true` and the field would be ignored in silence — the landing would happen anyway,
while a reader of the manifest believed a person stood in front of it. That is the same defect class as
`deliverable.build` / `deliverable.tests` (docs/bugs-fixed.md #54): a declaration that is never executed
reads as compliance, which is worse than a refusal. Measured, not assumed: the validator returned
`issues: []` for exactly that manifest (see the RED evidence below).

## Decision

1. **A green delivery lands itself.** The gate that unlocks a landing is `await_checks` on the host's
   own pipeline, and a red or pending one skips the merge structurally. There is no approval step in the
   chain, and none is to be added: a green gate is what lands a change.
2. **The decision is pinned by a refusal, not by documentation.** A workflow step that declares a key
   reading as a gate a person must pass (`requiresApproval`, `requiresHuman`, `requireReview`,
   `approval`, `approvalLabel`, `approvedBy`, `human`, `awaitingHuman`) is REFUSED BY NAME at load by
   `validateWorkflowManifest`, with a message that says the field is read by NOTHING and names where the
   gate actually lives. An unknown-key silence would have been the bug.
3. **The one place a human gate may be declared is configuration, not a step.** The pilot's
   `reviewMode: 'label'` is a board-driven wait (recorded as `awaiting_review`, not a defect, and it
   consumes no repair round). That is a policy the operator selects, not a field smuggled into a
   manifest.
4. **The counterpart is NOT relaxed.** A FAILED check still stops the run and asks a person: a judge
   that refuses the delivery, a red pipeline, or an exhausted repair budget (ADR-034) ends the run
   blocked. A machine never closes its own failing check — `answer-wrong` and `check-at-fault` stay a
   human's to declare (ADR-045, ADR-038). "Green lands itself" is a statement about the GREEN path, not
   a licence for a machine to grade its own work.

## Consequences

- The self-driving path is honest about where its gates are: a reader of `request-to-delivery/
  workflow.yaml` sees `dependsOn: [await_checks]` and finds no approval field, because there is none to
  find — and a manifest that adds one fails at load with the reason.
- **A green gate is not a correct requirement.** The judge checks the relations the DOCUMENT declares
  (ADR-033); if the document asked for the wrong thing, green is the wrong thing, correctly delivered.
  Nothing here models that, and nothing here claims to.
- **The failure path still needs a person.** That is deliberate and stays: an unattended system that can
  close its own failing check is one that can call a broken delivery done.
- **What is still unmodelled for unattended running**: a per-run judge directory (the forge writes to a
  fixed `.takumi/acceptance/<stepId>/`, so two concurrent runs on one project share it); a
  line-oriented report contract (a service that prints its report as one compact JSON line is read as
  one object — see ADR-047); no sandbox; no process supervision (TERM then KILL, no restart); assertions
  limited to a status code and a substring; TLS, auth and egress not modelled.

## Evidence (RED then GREEN)

- RED, before the refusal: `node --test packages/core/dist/test/green-lands-itself.test.js` →
  `# pass 2 / # fail 2`, with `error: 'the step is refused, not ignored (issues: [])'` and
  `error: '"requiresHuman" is refused by name (issues: [])'` — the validator silently accepted a merge
  step declaring an approval gate.
- GREEN, after `APPROVAL_FIELDS`: the same file → `# pass 4 / # fail 0`; the full `@takumi/core` suite →
  **530 tests, 527 pass, 0 fail, 3 skipped**.
