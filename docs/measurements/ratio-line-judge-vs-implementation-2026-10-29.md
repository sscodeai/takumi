# The ratio line: the judge and a correct implementation, checked against each other

Measured 2026-10-29.

## What was checked

The unattended run `wf-77e08360` failed at acceptance, and the reason mattered: the **implementation** was
wrong, not the document and not the judge. Its own docstring described `region,amount` — the input of a
previous request — because the delivery repository's `main` already held eight prior runs' results
(`a-reused-delivery-repository-collides-across-requests`).

So the three parts were checked against each other directly:

| part | where it came from |
|---|---|
| document | `1c5f8da:docs/requirements/intake.yaml` — declares `suite:id,passed:measure,total:other`, `run: "bash summary.sh {csv}"`, `relation: derived-ratio` |
| implementation | the same commit — `bash summary.sh` prints `checkout 8 10 80.0` / `search 3 4 75.0` / `TOTAL 14` |
| judge | forged by run `wf-77e08360`, `sha256:baff43eae8df` |

Command:

```
cd .takumi/acceptance/wf-77e08360/judge_forge
TAKUMI_REQUIREMENT=<takumi>/docs/requirements/intake.yaml \
TAKUMI_PROJECT=/tmp/vfy TAKUMI_WORKTREE=/tmp/vfy TAKUMI_JUDGE_DIR=$PWD bash judge.sh
```

## Result

```
ok 1 - REL-001 derived-ratio: each of 3 printed ratio(s) equals its own numerator/denominator (rounding: half-up)
ok 2 - DOC-001 every open decision has a chosen option (6/6)
ok 3 - DEC-001 AMB-001 honoured: "half-up: round half away from zero, so 6.25 becomes 6.3" (checked by REL-001)
```

3 of 3.

## What this does and does not establish

**Does:** with a document that declares a ratio answer and an implementation that computes it, the judge
forged from that document passes it. The judge is not the obstacle. The `derived-ratio` relation, the
decision binding (`DOC-001`), and the honouring of the chosen rounding (`DEC-001`) all work end to end on
the real forge output, not on a fixture written to make them pass.

**Does not:** establish that an unattended run lands this in one go. The last attempt died on a
cross-request collision in a shared demo repository. That is filed as a limitation and is not fixed.

## How the collision was caught, which is the point

The judge refused a delivery whose output did not match the shape its own document declared. Nobody
passed it "because the tests were green": `quality_gate` was green, `worktree_clean` was green,
`rule_review` passed, and the delivery was still refused. That is the behaviour the whole chain exists
for.
