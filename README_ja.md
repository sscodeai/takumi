<p align="center">
  <img src="./assets/brand/takumi-logo.svg" alt="Takumi" width="720">
</p>

<p align="center">
  <strong>検証可能な Agentic Software Delivery のためのモデル非依存プラットフォーム。</strong>
  <br>
  Workflows、traceability、evidence-native testing、agent evals、verify-before-done loops。
</p>

<p align="center">
  <a href="https://github.com/sscodeai/takumi/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sscodeai/takumi/actions/workflows/ci.yml/badge.svg" /></a>
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
| Agents can claim "done" too early | Quality gates、保留検証テスト、independent verification |
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

同じ原則は「仕事がどこから来るか」にも当てはまる（ADR-006）:

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
        GitHub / GitLab  —  plain push、PR は 1 本、checks、レビュー済み commit のみ merge
                            能力が無ければ明示的なエラー。黙って何もしない。
```

board 側が delivery state（label / status / column）を持ち、Takumi 側は実行証跡を持つ。
provider は自分が「できること」を宣言し、持っていない能力を要求された場合は
明示的なエラーになる — 黙って何もしない、という選択はしない。

```text
takumi/
├── apps/cli/              # takumi CLI: init, run, loop, runtime list, extension list
├── apps/console/          # SSE live logs を備えた lightweight web console
├── packages/core/         # workflow engine, runtime API, artifacts, traceability, MEA loop, sandbox
├── runtimes/              # fake, pi, deepseek, cli adapters
├── boards/                # task-board providers: fake, github, gitlab, jira, notion, redmine
├── deliveries/            # delivery providers: fake, github, gitlab
├── extensions/            # skills, tools, workflows
├── eval/                  # agent reliability evaluation tasks
├── bench/                 # system benchmark baselines
├── examples/              # Japanese SI を含む end-to-end delivery examples
└── docs/                  # ADRs、bug ledger、evaluation notes
```

## Core Ideas

- **Small Core**: orchestration、task/event/artifact models、runtime abstraction、extension loading、approval、audit のみを core が持つ。
- **Four extension kinds**: Skill、Tool Plugin、Workflow Plugin、Runtime Adapter。
- **Board agnostic**: 仕事は `TaskBoardProvider`（GitHub、GitLab、Jira、Notion、その他は MCP/REST adapter 1 本）から来る。board が delivery state を持ち、Takumi が実行証跡を持つ。
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
| Task-board providers: fake / GitHub / GitLab / Jira / Notion / Redmine, one shared contract suite | Done |
| Read-only board view: `takumi board --provider <id>` | Done |
| Delivery providers: fake / GitHub / GitLab — plain push、PR 1 本、レビュー済み commit のみ merge | Done |
| Runnable board -> delivery -> merge demo (in-memory、認証情報不要): `node scripts/board-delivery-demo.mjs` | Done |
| Pilot safety rails (ADR-008): 排他 slot lock、閉じた event registry、state bootstrap (`takumi board --check/--bootstrap`) | Done |
| Pilot tick (ADR-009): `takumi pilot --once` — select / lock / worktree / agent / deliver / review。systemd・cron で駆動 | Done |
| Pilot metrics (ADR-010): JSON カウンタ + Prometheus textfile、progress 書き込みの throttle | Done |
| Filing work (ADR-011): 全 board の `createWork`（marker で冪等）、赤い CI が自分で item を立てる | Done |
| Scoping a tick (ADR-012): 各 board 自身の検索による `query` スコープ、検索できない board では fail-closed | Done |
| Deterministic reviewer (ADR-013): `reviewMode: rules` — テスト弱体化と protected path を block、fail-closed | Done |
| Agent Eval with 保留検証テスト and repair loop | Done |
| MEA loop: Manage, Execute, Audit | Done |
| Golden Path E2E: Spring Boot + Vue inventory system, 53 Java files, 59 tests green | Done |

## Agent Eval

Takumi は `eval/` に Agent Eval framework を含みます。easy、hard、trap、no-self-test、complex、implicit constraint の 6 グループ、合計 23 個の real SWE tasks を扱います。各 task には agent の prompt context から除外された machine-verifiable verifier tests があり、agent-written tests は ground truth として扱いません。

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

board / delivery 層で見つかった defect（症状・根因・修正 commit・再発を防ぐテスト）は
[docs/bugs-fixed.md](./docs/bugs-fixed.md) に、Methodology、caveats、limitations は
[docs/evaluation.md](./docs/evaluation.md) にまとめています。

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
- board 層（ADR-006）は「仕事の取得元」、delivery 層（ADR-007）は branch / pull request / checks / merge を担当します。board ごとに表現できることは意図的に異なります: Notion database には label も編集可能な comment も pull request も無いため、それらの操作は黙って無視されるのではなく fail closed で失敗します。
- すべての provider はオフラインテストのみです: 実在の board / host に対して動かした adapter はまだありません。初回の実運用では API の細部（2 ページ目以降のページング、サイト固有の status / property 名、self-hosted の base URL）を調整する前提で見てください。
- これらの board では claim はアトミックではありません（全 provider で `atomicClaim: false`）: 同じアカウントを共有する 2 つの run が同時に claim したと誤認し得るため、「1 item = 1 runner」を保証するローカル slot lock は呼び出し側の責務です。
- base の merge がコンフリクトした場合は abort し、review セッションに引き渡します。履歴を書き換えて解決することはありません。
- Redmine では `statusMap`（CLI: `--status-map "ready=New,pr_open=In Progress"`）と、run 記録用のテキスト custom field（`--state-field`）が必要です。status がどの state にも対応しない issue は、修正方法を示して REPORT されます（黙って落とすことはありません）。

## Roadmap

- [x] Core types, runtime abstraction, and extension discovery
- [x] Workflow engine with DAG, approval gates, retry, and capability validation
- [x] Fake, Pi, DeepSeek, and CLI runtime adapters
- [x] Japanese SI skills and V-model workflow
- [x] Agent Eval and system benchmarks
- [x] Durable resume, parallel execution, web console, sandbox, and MEA loop
- [x] Task-board providers (fake / GitHub / GitLab / Jira / Notion / Redmine) with one shared contract suite
- [x] DeliveryProvider port: branch、plain push、PR 1 本、checks、レビュー済み head の merge
- [x] Delivery adapters for GitHub and GitLab
- [ ] One MCP/REST board adapter for the long tail (Backlog, Plane, in-house systems)
- [ ] A `deliveries/git` adapter for a bare remote with no review surface
- [ ] Claude runtime adapter
- [ ] Excel, Word, and Playwright tool plugins
- [ ] Jira and GitHub tool plugins (board 層が issue 連携をすでに担当)
- [ ] npm package publishing
- [ ] Real-repo-scale evals

## License

Takumi は [MIT License](./LICENSE) の下で公開されています。
