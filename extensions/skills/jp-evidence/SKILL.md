# jp-evidence

テスト・ビルド・実行結果のエビデンス自動収集スキル。

## Purpose

要件 → 設計 → コード → テスト の各工程で生成された証跡（エビデンス）を自動収集・整理し、トレーサビリティ付きで保存する。日本の SI の納品工程で最も評価される部分。

## Input

- テストログ
- スクリーンショット
- API レスポンス
- DB 実行結果
- ビルド結果
- コマンド出力

## Output

```text
artifacts/evidence/
├── UT-001/
│   ├── test.log
│   └── result.json
├── UT-002/
│   ├── test.log
│   └── result.json
└── summary.md
```

各エビデンスにトレーサビリティ：`trace: [REQ-001, UT-001]`

## Checklist

- [ ] 各テストケースに対応するエビデンスがあるか
- [ ] エビデンスに日時・実行環境が記録されているか
- [ ] エビデンスに由来要件のリンクがあるか
- [ ] 失敗したケースのエビデンスも保存されているか（隠蔽しない）

## Files

```
SKILL.md
prompts/collect.md
schemas/evidence.schema.json
```