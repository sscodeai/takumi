<p align="center">
  <img src="./assets/brand/takumi-logo.svg" alt="Takumi" width="720">
</p>

<p align="center">
  <strong>Model-agnostic platform for verifiable agentic software delivery.</strong>
  <br>
  Workflows, traceability, evidence-native testing, agent evals, and verify-before-done loops.
</p>

<p align="center">
  <a href="https://github.com/sscodeai/takumi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sscodeai/takumi/actions/workflows/ci.yml/badge.svg" /></a>
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
- Evaluate agent reliability with held-out verifier SWE tasks.
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
| Agents can claim "done" too early | Quality gates, held-out verifier tests, and independent verification |
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

The same principle applies to where work comes from (ADR-006):

```text
                          Work request
                                |
                       TaskBoardProvider
                                |
        +-------------+---------+---------+-------------+
        |             |                   |             |
      GitHub        GitLab       Jira      Notion    Redmine   ...one MCP/REST
        |             |            |          |          |          adapter
   Issues + PRs   Issues + MRs   Status   select prop  Status workflow
        |
        └──> DeliveryProvider  (ADR-007)
                   |
        GitHub / GitLab  —  plain push, one pull request, checks, merge of the
                            reviewed commit only; no capability, no silent no-op
```

A board keeps its own delivery state (a label, a status, a column); Takumi keeps
the execution evidence. A provider declares what it can do, and a capability it
does not have is an explicit error, never a silent no-op. Delivery is a separate
port because the two are genuinely different systems: a Jira board can pair with
a GitHub delivery, and a Notion database has no pull request at all.

```text
takumi/
├── apps/cli/              # takumi CLI: init, run, loop, runtime list, extension list
├── apps/console/          # lightweight web console with SSE live logs
├── packages/core/         # workflow engine, runtime API, artifacts, traceability, MEA loop, sandbox
├── runtimes/              # fake, pi, deepseek, cli adapters
├── boards/                # task-board providers: fake, github, gitlab, jira, notion, redmine
├── deliveries/            # delivery providers: fake, github, gitlab
├── extensions/            # skills, tools, workflows
├── eval/                  # agent reliability evaluation tasks
├── bench/                 # system benchmark baselines
├── examples/              # end-to-end delivery examples, including Japanese SI
└── docs/                  # ADRs (006-012: boards, delivery, rails, pilot, metrics, filing, scope), notes
```

## Core Ideas

- **Small Core**: orchestration, task/event/artifact models, runtime abstraction, extension loading, approval, and audit.
- **Four extension kinds**: Skill, Tool Plugin, Workflow Plugin, Runtime Adapter.
- **Board agnostic**: work comes from a `TaskBoardProvider` (GitHub, GitLab, Jira, Notion, or one MCP/REST adapter for the rest). The board owns the delivery state; Takumi owns the execution evidence.
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
| Task-board providers: fake / GitHub / GitLab / Jira / Notion / Redmine, one shared contract suite | Done |
| Read-only board view: `takumi board --provider <id>` | Done |
| Delivery providers: fake / GitHub / GitLab — plain push, one PR, merge of the reviewed commit only | Done |
| Runnable board -> delivery -> merge demo with in-memory providers: `node scripts/board-delivery-demo.mjs` | Done |
| Pilot safety rails (ADR-008): exclusive slot lock, closed event registry, state bootstrap (`takumi board --check/--bootstrap`) | Done |
| Pilot tick (ADR-009): `takumi pilot --once` — select, lock, worktree, agent, deliver, review; systemd/cron shape | Done |
| Pilot metrics (ADR-010): JSON counters + a Prometheus textfile, and progress writes throttled | Done |
| Filing work (ADR-011): `createWork` on every board, idempotent by marker; a red pipeline files its own item | Done |
| Scoping a tick (ADR-012): `query` scope through each board's own search, fail-closed where it cannot search | Done |
| OpenHands as an agent (spike report): proven through the existing pilot seam, zero new abstraction | Done |
| Agent Eval with held-out verifier tests and repair loop | Done |
| MEA loop: Manage, Execute, Audit | Done |
| Golden Path E2E: Spring Boot + Vue inventory system, 53 Java files, 59 tests green | Done |

## Agent Eval

Takumi ships an Agent Eval framework under `eval/`: 23 real SWE tasks across
easy, hard, trap, no-self-test, complex, and implicit constraint groups. Each
task has machine-verifiable verifier tests that are excluded from the agent
prompt context. Agent-written tests are never treated as the ground truth.

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

See [docs/bugs-fixed.md](./docs/bugs-fixed.md) for every defect found in the board
and delivery layers — symptom, root cause, the commit that fixed it and the test
that pins it — and [docs/evaluation.md](./docs/evaluation.md) for methodology, raw caveats,
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
- [examples/openhands-agent.sh](./examples/openhands-agent.sh): run the OpenHands CLI as a pilot agent command (see `docs/openhands-spike-report.md`).

## Known Limitations

Takumi is currently a Developer Preview.

- Agent Eval results are preliminary: 23 tasks is useful evidence, not a statistically large benchmark.
- `takumi loop` is v1: manager decisions are still LLM-driven and non-deterministic.
- Pi runtime is opt-in and depends on an external Pi SDK.
- Traceability currently relies on ID naming conventions rather than structural foreign keys.
- Tool plugins run with user privileges unless a sandbox is explicitly selected.
- Real-repo-scale evaluation is still on the roadmap.
- The board layer (ADR-006) covers the work source; the delivery layer (ADR-007) covers branch, pull request, checks and merge. Boards differ in what they can express, on purpose: a Notion database has no labels, no editable comments and no pull requests, so those operations fail closed instead of quietly doing nothing.
- Every provider ships with offline tests only: no adapter has yet been exercised against a live board or host. Expect to adjust API details (pagination beyond the first page, site-specific status/property names, self-hosted base URLs) on first real use.
- Claiming is not atomic on any of these boards (`atomicClaim: false` everywhere): two runs sharing one account can both believe they claimed an item, which is why a local slot lock — one runner per item — remains the caller's job.
- A conflicting base merge is aborted and handed to the review session; takumi never resolves a conflict by rewriting history.
- Redmine needs its `statusMap` (CLI: `--status-map "ready=New,pr_open=In Progress"`) and, for the run record, a text custom field (`--state-field`). An issue whose status maps to nothing is REPORTED with the fix, never silently dropped from the board.

## Roadmap

- [x] Core types, runtime abstraction, and extension discovery
- [x] Workflow engine with DAG, approval gates, retry, and capability validation
- [x] Fake, Pi, DeepSeek, and CLI runtime adapters
- [x] Japanese SI skills and V-model workflow
- [x] Agent Eval and system benchmarks
- [x] Durable resume, parallel execution, web console, sandbox, and MEA loop
- [x] Task-board providers (fake / GitHub / GitLab / Jira / Notion / Redmine) with one shared contract suite
- [x] DeliveryProvider port: branch, plain push, one pull request, checks, merge of the reviewed head
- [x] Delivery adapters for GitHub and GitLab
- [ ] One MCP/REST board adapter for the long tail (Backlog, Plane, in-house systems)
- [ ] A `deliveries/git` adapter for a bare remote with no review surface
- [ ] A `runtimes/openhands` adapter, if per-task usage and artifacts prove worth it (the CLI seam already works — see `docs/openhands-spike-report.md`)
- [ ] Claude runtime adapter
- [ ] Excel, Word, and Playwright tool plugins
- [ ] Jira and GitHub tool plugins (the board layer already covers issues)
- [ ] npm package publishing
- [ ] Real-repo-scale evals

## License

Takumi is released under the [MIT License](./LICENSE).
