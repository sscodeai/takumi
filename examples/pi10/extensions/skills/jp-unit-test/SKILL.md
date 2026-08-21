# jp-unit-test

日本企業ソフトウェア開発の単体テスト（Unit Test）スキル。

## Purpose

設計・実装から構造化されたテストケース（UT-001, UT-002, ...）を生成し、可能な限り実際に実行する。

## Input

- 実装コード
- 基本設計書（API・画面仕様）
- 要件（REQ-xxx）

## Output

各テストケース：

| フィールド | 説明 |
|---|---|
| ID | UT-001（連番） |
| Requirement | 由来要件（REQ-xxx） |
| Precondition | 前提条件 |
| Input | 入力値 |
| Steps | 手順 |
| Expected | 期待値 |
| Actual | 実測値 |
| Status | PASS / FAIL |

## Traceability

各テストケースに由来要件と実装箇所をリンク：`traces: [REQ-001]`、`codeRef: src/...`

## Checklist

- [ ] 正常系・異常系・境界値のケースが揃っているか
- [ ] 各ケースに期待値があるか
- [ ] 各ケースが REQ にリンクされているか
- [ ] テストが実際に実行されたか（実行結果があるか）

## Files

```
SKILL.md
prompts/generate.md
prompts/execute.md
schemas/test-case.schema.json
checklists/test-quality.md
```