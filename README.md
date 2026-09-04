<p align="center">
  <img src="./assets/brand/takumi-logo.svg" alt="Takumi" width="720">
</p>

<p align="center">
  <strong>Model-agnostic platform for verifiable agentic software delivery.</strong>
  <br>
  Workflows, traceability, evidence-native testing, agent evals, and verify-before-done loops.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827.svg" /></a>
  <img alt="Node 20 plus" src="https://img.shields.io/badge/node-20%2B-2DD4BF.svg" />
  <img alt="TypeScript 5.x" src="https://img.shields.io/badge/typescript-5.x-3178C6.svg" />
  <img alt="Developer Preview" src="https://img.shields.io/badge/status-developer_preview-F97316.svg" />
</p>

<p align="center">
  English | <a href="./README_ja.md">日本語</a>
</p>

---

Takumi is an open-source orchestration layer for AI software delivery. It is not
a single coding agent, a Pi wrapper, or a DeepSeek fork. Takumi coordinates
pluggable agent runtimes through explicit workflows, quality gates, artifacts,
traceability, and independent verification.

> **Agents propose. Takumi verifies.**

Takumi is designed for teams that need AI agents to produce software changes
that can be reviewed, tested, resumed, audited, and delivered with evidence.
Japanese SI / V-model delivery is included as a first-party workflow, not a
boundary of the platform.

## What You Can Do

- Run structured software delivery workflows from requirements to evidence.
- Swap agent runtimes without changing the platform core.
- Keep traceability from requirements to design, tests, evidence, and review.
- Gate agent output with real tests and independently collected evidence.
- Evaluate agent reliability with hidden-ground-truth SWE tasks.
- Run a Manage-Execute-Audit loop for long-horizon agent work.

## Quick Start

Install from source. npm package publishing is planned, but not shipped yet.

```bash
git clone https://github.com/sscodeai/takumi.git
cd takumi

pnpm install
pnpm build
```

Run a deterministic local task with no API key:

```bash
pnpm exec takumi init
pnpm exec takumi run "Implement user login API"
```

Run a workflow with a real runtime:

```bash
export COMMANDCODE_API_KEY=...
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime deepseek
```

Run the MEA loop:

```bash
pnpm exec takumi loop "Fix the sumEven bug and add tests" --runtime deepseek --max-rounds 5
```

## Why Takumi

| Problem | Takumi approach |
|---|---|
| AI tools generate code but lose the delivery trail | Traceability matrix across requirements, design, tests, evidence, and review |
| Products lock users into one model or harness | Runtime adapter API for fake, Pi, DeepSeek, CLI bridges, and future runtimes |
| Tests and evidence are treated as afterthoughts | Evidence-native pipeline for unit and integration test deliverables |
| Agents can claim "done" too early | Quality gates, hidden tests, and independent verification |
| Long tasks lose state across context windows | Manage-Execute-Audit loop with persistent task state |
| Domain delivery processes are hard to encode | Extensible workflow and skill system, with Japanese SI as a built-in example |

## Architecture

```text
                          Takumi
                            |
                    Orchestration Core
                            |
        +-------------------+-------------------+
        |                   |                   |
      Skills              Tools             Workflows
        |                   |                   |
        +-------------------+-------------------+
                            |
                       Runtime API
                            |
          +-----------------+-----------------+
          |                 |                 |
         Pi              DeepSeek           CLI
          |                                   |
   More runtimes                       Any harness
```

```text
takumi/
├── apps/cli/              # takumi CLI: init, run, loop, runtime list, extension list
├── apps/console/          # lightweight web console with SSE live logs
├── packages/core/         # workflow engine, runtime API, artifacts, traceability, MEA loop, sandbox
├── runtimes/              # fake, pi, deepseek, cli adapters
├── extensions/            # skills, tools, workflows
├── eval/                  # agent reliability evaluation tasks
├── bench/                 # system benchmark baselines
├── examples/              # end-to-end delivery examples, including Japanese SI
└── docs/                  # ADRs and evaluation notes
```

## Core Ideas

- **Small Core**: orchestration, task/event/artifact models, runtime abstraction, extension loading, approval, and audit.
- **Four extension kinds**: Skill, Tool Plugin, Workflow Plugin, Runtime Adapter.
- **Harness agnostic**: `runTask`, `cancel`, `getStatus`, `getUsage`, `getArtifacts` over a unified event stream.
- **Traceability by default**: `REQ-001 -> DESIGN-001 -> UT-001 -> EVIDENCE-001`.
- **Human in the loop**: workflows can declare approval gates.
- **Independent verification**: agent claims are not trusted as completion evidence.

## Features

| Capability | Status |
|---|---|
| Pluggable runtimes: fake / Pi / DeepSeek / CLI bridge | Done |
| Declarative workflows, including Japanese SI / V-model | Done |
| Skills for requirements, basic design, detailed design, tests, evidence, review | Done |
| Traceability matrix generation | Done |
| Approval gates | Done |
| Durable resume from audit records | Done |
| Parallel workflow step execution | Done |
| Sandbox abstraction with unshare support | Done |
| Web console with live logs | Done |
| Agent Eval with hidden ground truth and repair loop | Done |
| MEA loop: Manage, Execute, Audit | Done |
| Golden Path E2E: Spring Boot + Vue inventory system, 53 Java files, 59 tests green | Done |

## Agent Eval

Takumi ships an Agent Eval framework under `eval/`: 23 real SWE tasks across
easy, hard, trap, no-self-test, complex, and implicit constraint groups. Each
task has machine-verifiable ground truth. Agent-written tests are never treated
as the ground truth.

```bash
TAKUMI_EVAL_HARNESS=deepseek TAKUMI_EVAL_MODEL=deepseek/deepseek-v4-flash node eval/scripts/run-eval.mjs
TAKUMI_EVAL_HARNESS=deepseek TAKUMI_EVAL_MODEL=deepseek/deepseek-v4-pro node eval/scripts/run-eval.mjs --tasks=ts-complex
TAKUMI_EVAL_HARNESS=pi node eval/scripts/run-eval.mjs
```

| Model | First-pass | False completion | Repair triggered |
|---|---:|---:|---:|
| deepseek v4-flash | 23/23 | 0% | 0 |
| deepseek v4-pro, complex | 4/5 | 0% | 1 natural repair |
| Pi, opencode-zen | 6/6 | 0% | 0 |

See [docs/evaluation.md](./docs/evaluation.md) for methodology, raw caveats,
and limitations.

## MEA Loop

Takumi's Manager Loop follows the Manage-Execute-Audit pattern:

1. **Manager** owns persistent task state and decides the next subtask.
2. **Executor** works in a fresh context and may modify the environment.
3. **Auditor** independently verifies the resulting state.
4. Only clean audit evidence can mark a task record complete.

This is implemented in [packages/core/src/manager-loop.ts](./packages/core/src/manager-loop.ts)
and exposed through `takumi loop`.

Inspired by LongHorizon-Harness:

- GitHub: https://github.com/AMAP-ML/LongHorizon-Harness
- Paper: https://arxiv.org/abs/2608.01964
- Website: https://lh-harness.pages.dev/

## Examples

- [examples/pi10](./examples/pi10): Golden Path enterprise delivery project based on a Japanese SI / V-model workflow, including requirements, design documents, Spring Boot backend, Vue frontend, unit/integration tests, and evidence summaries.
- [examples/minimal-vmodel](./examples/minimal-vmodel): smaller V-model example for workflow and traceability experiments.

## Known Limitations

Takumi is currently a Developer Preview.

- Agent Eval results are preliminary: 23 tasks is useful evidence, not a statistically large benchmark.
- `takumi loop` is v1: manager decisions are still LLM-driven and non-deterministic.
- Pi runtime is opt-in and depends on an external Pi SDK.
- Traceability currently relies on ID naming conventions rather than structural foreign keys.
- Tool plugins run with user privileges unless a sandbox is explicitly selected.
- Real-repo-scale evaluation is still on the roadmap.

## Roadmap

- [x] Core types, runtime abstraction, and extension discovery
- [x] Workflow engine with DAG, approval gates, retry, and capability validation
- [x] Fake, Pi, DeepSeek, and CLI runtime adapters
- [x] Japanese SI skills and V-model workflow
- [x] Agent Eval and system benchmarks
- [x] Durable resume, parallel execution, web console, sandbox, and MEA loop
- [ ] Claude runtime adapter
- [ ] Excel, Word, Jira, GitHub, and Playwright tool plugins
- [ ] npm package publishing
- [ ] Real-repo-scale evals

## License

Takumi is released under the [MIT License](./LICENSE).
