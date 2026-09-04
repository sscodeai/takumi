<p align="center">
  <img src="./assets/brand/takumi-logo.svg" alt="Takumi" width="720">
</p>

<p align="center">
  <strong>検証可能な Agentic Software Delivery のためのモデル非依存プラットフォーム。</strong>
  <br>
  Workflows、traceability、evidence-native testing、agent evals、verify-before-done loops。
</p>

<p align="center">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827.svg" /></a>
  <img alt="Node 20 plus" src="https://img.shields.io/badge/node-20%2B-2DD4BF.svg" />
  <img alt="TypeScript 5.x" src="https://img.shields.io/badge/typescript-5.x-3178C6.svg" />
  <img alt="Developer Preview" src="https://img.shields.io/badge/status-developer_preview-F97316.svg" />
</p>

<p align="center">
  <a href="./README.md">English</a> | 日本語
</p>

---

Takumi は AI ソフトウェアデリバリーのためのオープンソース orchestration layer です。単一の coding agent、Pi wrapper、DeepSeek fork ではありません。Takumi は複数の agent runtime を、明示的な workflow、quality gate、artifact、traceability、independent verification を通じて統合します。

> **Agents propose. Takumi verifies.**

Takumi は、AI agent が生成したソフトウェア変更を、レビュー可能・テスト可能・再開可能・監査可能・エビデンス付きで納品可能な形にするための基盤です。日本 SI / V-model delivery は first-party workflow として含まれますが、Takumi の適用範囲はそこに限定されません。

## What You Can Do

- 要件から evidence まで、構造化された software delivery workflow を実行する。
- Platform core を変更せずに agent runtime を切り替える。
- Requirements、design、tests、evidence、review を traceability でつなぐ。
- Agent output を実テストと独立収集された evidence で gate する。
- Hidden-ground-truth SWE tasks で agent reliability を評価する。
- Long-horizon agent work に Manage-Execute-Audit loop を適用する。

## Quick Start

ソースからインストールします。npm package publishing は planned ですが、まだ未リリースです。

```bash
git clone https://github.com/sscodeai/takumi.git
cd takumi

pnpm install
pnpm build
```

API key なしで deterministic local task を実行します。

```bash
pnpm exec takumi init
pnpm exec takumi run "Implement user login API"
```

Real runtime で workflow を実行します。

```bash
export COMMANDCODE_API_KEY=...
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime deepseek
```

MEA loop を実行します。

```bash
pnpm exec takumi loop "Fix the sumEven bug and add tests" --runtime deepseek --max-rounds 5
```

## Why Takumi

| Problem | Takumi approach |
|---|---|
| AI tools generate code but lose the delivery trail | Requirements、design、tests、evidence、review をつなぐ traceability matrix |
| Products lock users into one model or harness | fake、Pi、DeepSeek、CLI bridge、future runtimes を扱う runtime adapter API |
| Tests and evidence are treated as afterthoughts | Unit / integration test deliverables のための evidence-native pipeline |
| Agents can claim "done" too early | Quality gates、hidden tests、independent verification |
| Long tasks lose state across context windows | Persistent task state を持つ Manage-Execute-Audit loop |
| Domain delivery processes are hard to encode | Workflow / skill extension system。Japanese SI は built-in example |

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
├── apps/console/          # SSE live logs を備えた lightweight web console
├── packages/core/         # workflow engine, runtime API, artifacts, traceability, MEA loop, sandbox
├── runtimes/              # fake, pi, deepseek, cli adapters
├── extensions/            # skills, tools, workflows
├── eval/                  # agent reliability evaluation tasks
├── bench/                 # system benchmark baselines
├── examples/              # Japanese SI を含む end-to-end delivery examples
└── docs/                  # ADRs and evaluation notes
```

## Core Ideas

- **Small Core**: orchestration、task/event/artifact models、runtime abstraction、extension loading、approval、audit のみを core が持つ。
- **Four extension kinds**: Skill、Tool Plugin、Workflow Plugin、Runtime Adapter。
- **Harness agnostic**: `runTask`、`cancel`、`getStatus`、`getUsage`、`getArtifacts` を unified event stream 上で扱う。
- **Traceability by default**: `REQ-001 -> DESIGN-001 -> UT-001 -> EVIDENCE-001`。
- **Human in the loop**: workflow は approval gate を宣言できる。
- **Independent verification**: agent の完了主張だけでは完了と見なさない。

## Features

| Capability | Status |
|---|---|
| Pluggable runtimes: fake / Pi / DeepSeek / CLI bridge | Done |
| Declarative workflows, including Japanese SI / V-model | Done |
| Requirements、basic design、detailed design、tests、evidence、review の skills | Done |
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

Takumi は `eval/` に Agent Eval framework を含みます。easy、hard、trap、no-self-test、complex、implicit constraint の 6 グループ、合計 23 個の real SWE tasks を扱います。各 task には machine-verifiable ground truth があり、agent-written tests は ground truth として扱いません。

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

Methodology、caveats、limitations は [docs/evaluation.md](./docs/evaluation.md) を参照してください。

## MEA Loop

Takumi の Manager Loop は Manage-Execute-Audit pattern に基づいています。

1. **Manager** は persistent task state を保持し、次の subtask を決定する。
2. **Executor** は fresh context で作業し、environment を変更できる。
3. **Auditor** は結果の状態を独立検証する。
4. Clean audit evidence のみが task record を completed にできる。

実装は [packages/core/src/manager-loop.ts](./packages/core/src/manager-loop.ts) にあり、`takumi loop` から利用できます。

Inspired by LongHorizon-Harness:

- GitHub: https://github.com/AMAP-ML/LongHorizon-Harness
- Paper: https://arxiv.org/abs/2608.01964
- Website: https://lh-harness.pages.dev/

## Examples

- [examples/pi10](./examples/pi10): Japanese SI / V-model workflow に基づく Golden Path enterprise delivery project。Requirements、design documents、Spring Boot backend、Vue frontend、unit/integration tests、evidence summaries を含みます。
- [examples/minimal-vmodel](./examples/minimal-vmodel): workflow と traceability 実験用の小さな V-model example。

## Known Limitations

Takumi は現在 Developer Preview です。

- Agent Eval results are preliminary: 23 tasks は有用な evidence ですが、統計的に大規模な benchmark ではありません。
- `takumi loop` is v1: manager decisions はまだ LLM-driven で non-deterministic です。
- Pi runtime は opt-in で、external Pi SDK に依存します。
- Traceability は現在 structural foreign keys ではなく ID naming conventions に依存しています。
- Tool plugins は sandbox を明示的に選択しない限り user privileges で動作します。
- Real-repo-scale evaluation は roadmap 上です。

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

Takumi は [MIT License](./LICENSE) の下で公開されています。
