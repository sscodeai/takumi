# Takumi

> **オープンソースの拡張可能な Agentic Software Engineering Platform — 日本企業のソフトウェア開発プロセスを第一級サポート。**

> **"Agents propose. Takumi verifies."** — 生成AIエージェントは提案する。Takumi は独立検証する。

Takumi はプラットフォーム層です。Pi のラッパーでも、DeepSeek Harness のフォークでも、単なるコーディングエージェントでもありません。プラグイン可能なエージェントランタイムの上でソフトウェアエンジニアリングのワークフローをオーケストレーションし、日本の SI 開発プロセス（要件定義 → 基本設計 → 詳細設計 → 実装 → 単体テスト → 結合テスト → エビデンス → レビュー → 納品）を組み込みサポートします。

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

**Core はプラットフォーム。Extensions はエコシステム。Runtimes はエンジン。**

## Takumi が存在する理由

| 課題 | 既存ツール |
|---|---|
| オープンソースの V-model ワークフロープラットフォームが存在しない | 日本の SI 自動化はすべてクローズドな SaaS |
| 統一されたトレーサビリティチェーンがない | ドキュメントは生成するが、エージェントセッション履歴・ツールログ・要件→エビデンスの git diff は保存しない |
| Harness 非依存のものが存在しない | 各製品は自社の推論バックエンドにロックイン |
| エビデンスネイティブなパイプラインがない | 単体/結合テストのエビデンスを第一級成果物として生成する製品がない |
| **「できました」が信頼できない** | エージェントの主張を独立検証するツールがない（品質ゲート + 隠しテスト）|

## Agent Eval — エージェント信頼性の科学的測定

Takumi には **Agent Eval フレームワーク**（`eval/`）が付属：23 個の実 SWE タスク × 6 グループ（easy/hard/trap/no-self-test/complex/implicit）、すべて machine-verifiable な隠し Ground Truth 付き。

```bash
# モデルを切り替える = 環境変数を切り替える（モデル非依存、実証済み）
TAKUMI_EVAL_HARNESS=deepseek TAKUMI_EVAL_MODEL=deepseek/deepseek-v4-flash node eval/scripts/run-eval.mjs
TAKUMI_EVAL_HARNESS=deepseek TAKUMI_EVAL_MODEL=deepseek/deepseek-v4-pro    node eval/scripts/run-eval.mjs --tasks=ts-complex
TAKUMI_EVAL_HARNESS=pi                                                     node eval/scripts/run-eval.mjs
```

| モデル | first-pass | false completion | repair 発生 |
|---|---|---|---|
| deepseek v4-flash | 23/23 (100%) | 0% | 0 |
| deepseek v4-pro (complex) | 4/5 (80%) | 0% | **1（自然発生 → 修復 → 100% final）** |
| Pi (opencode-zen) | 6/6 (100%) | 0% | 0 |

> **重要な発見**：制御可能で検証可能なタスクではエージェントは高い信頼性を示すが、強いモデルでも失敗することはある（v4-pro が並行処理タスクで初回失敗）— **独立検証レイヤーはどのモデルにも必要**。Eval フレームワーク自身も 2 つの測定バグを検出した（`docs/evaluation.md` 参照）—「測定ツールを先に検証してから結果を信じる」原則の証明。

## クイックスタート

> ソースからインストール（npm 公開は **Planned**、未リリース）。
> Node ≥ 20 と [pnpm](https://pnpm.io) が必要。

```bash
# 1. クローン & ビルド
git clone <repo-url> && cd takumi
pnpm install
pnpm build

# 2. プロジェクトを初期化
pnpm exec takumi init

# 3. 決定的なフェイクランタイムでタスクを実行（API キー不要）
pnpm exec takumi run "Implement user login API"

# 4. 本物のワークフローを実行（DeepSeek via commandcode.ai、COMMANDCODE_API_KEY が必要）
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime deepseek

# 5. MEA ループを実行（Manage-Execute-Audit、arXiv 2608.01964 準拠）
pnpm exec takumi loop "Fix the sumEven bug and add tests" --runtime deepseek --max-rounds 5
```

**Harness は設定だけで切り替え可能**（Core の変更なし）：

```bash
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime fake      # 決定的
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime pi        # Pi エージェント
pnpm exec takumi run requirements.md --workflow jp-si-standard --runtime deepseek  # OpenAI 互換 LLM
```

## アーキテクチャ

```
takumi/
├── apps/cli/              # takumi CLI (init/run/loop/runtime list/extension list)
├── apps/console/          # 軽量 Web コンソール（SSE ライブログ、:8787）
├── packages/core/         # オーケストレーション、ランタイム抽象、ワークフローエンジン、manager-loop (MEA)、sandbox、artifact store、traceability
├── runtimes/              # ランタイムアダプタ (fake, pi, deepseek)
├── extensions/            # ファーストパーティ拡張
│   ├── skills/            #   jp-requirements, jp-basic-design, jp-unit-test, jp-integration-test, jp-evidence, jp-code-review...
│   ├── tools/             #   (excel, jira, github, playwright — roadmap)
│   └── workflows/         #   jp-si-standard (V-model, 11 steps), rapid-mvp
├── eval/                  # Agent Eval (23 tasks × 6 groups, hidden ground truth)
├── bench/                 # システムベンチマーク (B1-B4)
├── examples/              # エンドツーエンドデモ (pi10: 53 Java + 59 tests green)
└── docs/                  # ADRs, evaluation.md
```

### コア原則

- **Small Core** — Core はオーケストレーション、タスク/イベント/アーティファクトモデル、ランタイム抽象、拡張ロード、承認、監査のみを所有。日本 SI 固有・ランタイム固有のものは持たない。
- **4 種類の拡張** — Skill（知識/手順）、Tool Plugin（実行可能な能力）、Workflow Plugin（宣言的プロセス）、Runtime Adapter（ハーネスエンジン）。
- **Harness 非依存のランタイム API** — 統一イベントストリーム上の `runTask / cancel / getStatus / getUsage / getArtifacts`。内部ツールコールは統一しない。
- **デフォルトでトレーサビリティ** — すべてのアーティファクトはトレースリンク（REQ-001 → DESIGN-001 → UT-001 → EVIDENCE-001）を持つ。`takumi run` はトレーサビリティマトリクスを出力。
- **ヒューマンインザループ** — ワークフローは承認ゲートを宣言。CLI は `[a] approve / [r] reject / [v] view` を促す。
- **独立検証** — 品質ゲートは実際のテストを実行。Agent Eval は隠し Ground Truth を使用。MEA ループの Auditor は Executor の主張を信じない。

## 機能

| 機能 | ステータス |
|---|---|
| プラグイン可能ランタイム (fake / pi / deepseek) + `TAKUMI_EVAL_MODEL` モデル切替 | ✅ |
| 日本 SI V-model ワークフロー（11 ステップ、結合試験含む）| ✅ |
| Durable Resume（`--resume`、audit から復元）| ✅ |
| 並列ステップ実行（レイヤーベース、TDD 検証済み）| ✅ |
| サンドボックス分離（unshare: ネットワークオフ / ホスト読み取り専用 / CPU 制限）| ✅ |
| Web コンソール（SSE ライブログ）| ✅ |
| Agent Eval（23 タスク、隠し Ground Truth、修復ループ）| ✅ |
| **Manager Loop — MEA（`takumi loop`、arXiv 2608.01964 準拠）** | ✅ |
| Golden Path 実 E2E（53 Java + 59 テスト全緑、mvn BUILD SUCCESS）| ✅ |

## 参考文献 — 着想の元

Takumi の Manager Loop（MEA: Manage-Execute-Audit）は **LongHorizon-Harness** の研究とアイデアに従っている — 長期タスクのループエンジニアリング：マネージャーがタスク状態を保持して次のサブタスクを決定し、エグゼキュータがフレッシュコンテキストで実行し、オーディターが結果の環境状態を独立検証する（クリーンな監査エビデンスのみがタスク状態を変更する）。

**LongHorizon-Harness**

- GitHub: https://github.com/AMAP-ML/LongHorizon-Harness
- Paper (arXiv): https://arxiv.org/abs/2608.01964
- Website: https://lh-harness.pages.dev/
- Hugging Face Daily Papers: https://huggingface.co/papers/2608.01964 (2026-W32 weekly #1)

Takumi はこのループを TypeScript/Node で独立実装（`packages/core/src/manager-loop.ts`、`takumi loop`）、モデル非依存で実実行検証済み。

## ドキュメント

- Architecture Decision Records: `docs/adr/`（ランタイム抽象、拡張システム、ワークフローモデル、イベントモデル、アーティファクトトレーサビリティ）
- Agent Evaluation: `docs/evaluation.md`（方法論、23 タスク結果、誠実な限界）

## 既知の制限

現在の **Developer Preview** の誠実な範囲：

- **Agent Eval 結果は preliminary**（23 タスクの小サンプル、統計的に有意ではない）；制御タスクでは False Completion 未発生（現実の曖昧さが必要）
- **`takumi loop`（MEA）は v1**：Manager は LLM 判断（非決定的状態機械）、GUI computer-use 未サポート
- **Pi イベントはリアルタイムストリーミングされない**（タスク完了後にバッファリング配送）
- **トレーサビリティは ID 命名規則**（REQ-001 リンク）、構造的外部キーではない
- **Pi ランタイムはオプトイン**（未公開 SDK 依存）：`pnpm install` では同梱されない
- Tool プラグインは `--sandbox unshare` 設定時にサンドボックスでシェル実行、デフォルトは非サンドボックス

## ロードマップ

- [x] Core 型 + ランタイム抽象 + 拡張ディスカバリ
- [x] FakeRuntime + CLI 垂直スライス
- [x] ワークフローエンジン（DAG、承認ゲート、リトライ、能力検証）
- [x] Pi ランタイムアダプタ（AgentSession SDK、インプロセス）
- [x] DeepSeek ランタイムアダプタ（OpenAI 互換ツールループ）+ TAKUMI_EVAL_MODEL
- [x] 日本 SI スキル（要件定義、基本設計、単体テスト、結合テスト、エビデンス、コードレビュー）
- [x] Agent Eval（23 タスク × 2+ モデル）+ システムベンチマーク（B1-B4）
- [x] Durable Resume + Parallel + Web Console + Sandbox
- [x] Manager Loop（MEA、`takumi loop`）
- [ ] Claude（Anthropic Messages）ランタイムアダプタ
- [ ] Excel/Word レンダリング、Jira/GitHub/Playwright ツール
- [ ] npm 公開
- [ ] 実リポジトリ規模の eval（SWE-bench スタイル）

## ライセンス

MIT
