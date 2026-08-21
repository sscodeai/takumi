# jp-code-review

日本企業ソフトウェア開発のコードレビュー（レビュー指摘対応）スキル。

## Purpose

実装コードを要件・設計・テストと照合してレビューし、指摘事項を構造化して出力する。レビュー指摘の修正も支援する。

## Input

- 実装コード（diff）
- 基本設計書
- 要件（REQ-xxx）
- テスト仕様書

## Output

| フィールド | 説明 |
|---|---|
| ID | REVIEW-001 |
| Severity | Critical / Major / Minor |
| Category | ロジック / セキュリティ / 性能 / 設計逸脱 / テスト不足 / コーディング規約 |
| Location | ファイル・行 |
| Issue | 指摘内容 |
| Suggestion | 修正提案 |
| Traceability | 関連 REQ / UT |

## Checklist

- [ ] 要件との整合性チェック（実装漏れ・余計な実装）
- [ ] 設計との整合性（設計書にない実装は理由を問う）
- [ ] セキュリティ（インジェクション・認可・機密情報）
- [ ] テストカバレッジ（新規ロジックに UT があるか）

## Files

```
SKILL.md
prompts/review.md
checklists/review-checklist.md
```