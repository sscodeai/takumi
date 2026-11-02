# Eval Repeat Results — 3 runs per arm

Generated 2026-11-02. Every arm below ran the same 23 tasks, the same provider
(`opencode-go`), and the same tool set. The only variables are the model and
whether the repair loop was enabled.

**Excluded from this table** (kept on disk as evidence, see `docs/eval-integrity.md`):

| File | Why excluded |
| --- | --- |
| `pi-2026-11-01T07-28-46-532Z.json` | pre-model-pinning run; `model` recorded as `default` |
| `pi-2026-11-02T12-26-41-527Z.json` | model had been retired by the provider (400 Model is unavailable, 0 tokens) |
| `pi-2026-11-02T13-01-39-114Z.json` | answer key readable from the workdir; agent cited it in its own summary |

---

## Results (n = 3 runs per arm, 23 tasks per run)

| Model | Arm | first-pass | false completion | repair | final |
| --- | --- | --- | --- | --- | --- |
| `hy3` (weak) | baseline | 87.0% (median), 82.6–91.3% | **13.0%** (8.7–17.4%) | — | 87.0% |
| `hy3` (weak) | harness | 87.0% (median), 82.6–91.3% | **0%** (0/3 runs) | **9/9 = 100%** | **100%** (3/3 runs) |
| `deepseek-v4.1-flash` (strong) | baseline | 95.7% (median), 95.7–95.7% | **4.3%** (1/23, all 3 runs) | — | 95.7% |
| `deepseek-v4.1-flash` (strong) | harness | 95.7% (median), 91.3–95.7% | **0%** (0/3 runs) | **4/4 = 100%** | **100%** (3/3 runs) |

Aggregate repair success across both models: **13/13 = 100%**.

## What is stable and what is not

**Stable across all three runs:**
- False completion is **exactly 0 in every harness run**, both models.
- Final success is **exactly 100% in every harness run**, both models.
- Repair success is 100% in every run where repair was entered.
- The strong model's baseline false-completion rate is 4.3% in all 3 runs
  (the same single task every time).

**Not stable:**
- **Per-task first-pass verdicts flip between runs at the same model.** `hy3`
  baseline failed 2, 3, 3 and 4 tasks across four runs. `hy3` harness entered
  repair on 4, 3 and 2 tasks in three runs. A single run understates or
  overstates that arm by up to 2 tasks.
- **First-pass rate for `hy3` in harness mode (82.6–91.3%) overlaps the baseline
  range (82.6–91.3%) completely.** The harness does not improve first-pass
  rate. It improves *final* success, because the repair loop exists.
- **Latency is not usable as a metric here.** Medians: hy3 baseline 31.1 s,
  hy3 harness 34.3 s, strong baseline 35.4 s, strong harness 29.9 s. The strong
  model's harness arm is *faster* than its baseline arm, which cannot be a causal
  effect of adding verification. Individual task latencies swung 2–3× between
  runs (one task: 76.4 s in one arm, 21.0 s in another). Timing variance
  dominates; do not quote latency.

## Failure concentration

Across 13 clean arms, only 5 of 23 tasks ever failed at first verification:

| Task | Failed in |
| --- | --- |
| `ts-implicit-timezone-001` | **13/13 arms** (every single arm) |
| `ts-complex-inventory-001` | 7/13 |
| `ts-feature-001` | 5/13 |
| `ts-noselftest-csv-001` | 2/13 |
| `ts-noselftest-url-001` | 1/13 |

`ts-implicit-timezone-001` fails in every arm because it requires `jobs` to be
sorted by `(hour, minute)` — a constraint the task description deliberately omits.
No model infers it. This single task accounts for the entirety of the strong
model's baseline false-completion rate (1/23).

**Implication for the next iteration:** 18 of 23 tasks are saturated for both
models and contribute no signal. The current set measures model strength on 5
tasks. Difficulty calibration is the open problem, not more harness features.

## Honest summary

What this data supports: independent verification eliminates 13.0% / 4.3%
false-completion claims on this task set, and the repair loop recovers all
13 tasks that entered it.

What it does not support: any claim about latency, cost, or generality. And the
effect size is measured on a task set where only 5 tasks ever discriminate —
the next honest step is harder tasks, not more runs of these.
