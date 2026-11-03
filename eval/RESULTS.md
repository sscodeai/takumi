# Agent Eval — Sanitized Results Summary

> Public summary of Agent Eval runs. Raw per-run JSON (agent outputs, verification
> logs) is intentionally not committed — it contains agent transcripts and
> machine-local details. Reproduce with `node eval/scripts/run-eval.mjs`.

## Read this before quoting any number

The 2026-08-20/21 runs listed at the bottom of this file are **superseded and
must not be cited**. They were produced by a harness that scored with the agent's
own test files and that left the held-out tests readable from the work directory.
Both defects are documented, with reproductions, in
[`docs/eval-integrity.md`](../docs/eval-integrity.md).

If you need a number, use the 2026-11-02 results below — three runs per arm, with
the held-out suite isolated from the agent.

## Metrics legend

- **First-pass Rate**: tasks PASS at first independent verification / all tasks
- **False Completion Rate**: (claimed SUCCESS AND verification FAILED) / claimed SUCCESS
- **Repair Success Rate**: tasks that failed first verify then passed after repair / tasks that entered repair
- **Final Success Rate**: tasks PASS after all allowed repairs / all tasks
- **Baseline**: one shot, no verification feedback, no repair (the control arm)
- **Harness**: verification feedback + repair loop enabled

## Results (2026-11-02, 3 runs per arm, 23 tasks per run)

| Model | Arm | First-pass | False Completion | Repair | Final |
|---|---|---|---|---|---|
| `hy3` (weak) | baseline | 87.0% (82.6–91.3%) | **13.0%** (8.7–17.4%) | — | 87.0% |
| `hy3` (weak) | harness | 87.0% (82.6–91.3%) | **0%** (all 3 runs) | **9/9** | **100%** |
| `deepseek-v4.1-flash` (strong) | baseline | 95.7% | **4.3%** (1/23, all 3 runs) | — | 95.7% |
| `deepseek-v4.1-flash` (strong) | harness | 95.7% (91.3–95.7%) | **0%** (all 3 runs) | **4/4** | **100%** |

Aggregate repair success: **13/13 = 100%**.

### What these numbers support

- Independent verification removes false-completion claims (13.0% and 4.3% → 0%,
  in every run).
- Given the verification output, the agent repairs successfully (13/13).
- The benefit is larger for the weaker model, which is the expected shape.

### What they do NOT support

- **First-pass rate is not improved** by the harness (weak model: 82.6–91.3% in
  both arms). Only *final* success changes.
- **No latency or cost claim.** Individual task latencies swing 2–3× between
  runs; timing variance dominates at this sample size.
- **No generalisation beyond 23 small, machine-checkable TypeScript/Node tasks**,
  two models, one provider.
- **Only 5 of 23 tasks ever discriminate** (`ts-implicit-timezone-001` fails in
  13/13 arms). The set is saturated for strong models — difficulty calibration is
  open work.

Full per-run data and stability analysis: [`REPEATS.md`](REPEATS.md).

## Superseded results (2026-08-20/21 — DO NOT CITE)

| Run | Model | Tasks | First-pass | False Completion | Repair | Final |
|---|---|---|---|---|---|---|
| eval all groups | deepseek/deepseek-v4-flash | 23 | 23/23 (100%) | 0% | 0 | 100% |
| eval complex | deepseek/deepseek-v4-pro | 5 | 4/5 (80%) | 0% | 1 | 5/5 (100%) |
| eval easy | pi (opencode-zen) | 6 | 6/6 (100%) | 0% | 0 | 100% |

Why superseded: verification ran `npm test`, which executes the agent's own test
files under `test/`. An agent could satisfy it with `assert.ok(true)` while the
implementation was wrong. Additionally the held-out tests lived in
`test/.hidden/` inside the work directory, where `cat` could read them.

## Reproduction

```bash
# install + build the runtime the eval drives
pnpm -r --workspace-concurrency=1 build

# baseline arm (control): no verification feedback, no repair
TAKUMI_EVAL_HARNESS=pi TAKUMI_PI_RUNTIME="$PWD/runtimes/pi/dist/index.js" \
TAKUMI_EVAL_MODE=baseline TAKUMI_EVAL_MODEL=opencode-go/hy3 \
node eval/scripts/run-eval.mjs

# harness arm: verification feedback + repair
TAKUMI_EVAL_HARNESS=pi TAKUMI_PI_RUNTIME="$PWD/runtimes/pi/dist/index.js" \
TAKUMI_EVAL_MODE=harness TAKUMI_EVAL_MODEL=opencode-go/hy3 \
node eval/scripts/run-eval.mjs
```

`TAKUMI_EVAL_MODEL` accepts `provider/model-id`. Omitting it runs whatever the
local Pi configuration selects — which makes the run non-reproducible, so always
pin it for anything you intend to report.

Full methodology: `docs/evaluation.md`. Integrity incidents:
`docs/eval-integrity.md`.
