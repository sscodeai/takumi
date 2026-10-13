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
| 5 | `3eb0bcc` (#79: the boundary classified — the model's hands confined, the platform's own tooling open) | **on** (userns; `sandbox` read back from every run record) | 3 | **3 of 3** | none — every record says `sandbox=unshare` |
| 6 | `26e7e8e` (#79 + #80 + ADR-059: acceptance bounded, wait sized to the host pipeline) | **on** | 3 | **3 of 3** | none — every record says `sandbox=unshare` |

## Round 4 in detail (15:43Z, 2026-10-12)

| Run | run id | wall clock | Pull request | What it took |
|---|---|---|---|---|
| 1 | `wf-e368c886` | 3,868 s (64.5 min) | [#21](https://github.com/sscodeai/takumi-delivery-demo/pull/21) merged, 16 files | attempt 1 refused by the judge, **repair round 2 accepted** (11 checks ok) |
| 2 | `wf-2a491cd3` | 1,770 s (29.5 min) | [#23](https://github.com/sscodeai/takumi-delivery-demo/pull/23) merged, 2 files | accepted on attempt 1 |
| 3 | `wf-3a2246f4` | 3,831 s (63.9 min) | [#25](https://github.com/sscodeai/takumi-delivery-demo/pull/25) merged, 5 files | intake repaired (attempt 2) AND delivery repaired (attempt 2) |

## Round 6 in detail (04:12Z, 2026-10-13) — boundary ON, acceptance bounded, wait fixed

| Run | run id | wall clock | Pull request | record |
|---|---|---|---|---|
| 1 | `wf-0e298f71` | 2,223 s (37 min) | [#40](https://github.com/sscodeai/takumi-delivery-demo/pull/40) merged | `sandbox=unshare`, `accepted=true`, `merge=done`, `await_checks=done` |
| 2 | `wf-f244d4b8` | 2,473 s (41 min) | [#42](https://github.com/sscodeai/takumi-delivery-demo/pull/42) merged | same |
| 3 | `wf-dcf25354` | 2,280 s (38 min) | [#44](https://github.com/sscodeai/takumi-delivery-demo/pull/44) merged | same |

Across these three runs **neither of the two bound defects recurred**: no `still PENDING after 300s`
(#80) and no `KILLED at its ...ms bound` (#77).

## First attempt vs the repair round — the loop is load-bearing

Read out of the step summaries (`delivery accepted on the first attempt` vs `... on attempt 2 of 2`),
rounds 4-6, 9 runs:

| run | intake | delivery |
|---|---|---|
| round 4 — 1 | first try | **repair round** |
| round 4 — 2 | first try | first try |
| round 4 — 3 | **repair round** | **repair round** |
| round 5 — 1,2,3 | first try ×3 | first try ×3 |
| round 6 — 1 | **repair round** | first try |
| round 6 — 2 | first try | first try |
| round 6 — 3 | first try | first try |

**intake: 7 of 9 first try. delivery: 7 of 9 first try. End to end: 9 of 9 with the loop.** So
"3 of 3" is not "everything worked the first time" — roughly one run in four is rescued, and the loop
is what the old 120 s bound was killing (round 3).

## The boundary, measured twice

| round | boundary | how it was applied | runs | success |
|---|---|---|---|---|
| 2 | ON | to **every** step's shell command | 3 | **0 of 3** |
| 4 | off | — | 3 | 3 of 3 |
| 5 | ON | to **the model's seam only** (ledger #79) | 3 | **3 of 3** |
| 6 | ON | the model's seam (ledger #79) **and** the delivered project (the acceptance step asks for the read-only-platform boundary) | 3 | **3 of 3** |

Same boundary, opposite result, and the difference is not the boundary: it is **whose code it was
applied to**. The platform's own tooling lives inside the repository the boundary makes invisible.

## Round 5 in detail (18:19Z, 2026-10-12) — boundary ON

| Run | run id | wall clock | Pull request | record |
|---|---|---|---|---|
| 1 | `wf-6c8cf8a9` | 1,319 s | [#29](https://github.com/sscodeai/takumi-delivery-demo/pull/29) merged | `sandbox=unshare`, `accepted=true` |
| 2 | `wf-13b5ea67` | 1,276 s | [#31](https://github.com/sscodeai/takumi-delivery-demo/pull/31) merged | `sandbox=unshare`, `accepted=true` |
| 3 | `wf-66f0e7ca` | 1,575 s | [#33](https://github.com/sscodeai/takumi-delivery-demo/pull/33) merged | `sandbox=unshare`, `accepted=true` |

## What the numbers say, including what they do not

1. **3 of 3 is three runs.** Three rounds have now ended in 3 of 3 (rounds 4, 5 and 6), which is
   stronger than one — and still not a reliability figure. Across all six rounds the count is
   **13 of 18** (72%), and **6 of 6 with the boundary ON since it was classified** (rounds 5 and 6;
   round 2's 0 of 3 was the same boundary applied to the wrong code).
2. **The repair loop is load-bearing** (see the table above): 7 of 9 first try at each stage, 9 of 9
   with the loop. A chain that reported only end-to-end success would be hiding the only structure
   that makes it work, and the 120 s bound that used to kill it (round 3) is why this matters.
3. **The cost of an honest bound.** A bound wide enough for a judge that runs the delivered
   project (900 s, ledger #77) means a FAILING judge now runs to its natural end instead of being
   cut off at 120 s: round-4 runs took 30–65 minutes against 9–29 minutes before. Wall clock is
   the price of not executing correct deliveries.
4. **Isolation is back, and it is classified** (round 5, ledger #79): the boundary confines the
   MODEL's hands — an agent step's bash and its read/write/edit tools — and runs the platform's own
   tooling open, because that tooling lives inside the repository a boundary makes invisible (that
   was ledger #75: the same boundary, applied to every step, took this chain from 4 of 6 to 0 of 3).
   **What it still does not close, named:** the acceptance step runs the DELIVERED project open (the
   platform's harness runs it, and the deliverable is model-authored), so this is still not a chain
   to point at a production repository unattended without a human watching. The next unit of work —
   a read-only platform for platform steps, plus a repeatable chain check
   (`scripts/verify-boundary-chain.sh`) — is specified, not built.
5. **Two of the failures were the workflow's own clocks, not the delivery's** (ledgers #77 and #80):
   a 120 s acceptance bound that killed a judge holding 4 passed checks, and a 300 s wait that gave
   up **four seconds** before the host's pipeline went green. Both bounds are now sized to what they
   wait for, and the engine names the clock when it is the clock. The limits that remain are listed
   in `docs/limitations.yaml`, which a test enforces (ADR-059).
6. **Failures here are cheap and closed.** Every failure in every round stopped the chain and named
   the step; none of them merged anything, and none of them edited a document to get past a check.

## Reproducing a round

```bash
source /srv/hermes/.env            # OPENCODE_GO_API_KEY (injected, never printed)
export TAKUMI_PI_RUNTIME=/abs/path/to/runtimes/pi/dist/index.js
pnpm -r build                      # the chain runs apps/cli/dist
bash scripts/preflight-unattended.sh   # refuses to measure an unhealthy machine (ledger #76)
bash scripts/autopilot.sh "<one sentence>"
```
