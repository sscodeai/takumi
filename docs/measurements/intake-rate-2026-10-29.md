# The intake's first-attempt rate — measured, not assumed

Measured 2026-10-29 with `scripts/measure-intake-rate.sh 3`.

## Why this file exists

`docs/limitations.yaml` carried `intake-reliability`: "the first-attempt rate is not something the
chain claims". That sentence was written BEFORE ledger #102 split the shape decision out of the
document. After #102 exactly ONE unattended run existed, so nothing could be said either way — and
editing the limitation to match a sample of one would have been the same mistake as leaving a stale
claim in it.

So it was measured.

## The three runs

Three different request shapes, not three copies of one:

| shape | request | attempt 1 passed the gate | delivered | seconds |
|---|---|---|---|---|
| ratio | pass percentage per suite from `suite,passed,total` | no | no | 1172 |
| aggregate | total revenue and mean per region from `region,amount` | yes | yes | 1052 |
| counts | open/closed ticket counts per assignee | no | yes | 1390 |

**First attempt: 1 of 3. Delivered: 2 of 3.**

Both failures were caught by the gate and fixed by the repair round. That is the REPAIR working, not
the intake being reliable — the distinction the limitation exists to preserve.

## The two failures were different defects

- **ratio** — the document omitted the `checkedAs: <half-up|truncate>` that a `derived-ratio` decision
  needs (`AMB-005` settled by `REL-004`).
- **counts** — the document declared no `deliverable.run` at all and recorded zero requirements.

Neither is the field-model confusion that #102 fixed, and the second one is what #107 addressed by
deciding the entry point in the short step.

## A defect this measurement exposed, which is NOT an intake defect

Run 1's follow-up attempt failed at `publish` with

```
the worktree has uncommitted changes; the runner never commits them
(first entry: M .github/workflows/ci.yml)
```

`ci_config` had written the pipeline file, the implementer had committed everything else, and every
gate — `quality_gate`, `rule_review`, `judge_forge`, `artifact_acceptance` — passed before `publish`
refused. Fixed in ledger #106 by checking the worktree right after the tests.

## And one it exposed that is a design boundary, not a bug

A later run of the SAME pass-percentage request produced an implementation whose own docstring
described `region,amount` — the input of the PREVIOUS request. The worktree is based on the delivery
repository's `main`, and `sscodeai/takumi-delivery-demo`'s `main` already held the merged results of
eight prior runs (PR #56–#70), all writing the same `docs/requirements/intake.yaml` and `summary.py`.
The implementer found that file and continued it.

The judge refused the delivery (the report matched no declared shape), so nothing incorrect landed.
Recorded as `a-reused-delivery-repository-collides-across-requests` in `docs/limitations.yaml`.

## What this does NOT say

It does not say the chain is unreliable in general: three runs is a small sample and the percentages
describe these runs. It says the first-attempt rate is **1 in 3 measured**, and that an unattended run
costs roughly three attempts' worth of tokens and time for two of every three requests.
