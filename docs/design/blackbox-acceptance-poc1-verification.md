# PoC-1 verification: the black-box acceptance workflow, extensions only

**Status**: implemented, run end to end, and independently verified. The verification
found defects that were NOT predicted by the design.

- Repository: `/srv/hermes/workspaces/takumi`, branch `feat/blackbox-acceptance`
  (cut from `github/dev` at `e20620a`).
- Design this implements: `docs/design/blackbox-acceptance-scout.md`, Section 3
  (Change 1 and Change 2) and Section 6 (PoC-1).
- Commits: `d8c6082` (the `req-intake` skill), `ef3c3af` (the workflow and its
  stand-in acceptance harness), `4a9ff68` (the repository runs itself as a takumi
  project). Zero core change: nothing under `packages/`, `apps/`, `runtimes/`,
  `reporters/`, `reviewers/` or `eval/` was touched.
- Provenance: the eight files were authored by a `pi-autodev feature` run from a
  numbered-contract prompt; every claim below was then re-run and re-read by the
  operator. Nothing here is a model self-report.

## 1. What was built

| File | Purpose |
|---|---|
| `extensions/skills/req-intake/manifest.yaml` | Skill manifest; the first prompt key (`intake`) is what `resolveStepPrompt` resolves for a step with no `skillAction`. |
| `extensions/skills/req-intake/SKILL.md` | The document schema and the hard rule that every open decision point becomes an `AMB-nnn` entry with 2-4 bounded options and a default. |
| `extensions/skills/req-intake/prompts/intake.md` | Request text → one YAML document with `requirements[]` (`REQ-nnn`) and `ambiguities[]` (`AMB-nnn`). |
| `extensions/skills/req-intake/prompts/confirm.md` | Renders the document plus the sha256 of its canonical text so a human confirms content, not a step name. |
| `extensions/workflows/blackbox-acceptance/workflow.yaml` | The eight steps of PoC-1, using only the seven step types that existed then (PoC-2 replaced the `quality_gate` stand-in with the real `acceptance` step, and PoC-3 added the `judge_forge` step — see sections 8 and 9). |
| `extensions/workflows/blackbox-acceptance/checks/acceptance-tap.sh` | The PoC-1/PoC-2 acceptance stand-in: a real fail-closed TAP harness. Removed in PoC-3, which replaced it with a forged judge (the literal-harness path stays supported and covered by `packages/core/src/test/acceptance-step.test.ts`). |
| `takumi.yaml` | The repository root becomes a takumi project, so takumi can run on itself. |
| `docs/requirements/poc-blackbox-acceptance.md` | The PoC input fixture (an employee-CSV summary request with four genuinely open decisions). |

## 2. The run

```
node apps/cli/dist/index.js run docs/requirements/poc-blackbox-acceptance.md \
  --runtime fake --workflow blackbox-acceptance --verbose
```

What the run shows (log: `/tmp/poc-run.log`):

- the workflow loads and every step is dispatched in the declared order;
- agent steps persist an artifact (`<artifacts>/<stepId-prefix>/<stepId>.md`) — the
  fake runtime's summary is a processed echo of the prompt, which is enough for
  `ArtifactStore.write` but is NOT a requirement document (see finding 6);
- the approval step logs `approval required` and proceeds **without a human**: the
  CLI's `interactiveApprove` returns true when stdin is not a TTY
  (`apps/cli/src/commands.ts:28-33`) and the engine defaults to true when no
  `onApproval` is supplied (`packages/core/src/workflow-engine.ts:396`). Confirmed,
  not worked around;
- `rule_review` was `skipped` and yet `artifact_acceptance` and `delivery` still ran
  (finding 3);
- the run ended `✓ workflow "blackbox-acceptance" failed` and the CLI still exited 0
  (finding 4).

`.takumi/artifacts/` afterwards: `req/req_intake.md`, `implementation/implementation.md`,
`unit/unit_and_integration_tests.md`, `delivery/delivery-manifest.md` (3 artifacts).

## 3. The acceptance harness is real

Both directions were run by the operator, not just the passing one:

```
$ bash extensions/workflows/blackbox-acceptance/checks/acceptance-tap.sh
ok 1 - requirement intake artifact exists: .takumi/artifacts/req/req_intake.md
ok 2 - requirement document contains an ambiguities key
ok 3 - requirement document contains at least one REQ- id
ok 4 - implementation artifact exists: .takumi/artifacts/implementation/implementation.md
ok 5 - unit and integration test artifact exists: .takumi/artifacts/unit/unit_and_integration_tests.md
# tests 5
# pass 5
# fail 0
exit=0

$ mv .takumi/artifacts/req/req_intake.md /tmp/ && bash .../acceptance-tap.sh ; echo $?
not ok 1 - requirement intake artifact is missing: .takumi/artifacts/req/req_intake.md
not ok 2 - requirement document has no ambiguities key: .takumi/artifacts/req/req_intake.md
not ok 3 - requirement document contains no REQ- id: .takumi/artifacts/req/req_intake.md
ok 4 - implementation artifact exists: .takumi/artifacts/implementation/implementation.md
ok 5 - unit and integration test artifact exists: .takumi/artifacts/unit/unit_and_integration_tests.md
# tests 5
# pass 2
# fail 3
exit=1
```

The harness fails closed, and its output shape is one the engine's own parser reads
(`packages/core/src/quality-gate.ts:73-86`).

## 4. Defects found by running it

None of these were predicted by the design. All are reproduced with the commands
below; findings 1-4 were fixed in the four commits that follow this document
(`e67aa81`, `299acea`, `c317eb7`, `e3d3545`, recorded as ledger entries 28-31).

### Finding 1 — the quality gate cannot pass over the repository's own suite (core)

`judgeGate`'s hard-fail detector is `/BUILD FAILURE|BUILD FAILED|FATAL/i` applied to
the WHOLE captured output (`packages/core/src/workflow-engine.ts:471`). The suite's
TAP output contains the test name `quality gate: Maven BUILD FAILURE is a hard fail`
(`# Subtest:` / `ok 188 -` lines in the captured output), so the marker matches and
the gate fails a green suite:

```
$ node apps/cli/dist/index.js run ... --workflow blackbox-acceptance   # in the log
  step quality_gate: failed — quality_gate FAILED: 0 failing over 289 tests, exit 0
  reason: a hard failure marker (BUILD FAILURE/BUILD FAILED/FATAL) was present
```

A detector that reads test NAMES cannot be used on a suite that names the failure
modes it tests. Any project testing its own hard-failure handling hits this.

### Finding 2 — the gate vetted 289 of the repository's 606 tests (core, fail-open)

`parseTap` matches the FIRST `# tests` line in the output
(`packages/core/src/quality-gate.ts:74`). The suite prints 19 TAP blocks (one per
workspace package) summing to 606; the gate reported `total: 289`, i.e. the first
block only. A failure in any of the other 317 tests is invisible to the gate — the
gate is not merely strict, it is silently partial in a monorepo.

```
$ grep -c '^# tests ' /tmp/poc1-suite-1001-0045.log   -> 19
$ grep -h '^# tests ' /tmp/poc1-suite-1001-0045.log | awk '{s+=$3} END {print s}'  -> 606
```

### Finding 3 — a skipped step does not stop its dependents (core, fail-open)

The skip rule is `deps.some((d) => failedIds.has(d))`
(`packages/core/src/workflow-engine.ts:359-366`). A SKIPPED step is never added to
`failedIds`, so its dependents do not see a failed dependency and run normally:

```
  step rule_review: skipped — skipped (dependency failed)
  step artifact_acceptance: completed — quality_gate PASSED: 0 failing over 5 tests
  step delivery: completed — delivery bundle ready (3 artifacts)
```

This contradicts the engine's own comment on the gate ("FAILS the gate and ABORTS the
workflow (no downstream step runs)", `packages/core/src/workflow-engine.ts:446`) and
it invalidates the design's Section 5 rule 7: ordering `acceptance` before `delivery`
protects nothing while a failed gate lets delivery through. Black-box acceptance
cannot be fail-closed on top of this.

### Finding 4 — the CLI exits 0 when the workflow failed (CLI, fail-open)

The `run` command prints the workflow summary and then `return 0` unconditionally
(`apps/cli/src/index.ts:137`). The run above printed `✓ workflow
"blackbox-acceptance" failed` and exited 0, so a CI job cannot tell a failed delivery
from a successful one.

### Finding 5 — an approval prompt cannot carry dynamic content (core, limitation)

The approval branch uses `step.prompt` verbatim and its options are hard-coded
(`packages/core/src/workflow-engine.ts:392-393`: `['approve','reject','view']`); no
`renderPrompt`/`resolveStepPrompt` is applied. A confirmation therefore cannot be
handed the document the intake step just produced, and a bounded-choice confirmation
has no place to return its answer. The PoC worked around this by embedding the
fixture statically in the workflow, which is a demonstration of the limitation, not a
fix for it. Combined with the non-TTY auto-approval, the human gate is currently
decorative in any pipeline.

### Finding 6 — with the fake runtime the intake artifact is the prompt echoed back (PoC scope)

The fake runtime's summary is `processed: <prompt>` and the engine persists that as
the step artifact (`packages/core/src/workflow-engine.ts:789-806`). The artifact
therefore contains the skill template itself, including its schema example — so the
harness checks "has an `ambiguities` key" and "has a `REQ-` id" pass because the
PROMPT contains them, and the delivery manifest's `trace=[REQ-001, REQ-002]` was
extracted from that echo.

PoC-1 therefore proves the wiring (steps dispatch, artifacts land, the harness runs
and fails closed), not the quality of an intake. A real intake claim needs a real
runtime and a harness that refuses a prompt echo; the design's PoC-1 did not
anticipate this.

### Finding 7 — a workflow is loadable but not discoverable (minor)

`loadWorkflow` finds `extensions/workflows/<name>/workflow.yaml` by name, but
`extension list` discovers only directories with a `manifest.yaml`. The
`blackbox-acceptance` workflow therefore runs and is invisible to discovery
(`extensions/workflows/blackbox-acceptance/` has no `manifest.yaml`).

### Note — a pre-existing Japanese string

`delivery/delivery-manifest.md` renders `# 納品物一覧 (Delivery Manifest)`. That
string is pre-existing core output, untouched by this slice; it is recorded here only
because the repository's language policy is English for new work.

## 5. What this slice does NOT prove

- Nothing about sandbox isolation. `cwd` is not a permission boundary; whether a real
  runtime confines a session is not measured here.
- Nothing about binding an acceptance to a requirement digest: the requirement digest
  in the ADR-018 review digest is PoC-2 (design Change 5). Today an edited requirement
  invalidates nothing.
- Nothing about a judge produced outside the implementer's context: the harness here is
  a static file under the same tree (PoC-3).
- Nothing about intake quality (finding 6).

## 6. Recommended next slice

The three fail-open defects (findings 1-3) plus the CLI exit code (finding 4) are
prerequisites for any claim that a black-box delivery is fail-closed. Each is a
one-file fix with a test that fails before it:

1. `fix(quality-gate): judge a build failure by the build's own output, not by test names`
2. `fix(quality-gate): read every test summary, not the first one`
3. `fix(core): a skipped step stops its dependents`
4. `fix(cli): a failed workflow exits non-zero`

Each with its own commit and its own row in `docs/bugs-fixed.md`, per the ledger's
own rule. Only after that does PoC-2 (the `acceptance` step type bound to a
requirement digest) rest on a gate that can actually stop a delivery.

## 7. After the four fixes: the same run, both directions

The four fixes above were made (`e67aa81`, `299acea`, `c317eb7`, `e3d3545`; ledger
entries 28-31) and the same workflow was run again, unchanged:

```
$ node apps/cli/dist/index.js run docs/requirements/poc-blackbox-acceptance.md \
    --runtime fake --workflow blackbox-acceptance --verbose
  workflow[quality_gate]: quality gate PASSED (0 failing)
  workflow[rule_review]: rule review passed (0 note(s))
  workflow[artifact_acceptance]: quality gate PASSED (0 failing)
  workflow[delivery]: delivery manifest written (4 artifacts)
  step quality_gate: completed — quality_gate PASSED: 0 failing over 616 tests, exit 0
  step rule_review: completed — rule_review PASSED: no findings in e67aa81..299acea
  step artifact_acceptance: completed — quality_gate PASSED: 0 failing over 5 tests, exit 0
  step delivery: completed — delivery bundle ready (4 artifacts)
✓ workflow "blackbox-acceptance" completed
EXIT=0
```

`616 tests` is the repaired count (606 before this slice, plus the 10 regression
tests the four fixes added) — the gate now reports the run that happened.

The failing direction, on a fixture workflow whose gate cannot pass:

```
$ node …/apps/cli/dist/index.js run "x" --runtime fake --workflow failing-gate
  workflow[gate]: quality gate FAILED (1 failing) — workflow aborted
  step gate: failed — quality_gate FAILED: 1 failing over 1 tests, exit !0
  step ship: skipped — skipped (dependency failed: gate)
✓ workflow "failing-gate" failed
EXIT=1
```

So a failed gate now stops the steps behind it and the process says so — the two
properties PoC-2's acceptance step depends on.

## 8. PoC-2: the acceptance step, bound to a confirmed requirement

PoC-2 added the core machinery (ADR-025): `requirementDigest`/`NO_REQUIREMENT` and the requirement
inside the ADR-018 review digest; the `acceptance` step type with `requirementRef`/`acceptanceRef`
required at load; `parseAcceptVerdict`; the ACCEPT artifact; `takumi requirement digest` and
`run --requirement/--confirmed-requirement`; and the workflow now runs the real acceptance step
against `docs/requirements/poc-blackbox-acceptance.yaml`.

The confirmation token:

```
$ node apps/cli/dist/index.js requirement digest docs/requirements/poc-blackbox-acceptance.yaml
docs/requirements/poc-blackbox-acceptance.yaml
sha256:53804e5bba4370d7f9f053ee03baf9f96a02a398b9e6fa7245222c8fad3bc1b4
```

The run, with that token:

```
  workflow[artifact_acceptance]: acceptance PASSED (8 check(s) ok) — ACCEPT-001 written
  step quality_gate: completed — quality_gate PASSED: 0 failing over 631 tests, exit 0
  step rule_review: completed — rule_review PASSED: no findings in d9acfe935e3b..ef789667298f
  step artifact_acceptance: completed — acceptance PASSED: the confirmed requirement is satisfied
  step delivery: completed — delivery bundle ready (5 artifacts)
✓ workflow "blackbox-acceptance" completed
EXIT=0
```

The ACCEPT artifact it wrote (`.takumi/artifacts/acceptance/ACCEPT-001.md`):

```yaml
id: ACCEPT-001
kind: acceptance
requirement:
  ref: docs/requirements/poc-blackbox-acceptance.yaml
  digest: sha256:53804e5bba4370d7f9f053ee03baf9f96a02a398b9e6fa7245222c8fad3bc1b4
  requirements: [REQ-001, REQ-002, REQ-003, REQ-004, REQ-005]
artifact:
  head: ef789667298f136be54a7a6d8bc73314e9e1007b
acceptance:
  harness: extensions/workflows/blackbox-acceptance/checks/acceptance-tap.sh
  verdict: pass
  verdictMarker: "ACCEPT_VERDICT: pass"
  checks:
    - "pass: every open decision has a chosen option (4/4)"
    …
confirmed:
  ref: docs/requirements/poc-blackbox-acceptance.yaml
  digest: sha256:53804e5bba4370d7f9f053ee03baf9f96a02a398b9e6fa7245222c8fad3bc1b4
```

Then the requirement was edited (one `chosen` option flipped, four lines of a five-requirement
document) and the run repeated with the OLD token:

```
  workflow[artifact_acceptance]: acceptance FAILED: the requirement document
    "docs/requirements/poc-blackbox-acceptance.yaml" is not the one that was confirmed
    (confirmed 53804e5bba43 at "docs/requirements/poc-blackbox-acceptance.yaml",
    the document now hashes to 8f751e736c84): re-confirm the edited document before it
    can be accepted
  step artifact_acceptance: failed — (the same message)
  step delivery: skipped — skipped (dependency failed: artifact_acceptance)
✓ workflow "blackbox-acceptance" failed
EXIT=1
```

That is the design's rule 7 — "an acceptance before delivery protects nothing by ordering alone" —
now enforced by mechanism: the failed acceptance stops the delivery, and the process says so.

What PoC-2 does NOT prove: nothing about sandbox isolation (`cwd` is not a permission boundary);
nothing about the harness being produced outside the implementer's context (the judge-forge is
PoC-3, and today the harness is a file in the same repository); nothing about intake quality under a
real runtime (with `fake` the agent artifacts are the prompt echoed back, which is why the harness's
checks 1-3 are about the confirmed document and 4-6 are labelled as wiring checks); and nothing about
the bounded-choice confirmation UI, which does not exist yet — the human reads the document and
approves its token.

## 9. PoC-3: the forged judge, and the difference it makes

PoC-3 added the third ring (ADR-026): a `judge_forge` step that generates the acceptance judge from
the confirmed requirement's `deliverable` contract — how to run the deliverable, the output shape, the
relations a judge must be able to check, and a differential anchor — outside the implementation
worktree and without reading the implementation. The workflow now forges its judge and the acceptance
step runs that judge (`acceptanceRef: "{judgePath}"`), refusing any other harness.

The deliverable for the demonstration is `examples/blackbox-poc/csv-summary.mjs` (a reference tool),
its sibling `csv-summary-broken.mjs` (one defect: the overall total adds the rounded DEPARTMENT
AVERAGES instead of the department totals) and `csv-summary.test.mjs` — the tool's OWN test, written
to the implementer's blind spot, so it passes for both.

**The reference deliverable:**

```
$ takumi requirement digest docs/requirements/poc-blackbox-acceptance.yaml   # the confirmation token
sha256:867d9fa97c4d8c49841ae02aa0e4f907e3f5e8d468f36a85288ce0aac439f02d

  step quality_gate: completed — quality_gate PASSED: 0 failing over 2 tests, exit 0
  step rule_review: completed — rule_review PASSED: 1 note(s) in e0bcb54c6074..56ec4b340448
  step judge_forge: completed — judge forged: …/.takumi/acceptance/judge_forge/judge.sh
                                sha256:6bf3582e4530 (outside …/.takumi/worktree)
  step artifact_acceptance: completed — acceptance PASSED: the confirmed requirement is satisfied
  step delivery: completed — delivery bundle ready (5 artifacts)
✓ workflow "blackbox-acceptance" completed            EXIT=0
```

**The same deliverable with one behavioural defect — and the tool's own tests still green:**

```
  step quality_gate: completed — quality_gate PASSED: 0 failing over 2 tests, exit 0   ← the implementer's tests
  step judge_forge: completed — judge forged: … sha256:6bf3582e4530 (outside …/.takumi/worktree)
  step artifact_acceptance: failed — acceptance FAILED: the harness reported a failing verdict
  step delivery: skipped — skipped (dependency failed: artifact_acceptance)
✓ workflow "blackbox-acceptance" failed               EXIT=1

  ok 1 - REL-001 row-order-invariance: reshuffling the rows changes nothing
  not ok 2 - REL-002 additivity: department totals sum to 428 but the report says 214
  not ok 3 - REL-003 duplicate-resolution: headcount 4 (expected 4), total 269 (expected 323 = base 214 + 200 - replaced 91)
  ok 4 - REL-004 malformed-row-accounting: 3 malformed rows skipped and counted, totals unchanged
  ok 5 - DIFF-001 independent-aggregation: an independent recomputation matches the report
  ok 6 - DOC-001 every open decision has a chosen option (4/4)
  # not mechanised: the 50,000-row performance criterion (REQ-001)
  # not mechanised: the count of resolved duplicates being printed (REQ-003)
  # not mechanised: the optional output-file argument (REQ-004)
  ACCEPT_VERDICT: fail
```

That difference — the gate green, the judge red, no ACCEPT artifact, delivery skipped, exit 1 — is
the whole argument for the third ring: a judge derived from the requirement catches a defect the
implementer's own tests were written not to see.

**A relation the forge does not implement is a refusal, not a gap.** With `REL-005
i18n-collation-invariance` temporarily declared in the document and a fresh token:

```
  step judge_forge: failed — the judge forge did not report success (no "JUDGE_FORGE: ok" marker)
  step artifact_acceptance: skipped — skipped (dependency failed: judge_forge)
  step delivery: skipped — skipped (dependency skipped: artifact_acceptance)
✓ workflow "blackbox-acceptance" failed               EXIT=1

  this forge does not implement: i18n-collation-invariance — refusing to build a judge with a gap
  in it (implemented: row-order-invariance additivity duplicate-resolution malformed-row-accounting)
```

Two defects were found by these runs and are fixed with their own commits: the repository's own
secret heuristic read a fixture path as a credential and stopped the delivery for a human (ledger
#32, `56ec4b3`), and the worktree path handed to the judge was not resolved, so a relative
`--worktree` left the judge judging an empty report (ledger #33, `966c5b8`).

What PoC-3 does NOT prove, stated as plainly as the rest: the separation is structural, not a
permission — an agent with filesystem access could still read `<project>/.takumi/acceptance/…` by
guessing the path, and no sandbox claim is made here. The deliverable was placed in the worktree BY
HAND for this demonstration, because the `fake` runtime's agent steps echo their prompts: what is
proven is the judge's behaviour, not an agent's. The four relations and one anchor are the honest
measure of what this acceptance covers; the prose criteria the judge reports as not mechanised are
what it does not.

## 10. The human's side: a bounded-choice confirmation (ADR-027)

The last piece of the request's own shape — "the human only confirms: by CHECKING boxes and TYPING
NUMBERS" — was still a document plus a copied token. `takumi requirement confirm <ref>` now puts each
open decision in the document to the human as a numbered, bounded choice, one at a time:

```
$ takumi requirement confirm docs/requirements/poc-blackbox-acceptance.yaml     # real terminal
Confirming docs/requirements/poc-blackbox-acceptance.yaml — 4 open decision(s). Nothing is written
until the last one is answered.
Each answer is written into the document itself, and the document's digest is the token the
acceptance binds to.

  What happens to a malformed row?
    [1] Stop with an error
    [2] Skip the row, count it, and report the count   (current)
    [3] Skip the row and write it to a rejected-rows file
    [enter] keep the current/default choice      [q] abort
    >
  Which row wins when employee_id repeats?
    [1] First row wins   [2] Last row wins   [3] The row with the latest start_date wins (current)   [4] Treat it as an error
    >                    ← [enter]: keep
  Where does the summary go?
    [1] stdout only      [2] stdout, plus an optional file path   (current)
    > 1                  ← a real CHANGE, written into the document
  How is the average rounded, and in what currency?
    [1] Half-up, no currency printed   (current)   [2] Truncate…   [3] Half-up, currency printed…
    >                    ← [enter]: keep

Confirmed decisions (each written into the document):
  x AMB-001: Skip the row, count it, and report the count
  x AMB-002: The row with the latest start_date wins
  x AMB-003: stdout only
  x AMB-004: Half-up, no currency printed

The confirmation token for this document — pass it to a run:
docs/requirements/poc-blackbox-acceptance.yaml
sha256:aa26fa885a40b759386d5ee65d37393312f98e588df4cf2122683e4456995e98
```

What it wrote (the diff is the whole record of the human's decision):

```diff
-    chosen: "stdout, plus an optional file path"
+    chosen: "stdout only"
+confirmation:
+  by: "SS"                      # a NAME, not an identity (ADR-018): the token is what binds
+  at: "2026-10-01T02:00:02.958Z"
+  method: bounded-choice
```

And the two runs either side of that edit, with the acceptance binding to the token:

```
$ … run … --confirmed-requirement sha256:867d9fa97c4d…      # the token from BEFORE the confirmation
  step artifact_acceptance: failed — the requirement document … is not the one that was confirmed
    (confirmed 867d9fa97c4d …, the document now hashes to aa26fa885a40): re-confirm the edited
    document before it can be accepted
  step delivery: skipped — skipped (dependency failed: artifact_acceptance)
✓ workflow "blackbox-acceptance" failed              EXIT=1

$ … run … --confirmed-requirement sha256:aa26fa885a40…      # the token the confirmation printed
  step judge_forge: completed — judge forged: … judge.sh sha256:6bf3582e4530 (outside …/worktree)
  step artifact_acceptance: completed — acceptance PASSED: the confirmed requirement is satisfied
  step delivery: completed — delivery bundle ready (5 artifacts)
✓ workflow "blackbox-acceptance" completed           EXIT=0
```

The ACCEPT artifact it wrote carries that token as the requirement digest, so the chain is closed:
the number the human typed → the document → the token → the acceptance the machine ran.

Refusals, each demonstrated by a real invocation: a pipeline (`echo "" | … confirm`) is refused with
`stdin is not a TTY` and prints no token; `--dry-run` lists the decisions read-only and exits 1 while a
blocking decision has neither default nor choice; `[q]` exits 2 and writes nothing; a blocking decision
answered `[s]` refuses, writes nothing, and prints no token.

What this does NOT do, stated plainly: the judge checks that every decision is RECORDED (DOC-001) and
that the declared relations hold — nothing yet derives a check from a `chosen` value, so an
implementation that does the opposite of a decision the document records is caught only if a relation
or an anchor happens to disagree. That gap is recorded in ADR-027 and is the next thing worth closing
in the judge's vocabulary. Nothing in the command is language-specific, and nothing verifies the
language either: a Chinese or Japanese document renders as written and is judged the same way.

## 11. A decision the human recorded is a decision the implementation must honour (ADR-028)

Section 10 recorded the gap plainly: the judge checked that every decision was RECORDED (DOC-001) and
that the declared relations held, but nothing derived a check from the `chosen` option — so a document
that chose "first row wins" and an implementation that keeps the last row would pass.

The document now says which check SETTLES which decision, and the check's fixture and expected values
come from the answer:

```yaml
    - id: REL-003
      relation: duplicate-resolution
      decides: AMB-002          # this relation is the one that settles AMB-002
    - id: REL-004
      relation: malformed-row-accounting
      decides: AMB-001
    - id: DIFF-001
      anchor: independent-aggregation
      decides: AMB-004          # the rounding rule the judge recomputes with
```

The forge refuses, before any judge exists, when the binding is incomplete or unmechanisable. Each
refusal was produced by a real invocation:

```
$ … forge …                                        # REL-003's `decides: AMB-002` removed
blocking decision(s) AMB-002 are exercised by no declared relation or anchor: add "decides: AMB-nnn"
to the check that settles them — a blocking decision nothing checks does not bind the implementation

$ … forge …                                        # a relation pointing at a decision that is not there
"REL-003" exercises "AMB-099", which is not a decision in this document: a check bound to nothing
decides nothing

$ … forge …                                        # AMB-002 answered "Ask the user at runtime"
the decision AMB-002 chose "Ask the user at runtime", which the relation REL-003 cannot mechanise —
this forge can decide "The row with the latest start_date wins" "First row wins" "Last row wins"
"Treat it as an error": either change the option in the document or implement it in the forge, but a
decision nobody can check is not a decision

$ … forge …                                        # no relation exercises a rounding decision
no declared relation or anchor exercises a rounding decision, so the judge would have to assume how
salaries are rounded: point a relation or anchor at the decision that settles it
```

What makes it evidence rather than ceremony is the FLIP: the same implementation, the same fixtures,
only the human's answer changed — and the verdict moves.

| the document chose | the implementation (unchanged) | the run |
| --- | --- | --- |
| the row with the latest start_date wins | keeps the latest start_date | `9/9 ok` → `acceptance PASSED` → `ACCEPT-001` written, delivery ready | 
| First row wins | keeps the latest start_date | `not ok REL-003 … late-date total 537 want 428` / `not ok DEC-002 AMB-002 NOT honoured: "First row wins" (checked by REL-003, which failed)` → `delivery skipped` | 
| the row with the latest start_date wins *(restored)* | keeps the latest start_date | `acceptance PASSED`, `ACCEPT-001` carries all nine checks |

The real runs, verbatim from the middle row:

```
$ … run … --confirmed-requirement sha256:23d93ab3417d…      # the document the flip was confirmed as
  step judge_forge: completed — judge forged: …/judge.sh sha256:44c838119fda (outside …/worktree)
  step artifact_acceptance: failed — acceptance FAILED: the harness reported a failing verdict
    not ok 3 - REL-003 duplicate-resolution: the chosen option "first-row" does not hold
      (headcount 4 want 4, late-date total 537 want 428, early-date total 428 want 428)
    ok 7 - DEC-001 AMB-001 honoured: "Skip the row, count it, and report the count" (checked by REL-004)
    not ok 8 - DEC-002 AMB-002 NOT honoured: "First row wins" (checked by REL-003, which failed)
    ok 9 - DEC-003 AMB-004 honoured: "Half-up, no currency printed" (checked by DIFF-001)
  step delivery: skipped — skipped (dependency failed: artifact_acceptance)
✓ workflow "blackbox-acceptance" failed                       EXIT=1
```

And the ACCEPT artifact is now legible from the human's side — the checks list says which decision each
binding settled:

```
  checks:
    - "pass: REL-003 duplicate-resolution: 'latest-start-date' holds on both duplicate fixtures (headcount 4, totals 537 / 428)"
    - "pass: DEC-001 AMB-001 honoured: 'Skip the row, count it, and report the count' (checked by REL-004)"
    - "pass: DEC-002 AMB-002 honoured: 'The row with the latest start_date wins' (checked by REL-003)"
    - "pass: DEC-003 AMB-004 honoured: 'Half-up, no currency printed' (checked by DIFF-001)"
```

Two further runs of the same kind are in the regression suite (`judge-forge-decisions.test.ts`, 12
tests, all passing): the malformed-row answer "Stop with an error" fails DEC-001 against an
implementation that skips and counts, and the rounding answer "Truncate" fails DIFF-001 and DEC-003.

Honest limits, stated rather than worked around: the binding is DECLARED by a human in the document and
nothing verifies that the check really exercises the decision it claims (a "decoration binding" is not
caught); the matching is on the option's text, so re-wording an option without touching the forge
refuses rather than mis-checks; AMB-003 (where the summary goes) is not mechanised and is reported as
`# not mechanised (non-blocking decision)` — never as ok — so an implementation that writes a file when
the document chose stdout-only is still accepted; and the fixture rows themselves are still fixed in the
forge, with only the algebra around them driven by the answer.

## 12. The failure comes back (ADR-029), and the loop closes by itself

Section 11 ended with a rejection: an acceptance that failed, a red line in a terminal, and a document
that had learned nothing. The human had to notice, edit the requirement by hand, re-run
`takumi requirement digest`, and carry a new token to the next run — the clerical work the mode exists
to remove, with the easiest step to skip being the one that matters.

Now the run writes the failure back itself. The whole loop, verbatim from real invocations:

```
$ … run … --confirmed-requirement sha256:8644a79ff4…        # the broken reference deliverable
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
```

The document gained the entry, with the failing checks verbatim and the digest it was judged at:

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

Four things follow, each demonstrated on the real repository rather than argued for:

1. **The failure is citable.** `REJECT-001.md` sits beside `ACCEPT-001.md` (`kind:
   acceptance-reject`) with the requirement digest, the digest after the write-back, the head, the
   worktree, the forged judge and its digest, every check, the failing checks on their own, and the
   judge's own output. The delivery bundle grew by one artifact: the rejection travels with the run.
2. **The failure is visible from the human's side.** `takumi requirement feedback …` prints the entry
   with its run, both digests and the failing checks, and exits 1 while it is open — a pipeline can
   gate on it without approving anything.
3. **The old confirmation is dead by construction.** A second run with the same token is refused by
   name: `is not the one that was confirmed (confirmed 8644a79ff49b …, the document now hashes to
   cc157afd540c)`. Nobody has to remember to invalidate anything, and a refusal is not itself written
   back — the run's own failure record is untouched, and no second `feedback:` entry appears.
4. **The human's number closes it.** `takumi requirement confirm` opens with the failure and one bounded
   choice — and `[enter]`, the safe answer, is `leave it open`:

   ```
   The last acceptance of this document FAILED and wrote FB-001 back into it (2026-10-01T05:05:57.188Z):
     REL-002 additivity: …   REL-003 duplicate-resolution: …   DEC-002 AMB-002 NOT honoured: …
     FB-001: what addresses this failure?
       [1] the failure is addressed — mark it resolved
       [2] leave it open   (current)
       [enter] keep the current/default choice      [q] abort
       >
   refused: FB-001 is still open. A document with a known failure in it is not confirmable:
     fix what failed and re-confirm, or record a resolution and say what addresses it:
     takumi requirement resolve docs/requirements/poc-blackbox-acceptance.yaml --id FB-001 --note "what addresses it"
   ```

   and answering `[1]` resolves the entry in the same act as the confirmation, with the new token
   covering both writes:

   ```
   sha256:966dae0656c65597bfa2e22dd440ab57477b89ffcffa0b474f8b0b5194100971
   ```

   With the correct deliverable back in the worktree, that token is accepted:
   `step artifact_acceptance: completed — acceptance PASSED`, nine checks (`DEC-001 … DEC-003` among
   them), `delivery bundle ready (7 artifacts)`, `EXIT=0`. The entry stays on the record as resolved,
   with who said so, when, and that it was answered at re-confirmation by bounded choice.

Honest limits, stated rather than worked around: nothing verifies that the implementation actually
changed between a resolution and the next acceptance — the human's assertion is the closure, and the
judge fails again if it was wrong; the `feedback:` block lives in the same document as the decisions and
grows without archiving; an entry is one per failed run, not one per failing check; two runs against the
same document can interleave writes (no lock — last writer wins); and only a rejection the JUDGE
produced is written back, so a run that could not be accepted (a stale confirmation, a judge that never
ran) leaves the document alone and says so in its summary.

## 13. Answering a failure becomes a choice, and the intake finally sees it (ADR-030)

Section 12 ended with the human's number closing a failure — but "the failure is addressed" was all the
record said, and nothing told the human which decision the failing check was even about. A failure has
two different repairs and they are not interchangeable: the implementation ignored the answer that was
recorded, or the answer itself was wrong.

The machine can only do part of that, and it does exactly that part: trace a failing check to the
decision it EXERCISES, name the answer recorded for it, and offer that decision's own alternatives.
`takumi requirement brief <ref>` prints it — read-only, nothing generated:

```
$ takumi requirement brief docs/requirements/poc-blackbox-acceptance.yaml
## Acceptance feedback (written back by the machine)
…
### FB-002 — OPEN (run wf-82150fff)
- **REL-002** — REL-002 additivity: department totals sum to 428 but the report says 214 — sum=428 reported=214
  - REL-002 is a declared check, and it exercises no decision: the failure is about the implementation
    (or about a piece of the requirement no decision covers), not about an answer the human gave
- **REL-003** — REL-003 duplicate-resolution: the chosen option "latest-start-date" does not hold …
  - decision: AMB-002 (blocking) — Which row wins when employee_id repeats?
  - recorded answer: The row with the latest start_date wins
  - the implementation did not honour it. Either the implementation changes, or the answer does:
    - First row wins
    - Last row wins
    - Treat it as an error
- **DEC-002** — DEC-002 AMB-002 NOT honoured: "The row with the latest start_date wins" …
  - decision: AMB-002 (blocking) … (traced by its numbering, not by a binding the document wrote twice)
```

That trace is what the confirmation now asks about — and the safe answer is still the refusal:

```
  The last acceptance of this document FAILED and wrote FB-002 back into it (2026-10-01T05:38:10.666Z):
    REL-002 additivity: … REL-003 duplicate-resolution: … DEC-002 AMB-002 NOT honoured: …
    This failure is about AMB-002, currently answered "The row with the latest start_date wins".
    Either the implementation ignored that answer, or the answer itself was wrong.
    FB-002: what settles this failure?
      [1] the recorded answer stands and the IMPLEMENTATION changes — mark it resolved
      [2] the answer was wrong — decide that decision again below
      [3] leave it open   (current)
      > 2
      … then, at AMB-002, [enter] (keep the recorded answer):
  refused: you answered that the answer was wrong, but AMB-002 still reads "The row with the latest
    start_date wins" — nothing changed.
    Pick a different option for AMB-002, or say that the implementation changes instead.
```

The claim has to have content, and the document is right there to check it against. Answering `[2]` and
actually changing the decision closes the failure with the decision that answered it recorded:

```yaml
    status: resolved
    resolvedNote: "the answer was wrong: AMB-002 was re-decided at this confirmation (2026-10-01T05:40:23.583Z)"
    resolvedByDecision: "AMB-002"
```

And the narrative loop then closes for real, with the implementation changed to match the new answer
(a hand-written last-row-wins deliverable, since the `fake` runtime's agent cannot write code):

```
$ … run … --confirmed-requirement sha256:11ae8bda80ff…
  step quality_gate: completed — quality_gate PASSED: 0 failing over 2 tests, exit 0
  step judge_forge: completed — judge forged: …/judge.sh sha256:15b5e1e9a38a (outside …/worktree)
  ok 3 - REL-003 duplicate-resolution: "last-row" holds on both duplicate fixtures (headcount 4, totals 537 / 537)
  ok 8 - DEC-002 AMB-002 honoured: "Last row wins" (checked by REL-003)
  step artifact_acceptance: completed — acceptance PASSED: the confirmed requirement is satisfied
  step delivery: completed — delivery bundle ready (7 artifacts)
✓ workflow "blackbox-acceptance" completed                        EXIT=0
```

Note what did NOT change: the deliverable's own test. It asserts the summary's shape and never the
duplicate rule — the implementer's blind spot — so it stayed green while the rule underneath it changed,
and the forged judge is what actually checked the new answer.

Finally, a decision may cite the failure it came from (`fromFeedback: FB-nnn`), and a citation that
names nothing is refused twice — before a human is asked, and again at acceptance time:

```
$ takumi requirement confirm docs/requirements/poc-blackbox-acceptance.yaml --dry-run
docs/requirements/poc-blackbox-acceptance.yaml: the document does not hold together — 1 issue(s):
  AMB-003 cites FB-099, which this document does not record as an acceptance failure: a decision that
  came from nothing is a decision nobody asked for
Nothing was written. Fix the document first (a decision that came from a failure must name one).   EXIT=1

$ … metamorphic-forge.sh …
a decision cites "FB-099", which this document does not record as a failure (recorded: FB-001 FB-002 ):
a citation that names nothing is a claim nobody can check                              EXIT=1
```

Both were produced by adding that one line to the real document and removing it again — which is why the
token above is still `sha256:11ae8bda80ff…` afterwards: the digest is a function of the text, and the
text is back.

Honest limits, stated rather than worked around: the trace is only as good as the document's own
`decides:` binding (a "decoration binding" would trace a failure to the wrong answer — ADR-028's limit,
unchanged); the alternatives are the decision's OWN options, so an answer that is not among them cannot
be offered (the intake has to widen them, and the forge has to be able to test them); nothing verifies
that the human's choice was right (the next acceptance does); the intake's compliance with its re-pass
contract is a prompt and a shape, not a proof — its output is checked as a document, and its JUDGEMENT is
the human's confirmation; and the brief contains no generated content, deliberately, because deciding
what an undecided point should offer needs the semantics of the request.




