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
| `extensions/workflows/blackbox-acceptance/workflow.yaml` | The eight steps, using only the seven existing step types. |
| `extensions/workflows/blackbox-acceptance/checks/acceptance-tap.sh` | The PoC-1 acceptance stand-in: a real fail-closed TAP harness. |
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
