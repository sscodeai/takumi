# Takumi

> **Open-source extensible Agentic Software Engineering Platform with first-class support for Japanese enterprise software development.**

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

# 4. Run a real workflow with the Pi runtime (needs OPENCODE_GO_API_KEY)
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime pi
```

**Bring your own harness** — switch runtimes by configuration only, no Core changes:

```bash
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime fake   # deterministic
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime pi     # real Pi agent
```

## Architecture

```
takumi/
├── apps/cli/              # takumi CLI (init/run/runtime list/extension list)
├── packages/core/         # orchestration primitives, runtime abstraction, workflow engine, artifact store, traceability
├── runtimes/              # runtime adapters (fake, pi)
├── extensions/            # first-party extensions
│   ├── skills/            #   jp-requirements, jp-basic-design, jp-unit-test, jp-evidence, jp-code-review...
│   ├── tools/             #   (excel, jira, github, playwright — roadmap)
│   └── workflows/         #   jp-si-standard (V-model), rapid-mvp
├── examples/              # end-to-end demos
├── benchmarks/            # Japan SWE-Agent Benchmark (roadmap)
└── docs/                  # ADRs, research notes, project status
```

### Core principles

- **Small Core** — Core only owns orchestration, task/event/artifact models, runtime abstraction, extension loading, approval, audit. No Japanese-SI specifics, no runtime specifics.
- **Four extension kinds** — Skill (knowledge/procedure), Tool Plugin (executable capability), Workflow Plugin (declarative process), Runtime Adapter (harness engine).
- **Harness-agnostic runtime API** — `runTask / cancel / getStatus / getUsage / getArtifacts` over a unified event stream. We do NOT unify internal tool calls.
- **Traceability by default** — every artifact carries trace links (REQ-001 → DESIGN-001 → UT-001 → EVIDENCE-001); `takumi run` prints a Traceability Matrix.
- **Human-in-the-loop** — workflows declare approval gates; CLI prompts `[a] approve / [r] reject / [v] view`.

## Documentation

- Architecture Decision Records: `docs/adr/` (runtime abstraction, extension system, workflow model, event model, artifact traceability)
- Technical charter: `docs/CHATTER.md`
- Project status: `docs/PROJECT_STATUS.md`
- Acceptance: `docs/acceptance-report.md` (40-gate, 4 independent reviewer subagents, scorecard)

## Known limitations

Honest scope for the current **Developer Preview** (see `docs/acceptance-report.md` for full detail):

- **Resume: not supported** across process crashes — `resume: false`. A long workflow
  killed mid-run cannot be resumed; restart from the beginning. Pi does reuse a
  session *within* one process (context continuity across steps), but there is no
  durable cross-process resume.
- **No parallel step execution yet** — the engine executes the workflow in
  topological serial order; parallel execution is declared in the model but not
  concurrent.
- **Pi events are not streamed in real time** — events are delivered once the
  task finishes (buffered), not live during generation.
- **Traceability is by ID-naming convention** (REQ-001 links), not structural foreign keys.
- **Tool plugins** run shell commands directly (no sandbox) — only run trusted steps.
- **Pi runtime is opt-in** (depends on an unpublished SDK): `pnpm install` does not ship it.

## Roadmap

- [x] Core types + runtime abstraction + extension discovery
- [x] FakeRuntime + CLI vertical slice
- [x] Workflow engine (DAG, approval gates, retry, capability validation)
- [x] Pi runtime adapter (AgentSession SDK, in-process)
- [x] Japanese SI skills (requirements, basic design, unit test, evidence, code review)
- [ ] DeepSeek Harness runtime adapter
- [ ] Excel/Word rendering, Jira/GitHub/Playwright tools
- [ ] Web dashboard
- [ ] Japan SWE-Agent Benchmark (Pi vs DeepSeek Harness)
- [ ] Approval CLI interaction, audit log

## License

MIT
