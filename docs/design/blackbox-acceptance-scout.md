# Black-box acceptance: a scouting design

- **Date**: 2026-10-01
- **Author**: scout pass (read-only)
- **Baseline**: `dev` @ `e20620a`; `pnpm install && pnpm build && pnpm test` = 606 tests,
  603 passing, 3 skipped, 0 failing, `pnpm typecheck` clean (`docs/acceptance-report.md:9`).
- **Read-only contract**: nothing under `packages/`, `apps/`, `boards/`, `deliveries/`,
  `reviewers/`, `reporters/`, `runtimes/`, `extensions/`, `eval/` or any test was modified.
  This document is the only file written.
- **Target**: a delivery mode in which natural-language requirements become a structured,
  human-confirmed requirement document; the AI picks language, architecture and stack; the human
  sees neither design nor code; the human touches exactly two things — confirming the
  requirements (including each open ambiguity, as a bounded choice) and accepting the delivered
  artifact by behaviour. Feedback returns to the requirement document and the cycle repeats.
- **Method**: every claim about existing code below cites a file and line that was read on this
  tree. Where something cannot be determined from the repository, it says **not determined**.

---

## 1. Current state map

### 1.1 The workflow step vocabulary and step validation

- `WORKFLOW_STEP_TYPES` is a closed union of seven types: `agent`, `approval`, `tool`,
  `quality_gate`, `independent_review`, `rule_review`, `delivery`
  (`packages/core/src/workflow.ts:17-25`). `StepType` is derived from it
  (`packages/core/src/workflow.ts:27`), so the union is the single source of truth.
- `isWorkflowStepType` is a membership test over that array
  (`packages/core/src/workflow.ts:30-32`).
- `validateWorkflowManifest` refuses an unknown step type with the allowed list in the message
  (`packages/core/src/workflow.ts:99-103`), and refuses a `rule_review` whose `baseRef` is
  missing or blank (`packages/core/src/workflow.ts:104-106`).
- `WorkflowDefinition` declares `requiredSkills` and `requiredTools`
  (`packages/core/src/workflow.ts:121` and `:123`), but nothing on this tree validates them:
  a grep for those fields outside `workflow.ts` returns no reader. Declaring a required skill
  that is absent is currently silent.
- The engine's comment claims "dispatch is exhaustive over `WORKFLOW_STEP_TYPES`"
  (`packages/core/src/workflow.ts:81-83`). Read against the engine, that claim is too strong:
  the engine falls through to the generic `agent` path for any unrecognised type
  (`packages/core/src/workflow-engine.ts:266` onwards; the last explicit branch is `delivery` at
  `:704`). The manifest validator at load time is the only thing that keeps the union honest.
- The CLI loads a workflow from `<cwd>/<registry.workflows>/<name>/workflow.yaml|json`
  (`apps/cli/src/commands.ts:223-231`), then calls `validateWorkflowManifest` and throws with the
  issues joined into one message (`apps/cli/src/commands.ts:238-247`).

### 1.2 How a step is executed

- `executeWorkflow` (`packages/core/src/workflow-engine.ts:266`) validates runtime capabilities
  before anything runs (`:267-274`), topologically orders steps (`:276`), then walks them in one
  serial loop.
- Each branch is a hand-written `if` on `step.type`: `approval` (`:384`), `tool` (`:413`),
  `quality_gate` (`:448`), `rule_review` (`:503`), `independent_review` (`:645`), `delivery`
  (`:704`); anything else runs as an `agent` step with retry (`:730` onwards).
- Step prompts are resolved through `resolveStepPrompt`
  (`packages/core/src/workflow-engine.ts:199`): a `step.skill` plus `ctx.skillsRoot` loads
  `<skillsRoot>/<skill>/prompts/<action>.md` via the skill manifest, `{placeholders}` are
  substituted, and any missing skill/action/template falls back to `step.prompt`
  (`:199-235`). `inputVars` arrives from the CLI as `{ input: opts.prompt }`
  (`apps/cli/src/commands.ts:340`), which is why workflow YAML uses `{input}`.
- Completed agent output is persisted as an artifact with `kind`, `fileName`, `content`,
  `contentType` and `trace` (`packages/core/src/workflow-engine.ts:793-802`;
  `ArtifactStore.write` signature at `packages/core/src/artifact-store.ts:32-40`).
- Trace ids are scraped from step text with `extractTraceIds`, whose alternation is
  `REQ|UT|IT|DESIGN|EVIDENCE` (`packages/core/src/workflow-engine.ts:162-168`). `ACCEPT-*` is
  not in that alternation today.

### 1.3 The approval interaction and its options

- `ApprovalRequest` carries `id`, `workflowRunId`, `taskId`, `stepId`, `prompt`,
  `options: ('approve' | 'reject' | 'view')[]`, `createdAt`
  (`packages/core/src/types.ts:159-169`). `ApprovalDecision` is `'approved' | 'rejected'`
  (`packages/core/src/types.ts:171`).
- The engine hard-codes exactly three options when it constructs the request
  (`packages/core/src/workflow-engine.ts:393`), then awaits `ctx.onApproval`; with no callback it
  approves by default (`:396`). A rejection sets the run to `cancelled` and returns immediately
  (`:397-403`).
- The CLI implementation is a boolean prompt: `[a] approve`, `[r] reject`, `[v] view`
  (`apps/cli/src/commands.ts:36-53`). Non-TTY stdin auto-approves and still records the decision
  (`apps/cli/src/commands.ts:28-33`).
- Consequence for the target mode: an approval today is a **boolean about a step**, not a
  structured confirmation of content, and it cannot carry a chosen option for an ambiguity.

### 1.4 `reviewMode` in the pilot, and what a human approval means today

- `PilotPolicy.reviewMode` is `'checks-only' | 'label' | 'rules'`
  (`packages/core/src/pilot.ts:52`), documented in the same file (`:40-51`) and in
  `docs/adr/009-pilot.md:70-76`.
- `'label'` requires a non-empty `approvalLabel`; the tick throws a precondition error otherwise
  (`packages/core/src/pilot.ts:192-193`). The review hook re-reads the item and returns
  `awaiting-human` while the label is absent (`packages/core/src/pilot.ts:450-455`). Waiting for
  that human burns no review round and asks the agent to fix nothing
  (`docs/adr/009-pilot.md:78-83`).
- So "a human approved" today means: a boolean passed to an `approval` step, or a label present
  on a board item. Neither records **what content** was approved. ADR-018 added the missing half
  for the human gate: an approval is bound to a digest
  (`docs/adr/018-a-review-is-evidence-about-one-set-of-inputs.md`, decisions 1-3 and 6), and the
  delivered correction makes the refusal approval-centric (`packages/core/src/delivery-loop.ts:276-306`;
  `docs/adr/018-a-review-is-evidence-about-one-set-of-inputs.md`, closing correction note).
- ADR-024 records that the workflow path's `rule_review` does **not** yet write ADR-018's digest
  into a board state record; that binding only exists on the delivery-loop path
  (`docs/adr/024-what-judges-a-workflow-review.md`, "Not done, and named").

### 1.5 The eval harness's held-out verifier

- `eval/scripts/run-eval.mjs` copies a fixture directory into a temp workdir
  (`eval/scripts/run-eval.mjs:103`), including whatever lives under `test/.hidden/`.
- The agent then runs against that workdir (`:110-118`), claims success, and only then does
  `verify()` move the hidden tests up into `test/` (`eval/scripts/run-eval.mjs:75-80`) and run the
  task's verify command (`:82-88`).
- On failure the runner feeds verification output back to the agent for repair, with the
  instruction not to modify the tests (`eval/scripts/run-eval.mjs:141-150`).
- There are 23 pre-authored tasks (`eval/tasks/tasks.json`, length 23;
  `docs/evaluation.md:26-31`; `docs/acceptance-report.md:81-82`). Each task carries
  `allowed_tools` and `completion_criteria` fields, but `run-eval.mjs` does not read either — a
  grep of the runner for those keys returns nothing. The claim that held-out tests are "excluded
  from agent prompt context" (`docs/evaluation.md:37`) is therefore a property of the fixture
  layout, not an enforced isolation boundary: `.hidden` files are physically inside the agent's
  workdir from `:103` onward.
- The acceptance report names exactly this as the platform's limit #2: the held-out verifier
  tests are hand-written, and the platform does not generate an independent oracle for an
  arbitrary new requirement (`docs/acceptance-report.md:81-82`).

### 1.6 MirroringBoard's write-only rule and what it forbids

- `MirroringBoard` implements one authority plus N write-only projections
  (`packages/core/src/board-mirror.ts:1-11`). Rule 1: reading, claiming, the state record,
  bootstrap and EVERY decision go to the primary; a mirror is never read for control flow
  (`packages/core/src/board-mirror.ts:16-21`). Rule 6: a projection is complete or it is loud
  (`packages/core/src/board-mirror.ts:37-42`).
- ADR-017 states it as "Outbound only" and says an inbound path — someone files an idea in a
  mirror and it becomes real work — is deliberately a different feature with its own trust
  decision (`docs/adr/017-mirror-boards.md`, Decision 6).
- What this forbids for the target mode: requirement confirmation and ambiguity choices may not
  be driven by or read from a mirror. A human editing a Notion page cannot be the confirmation
  record. The confirmation must land on the authority (board state record, or an artifact plus a
  first-class approval record as in ADR-018) and may then be projected outward, never the
  reverse. The state record itself is deliberately not mirrored
  (`packages/core/src/board-mirror.ts:33-36`; `docs/adr/017-mirror-boards.md`, Decision 5).

---

## 2. Gap analysis for the black-box mode

### (a) Requirement-side structured confirmation

- **Exists**: agent steps driven by skills (`packages/core/src/workflow-engine.ts:199-235`); a
  requirements skill with a manifest listing one prompt action
  (`extensions/skills/jp-requirements/manifest.yaml:1-7`) and a prompt that asks for
  `id/title/description/acceptance_criteria/priority/source/traceability` per requirement
  (`extensions/skills/jp-requirements/prompts/analyze.md`); a `REQ-\d+` id convention that the
  traceability matrix understands (`packages/core/src/traceability.ts:1-12`;
  `packages/core/src/workflow-engine.ts:162-168`); an `approval` step (boolean); ADR-018's
  digest-bound approval records.
- **Missing**: (i) a requirement document shape that separates stated requirements from **open
  ambiguities with bounded options**; (ii) a confirmation step that records the chosen option per
  ambiguity; (iii) a digest of the confirmed requirement document, so later acceptance can be
  invalidated by an edit. Today an approval is a boolean (`packages/core/src/types.ts:159-169`,
  `apps/cli/src/commands.ts:36-53`) and the requirement text itself is never hashed.
- **Smallest thing that closes it**: a `req-intake` skill that emits a YAML requirement document
  with an `ambiguities:` list (each entry: `id`, `question`, `options[2-4]`, `default`,
  `chosen`), plus a `requirementDigest(text)` helper that reuses ADR-018's canonical-hash shape
  (`packages/core/src/review-digest.ts:34-44`, `:79-82`). The existing `approval` step can carry
  the confirmation in its prompt for a zero-core PoC; a bounded-choice UI is a later slice
  (Section 3, change 8; Section 7).

### (b) Artifact-level behavioural acceptance

- **Exists**: `quality_gate` runs a real command and parses TAP/jest/vitest/pytest/Maven/Gradle
  shapes, failing closed on unrecognised output, a non-zero exit, a hard-failure marker, zero
  tests, and all-skipped (`packages/core/src/workflow-engine.ts:448-501`;
  `packages/core/src/quality-gate.ts:158-181`). `rule_review` judges the real change set with
  deterministic rules and fails closed on `block`/`human` findings
  (`packages/core/src/workflow-engine.ts:503-643`). `independent_review` requires a structured
  `REVIEW_VERDICT` marker and fails closed when it is missing or ambiguous
  (`packages/core/src/workflow-engine.ts:126-160`, `:645-702`; ADR-024). `delivery` writes only
  an artifact manifest (`packages/core/src/workflow-engine.ts:704-729`). Artifacts are
  first-class and traceable (`packages/core/src/artifact-store.ts:32-40`).
- **Missing**: an acceptance step whose verdict is about **behaviour of the delivered artifact
  against the confirmed requirement**, recorded as its own artifact with the requirement digest
  inside it. `quality_gate` proves tests pass, and it will happily prove that for tests the
  implementing agent wrote; `independent_review` is an LLM second reader and ADR-024 explicitly
  keeps it prose-advisory, not the gate. Nothing today binds "the acceptance criterion in REQ-003
  now holds" to an executable check.
- **Smallest thing that closes it**: a new `acceptance` step type that (1) requires a
  `requirementRef`, (2) runs an acceptance harness produced by a judge-forge step or supplied by
  the requirement, (3) reads a structured `ACCEPT_VERDICT: pass|fail` marker with the same
  fail-closed rules as `parseReviewVerdict`, and (4) writes an `ACCEPT` artifact containing the
  requirement digest, head/base SHAs, policy/ruleset/reviewer identity and per-criterion results.
  Sections 3 and 4 specify it.

### (c) A judge generated for a NEW requirement, not the 23 pre-authored eval tasks

- **Exists**: 23 hand-written tasks with `.hidden` ground-truth tests
  (`eval/tasks/tasks.json`; `eval/scripts/run-eval.mjs:75-80`); per-task `verify.command` and
  `expect_stdout` (`eval/scripts/run-eval.mjs:82-88`); a repair loop fed by verifier output
  (`:141-150`); a `rule_review` step that can already judge a change set deterministically
  (`packages/core/src/workflow-engine.ts:503`).
- **Missing**: (i) any generation of a verifier for a requirement that did not exist when the
  tasks were authored; (ii) enforcement that the generated verifier never enters the implementing
  agent's context. Today the only isolation primitive on the workflow path is `cwd`: the
  independent review runs with `cwd: reviewDir` (`packages/core/src/workflow-engine.ts:649-660`),
  and the comment there calls it "isolated session context". Whether a real runtime constrains
  file access to that cwd is **not determined** from this repository; for the fake runtime it
  certainly does not.
- **Smallest thing that closes it**: a judge-forge agent step whose output is written outside the
  implementation worktree, and a verifier invocation that runs from a different cwd, with the
  implementing agent's prompt constructed so the judge text is not a variable in it. Section 4
  states the provable parts and the not-determined parts honestly.

---

## 3. Minimal design: numbered change list

Everything below is a proposal. Nothing here was implemented in this pass.

### Change 1 (zero core change): the workflow extension

New file: `extensions/workflows/blackbox-acceptance/workflow.yaml`.

It uses only the seven existing step types (`packages/core/src/workflow.ts:17-25`), so it loads
through today's validator and runs through today's engine with no core edit:

1. `req_intake` — `type: agent`, `skill: req-intake`, `prompt: "{input}"`, emitting the
   structured requirement document including `ambiguities[]`.
2. `ambiguity_confirmation` — `type: approval`, prompt containing the requirement document and
   its `sha256`, so the human confirms content, not a step name. Under the current CLI this is
   `[a]/[r]` (`apps/cli/src/commands.ts:36-53`); the bounded-choice UI is change 8.
3. `implementation` — `type: agent`, prompt tells the agent to choose language/architecture/stack
   and implement; no human reads its output.
4. `unit_and_integration_tests` — `type: agent`.
5. `quality_gate` — `type: quality_gate`, prompt is the project test command; fails closed per
   `packages/core/src/workflow-engine.ts:448-501`.
6. `rule_review` — `type: rule_review`, `baseRef` required
   (`packages/core/src/workflow.ts:104-106`).
7. `artifact_acceptance` — `type: quality_gate` in PoC-1 (the stand-in for the new
   `acceptance` step), running the acceptance harness produced by the judge-forge step.
8. `delivery` — `type: delivery`.

The workflow declares `requiredSkills: [req-intake]`; note that nothing validates that today
(Section 1.1), so the skill must also be present in `extensions/skills/`.

### Change 2: the `req-intake` skill (English only)

New files:

- `extensions/skills/req-intake/manifest.yaml` — same shape as the existing skill manifest
  (`extensions/skills/jp-requirements/manifest.yaml:1-7`): `name: req-intake`, `kind: skill`,
  `version`, `description`, `prompts: { intake: prompts/intake.md, confirm: prompts/confirm.md }`.
- `extensions/skills/req-intake/SKILL.md`.
- `extensions/skills/req-intake/prompts/intake.md` — instructs the agent to emit a YAML document
  with `requirements[]` (id `REQ-nnn`, title, description, `acceptance_criteria[]`, priority,
  source) and `ambiguities[]` (id `AMB-nnn`, question, `options[]` of 2-4 strings, `default`,
  `blocking: true|false`).
- `extensions/skills/req-intake/prompts/confirm.md` — instructs the agent to render the document
  plus its digest for human confirmation, and to record chosen options into the document.

Per the repository language policy (`AGENTS.md`), this new skill is English; the existing
`jp-*` skills are Japanese and are not modified by this design.

### Change 3: the `acceptance` step type — `packages/core/src/workflow.ts`

Exact changes:

- Add `'acceptance'` to `WORKFLOW_STEP_TYPES` (`packages/core/src/workflow.ts:17-25`).
  `StepType` follows automatically (`:27`), and `isWorkflowStepType` (`:30-32`) accepts it.
- Add to `WorkflowStep`: `requirementRef?: string` (path to the confirmed requirement document),
  `acceptanceRef?: string` (path to the acceptance harness the step runs), and
  `acceptanceFailClosed?: boolean` (default true; present so a caller cannot accidentally opt out
  silently).
- Extend `validateWorkflowManifest` (`packages/core/src/workflow.ts:85-108`) with the same shape
  as the `rule_review` rule at `:104-106`:
  - an `acceptance` step with no non-empty `requirementRef` is refused: acceptance not bound to a
    requirement is not acceptance;
  - an `acceptance` step with no non-empty `acceptanceRef` is refused: there is nothing to run;
  - the validator is pure and does not read the filesystem, so file existence is checked at
    execution time, not load time — stated explicitly rather than pretended otherwise.

Manifest validation today runs at load via `loadWorkflow` (`apps/cli/src/commands.ts:238-247`),
so these messages surface the way `rule_review`'s do.

### Change 4: the engine branch — `packages/core/src/workflow-engine.ts`

- Add one branch before the agent fallthrough (i.e. alongside `:503` and `:645`).
- Behaviour:
  1. Fail closed if the step has no `requirementRef` or `acceptanceRef` (defence in depth; the
     manifest validator already refuses).
  2. Read the requirement document, compute `requirementDigest`, and if the run carries a
     confirmed-requirement digest that differs, fail the step naming both digests — the same
     "refused by name" shape as `staleReviewReason`
     (`packages/core/src/delivery-loop.ts:276-306`).
  3. Run the acceptance harness with the same exec seam as `quality_gate`
     (`packages/core/src/workflow-engine.ts:448-467`) and the same fail-closed parsing posture.
  4. Parse a structured `ACCEPT_VERDICT: pass|fail` marker out of the harness output using a
     sibling of `parseReviewVerdict` (`packages/core/src/workflow-engine.ts:126-160`): missing,
     unknown or two conflicting markers all fail the step; prose decides nothing.
  5. Write the `ACCEPT` artifact (fields below) through `ArtifactStore.write`
     (`packages/core/src/artifact-store.ts:32-40`) with `trace: [REQ-…]` taken from the
     requirement document, and add `ACCEPT` to the `extractTraceIds` alternation
     (`packages/core/src/workflow-engine.ts:162-168`) if `ACCEPT-nnn` ids should propagate.
  6. A non-zero exit, unrecognised output, or a `fail` verdict fails the step and aborts
     downstream steps the way `quality_gate` does (`:490-501`).

### Change 5: bind acceptance to the same input digest as the review (ADR-018)

- Extend `ReviewInputs` with `requirement: string`
  (`packages/core/src/review-digest.ts:34-44`) and include it in `reviewDigest`'s canonical
  object (`:79-82`). Because `canonical` sorts keys (`:93-97`), the digest stays stable for
  unchanged inputs.
- Add `requirementDigest(text: string): string` next to `policyHash`/`rulesetHash`
  (`packages/core/src/review-digest.ts:52-77`).
- Effect on the delivery loop: `reviewInputsFor` (`packages/core/src/delivery-loop.ts:411-431`)
  gains the requirement digest from the plan, and `staleReviewReason` (`:279-306`) reports
  "the requirement changed" alongside head/base/policy/ruleset/reviewer. A changed requirement
  therefore invalidates an old acceptance and an old human approval by construction, not by
  convention.
- Compatibility note: adding a field to `ReviewInputs` is a breaking change for every caller of
  `reviewDigest`; it must land in one commit with its callers and tests, and old state records
  without a requirement digest are refused by the same "unknown provenance" logic that ADR-018
  already applies to pre-digest records
  (`docs/adr/018-a-review-is-evidence-about-one-set-of-inputs.md`, Decision 4 and its correction).

### The `ACCEPT` artifact: required fields

Written as markdown plus a fenced `yaml` block (the store persists one content string,
`packages/core/src/artifact-store.ts:32-40`), with `kind: acceptance`:

```yaml
id: ACCEPT-001                     # sequential per run
requirement:
  ref: docs/requirements/REQ.md    # the confirmed document
  digest: sha256:<64 hex>          # requirementDigest(document)
  requirements: [REQ-001, REQ-003] # criteria this acceptance covers
artifact:
  head: <40 hex sha>
  base: <40 hex sha>
  ref: <delivery ref or artifact path>
review:                            # ADR-018 identity
  policy: sha256:<64 hex>
  ruleset: sha256:<64 hex>
  reviewer: <reviewer id>
  digest: sha256:<64 hex>          # reviewDigest({head,base,policy,ruleset,reviewer,requirement})
acceptance:
  harness: <path from acceptanceRef>
  verdict: pass | fail
  criteria:
    - id: REQ-001
      check: <what was executed>
      result: pass | fail
      evidence: <artifact path or command output excerpt>
  verdictMarker: "ACCEPT_VERDICT: pass"   # the single structured line
confirmedBy:
  by: <identity or null>
  at: <ISO timestamp>
  method: approval-step | label
  choices:                          # one entry per ambiguity the human decided
    - id: AMB-001
      chosen: <option string>
invalidatedBy:                      # the rule, not a timestamp
  - requirement-digest-change
  - head-move
  - base-move
  - policy-change
  - ruleset-change
  - reviewer-change
```

The binding rule: `review.digest` (the ADR-018 digest over the six inputs, now including the
requirement digest) is the only thing that makes the artifact valid. Any later run recomputes it
and refuses a mismatch by name, exactly as the merge path already does for human approvals
(`packages/core/src/delivery-loop.ts:279-306`).

### Change 6: exports — `packages/core/src/index.ts`

Export the new/changed symbols from `packages/core/src/index.ts` (the existing pattern is the
workflow block at `:34-44` and the digest block at `:58-65`).

### Change 7: tests (named, to be written in the implementation slice)

- `packages/core/src/test/acceptance-step.test.ts` — manifest validation for `acceptance`
  (missing `requirementRef`, missing `acceptanceRef`), fail-closed verdict parsing, ACCEPT
  artifact fields.
- Extend the digest tests under `packages/core/src/test/` — a requirement change invalidates an
  acceptance; unchanged inputs keep the digest stable (`canonical` at
  `packages/core/src/review-digest.ts:93-97`).
- `apps/cli/src/test/cli.test.ts` — a workflow with an `acceptance` step loads; one without
  `requirementRef` is refused with the allowed list, in the style of the existing `rule_review`
  test (`apps/cli/src/test/cli.test.ts:82-99`).

### Change 8 (optional, human-confirmation UI): `apps/cli/src/commands.ts`

To make "each open ambiguity as a limited choice" real, `ApprovalRequest.options`
(`packages/core/src/types.ts:167`) needs to carry more than the three hard-coded values
(`packages/core/src/workflow-engine.ts:393`), and `interactiveApprove`
(`apps/cli/src/commands.ts:23-53`) needs to render and return a chosen option rather than a
boolean. This is **not needed for PoC-1**, where the ambiguity choices are pre-filled defaults and
the human can only accept or reject the whole document. It is needed for the target outcome as
stated.

### Change 9: judge forge — see Section 4

### Change 10: decision record

New file: `docs/adr/025-blackbox-acceptance.md`, recording the two new concepts (a confirmed
requirement digest; an `acceptance` step whose verdict is behavioural) and the fail-closed rules
in Section 5.

---

## 4. The judge-forge question

**Where a frozen judge could live for a brand-new requirement.** Three places are available on
this tree, in increasing strength:

1. **A run-scoped directory outside the worktree.** The engine already creates
   `<ctx.cwd>/.takumi/review` for the independent reviewer and runs that step with
   `cwd: reviewDir` (`packages/core/src/workflow-engine.ts:649-660`). A judge forge would write
   to `<ctx.cwd>/.takumi/acceptance/<accept-id>/` and the acceptance step would execute from
   there. The implementing agent's own step still runs with `cwd: ctx.cwd`
   (`packages/core/src/workflow-engine.ts:748`; the parallel pre-run uses the same value at
   `:316`), so the judge is outside the directory the agent is told to work in.
2. **An artifact kind in the artifact store**, written only after the implementation step has
   completed. The store refuses a path that escapes its root (`docs/acceptance-report.md:40`,
   Gate 20), which makes "the judge is inside `.takumi/artifacts`" a checkable property rather
   than a promise.
3. **A separate process/uid/container for the verifier.** The CLI accepts `--sandbox none|unshare`
   (`apps/cli/src/index.ts:71-91`) and `packages/core/src/sandbox-unshare.ts` exists. Whether
   `unshare` confines filesystem visibility was **not determined** from this tree when this note was
   written; it has since been **measured** by ADR-058 (`packages/core/src/test/sandbox-boundary.test.ts`,
   `sandbox-real-boundary.test.ts`), which also states the limits the boundary does NOT close —
   notably the delivery agent's model egress.

**How the eval harness moves the hidden tests today (the only working precedent).**
`eval/scripts/run-eval.mjs` keeps ground-truth tests under `test/.hidden/` in the fixture, copies
the fixture into the workdir including them (`:103`), runs the agent, then `verify()` moves each
hidden file up into `test/` (`:75-80`) and runs `task.verify.command` (`:82-88`). The repair loop
then shows the agent the verifier output while forbidding edits to the tests (`:145-150`).

**What that precedent does and does not prove.**

- It proves a *sequencing* rule: the judge is materialised into the runnable location only after
  the implementing agent has stopped.
- It does **not** prove isolation: the `.hidden` directory is inside the agent's own workdir from
  `:103` onward, and the runner never reads `allowed_tools` or `completion_criteria`. The
  "excluded from agent prompt context" statement (`docs/evaluation.md:37`) is a property of the
  fixture layout, not a boundary. This is the honest baseline for judge forge.
- The same limit applies to the workflow path's `cwd: reviewDir`: a `cwd` is not a permission
  boundary unless the runtime enforces one. Stated as **not determined**.

**Provable properties a judge-forge PoC can assert (all checkable offline):**

1. The judge file path is not under the implementation worktree path passed to the implementing
   agent's task (`ctx.cwd`), asserted by string prefix.
2. The implementing agent's resolved prompt (`resolveStepPrompt`,
   `packages/core/src/workflow-engine.ts:199-235`) contains no judge text and no `{judge}`
   placeholder; the judge path is not in `vars`.
3. The judge is written only after the implementation step's result is `completed`, asserted by
   ordering in the run's audit record (`writeAudit` is defined at `apps/cli/src/commands.ts:275`
   and the workflow run calls it at `:355`).
4. A run whose judge cannot be produced yields no `ACCEPT` artifact and fails the step — never a
   pass (the posture of `quality_gate`, `packages/core/src/workflow-engine.ts:490-501`, and
   ADR-024's "a review that could not run is a FAILURE").
5. The verifier process runs with a different cwd than the implementer, asserted the way the
   independent review already differs (`packages/core/src/workflow-engine.ts:660` vs
   `:748`).

Property 4 is the one that makes the mode safe even when properties 1-3 are defeated by a
determined agent: an unverifiable delivery does not get accepted.

---

## 5. Failure modes this mode introduces, and the fail-closed rules

The risk classes reuse what the existing guards already treat as dangerous, so this mode does not
invent a new taxonomy: ADR-013's severity model (`packages/core/src/review-rules.ts:49-54`), the
protected-path rule (`packages/core/src/review-rules.ts:322-325`), the committed-secret rule
(`packages/core/src/review-rules.ts:345-357`; ADR-019) and the test-weakening rules
(`packages/core/src/review-rules.ts:270`).

| Class | Examples | Through the black box? | Why |
|---|---|---|---|
| R0 — pure, local, deterministic | a parser, a formatter, an algorithm with no I/O | Yes | Reversible, no external effect; a wrong answer is observable by behaviour alone. |
| R1 — in-repo, reversible, no external effect | a library function, a refactor, a bug fix | Yes, with acceptance | Behaviour can be judged and the change reverted. |
| R2 — protected surfaces | CI configuration, dependency manifests, container build, takumi's own configuration | **Refused** | Already `human` severity: a machine may not wave it through and an agent must not "fix" a legitimate change by reverting it (`packages/core/src/review-rules.ts:322-325`; default protected patterns at `:113`). Surfaces as a human decision outside the black box. |
| R3 — credentials and secrets | any committed token, key or password | **Refused, step fails** | `secret/committed` / `secret/suspected` (`packages/core/src/review-rules.ts:345-357`); ADR-019: the leak is the push, not the merge, so the fix is rotation by a human. |
| R3' — destructive or externally visible operations | data migration, deleting user data, sending mail, changing production infrastructure | **Refused unless the requirement explicitly names a reversible sandbox** | Not determined by any existing rule; the black box has no safe default here. Must be a human confirmation with an explicit target. |

The failure modes, each with the rule that must exist to fail closed:

1. **A requirement ambiguity is resolved silently by the model.** Fails open today: an agent can
   emit a document with no `ambiguities[]` and proceed. Rule: the intake step's output must be
   refused by the confirmation step when the document has zero `ambiguities[]` and the input text
   contains an unstated decision point; in practice the confirmation is a human reading the
   document, so the rule is "the confirmation artifact records the requirement digest and, when
   `ambiguities[]` is empty, a human explicitly declares `no open ambiguities`".
2. **The confirmation auto-approves in a pipeline.** This is real today: `interactiveApprove`
   returns `true` when stdin is not a TTY (`apps/cli/src/commands.ts:28-33`), and the engine
   defaults to `true` when `onApproval` is absent (`packages/core/src/workflow-engine.ts:396`).
   For a requirement confirmation this is fatal. Rule: an `acceptance`-class confirmation step
   must refuse to run without an explicit human decision; a non-interactive run fails the
   confirmation rather than approving it. This is a **core change** (the approval branch at
   `packages/core/src/workflow-engine.ts:384-407`), and it must not weaken the existing
   auto-approval for ordinary delivery approvals.
3. **The requirement changes after acceptance.** Closed by change 5 (requirement digest inside
   the ADR-018 digest). Without it, a silent edit invalidates nothing.
4. **A resumed run replays a stale acceptance.** `ctx.resume.completed` replays recorded steps
   instead of executing them (`packages/core/src/workflow-engine.ts:370-380`), and the CLI
   rebuilds that map from the newest audit record (`apps/cli/src/commands.ts:293-315`). Rule: a
   replayed `acceptance` step must re-verify the requirement digest and the head SHA before it is
   honoured; a replay whose digest no longer matches must fail rather than be reported completed.
5. **The acceptance harness is the implementing agent's own test.** Fails open: `quality_gate`
   proves only that *some* test command was green (`packages/core/src/workflow-engine.ts:448-501`),
   and ADR-013's whole context is that a pipeline can be satisfied by weakening the tests it runs.
   Rule: the acceptance harness is produced out-of-band by the judge forge and its path lives
   outside the implementation worktree (Section 4); a harness under the implementation worktree is
   refused by the acceptance step.
6. **A judge that cannot run is read as a pass.** Rule: the acceptance step requires a
   `pass`-valued `ACCEPT_VERDICT` marker; a missing, unknown or conflicting marker, a non-zero
   exit, or unrecognised output fails the step and aborts downstream steps
   (`packages/core/src/workflow-engine.ts:126-160` and `:490-501` are the precedents).
7. **The delivery manifest looks complete with no acceptance in it.** The `delivery` step always
   completes when it can write a manifest (`packages/core/src/workflow-engine.ts:704-729`).
   Rule: the blackbox workflow orders `acceptance` before `delivery` (change 1), and the delivery
   step's manifest must list an ACCEPT artifact whose `review.digest` matches the run; a manifest
   with no ACCEPT is not a delivery.
8. **A mirror is used as the confirmation channel.** Forbidden by ADR-017 Decision 6 and
   `packages/core/src/board-mirror.ts:16-21`; the confirmation must live on the authority.
9. **A declared requirement skill is missing and the step silently falls back.** `requiredSkills`
   is declared but unvalidated (`packages/core/src/workflow.ts:121`), and `resolveStepPrompt`
   falls back to `step.prompt` when a skill is absent
   (`packages/core/src/workflow-engine.ts:199-235`). For requirement intake this is a silent
   quality loss. Rule: validate `requiredSkills`/`requiredTools` at load time, refusing a
   workflow whose declared requirement skill is absent.
10. **The acceptance covers only part of the requirement document.** Rule: the ACCEPT artifact
    lists `requirement.requirements[]` and the coverage must equal the confirmed requirement ids;
    an uncovered `REQ-*` fails the acceptance step.

---

## 6. PoC plan

### PoC-1 — zero core change (the workflow extension only)

Command (from a project directory whose `takumi.yaml` registry points at the skill and workflow
directories):

```bash
node apps/cli/dist/index.js run requirements.md --runtime fake --workflow blackbox-acceptance --verbose
```

Observe to prove it worked:

- the workflow loads (no "unknown type" error) and the CLI prints every step of the
  `extensions/workflows/blackbox-acceptance/workflow.yaml` order;
- a `req_intake` artifact lands under the artifact root with the structured document, including
  `ambiguities[]`;
- the log shows `approval required [ambiguity_confirmation]` (engine emits it at
  `packages/core/src/workflow-engine.ts:386`) and the run continues only after the answer;
- `.takumi/artifacts/` contains an acceptance-shaped artifact and a delivery manifest.

What would falsify it:

- the run refuses at load with `unknown type "…"`, meaning a step type was used that is not in
  `WORKFLOW_STEP_TYPES` (`packages/core/src/workflow.ts:99-103`);
- the requirement step produces no `ambiguities[]` at all, meaning the confirmation is decorative;
- **run it without a TTY** (the normal CI shape): the confirmation auto-approves
  (`apps/cli/src/commands.ts:28-33`), which falsifies the claim that the human confirms
  requirements in this PoC. This is expected and is why change 8 and rule 2 in Section 5 exist.

### PoC-2 — the core step type

Command sequence:

```bash
pnpm --filter @takumi/core build
pnpm --filter @takumi/cli build
node apps/cli/dist/index.js run requirements.md --runtime fake --workflow blackbox-acceptance --verbose
```

Plus two negative checks, each as a small fixture workflow:

```bash
# (a) an acceptance step with no requirementRef must be refused at load
node apps/cli/dist/index.js run x --workflow acceptance-no-requirement --verbose   # expect exit != 0

# (b) edit the requirement document after confirmation, then re-run the acceptance step
#     expect a refusal naming both requirement digests
```

Observe to prove it worked:

- the run emits an `acceptance` step result and writes an `ACCEPT` artifact whose fenced YAML
  contains `requirement.digest`, `review.digest`, `acceptance.verdict` and the per-criterion
  results (field list in Section 3);
- check (a) fails at load with the two validation messages from change 3;
- check (b) fails the step naming the old and new digests, the same shape as
  `staleReviewReason` (`packages/core/src/delivery-loop.ts:299-306`).

What would falsify it:

- the acceptance step loads with no `requirementRef` (validation hole);
- a changed requirement still produces a passing ACCEPT artifact (the digest is not bound);
- reconcile this with `pnpm test`: if the added `requirement` field to `ReviewInputs` breaks
  digest tests, that is expected and must be fixed in the same commit (change 5 compatibility
  note), not by weakening the digest.

### PoC-3 — judge forge

Command:

```bash
node apps/cli/dist/index.js run requirements.md --runtime fake --workflow blackbox-acceptance --verbose
# then inspect the run's audit record and the judge location
ls -R .takumi/acceptance .takumi/artifacts
cat .takumi/audit/*.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log(r.steps.map(x=>x.stepId+':'+x.status).join('\n'))})"
```

Observe to prove it worked, per the provable properties in Section 4:

- the judge file path is not under the implementation worktree path;
- the implementation step's prompt (visible through the artifact the step wrote, or the audit
  record) contains no judge text;
- the audit record orders `implementation: completed` before the judge-forge step;
- a deliberately broken judge (e.g. a harness that prints nothing) fails the acceptance step and
  produces no ACCEPT artifact.

What would falsify it:

- the judge file is readable from the implementation worktree path (then it is inside the agent's
  context, and the mode is not black-box);
- the implementation step's resolved prompt contains judge text (then the agent can fit the
  judge);
- a judge that cannot run still yields a passing ACCEPT artifact.

Honest scope note for PoC-3: with the fake runtime every check above is a *sequencing and path*
check, not a security check. Whether a real runtime (Pi, DeepSeek, OpenHands) confines a session
to its `cwd` **was not determined** from this repository when this note was written. It has since
been measured for the Pi runtime by ADR-058 (`runtimes/pi/src/test/confinement.test.ts`): a confined
task gets `noTools: 'builtin'` and contained `read`/`write`/`edit`/`ls`/`find`/`bash` tools, with
`grep` dropped because its search cannot be contained. The delivery agent still keeps model egress,
which ADR-058 states as a named limitation rather than an isolation claim. The eval
harness's `.hidden` layout is the precedent for the sequencing half only
(`eval/scripts/run-eval.mjs:75-80`, `:103`).

---

## 7. Open questions for the human

1. **Who may confirm a requirement, and what identity is recorded?** The board label path cannot
   name the approver (`docs/adr/018-a-review-is-evidence-about-one-set-of-inputs.md`, Decision 6:
   `by` is null when the board gives no identity). For a requirement confirmation, is an
   anonymous approval acceptable?
2. **What is the canonical requirement document format and location?** This design proposes YAML
   under `docs/requirements/`; nothing in the repository fixes it. The `jp-requirements` skill
   emits YAML to stdout, not a file.
3. **Does requirement confirmation require the bounded-choice UI (change 8) in the first slice,
   or is accept/reject of a document with pre-filled defaults enough for the first customer?**
   The target outcome says "each open ambiguity, as a limited choice", which points at change 8.
4. **May a behavioural acceptance be automated at all for R2 and R3' classes, or must those
   always end in a human decision?** Section 5 refuses them; the boundary of "explicitly names a
   reversible sandbox" needs the human's definition.
5. **Where should the ACCEPT artifact be authoritative** — board state record (as ADR-018's
   `reviewed`/`approval` blocks are) or artifact store only? ADR-024 records that the workflow
   path does not yet write a digest into a state record, so this decision also decides whether
   change 5 lands on the workflow path or only on the pilot path.
6. **May the judge forge use the same model family as the implementer?** ADR-024 says the prose
   reviewer shares the implementer's blind spots and is therefore a second opinion, not a check.
   A generated judge has the same problem unless it is cross-family or deterministic; the
   repository does not decide this.
7. **Which class does a new project's language/stack choice fall into before the requirement is
   confirmed?** Choosing a stack is an architecture decision with lock-in, and the target says
   the AI chooses it in the black box; if the human never sees it, the acceptance must be strong
   enough to make a wrong stack choice reversible. No rule covers this today.
8. **Language of the new skill.** The repository policy requires English for new code, docs and
   skills (`AGENTS.md`), while the existing requirements workflow is Japanese. Should
   `req-intake` be English-only, with the Japanese `jp-*` skills kept as a separate flow?
9. **Cost and time budget.** 23 pre-authored eval tasks exist, but the black-box cycle adds
   intake, judge forge, acceptance and possible re-confirmation rounds per delivery. What is the
   acceptable wall-clock and token budget per cycle before the mode is considered failed?
10. **What happens to a delivery whose acceptance failed after the human already confirmed the
    requirement?** The feedback loop returns to the requirement document; it is not determined
    whether the human re-confirms the edited document or only the changed ambiguities.
