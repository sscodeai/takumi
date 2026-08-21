# jp-requirements

日本企業ソフトウェア開発の要件定義（Requirements Analysis）スキル。

## Purpose

入力（Markdown / Text / 要件文書）を解析し、標準化された Requirement リスト（REQ-001, REQ-002, ...）を出力する。

## Input

- 要件定義書 / 仕様書 / Issue / 顧客要求（Markdown またはテキスト）

## Output

各要件は以下のフィールドを持つ：

| フィールド | 必須 | 説明 |
|---|---|---|
| ID | ✅ | REQ-001（連番） |
| Title | ✅ | 要件タイトル |
| Description | ✅ | 要件の説明 |
| Acceptance Criteria | ✅ | 受け入れ基準 |
| Priority | ✅ | High / Medium / Low |
| Source | ✅ | 出典（要件文書の節や発言など） |
| Traceability | ✅ | トレーサビリティリンク（下流への ID は実装フェーズで付与） |

## Checklist

- [ ] 曖昧な記述は 5W1H で具体化したか
- [ ] 業務用語と技術用語を区別したか
- [ ] 非機能要件（性能・セキュリティ・可用性）を漏らしていないか
- [ ] 各要件に受け入れ基準があるか
- [ ] ID 採番が一意か

## Files

```
SKILL.md
prompts/analyze.md        # 要件解析プロンプト
prompts/refine.md         # 曖昧要件洗い出しプロンプト
examples/requirements-sample.md
checklists/quality.md
schemas/requirement.schema.json
```