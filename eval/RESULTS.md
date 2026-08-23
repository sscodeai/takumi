# Agent Eval — Sanitized Results Summary

> Public summary of Agent Eval runs. Raw per-run JSON (agent outputs, verification
> logs) is intentionally not committed — it contains agent transcripts and
> machine-local details. Reproduce with `node eval/scripts/run-eval.mjs`.

## Metrics legend

- **First-pass Rate**: tasks PASS at first independent verification / all tasks
- **False Completion Rate**: (claimed SUCCESS AND verification FAILED) / claimed SUCCESS
- **Repair Success Rate**: tasks that failed first verify then passed after repair / tasks that entered repair
- **Final Success Rate**: tasks PASS after all allowed repairs / all tasks

## Results (real runs, 2026-08-20/21)

| Run | Model | Tasks | First-pass | False Completion | Repair | Final |
|---|---|---|---|---|---|---|
| eval all groups | deepseek/deepseek-v4-flash | 23 | 23/23 (100%) | 0% | 0 | 100% |
| eval complex | deepseek/deepseek-v4-pro | 5 | 4/5 (80%) | 0% | **1 (natural)** | **5/5 (100%)** |
| eval easy | pi (opencode-zen) | 6 | 6/6 (100%) | 0% | 0 | 100% |

### Key finding

- Agents are highly reliable on controllable, well-specified tasks (23/23 first-pass).
- Even stronger models fail sometimes (v4-pro on the concurrent-queue task: claimed
  success, independent verification FAILED, 1 repair → PASS). The verification layer
  is necessary for any model — "Agents propose. Takumi verifies."
- The eval framework itself caught 2 of its own measurement bugs (expect_stdout
  mismatch, import path) before the above numbers were trustworthy.

## Reproduction

```bash
node eval/scripts/build-tasks.mjs
TAKUMI_EVAL_HARNESS=deepseek node eval/scripts/run-eval.mjs
TAKUMI_EVAL_HARNESS=deepseek TAKUMI_EVAL_MODEL=deepseek/deepseek-v4-pro node eval/scripts/run-eval.mjs --tasks=ts-complex
```

Full methodology: `docs/evaluation.md`.
