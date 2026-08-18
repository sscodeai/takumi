# jp-basic-design

日本企業ソフトウェア開発の基本設計（Basic Design）スキル。

## Purpose

要件定義（REQ-xxx）から日本スタイルの基本設計書を生成する。第一版は Markdown/JSON 形式、将来 Excel テンプレートをサポートする。

## Input

- 要件リスト（REQ-001 ...）

## Output

基本設計書は以下を含む：

| セクション | 説明 |
|---|---|
| System Overview | システム概要 |
| Architecture | アーキテクチャ（構成図、技術選定） |
| Screen List | 画面一覧 |
| API List | API 一覧（エンドポイント、メソッド、入出力） |
| DB Design | DB 設計（テーブル・ER 関係） |
| Permission | 権限設計 |
| Validation | 入力検証ルール |
| Error Handling | 例外処理・エラーコード |
| External Interfaces | 外部インターフェース |
| Non-functional Requirements | 非機能要件（性能・セキュリティ） |

## Traceability

各設計要素に由来要件をリンクする：`traces: [REQ-001, REQ-002]`

## Checklist

- [ ] 全 REQ が設計書のどこかにマッピングされているか
- [ ] 画面一覧と API 一覧の整合性があるか
- [ ] 例外処理が漏れていないか
- [ ] 非機能要件が設計に反映されているか

## Files

```
SKILL.md
prompts/generate.md
schemas/basic-design.schema.json
checklists/design-quality.md
```