# 単体テスト仕様書 / Unit Test Specification

対象: `examples/minimal-vmodel` 社員管理システム（実装コード）
実行日時: 2025-04-30（リポジトリ内テスト実行時点の環境）
実行環境: Node.js v22.23.2（package.json の `engines` は `>=22.18.0`）

## 実行方法

```bash
cd <repo>/examples/minimal-vmodel
npm test
```

- 実装は TypeScript で、コンストラクタの parameter property を利用しているため、Node.js の strip-only モードでは実行できない。
- このため `package.json` の `test` スクリプトを以下へ変更した。
  - `node --experimental-transform-types --test "test/*.test.ts"`
- Node 22 のテストランナーは `--test test/`（ディレクトリ末尾スラッシュ）をモジュールとして解決しようとして失敗するため、glob を指定する。

## 実行結果（エビデンス: `test/unit-test-results.txt`）

```text
# tests 135
# suites 23
# pass 135
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

| 集計 | 値 |
|------|-----|
| テスト数 | 135 |
| スイート数 | 23 |
| 成功 | 135 |
| 失敗 | 0 |
| スキップ | 0 |
| 実行時間 | 約 1.28 秒 |

## テストケース一覧

### UT-001 入力検証（`src/validation/validators.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-001-01 | 有効な登録入力を許容 | REQ-VAL-01 | PASS |
| UT-001-02 | 必須項目欠落を検出 | REQ-VAL-01 | PASS |
| UT-001-03 | employeeNo 形式・境界値 | REQ-EMP-05 | PASS |
| UT-001-04 | 氏名 100 文字制限 | REQ-EMP-05 | PASS |
| UT-001-05 | email 形式 | REQ-VAL-04 | PASS |
| UT-001-06 | username 文字セット | REQ-VAL-02 | PASS |
| UT-001-07 | パスワード強度 | REQ-VAL-03 | PASS |
| UT-001-08 | role 列挙 | REQ-RBAC-01 | PASS |
| UT-001-09 | 部署長・日付形式 | REQ-EMP-05 | PASS |
| UT-001-10 | 未来日付（既知ギャップ: 形式のみ検証） | REQ-EMP-05 | PASS（実装現状を固定） |
| UT-001-11 | 更新入力・ログイン入力・一覧クエリ検証 | REQ-EMP-02,03 / REQ-VAL-01,06 | PASS |

### UT-002 ドメイン例外（`src/domain/errors.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-002-01 | 各例外の status/code/message/details | REQ-VAL-05,06 | PASS |
| UT-002-02 | ValidationError の details | REQ-VAL-01 | PASS |
| UT-002-03 | InternalError の cause | REQ-VAL-08 | PASS |

### UT-003 パスワード（`src/auth/password.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-003-01 | bcrypt ハッシュ化・平文非保存 | REQ-AUTH-03 | PASS |
| UT-003-02 | 正誤検証・ソルト差異 | REQ-AUTH-03 | PASS |

### UT-004 JWT トークン（`src/auth/token.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-004-01 | sign/verify の正常系 | REQ-AUTH-04 | PASS |
| UT-004-02 | 異なる秘密鍵・不正・期限切れ・sub 欠落 | REQ-AUTH-04 | PASS |

### UT-005 認証サービス（`src/auth/authService.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-005-01 | ログイン成功・トークン発行 | REQ-AUTH-01 | PASS |
| UT-005-02 | 失敗時に認証情報を特定しない | REQ-AUTH-02 | PASS |
| UT-005-03 | ログイン入力検証 | REQ-VAL-01 | PASS |
| UT-005-04 | ログイン/ログアウト監査ログ | REQ-AUTH-04 / REQ-NFR-01 | PASS |

### UT-006 社員管理サービス（`src/employees/employeeService.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-006-01 | 一覧の RBAC スコープ | REQ-RBAC-03,05 | PASS |
| UT-006-02 | 詳細参照の水平・垂直越権拒否 | REQ-RBAC-05 | PASS |
| UT-006-03 | 社員登録（admin/manager） | REQ-EMP-01 / REQ-RBAC-03 | PASS |
| UT-006-04 | 社員更新（admin/manager/member 制約） | REQ-EMP-03 / REQ-RBAC-03,04 | PASS |
| UT-006-05 | パスワード更新時のハッシュ化 | REQ-AUTH-03 | PASS |
| UT-006-06 | 社員削除（admin のみ・自身削除禁止） | REQ-EMP-04,06 / REQ-RBAC-02 | PASS |
| UT-006-07 | CREATE/UPDATE/DELETE 監査ログ | REQ-NFR-01 | PASS |

### UT-007 インメモリリポジトリ（`src/db/inMemoryRepository.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-007-01 | create/検索/ページング | REQ-EMP-01,02 | PASS |
| UT-007-02 | 一意制約（employeeNo/email/username） | REQ-VAL-02,04 | PASS |
| UT-007-03 | update/delete と NotFound | REQ-EMP-03,04 / REQ-VAL-06 | PASS |

### UT-008 PostgreSQL リポジトリ（`src/db/employeeRepositoryPg.ts`、Pool モック）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-008-01 | スネークケース→ドメイン型マッピング | REQ-EMP-02 | PASS |
| UT-008-02 | findAll フィルタ・ページング SQL 組み立て | REQ-EMP-02 | PASS |
| UT-008-03 | create/update/delete の正常系・NotFound | REQ-EMP-01,03,04 | PASS |
| UT-008-04 | 一意制約違反の ConflictError 変換 | REQ-VAL-02,04 | PASS |

### UT-009 認証・認可ミドルウェア（`src/middleware/authMiddleware.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-009-01 | Bearer 検証・未指定・不正トークン | REQ-AUTH-04 | PASS |
| UT-009-02 | ロールガード（許可・未認証・403） | REQ-RBAC-02 | PASS |

### UT-010 例外ハンドラ（`src/middleware/errorHandler.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-010-01 | AppError の共通形式変換 | REQ-VAL-05,06 | PASS |
| UT-010-02 | JSON parse / JWT / 未捕捉例外の変換 | REQ-AUTH-04 / REQ-VAL-06,08 | PASS |
| UT-010-03 | スタック情報の非公開 | REQ-VAL-08 | PASS |

### UT-011 設定・操作ログ（`src/config.ts`, `src/logs/operationLog.ts`）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-011-01 | 設定値の既定・上書き・PORT 境界 | — | PASS |
| UT-011-02 | 操作ログ記録と失敗時の継続 | REQ-NFR-01 | PASS |

### UT-012 API 統合テスト（HTTP 経由、`src/app.ts` / routes）

| ID | 内容 | 要件 | Status |
|----|------|------|--------|
| UT-012-01 | ログイン/ログアウト | REQ-AUTH-01,02,04 | PASS |
| UT-012-02 | 認証必須 API の 401 | REQ-AUTH-04 | PASS |
| UT-012-03 | 一覧・詳細の RBAC スコープと越権 | REQ-RBAC-03,05 | PASS |
| UT-012-04 | 社員登録（RBAC・passwordHash 非公開） | REQ-EMP-01 / REQ-AUTH-03 | PASS |
| UT-012-05 | 更新・削除（RBAC・自身削除禁止） | REQ-EMP-03,04,06 | PASS |
| UT-012-06 | バリデーションエラー・JSON/404 統一形式 | REQ-VAL-01,05,06 | PASS |
| UT-012-07 | 内部情報非公開 | REQ-VAL-08 | PASS |

## 既知の実装ギャップ（テスト対象外 / 要確認）

1. **`npm run typecheck` は既存ソースの型エラーで失敗する**（ユニットテスト実行には影響しない）。
   - `src/db/employeeRepositoryPg.ts`: `instanceof` 型エラー、`FieldError` 代入エラー
   - `src/db/inMemoryRepository.ts`: `./employeeRepository.ts` の解決エラー
   - `src/db/operationLogPg.ts`: `./operationLog.ts` の解決エラー
   - ※ 今回はテスト生成のみ依頼のため実装は変更していない。
2. **未来日付の拒否**（REQ-EMP-05）は未実装。現在は形式チェックのみ。UT-001-10 で実装現状を固定。
3. **member の自身更新**（基本設計書 6.2 では許可）はサービス実装では `AuthorizationError` になる。
4. **API の更新メソッド**は設計書の PATCH ではなく PUT で実装されている。
5. **ソフトデリート**（基本設計書 5.5）は未実装で、DELETE は物理削除。
6. **エラーレスポンス形式**は設計書の `{ code, message, fieldErrors }` ではなく `{ error: { code, message, details, traceId } }` で実装されている。
7. **ログイン失敗のアカウントロック**（REQ-AUTH-05）は未実装。
