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

| 7 | `b3b559c` (a FRESH target repository: 1 commit, a README) | **on** | 3 | **0 of 3** | none reached the delivery leg. All three died at `publish` with `remote: Permission to sscodeai/takumi-delivery-demo-2.git denied to sscodeai` (recorded here as a credential that had not been selected for the new repository — see the CORRECTION below, ledger #89). The IMPLEMENTATION leg was **3 of 3 from scratch** (entry point, sources, tests, docs — the delivery agent's own words in earlier rounds were "the branch ALREADY carried a complete delivery, so the work was to VERIFY it") and the forged judge accepted all three (ledger #81) |
| 8 | `7972d62` (#81: the preflight probes the delivery target) | **on** | 3 | **0 of 3** | a DIFFERENT FAMILY of requirement — the length of the shortest path over a grid map. Every run died at `intake_shape` in ~7 minutes, **before any implementation was paid for**, because this chain's judge checks a deliverable's ANSWER with exactly one relation (an aggregate of a per-row numeric measure) and a path length is not one (ledger #82) |
| 9 | `99b4e66` (#52: rounding asked only of the checks that need it) | **on** | 3 | **0 of 3** | the same sentence and the same refusal as round 8, ~7 min each: the intake still described a graph requirement with record-family relations, and the repair round — handed the two ways out in words — added `mutation-detection` ON TOP of them instead of replacing them (ledger #83's condition was fixed; the document was the problem) |
| 10 | `8be7e142` (#54: the intake is told which of the two shapes it is writing) | **on** | 3 | **0 of 3** | the intake wrote **exactly** the Shape B document the prompt asks for (one scenario, no world) — and every run died at `intake_shape` **check 2**, the front door validator, in **2.5 minutes** each: `the deliverable block declares no input_format`. The forge never saw the document (ledger #85) |
| 11 | `a5f016d` (#55: the front door demands the world only where it is used) | **on** | 3 | **0 of 3** | **all three got past the intake** (one on the first attempt) and into the delivery side, 30-60 min each: RUN 1 and 3's ATTEMPT 1 passed the gate (620/625 tests) and was refused by the JUDGE (`artifact_acceptance FAILED`), and only their ATTEMPT 2 died at a gate that could not read a test summary (`0 failing over 0 tests`, `shape: unrecognised`, exit 0) — a symptom of the repair round being briefed with the PASSING gate; RUN 2 reached the **forged judge**, which refused the delivery — and the repair round was briefed from a gate that had PASSED (ledger #86) |
| 12 | `b45068c` (#56: the attempt's verdict and brief come from the JUDGE, not from a gate that passed) | **on** | 3 | **2 of 3** | **the first cross-family round.** The sentence was a graph shortest path over a grid map. Two runs delivered and MERGED it: `wf-cd0be302` 3,297 s (55 min) → demo PR [#46](https://github.com/sscodeai/takumi-delivery-demo/pull/46), and `wf-41f48e83` 767 s (12.8 min) → PR [#48](https://github.com/sscodeai/takumi-delivery-demo/pull/48); both records `accepted=true`, `sandbox=unshare`, every step `done`, both PRs `MERGED`. The failure (RUN 2) is a **legitimate judge rejection**, and its reason is now ON RECORD: `not ok 5 - DEC-001 AMB-001 NOT honoured … (checked by REL-001, which failed)`, `failing checks: REL-001, DEC-001` (ledger #86 fixed the path that used to lose it) |
| 13 | `37744ab` (#57) | **on** | 3 | **3 of 3** | a **THIRD family**: *a JSON file holding an array of objects → the keys common to every object, sorted, or `none`*. All three delivered and MERGED (`wf-26464daa` 1,174 s → PR [#50](https://github.com/sscodeai/takumi-delivery-demo/pull/50); `wf-eed989e0` 2,429 s → PR [#52](https://github.com/sscodeai/takumi-delivery-demo/pull/52); `wf-69435629` 2,300 s → PR [#54](https://github.com/sscodeai/takumi-delivery-demo/pull/54)), every record `accepted=true sandbox=unshare`. **RUN 2 is the repair path working for a non-record family**: its judge refused attempt 1 (`acceptance FAILED`) and attempt 2 was accepted — what round 12 could not do. RUN 3's attempt 1 failed a quality gate and was repaired too. The round also EXPOSED a leak (ledger #87): RUN 2's delivery copied the platform's `docs/authorizations/SA-002.yaml` into the PUBLIC target repository |
> **CORRECTION (2026-10-15) — in rounds 12 and 13 the AGENT's hands were OPEN.**
>
> Both rounds ran against the pi runtime artifact built 2026-10-12 20:20 JST
> (`runtimes/pi/dist/index.js`). It predated the confinement source by ~4.5 h and carried none of it:
> `grep -c 'noTools\|createConfinedTools\|confinementOf' runtimes/pi/dist/index.js` = `0/0/0`, while
> `runtimes/pi/src/index.ts` and `runtimes/pi/src/confinement.ts` landed at 00:48 JST on 2026-10-13.
> `runtimes/pi` is not a pnpm workspace member and `dist/` is gitignored, so `pnpm -r build` never
> rebuilt it, and a stale build loads fine — so the runtime that ran rounds 12 and 13 handed the
> model the SDK's BUILTIN tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) while the
> record said `sandbox: unshare` (verified in this repository's own run records:
> `.takumi/runs/wf-cd0be302.json`, `wf-41f48e83.json`, `wf-26464daa.json`, `wf-eed989e0.json`,
> `wf-69435629.json`, each `"sandbox": "unshare"`).
>
> Read the `sandbox=unshare` in rows 12 and 13 (and in the per-run detail beginning at
> `docs/unattended-chain-measurements.md:169` and `:203`) as the boundary that was CONFIGURED, not as
> "the model's hands were contained". The one thing under a boundary in those runs was the ACCEPTANCE
> HARNESS's subject — the delivered project, via `sandboxPlatform` (platform read-only). The
> platform's own step commands were not confined either, and deliberately so (ledger #79 runs them
> where the platform lives). What happened in the agent's session is the consequence ledger #88 was
> written for: round 13 RUN 2 read the platform's own `docs/authorizations/SA-002.yaml` and copied it
> byte-identical into the target repository (`sha256:8067ab6c…`, commit `47ab7996`, PR #52) — a read a
> confined agent could not have made (ledger #87 records the copy; ledger #88 records why the
> boundary was absent).
>
> This is a correction of the CLAIM, not a re-measurement: no figure in the tables above changes, and
> the success counts (round 12: 2 of 3; round 13: 3 of 3) stand. The fix is ledger #88: the runtime
> is rebuilt, `runtimes/pi/src/test/session-confinement.test.ts` measures the artifact's own tools,
> `scripts/preflight-unattended.sh` refuses a dist older than its source, and the run record now
> carries a derived `boundaries.agentTools` so this cannot be read past again.

> **CORRECTION (2026-10-18) — round 7's cause was recorded one layer too high (ledger #89).**
>
> Round 7 is written above as "the credential is a fine-grained PAT, selected per repository, and the
> fresh target was not in its list". The failure MESSAGE said that; the CAUSE was not established.
> Measured 2026-10-18: the credential **is** selected for the target — the API answered **201** for
> creating a branch, writing a file and opening a pull request on `sscodeai/takumi-delivery-demo-2` —
> while the transport the `publish` step really uses (`git push`, per
> `packages/delivery-forgejo/src/index.ts`, with the pull request opened after it) was rejected for
> **every** repository. The controlled triple: the same token pushed with `http.extraheader` to BOTH
> the fresh target and the working target (exit 0, exit 0); the `credential.helper=store` path failed
> for BOTH (exit 128). Two successes and one failure isolate the CREDENTIAL, not the repository.
> `Invalid username or token` / `Authentication failed` is the host rejecting the credential, and
> `Permission to <repo>.git denied` is a repository not granted — the same face, two faults, and the
> preflight printed the second message for both (now fixed; it classifies).
>
> **What this changes for the numbers: nothing, and the row above is left standing with a pointer.**
> Round 7 is still 0 of 3. What changes is which layer the failure is attributed to, and therefore
> which layer the operator has to fix. **The end-to-end number for a fresh repository still does not
> exist** — it now waits on the credential transport rather than on a GitHub UI selection.

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

## Round 8 in detail (06:12Z, 2026-10-13) — a different FAMILY, and the chain says no

| Run | run id | wall clock | Outcome | Where it stopped |
|---|---|---|---|---|
| 1 | `wf-74c1978d` | 429 s | refused | `intake_shape`: `quality_gate FAILED (1 failing)` → `ACCEPT_VERDICT: fail` |
| 2 | `wf-b932b10f` | 402 s | refused | same, after the repair round rewrote the document |
| 3 | `wf-1478fd10` | 461 s | refused | same; `attempt 1 of 2: refused` |

The three runs are one finding: the intake wrote a good document (**7 requirements, 3 decisions, all
of the graph described** — 4-neighbour movement, moves-vs-cells, the malformed-record policy, and an
`independent-aggregation` anchor that means "an independent breadth-first recomputation matches the
tool's result line", which is the RIGHT intent for a path length), the shape gate passed 5 of its 6
checks, and `judge_forge` refused the sixth:

```
the judge in this chain checks a deliverable's ANSWER with exactly one relation,
independent-aggregation: an independent recomputation of an AGGREGATE of a per-row numeric measure,
which needs the decision that settles how those values are rounded. ... IF IT DOES NOT — its answer is
not an aggregate of a per-row measure, so nothing in it is ever rounded — then NO REPAIR TO THE
DOCUMENT CAN CLOSE THIS: the judge layer implements one family of answer ...
```

Until ledger #82 that sentence read "…so the judge would have to assume how **salaries** are rounded:
point a relation or anchor at the decision that settles it", which sent the repair round to add a
rounding decision a shortest-path requirement cannot have — twice per run, six times across the round —
and the run then reported the INTAKE as the fault.

**What this round is worth.** It is the first round that is not about the CSV-summary family, and it
answers the largest gap named in `docs/limitations.yaml` — by exposing two demands the chain makes of
**every** document (ledgers #83 and #84) rather than by producing a success rate. Until #83 the refusal
also told its repair round to add a rounding decision, which a path length cannot have, and the round
came back reporting the INTAKE as the fault; now it names both ways out. #83 is fixed (a document whose
answer is checked by a scenario gets a judge); #84 — the world assembly — is measured, recorded in the
machine-read inventory, and pinned by a test that skips itself when it closes. A failure that is cheap,
closed, attributed to the right layer and written down is a better outcome than a lucky pass, and it is
why no "3 of 3" above should be read as a statement about requirements in general.

## Round 7 in detail — the implementation leg generalises, the delivery leg was blocked

`sscodeai/takumi-delivery-demo-2`, created for the round: public, one commit, a README, nothing else.
Same sentence as rounds 4–6, same model, boundary ON. All three runs wrote a complete deliverable from
scratch — `summary.sh`, `src/`, `tests/`, `run-tests.sh`, `docs/`, three commits (`cc581b2` initial,
`8830fb7` feat, `782ec6c` test) — passed their own quality gate, and were ACCEPTED by their forged
judge; then all three died at `publish` because the delivery credential (a fine-grained PAT) had not
been selected for the new repository. Ledger #81 turned that into a preflight check, so the wasted
1.5 hours cannot repeat. **The end-to-end number for a fresh repository still does not exist** — it
needs the operator to add that repository to the token's list, which is a GitHub UI action.

## Rounds 9-11: the intake wall, the front door, and the delivery side

Three rounds, one requirement family outside the record world, one door fixed each time. The rate did not
move (0 of 3, 0 of 3, 0 of 3) and the WALL moved three times, which is the useful part:

1. **Round 9 — the intake cannot write a document for a family it was never told about.** Asked for the
   length of the shortest path on a grid map, it wrote a record world it invented (`row_index:id,
   row_text:other,open_cells:measure`), declared `malformed-row-accounting` / `duplicate-resolution` and an
   `independent-aggregation` anchor, and the forge refused it (correctly: those relations need a rounding
   decision). Handed the two ways out, the repair round added a mechanism on top of them. Fixed by telling
   the intake which of the TWO SHAPES it is writing (#54).
2. **Round 10 — the front door. 2.5 minutes per run, the fastest failures so far.** The intake wrote
   exactly the Shape B document the prompt asks for, and the TypeScript validator — which had not learned
   what the forge learned in #83/#84 — refused it for having no declared world. Fixed by sharing one list
   between the two doors, with a drift test (#55, ledger #85).
3. **Round 11 — the delivery side: the first round that IMPLEMENTED anything for this family.** All three
   runs got past the intake; the deliveries ran 30-60 minutes; RUN 1 and 3 died at a quality gate that
   could not read a test summary, and RUN 2 reached the forged judge.  Both are delivery-side findings
   (ledger #86 for the second).

**What round 11 delivers that no earlier round did:** a non-record requirement reached the implementation
and, in one run, the forged judge — the acceptance step ran the delivered artifact and returned a verdict.
The remaining failures are about EVIDENCE: which test command the gate runs, and which step's output the
repair round is briefed from.

**Two measurement caveats, stated rather than hidden.** The target repository carries the PREVIOUS
deliverable, so a quality gate that runs "the project's tests" runs both suites (620, 592 and 625 tests in
round 11's three runs) — the number in the gate output is not the new deliverable's suite alone. And the
one-family sample is still one family: three rounds of it now, with three different walls.

## Round 12 in detail (11:35Z, 2026-10-13) — a requirement from ANOTHER family, delivered

| Run | run id | wall clock | Pull request | record |
|---|---|---|---|---|
| 1 | `wf-cd0be302` | 3,297 s (55 min) | [#46](https://github.com/sscodeai/takumi-delivery-demo/pull/46) **MERGED** | `accepted=true`, `sandbox=unshare`, every step `done` |
| 2 | `wf-…` | 2,388 s (40 min) | none — the judge refused it twice | `accepted=false`; failing checks `REL-001, DEC-001` |
| 3 | `wf-41f48e83` | 767 s (12.8 min) | [#48](https://github.com/sscodeai/takumi-delivery-demo/pull/48) **MERGED** | `accepted=true`, `sandbox=unshare`, every step `done` |

The sentence was the same one rounds 8–11 could not get past: *"a small command-line tool that reads a
grid map from a text file (walls `#`, free cells `.`, one `S` and one `E`) and prints the length of the
shortest path … or `unreachable`"*. What arrived in the target repository: `pathfind.sh` + `pathfind.py` +
`tests/pathfind_tests.py` + `mutation/` + `run-tests.sh` + a CI workflow + the confirmed requirement
document — implemented, tested, judged, published, and merged, with nobody at the keyboard.

**Where each round's failure had been, and where it is now:**

| Round | The wall | Fixed by |
|---|---|---|
| 9 | the intake described a graph requirement with invented record-family relations | #54 (the intake is told which of the two shapes it is writing) |
| 10 | the front door demanded a declared world the forge no longer required | #55 (one shared list, drift-tested) |
| 11 | the repair round was briefed from a quality gate that had PASSED, so an attempt its judge refused was told there was nothing to repair — and the judge's reason was in no record at all | #56 (the acceptance is the verdict whenever there is one) |
| 12 | **nothing structural.** One run's delivery was refused by its judge, for a reason the record now carries: `DEC-001 AMB-001 NOT honoured … checked by REL-001, which failed` | — |

**Round 11's detail, corrected.** Its row above says RUN 1 and 3 died at a delivery quality gate; the
event sequence says something more precise, and it matters for what was fixed. In RUN 1, ATTEMPT 1 ran
`implementation → unit_and_integration_tests → quality_gate PASSED (620 tests) → rule_review →
judge_forge → artifact_acceptance FAILED` — the judge refused the delivery — and only ATTEMPT 2's gate
failed with `0 failing over 0 tests, shape: unrecognised`. The unreadable gate was a SYMPTOM: the repair
round had been briefed with the passing gate, so it changed the test runner without knowing what the judge
objected to. Both are ledger #86, and round 12 is the round that shows the fix working.

**What this does NOT show.** Two merged deliveries of ONE non-record requirement, on a target repository
that already carried a previous deliverable: the second success reused what the first merged. The sample
is now two families (the record aggregate, and this scenario-judged CLI), not "requirements in general" —
and the judge for this family checks the answer through the DELIVERED TESTS' report plus mutation
detection, which is weaker than an independent recomputation: the document declares that, and the chain
reports it as declared, not as stronger than it is.

## Round 13 in detail (13:34Z, 2026-10-13) — a third family, 3 of 3, and the repair loop working

| Run | run id | wall clock | Pull request | first attempt | record |
|---|---|---|---|---|---|
| 1 | `wf-26464daa` | 1,174 s (19.6 min) | [#50](https://github.com/sscodeai/takumi-delivery-demo/pull/50) **MERGED** | accepted | `accepted=true`, `sandbox=unshare` |
| 2 | `wf-eed989e0` | 2,429 s (40.5 min) | [#52](https://github.com/sscodeai/takumi-delivery-demo/pull/52) **MERGED** | **refused by the judge**, accepted on attempt 2 | `accepted=true`, `sandbox=unshare` |
| 3 | `wf-69435629` | 2,300 s (38.3 min) | [#54](https://github.com/sscodeai/takumi-delivery-demo/pull/54) **MERGED** | gate failed, accepted on attempt 2 | `accepted=true`, `sandbox=unshare` |

The sentence: *"a small command-line tool that reads a JSON file holding an array of objects and prints the
keys that appear in every one of those objects, one per line, sorted alphabetically, or the single word
`none` when no key is common to all of them."* What arrived: `common-keys.sh` + `common_keys.py` +
`tests/common_keys_tests.py` + a mutation config + a CI workflow. Three families have now been delivered
end-to-end: the record aggregate (rounds 4-6), a graph shortest path (round 12), and this set operation.

**The repair loop, on a family where the gate is weak.** A scenario-judged delivery's quality gate passes by
construction (the implementer wrote those tests), so the JUDGE is the only real check — and in round 12 a
judge refusal could not be repaired. In round 13 RUN 2 it was: attempt 1's judge refused the delivery,
`#86` handed attempt 2 the judge's own failing checks, and attempt 2 was accepted. RUN 3 shows the same for
a failed quality gate. **First attempt: 1 of 3. With the loop: 3 of 3** — the same shape as the record
family, and the first time it holds outside it.

**And the round found a leak (ledger #87).** RUN 2's delivery copied the platform's
`docs/authorizations/SA-002.yaml` — the standing authorization, the operator's identity inside it,
byte-identical — into the target repository, which is PUBLIC. An earlier round had already put `SA-001.yaml`
there. The protected-path rule reports a CREATED protected path as a note (right for `package.json`, wrong
for a grant), so the review passed. A new rule now BLOCKS any delivery that creates `docs/authorizations/**`
before the acceptance can run.

**Caveats, unchanged and one new.** The target repository carries the previous deliveries, so the numbers
above include them; the sample is three families, not requirements in general; and the copies of the two
authorization files are STILL PUBLIC in that repository — removing them is an operator's decision about a
repository the chain does not own, and it is named here rather than quietly cleaned.

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

7. **Round 8 aimed at the largest named gap — a requirement from another family — and found two demands
   the chain makes of every document** (rounds 7 and 8, ledgers #81-#84). It refused in ~7 minutes, before
   any spend, which is what a wrong-family measurement should cost. But the finding is not "this family
   cannot be judged": the three relation types that recompute their expectations FROM THE RECORDS need a
   rounding decision, while a scenario, mutation-detection, `row-order-invariance` and `additivity` need
   none. #83 removed the rounding demand from the documents that need no rounding rule — a
   scenario-checked document now gets a judge — and #84 is the same defect one layer up (the world
   assembly). Both were fixed the same day (#83, #84), so the honest reading of every "3 of 3" above is:
   **3 of 3 for the record-aggregate family, with the door to the others opened** — a document whose only
   check is a scenario now gets a judge, with or without a declared world. Whether a requirement from
   another family now survives the WHOLE chain is a separate measurement, and it has not been made yet. A deliverable's ANSWER is checked by exactly one relation,
   `independent-aggregation`: an independent recomputation of an aggregate of a per-row numeric measure
   with a rounding rule. The other relations check the INPUT (`duplicate-resolution`,
   `malformed-row-accounting`) or the SHAPE of the report (`row-order-invariance`, `additivity`). So
   "3 of 3" means **3 of 3 for that family** — every round measured here is the same sentence — and
   round 8 is what happens outside it: 0 of 3, refused at intake in ~7 minutes, before any spend, and
   (after #82) with the boundary named instead of a document defect. **This is the largest named gap,
   and it is not a code gap: it is the judge's vocabulary.**

8. **The chain has delivered a requirement from a second family** (round 12, ledgers #83-#86): a graph
   shortest path, implemented, judged, published and merged — twice. It took four walls to get there, one
   per round, and none of them was the requirement: the intake's vocabulary (#54), the front door's demand
   for a world (#55), the step the repair round is briefed from (#56), and the sentence the forge printed
   when it could not parameterise an answer (#52). Failures here keep being about the CHAIN's own contracts,
   and round 12 is the first round where the only failure was the delivery's.

9. **Three families, and the loop is what carries it.** Round 13 delivered a third family 3 of 3 with **1 of 3
   on the first attempt**: the repair round did the rest, including on a family whose quality gate is weak by
   construction. The honest summary of this file is therefore not "N of M deliveries" but "N of M deliveries
   **with a repair loop that is load-bearing**", measured now on two families.

## Reproducing a round

```bash
source <your-env-file>              # provider key (injected, never printed)
export TAKUMI_PI_RUNTIME=/abs/path/to/runtimes/pi/dist/index.js
pnpm -r build                      # the chain runs apps/cli/dist
bash scripts/preflight-unattended.sh   # refuses to measure an unhealthy machine (ledger #76)
bash scripts/autopilot.sh "<one sentence>"
```
