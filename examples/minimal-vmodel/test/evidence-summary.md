# Evidence 汇总 / エビデンス集約レポート

対象: `examples/minimal-vmodel` 社員管理システム（実装コード）
作成日時（UTC）: 2026-08-19T00:21:50Z

---

## 1. 実行環境

| 項目 | 値 |
|------|-----|
| Node.js | v22.23.2 |
| npm | 10.9.8 |
| Git commit | `df9420231d8d1f68310028d1deeccdf9c1e0792e` |
| 実行方式 | `npm test`（`node --experimental-transform-types --test "test/*.test.ts"`） |
| ソースファイル数 | 20（`src/**/*.ts`） |
| テストファイル数 | 13（`test/*.test.ts`） |

---

## 2. テスト実行結果（Evidence）

### 2.1 集計

```text
# tests 135
# suites 23
# pass 135
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1263
```

| 集計項目 | 値 |
|----------|-----|
| テスト数 | 135 |
| スイート数 | 23 |
| 成功 | 135 |
| 失敗 | 0 |
| キャンセル | 0 |
| スキップ | 0 |
| TODO | 0 |
| 実行時間 | 約 1.26 秒 |
| 判定 | **PASS（全件成功）** |

### 2.2 スイート別結果（23 スイート）

| # | スイート | 結果 |
|---|----------|------|
| 1 | API integration | ✅ PASS |
| 2 | AuthService.login | ✅ PASS |
| 3 | AuthService.logout | ✅ PASS |
| 4 | createAuthMiddleware | ✅ PASS |
| 5 | createErrorHandler | ✅ PASS |
| 6 | createSafeOperationLogger | ✅ PASS |
| 7 | domain errors | ✅ PASS |
| 8 | EmployeeService.create | ✅ PASS |
| 9 | EmployeeService.getById | ✅ PASS |
| 10 | EmployeeService.list | ✅ PASS |
| 11 | EmployeeService.remove | ✅ PASS |
| 12 | EmployeeService.update | ✅ PASS |
| 13 | InMemoryEmployeeRepository | ✅ PASS |
| 14 | isValidPassword / isIsoDate | ✅ PASS |
| 15 | loadConfig | ✅ PASS |
| 16 | password | ✅ PASS |
| 17 | PostgresEmployeeRepository | ✅ PASS |
| 18 | requireRoles | ✅ PASS |
| 19 | token service | ✅ PASS |
| 20 | validateCreate | ✅ PASS |
| 21 | validateListQuery | ✅ PASS |
| 22 | validateLogin | ✅ PASS |
| 23 | validateUpdate | ✅ PASS |

---

## 3. ビルド / 型チェック結果（Evidence）

### 3.1 ビルドスクリプト

package.json に `build` スクリプトは未定義。`dist/` は存在しない。
ビルド相当の静的検証として `typecheck`（`tsc --noEmit`）を実行した。

### 3.2 typecheck 実行結果

```text
> employee-management-system@1.0.0 typecheck
> tsc --noEmit

src/db/employeeRepositoryPg.ts(46,10): error TS2358
src/db/employeeRepositoryPg.ts(68,48): error TS2322
src/db/inMemoryRepository.ts(10,41): error TS2307
src/db/operationLogPg.ts(6,45): error TS2307
typecheck exit: 2
```

| 判定 | 値 |
|------|-----|
| 型エラー数 | 4 |
| 終了コード | 2 |
| 判定 | **FAIL（要修正）** |

### 3.3 型エラー詳細

| ファイル | 行 | コード | 内容 |
|----------|-----|--------|------|
| `src/db/employeeRepositoryPg.ts` | 46 | TS2358 | `instanceof` 左辺の型不正 |
| `src/db/employeeRepositoryPg.ts` | 68 | TS2322 | `FieldError` への代入型不一致 |
| `src/db/inMemoryRepository.ts` | 10 | TS2307 | `./employeeRepository.ts` の解決不可 |
| `src/db/operationLogPg.ts` | 6 | TS2307 | `./operationLog.ts` の解決不可 |

---

## 4. 総合判定

| 項目 | 結果 | 備考 |
|------|------|------|
| ユニット / 統合テスト | ✅ PASS（135/135） | 実行時エラーなし |
| 型チェック（ビルド相当） | ❌ FAIL（4 エラー） | テスト実行には影響しない |
| ビルド成果物 | なし | `build` スクリプト未定義 |

### 結論

- テスト実行は全件成功し、要求仕様（ログイン認証・社員 CRUD・RBAC・入力検証・例外処理）に対するテストエビデンスは取得済み。
- 型チェックに 4 件の既知エラーが残存しており、本番ビルド / 型安全性の観点では要修正（既知ギャップとして記録）。
