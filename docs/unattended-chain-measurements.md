# Unattended chain — measured success rate

Every row below is an END-TO-END measurement on the real machine: one sentence in, a merged pull
request out, nobody at the keyboard. Credentials are injected by name and never printed; the model
is `opencode-go/deepseek-v4.1-flash` in every row.

**Method:** 3 consecutive runs per round, serial, 20 s apart, each run a fresh
`scripts/autopilot.sh "<one sentence>"`. A run counts as a success only when the harness created
the pull request AND the host's own pipeline went green AND the merge step landed it — verified
afterwards against the run record (`accepted: true`, `merge` step `done`) and the pull request's
own state, never from the driver's exit code alone.

| Round | head | boundary | Runs | Success | What the failures were |
|---|---|---|---|---|---|
| 1 | `1dc87ae` (before the boundary) | off | 3 | **2 of 3** | run 2 refused: the judge spoke `fail` in 7.6 s on attempt 1, and on attempt 2 the step's own 120 s bound SIGTERMed it — recorded as `the acceptance verdict marker … was missing` (ledger #77) |
| 2 | `6da077e` (boundary merged) | **on** (unshare) | 3 | **0 of 3** | every run died at `judge_forge`: `bash: extensions/judges/metamorphic-forge.sh: No such file or directory`. The boundary made the platform repository invisible to the platform's OWN tools (ledger #75) — **reverted** |
| 3 | `4387b4f` (boundary reverted) | off | 3 | **2 of 3** | run 1: same 120 s kill as round 1, twice (7,616 ms spoken vs 125,092 ms killed, same judge digest) |
| 4 | `8056878` (#76 diagnosis, #77 silent-judge, #78 preflight) | off | 3 | **3 of 3** | none |

## Round 4 in detail (15:43Z, 2026-10-12)

| Run | run id | wall clock | Pull request | What it took |
|---|---|---|---|---|
| 1 | `wf-e368c886` | 3,868 s (64.5 min) | [#21](https://github.com/sscodeai/takumi-delivery-demo/pull/21) merged, 16 files | attempt 1 refused by the judge, **repair round 2 accepted** (11 checks ok) |
| 2 | `wf-2a491cd3` | 1,770 s (29.5 min) | [#23](https://github.com/sscodeai/takumi-delivery-demo/pull/23) merged, 2 files | accepted on attempt 1 |
| 3 | `wf-3a2246f4` | 3,831 s (63.9 min) | [#25](https://github.com/sscodeai/takumi-delivery-demo/pull/25) merged, 5 files | intake repaired (attempt 2) AND delivery repaired (attempt 2) |

## What the numbers say, including what they do not

1. **3 of 3 is three runs.** It is not a reliability figure; it is the first round with no failure
   in it, and the round before it, on code one fix older, was 2 of 3. The honest summary of the
   current head is **5 of 6 over rounds 3 and 4** (83%), with the boundary off.
2. **The repair loop is load-bearing.** In round 4 the FIRST attempt succeeded only once (run 2):
   runs 1 and 3 were rescued by the repair round. So "3 of 3" is really "1 of 3 first try,
   3 of 3 with the loop", and the loop is the thing the 120 s bound was killing (round 3).
3. **The cost of an honest bound.** A bound wide enough for a judge that runs the delivered
   project (900 s, ledger #77) means a FAILING judge now runs to its natural end instead of being
   cut off at 120 s: round-4 runs took 30–65 minutes against 9–29 minutes before. Wall clock is
   the price of not executing correct deliveries.
4. **There is no isolation.** The boundary is reverted: the delivery agent runs with the
   operator's own write access to the host, and it has demonstrably edited the platform repository
   while being judged (ledger #68). Until the boundary returns — redesigned so it confines the
   agent and not the platform's own tools — this chain is for low-risk, revertible repositories
   with a human watching. It is not to be pointed at a production repository unattended.
5. **Failures here are cheap and closed.** Every failure in every round stopped the chain and named
   the step; none of them merged anything, and none of them edited a document to get past a check.

## Reproducing a round

```bash
source /srv/hermes/.env            # OPENCODE_GO_API_KEY (injected, never printed)
export TAKUMI_PI_RUNTIME=/abs/path/to/runtimes/pi/dist/index.js
pnpm -r build                      # the chain runs apps/cli/dist
bash scripts/preflight-unattended.sh   # refuses to measure an unhealthy machine (ledger #76)
bash scripts/autopilot.sh "<one sentence>"
```
