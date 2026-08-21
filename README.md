# Takumi

> **Open-source extensible Agentic Software Engineering Platform with first-class support for Japanese enterprise software development.**

> **"Agents propose. Takumi verifies."** — AI coding agents propose; Takumi independently verifies.

Takumi is a platform layer — **not** a Pi wrapper, not a DeepSeek Harness fork, not another coding agent. It orchestrates software-engineering workflows across pluggable agent runtimes, with built-in support for the Japanese SI development process (要件定義 → 基本設計 → 詳細設計 → 実装 → 単体テスト → 結合テスト → エビデンス → レビュー → 納品).

```
                          Takumi
                           │
                 Orchestration Core
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
     Skills              Tools             Workflows
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                     Runtime API
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
          Pi        DeepSeek Harness      Codex
                           │
                    More Runtimes
```

**Core is the platform. Extensions are the ecosystem. Runtimes are the engines.**

## Why Takumi exists

| Problem | Existing tools |
|---|---|
| No open-source V-model workflow platform | All Japanese SI automation is closed-source SaaS |
| No unified traceability chain | Tools generate docs but drop agent session trails, tool logs, and 要件→エビデンス git diffs |
| No harness-agnosticism | Every product is locked to its own inference backend |
| No evidence-native pipeline | Nothing produces エビデンス (unit/integration test evidence) as a first-class deliverable |
| **"Done" claims cannot be trusted** | No tool independently verifies agent claims (quality gate + hidden tests) |

## Agent Eval — measuring agent reliability scientifically

Takumi ships an **Agent Eval framework** (`eval/`): 23 real SWE tasks in 6 groups (easy/hard/trap/no-self-test/complex/implicit), all with machine-verifiable hidden ground truth.

```bash
# Swap model = swap env var (model-agnostic, proven)
TAKUMI_EVAL_HARNESS=deepseek TAKUMI_EVAL_MODEL=deepseek/deepseek-v4-flash node eval/scripts/run-eval.mjs
TAKUMI_EVAL_HARNESS=deepseek TAKUMI_EVAL_MODEL=deepseek/deepseek-v4-pro    node eval/scripts/run-eval.mjs --tasks=ts-complex
TAKUMI_EVAL_HARNESS=pi                                                     node eval/scripts/run-eval.mjs
```

| Model | first-pass | false completion | repair triggered |
|---|---|---|---|
| deepseek v4-flash | 23/23 (100%) | 0% | 0 |
| deepseek v4-pro (complex) | 4/5 (80%) | 0% | **1 (natural → repaired → 100% final)** |
| Pi (opencode-zen) | 6/6 (100%) | 0% | 0 |

> **Key finding**: agents are highly reliable on controllable, verifiable tasks; but even stronger models fail sometimes (v4-pro on a concurrency task) — **an independent verification layer is necessary for any model**. The eval framework caught 2 of its own measurement bugs (see `docs/evaluation.md`), proving "verify the measurement tool before trusting results".

## Quick Start

> Install from source (npm package publishing is **Planned**, not yet shipped).
> Requires Node ≥ 20 and [pnpm](https://pnpm.io).

```bash
# 1. Clone + build
git clone <repo-url> && cd takumi
pnpm install
pnpm build                 # sequential workspace build (core → runtimes → cli)

# 2. Scaffold a project
pnpm exec takumi init

# 3. Run a task with the deterministic fake runtime (no API key needed)
pnpm exec takumi run "Implement user login API"

# 4. Run a real workflow (DeepSeek via commandcode.ai, needs COMMANDCODE_API_KEY)
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime deepseek

# 5. Run the MEA loop (Manage-Execute-Audit, arXiv 2608.01964 aligned)
pnpm exec takumi loop "Fix the sumEven bug and add tests" --runtime deepseek --max-rounds 5
```

**Bring your own harness** — switch runtimes by configuration only, no Core changes:

```bash
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime fake      # deterministic
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime pi        # real Pi agent
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime deepseek  # OpenAI-compatible LLM
```

## Architecture

```
takumi/
├── apps/cli/              # takumi CLI (init/run/loop/runtime list/extension list)
├── apps/console/          # lightweight web console (SSE live logs, :8787)
├── packages/core/         # orchestration, runtime abstraction, workflow engine, manager-loop (MEA), sandbox, artifact store, traceability
├── runtimes/              # runtime adapters (fake, pi, deepseek)
├── extensions/            # first-party extensions
│   ├── skills/            #   jp-requirements, jp-basic-design, jp-unit-test, jp-integration-test, jp-evidence, jp-code-review...
│   ├── tools/             #   (excel, jira, github, playwright — roadmap)
│   └── workflows/         #   jp-si-standard (V-model, 11 steps), rapid-mvp
├── eval/                  # Agent Eval (23 tasks × 6 groups, hidden ground truth)
├── bench/                 # System benchmark (B1-B4: reliability/quality-gate/artifacts/parity)
├── examples/              # end-to-end demos (pi10: 53 Java + 59 tests green)
└── docs/                  # ADRs, evaluation.md, final-state-audit.md, finalization-protocol.md
```

### Core principles

- **Small Core** — Core only owns orchestration, task/event/artifact models, runtime abstraction, extension loading, approval, audit. No Japanese-SI specifics, no runtime specifics.
- **Four extension kinds** — Skill (knowledge/procedure), Tool Plugin (executable capability), Workflow Plugin (declarative process), Runtime Adapter (harness engine).
- **Harness-agnostic runtime API** — `runTask / cancel / getStatus / getUsage / getArtifacts` over a unified event stream. We do NOT unify internal tool calls.
- **Traceability by default** — every artifact carries trace links (REQ-001 → DESIGN-001 → UT-001 → EVIDENCE-001); `takumi run` prints a Traceability Matrix.
- **Human-in-the-loop** — workflows declare approval gates; CLI prompts `[a] approve / [r] reject / [v] view`.
- **Independent verification** — quality gates run real tests; Agent Eval uses hidden ground truth; the MEA loop's Auditor never trusts the Executor's claim.

## Features

| Feature | Status |
|---|---|
| Pluggable runtimes (fake / pi / deepseek) + `TAKUMI_EVAL_MODEL` model switching | ✅ |
| Japanese SI V-model workflow (11 steps, incl. 結合試験) | ✅ |
| Durable Resume (`--resume` from audit) | ✅ |
| Parallel step execution (layer-based, TDD-verified) | ✅ |
| Sandbox isolation (unshare: network-off, read-only host, CPU limits) | ✅ |
| Web console (SSE live logs) | ✅ |
| Agent Eval (23 tasks, hidden ground truth, repair loop) | ✅ |
| **Manager Loop — MEA (`takumi loop`, arXiv 2608.01964 aligned)** | ✅ |
| Golden Path real E2E (53 Java + 59 tests green, mvn BUILD SUCCESS) | ✅ |

## Documentation

- Architecture Decision Records: `docs/adr/` (runtime abstraction, extension system, workflow model, event model, artifact traceability)
- Agent Evaluation: `docs/evaluation.md` (methodology, 23-task results, honest limitations)
- Current State Audit: `docs/final-state-audit.md` (re-verified PASS/PARTIAL/FAIL per capability)
- Acceptance: `docs/acceptance-report.md` (40-gate, 4 independent reviewer subagents, scorecard)

## Known limitations

Honest scope for the current **Developer Preview**:

- **Agent Eval results are preliminary** (23 tasks, small sample, not statistically significant); False Completion not triggered in controlled tasks (needs real-world ambiguity)
- **`takumi loop` (MEA) is v1**: Manager uses LLM decisions (non-deterministic state machine), GUI computer-use not supported
- **Pi events are not streamed in real time** — events are delivered once the task finishes (buffered)
- **Traceability is by ID-naming convention** (REQ-001 links), not structural foreign keys
- **Pi runtime is opt-in** (depends on an unpublished SDK): `pnpm install` does not ship it
- Tool plugins run shell commands via sandbox when `--sandbox unshare` is set; default unsandboxed

## Roadmap

- [x] Core types + runtime abstraction + extension discovery
- [x] FakeRuntime + CLI vertical slice
- [x] Workflow engine (DAG, approval gates, retry, capability validation)
- [x] Pi runtime adapter (AgentSession SDK, in-process)
- [x] DeepSeek runtime adapter (OpenAI-compatible tool loop) + TAKUMI_EVAL_MODEL
- [x] Japanese SI skills (requirements, basic design, unit test, integration test, evidence, code review)
- [x] Agent Eval (23 tasks × 2+ models) + System Benchmark (B1-B4)
- [x] Durable Resume + Parallel + Web Console + Sandbox
- [x] Manager Loop (MEA, `takumi loop`)
- [ ] Claude (Anthropic Messages) runtime adapter
- [ ] Excel/Word rendering, Jira/GitHub/Playwright tools
- [ ] npm publish
- [ ] Real-repo-scale eval (SWE-bench style)

## License

MIT
