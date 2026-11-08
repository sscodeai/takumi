# The intake, on the first attempt, end to end

Measured 2026-11-09, run `wf-20794cb8`.

## The run

Request: a command-line tool that reads `suite,passed,total` and prints a pass percentage per suite.

```
intake_attempt         delivery accepted on the FIRST attempt
ambiguity_confirmation approved
judge_forge            forged, sha256:53a08b1f0381
artifact_acceptance    PASSED (3 checks ok) — ACCEPT-001 written
publish                PR #87 opened
merge                  MERGED, head 746b5cd0
== delivered
```

No repair round, no re-confirmation, no human step.

## What landed

`sscodeai/takumi-delivery-demo` `main`, `docs/requirements/intake.yaml`:

```
run:      "bash summary.sh {csv}"
columns:  "suite:id,passed:measure,total:other"
relation: derived-ratio
```

## What it took

Fourteen ledger rows (#129–#142), and only two of them were about the intake's *output*:

| # | what was broken |
|---|---|
| #129 | a deterministic repair step, so a missing decided value does not cost a whole rewrite |
| #130 | the step named `{requirement}`, which does not exist at intake time |
| **#131** | **the measurement counted a run that never started as a pass** |
| #132 | a step read `{step.shape_decision}` without depending on that step |
| **#133** | **`renderPrompt` matched `\w+`, which has no dot — so `{step.X}` never substituted, in ANY workflow** |
| #134 | step 1 answers inside a ``` fence, which the key reader could not see |
| #135 | a multi-line answer cannot travel as a quoted shell argument |
| #136 | a relation step 1 did not allow is dropped |
| #137 | the repair edits the document, so it must refuse one that is not YAML first |
| #138 | a blocking decision no check exercises is bound via its `checkedAs` mode |
| #139 | on a QUOTIENT answer, do not write decisions nothing can check |
| #140 | and when the model writes them anyway, remove them |
| #141 | a `differential:` entry names its check with `anchor:`, not `relation:` |
| #142 | two ids on one key |

**Eight of those fourteen were defects in the CHAIN, not in the model's output** — including one
(`#133`) that silently disabled every step-to-step handoff in every workflow, and one (`#131`) that made
the measurement itself lie.

## What this does NOT establish

**One run.** The measured first-attempt rate before this was **1 in 6** across rate9 and rate10 (the two
measurements taken after the chain was functional). A single first-attempt pass does not move that
number, and `intake-reliability` in `docs/limitations.yaml` stays open for exactly that reason: an
unattended run must still be expected to cost two to three attempts for most requests.

What it DOES establish is narrower and worth having: the repairs work, the chain hands its own decisions
from step to step, and a first attempt *can* pass — which was not true while #133 was in place.
