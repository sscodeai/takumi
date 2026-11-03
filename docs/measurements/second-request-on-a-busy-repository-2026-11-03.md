# A second request, landing on a repository whose main already held eight

Measured 2026-11-03. This is the evidence `a-reused-delivery-repository-collides-across-requests`
(#112) was waiting for.

## The setup that used to fail

`sscodeai/takumi-delivery-demo`'s `main` held the merged results of eight prior runs (PR #56–#70),
every one of them writing the same `docs/requirements/intake.yaml` and `summary.py`. On 2026-10-29 a
pass-percentage request in that repository produced an implementation whose own docstring described
`region,amount` — the input of an earlier request — because the implementer found `summary.py` there
and continued it. The judge refused the delivery, correctly, and the run was spent.

## What was changed (#114)

The implementer prompt now says the directory may already contain another request's work, names that
measured failure, and gives the rule: take the input world from THIS document's
`input_format.columns`; do not infer the input from what is on disk; REPLACE an inherited file whose
behaviour the requirement does not mention; and do not clear the repository to start over.

## The run

`wf-0a7781cf`, same request, same repository — still holding eight prior requests' results.

- intake passed on the **first** attempt, declaring `derived-ratio` and `mutation-detection`
- the confirmation was approved
- the implementer produced `summary.py`, docstring:

      Per-suite pass-percentage report behind ``bash summary.sh <csv>``.
      input:        CSV whose header names suite, passed, total

  — the declared input, not `region,amount`
- `bash summary.sh` on `suite,passed,total / checkout,8,10 / search,3,4` prints

      checkout 8 10 80.0
      search 3 4 75.0
      TOTAL 11

- judge `451dfee0c701` against worktree `847c853`:

      ok 1 - REL-001 derived-ratio: each of 3 printed ratio(s) equals its own numerator/denominator (rounding: half-up)
      ok 2 - REL-002 mutation-detection: the delivered tests fail when the delivered behaviour is mutated (0 survivor(s) tolerated)
      ok 3 - SCN-001 the delivered tests pass, including half-up rounding, duplicate-suite merging, skipping of zero-total and non-numeric rows, the TOTAL line and deterministic ordering
      ok 4 - DOC-001 every open decision has a chosen option (8/8)
      ok 5 - DEC-001 AMB-001 honoured: "half-up: round half away from zero, so 6.25 becomes 6.3" (checked by REL-001)

  5 of 5.

## What this establishes

A request can land correctly on a repository whose `main` already holds a different request's merged
work, when the implementer is told what an inherited file means. The collision in #112 is closed by
the mechanism #114 put in place, and the measurement above is the real run its closing condition
asked for — not a test.

## What it does not establish

The **run** still failed: `artifact_acceptance` aborted the delivery on the mutation relation before
the worktree reached the state measured above. The judge invoked `bash run-mutation.sh` and got
`exit 127`, while the same command run by hand — and under `unshare -r -n`, and under `sh -c` as the
judge does — succeeds with 18 mutants killed and 0 survivors. The worktree at acceptance time
therefore did not yet contain what it contains now.

That is a **distinct defect**, not a continuation of #112: a delivery step can be judged before the
files it declares exist. It is filed separately rather than folded in here, because the honest reading
is "the collision is fixed; the mutation harness was judged too early", and merging the two would let
the second one hide behind the first.
