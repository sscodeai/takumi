# Takumi

> **オープンソースの拡張可能な Agentic Software Engineering Platform — 日本企業のソフトウェア開発プロセスを第一級サポート。**

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

## クイックスタート

```bash
# 1. インストール
npm install -g takumi

# 2. プロジェクトを初期化
takumi init

# 3. 決定的なフェイクランタイムでタスクを実行
takumi run "Implement user login API"

# 4. Pi ランタイムで本物のワークフローを実行
takumi run requirements.md --workflow jp-si-standard --runtime pi
```

**Bring your own harness** — Core を変更せず設定だけでランタイムを切り替え:

```bash
takumi run requirements.md --workflow jp-si-standard --runtime fake   # 決定的（テスト用）
takumi run requirements.md --workflow jp-si-standard --runtime pi     # 実 Pi エージェント
```

## アーキテクチャ

```
takumi/
├── apps/cli/              # takumi CLI (init/run/runtime list/extension list)
├── packages/core/         # オーケストレーション基盤・ランタイム抽象・ワークフローエンジン・アーティファクトストア・トレーサビリティ
├── runtimes/              # ランタイムアダプタ (fake, pi)
├── extensions/            # ファーストパーティ拡張
│   ├── skills/            #   jp-requirements, jp-basic-design, jp-unit-test, jp-evidence, jp-code-review...
│   ├── tools/             #   (excel, jira, github, playwright — ロードマップ)
│   └── workflows/         #   jp-si-standard (V-model), rapid-mvp
├── examples/              # エンドツーエンドデモ
├── benchmarks/            # Japan SWE-Agent Benchmark (ロードマップ)
└── docs/                  # ADR・調査ノート・プロジェクトステータス
```

### コア原則

- **スモールコア** — Core はオーケストレーション・タスク/イベント/アーティファクトモデル・ランタイム抽象・拡張ローディング・承認・監査のみ。日本 SI 固有・ランタイム固有のコードを含まない。
- **4 種の拡張** — Skill（知識/手順）、Tool Plugin（実行可能な能力）、Workflow Plugin（宣言的プロセス）、Runtime Adapter（ハーネスエンジン）。
- **Harness 非依存のランタイム API** — 統一イベントストリーム上の `runTask / cancel / getStatus / getUsage / getArtifacts`。内部ツールコールは統一しない。
- **デフォルトでトレーサビリティ** — すべてのアーティファクトがトレースリンク（REQ-001 → DESIGN-001 → UT-001 → EVIDENCE-001）を持ち、`takumi run` はトレーサビリティマトリクスを出力。
- **ヒューマン・イン・ザ・ループ** — ワークフローは承認ゲートを宣言でき、CLI は `[a] 承認 / [r] 却下 / [v] 表示` を促す。

## ドキュメント

- アーキテクチャ決定記録: `docs/adr/`（ランタイム抽象、拡張システム、ワークフローモデル、イベントモデル、アーティファクトトレーサビリティ）
- 技術憲章: `docs/CHATTER.md`
- プロジェクトステータス: `docs/PROJECT_STATUS.md`

## ロードマップ

- [x] コア型 + ランタイム抽象 + 拡張ディスカバリ
- [x] FakeRuntime + CLI 垂直スライス
- [x] ワークフローエンジン（DAG、承認ゲート、リトライ、ケイパビリティ検証）
- [x] Pi ランタイムアダプタ（AgentSession SDK、インプロセス）
- [x] 日本 SI スキル（要件定義、基本設計、単体テスト、エビデンス、コードレビュー）
- [ ] DeepSeek Harness ランタイムアダプタ
- [ ] Excel/Word レンダリング、Jira/GitHub/Playwright ツール
- [ ] Web ダッシュボード
- [ ] Japan SWE-Agent Benchmark（Pi vs DeepSeek Harness）
- [ ] 承認 CLI インタラクション、監査ログ

## ライセンス

MIT