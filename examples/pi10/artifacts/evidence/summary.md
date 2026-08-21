# エビデンスサマリー

- 収集日時: 2026-08-20T01:07:25Z (UTC)
- プロジェクト: 在庫管理システム (com.example.inventory) / モジュール: pi10
- 実行環境: JDK 17.0.20 (Temurin-17.0.20+8) / Maven 3.9.9 (<home>/tools/apache-maven-3.9.9)
- 実行コマンド: `mvn test`
- 合計: Tests run: 59, Failures: 0, Errors: 0, Skipped: 0
- エビデンス件数: 59 件（全て PASS、失敗ケースなし）

## テストケース別エビデンス

| エビデンスID | 種別 | ファイル | トレーサビリティ | 結果 |
|---|---|---|---|---|
| EVIDENCE-001 | test-result | artifacts/evidence/unit/AuthIntegrationTest/UT-AUTH-002.json | UT-AUTH-002, REQ-USER / E-401 / API-USR-001 | PASS |
| EVIDENCE-002 | test-result | artifacts/evidence/unit/AuthIntegrationTest/UT-AUTH-006.json | UT-AUTH-006, REQ-USER / E-401 | PASS |
| EVIDENCE-003 | test-result | artifacts/evidence/unit/AuthIntegrationTest/UT-AUTH-001.json | UT-AUTH-001, REQ-USER / API-USR-001 | PASS |
| EVIDENCE-004 | test-result | artifacts/evidence/unit/AuthIntegrationTest/UT-AUTH-003.json | UT-AUTH-003, REQ-USER / E-401 | PASS |
| EVIDENCE-005 | test-result | artifacts/evidence/unit/AuthIntegrationTest/UT-AUTH-004.json | UT-AUTH-004, REQ-USER / V-009 / V-010 / E-400 | PASS |
| EVIDENCE-006 | test-result | artifacts/evidence/unit/AuthIntegrationTest/UT-AUTH-005.json | UT-AUTH-005, REQ-USER / 権限 §6 | PASS |
| EVIDENCE-007 | test-result | artifacts/evidence/unit/AuthIntegrationTest/UT-AUTH-007.json | UT-AUTH-007, REQ-USER / A-03 | PASS |
| EVIDENCE-008 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-004.json | UT-INV-004, REQ-INV / API-INV-004 | PASS |
| EVIDENCE-009 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-006.json | UT-INV-006, REQ-INV / V-005 / E-409（異常: 在庫超過） | PASS |
| EVIDENCE-010 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-008.json | UT-INV-008, REQ-USER / 権限 §6.2 / E-403 | PASS |
| EVIDENCE-011 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-007.json | UT-INV-007, REQ-INV / V-001 / E-404 | PASS |
| EVIDENCE-012 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-009.json | UT-INV-009, REQ-INV / A-07 | PASS |
| EVIDENCE-013 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-002.json | UT-INV-002, REQ-INV / V-005（境界値: 数量 1） | PASS |
| EVIDENCE-014 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-001.json | UT-INV-001, REQ-INV / API-INV-003 / A-07 | PASS |
| EVIDENCE-015 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-003.json | UT-INV-003, REQ-INV / V-005（異常: 0 / 負値） | PASS |
| EVIDENCE-016 | test-result | artifacts/evidence/unit/InventoryIntegrationTest/UT-INV-005.json | UT-INV-005, REQ-INV / V-005（境界値: 出庫数量 = 現在在庫） | PASS |
| EVIDENCE-017 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-002.json | UT-ORD-002, REQ-ORDER / V-007（境界値: 数量 1） | PASS |
| EVIDENCE-018 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-010.json | UT-ORD-010, REQ-ORDER / E-409 / API-ORD-005（異常: 在庫不足） | PASS |
| EVIDENCE-019 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-015.json | UT-ORD-015, REQ-ORDER / §3.2 同時実行制御 / E-409 | PASS |
| EVIDENCE-020 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-005.json | UT-ORD-005, REQ-ORDER / V-008（異常: 空・256 文字） | PASS |
| EVIDENCE-021 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-007.json | UT-ORD-007, REQ-ORDER / API-ORD-004 | PASS |
| EVIDENCE-022 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-014.json | UT-ORD-014, REQ-ORDER / API-ORD-006 / E-409（異常: 再キャンセル） | PASS |
| EVIDENCE-023 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-008.json | UT-ORD-008, REQ-ORDER / API-ORD-004 / E-409（異常: 状態遷移不正） | PASS |
| EVIDENCE-024 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-011.json | UT-ORD-011, REQ-ORDER / API-ORD-005 / E-409（異常: 再確定） | PASS |
| EVIDENCE-025 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-012.json | UT-ORD-012, REQ-ORDER / API-ORD-006 | PASS |
| EVIDENCE-026 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-009.json | UT-ORD-009, REQ-ORDER / API-ORD-005 | PASS |
| EVIDENCE-027 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-006.json | UT-ORD-006, REQ-ORDER / V-006 / E-404（異常: 商品不存在） | PASS |
| EVIDENCE-028 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-001.json | UT-ORD-001, REQ-ORDER / API-ORD-002 / A-06 | PASS |
| EVIDENCE-029 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-004.json | UT-ORD-004, REQ-ORDER / API-ORD-002（異常: 明細 0 件） | PASS |
| EVIDENCE-030 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-003.json | UT-ORD-003, REQ-ORDER / V-007（異常: 0 / 負値） | PASS |
| EVIDENCE-031 | test-result | artifacts/evidence/unit/OrderIntegrationTest/UT-ORD-013.json | UT-ORD-013, REQ-ORDER / API-ORD-006 / A-05 | PASS |
| EVIDENCE-032 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-009.json | UT-PROD-009, REQ-INV / A-02 | PASS |
| EVIDENCE-033 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-008.json | UT-PROD-008, REQ-INV / API-INV-002 / E-404 | PASS |
| EVIDENCE-034 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-003.json | UT-PROD-003, REQ-INV / V-003（境界値: 単価最大） | PASS |
| EVIDENCE-035 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-001.json | UT-PROD-001, REQ-INV / A-02 / V-002〜V-004 | PASS |
| EVIDENCE-036 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-010.json | UT-PROD-010, REQ-USER / 権限 §6.2 / E-403 | PASS |
| EVIDENCE-037 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-007.json | UT-PROD-007, REQ-INV / V-004（境界値: 在庫 0 / 負値） | PASS |
| EVIDENCE-038 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-006.json | UT-PROD-006, REQ-INV / V-002（異常: 空・256 文字） | PASS |
| EVIDENCE-039 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-002.json | UT-PROD-002, REQ-INV / V-003（境界値: 単価 0） | PASS |
| EVIDENCE-040 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-005.json | UT-PROD-005, REQ-INV / V-003（異常: 桁超過） | PASS |
| EVIDENCE-041 | test-result | artifacts/evidence/unit/ProductIntegrationTest/UT-PROD-004.json | UT-PROD-004, REQ-INV / V-003（異常: 負値） | PASS |
| EVIDENCE-042 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-007.json | UT-USR-007, REQ-USER / API-USR-005 | PASS |
| EVIDENCE-043 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-010.json | UT-USR-010, REQ-USER / 権限 §6.2 / E-403 | PASS |
| EVIDENCE-044 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-009.json | UT-USR-009, REQ-USER / API-USR-005 / E-409（異常: 自分自身の削除） | PASS |
| EVIDENCE-045 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-008.json | UT-USR-008, REQ-USER / API-USR-004/005 / E-409（異常: 最後の admin） | PASS |
| EVIDENCE-046 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-004.json | UT-USR-004, REQ-USER / V-010 / A-08（異常: パスワード） | PASS |
| EVIDENCE-047 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-002.json | UT-USR-002, REQ-USER / V-009 / E-409（異常: 重複） | PASS |
| EVIDENCE-048 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-003.json | UT-USR-003, REQ-USER / V-009（異常: 形式不正） | PASS |
| EVIDENCE-049 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-005.json | UT-USR-005, REQ-USER / V-011（異常: ロール不正） | PASS |
| EVIDENCE-050 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-006.json | UT-USR-006, REQ-USER / API-USR-004 | PASS |
| EVIDENCE-051 | test-result | artifacts/evidence/unit/UserIntegrationTest/UT-USR-001.json | UT-USR-001, REQ-USER / API-USR-003 / §10 | PASS |
| EVIDENCE-052 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-007.json | IT-007, REQ-009（UT-USR-010 / UT-INV-008 / UT-PROD-010 の結合確認） | PASS |
| EVIDENCE-053 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-005.json | IT-005, REQ-005 / REQ-006 / REQ-015（UT-ORD-013 の結合確認） | PASS |
| EVIDENCE-054 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-008.json | IT-008, REQ-011 / REQ-010（UT-AUTH-004 / UT-PROD-008 / UT-ORD-008 の結合確認） | PASS |
| EVIDENCE-055 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-006.json | IT-006, REQ-003 / REQ-004 / REQ-015（UT-INV-001 / UT-INV-004 の結合確認） | PASS |
| EVIDENCE-056 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-003.json | IT-003, REQ-006 / REQ-015（UT-ORD-009 / UT-INV-004 の結合確認） | PASS |
| EVIDENCE-057 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-002.json | IT-002, REQ-007 / REQ-008（UT-USR-001 / UT-AUTH-001 の結合確認） | PASS |
| EVIDENCE-058 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-001.json | IT-001, REQ-008 / REQ-009 / REQ-002（UT-AUTH-001 / UT-AUTH-005 / UT-PROD 系との結合確認） | PASS |
| EVIDENCE-059 | test-result | artifacts/evidence/integration/CrossModuleIntegrationTest/IT-004.json | IT-004, REQ-006 / REQ-014 / REQ-011（UT-ORD-010 / UT-INV-006 の結合確認） | PASS |

## Surefire ログ（スイート別）

| スイート | 種別 | ファイル | 結果 |
|---|---|---|---|
| com.example.inventory.AuthIntegrationTest | test-log | artifacts/evidence/surefire-reports/com.example.inventory.AuthIntegrationTest.txt (XML: TEST-com.example.inventory.AuthIntegrationTest.xml) | PASS |
| com.example.inventory.CrossModuleIntegrationTest | test-log | artifacts/evidence/surefire-reports/com.example.inventory.CrossModuleIntegrationTest.txt (XML: TEST-com.example.inventory.CrossModuleIntegrationTest.xml) | PASS |
| com.example.inventory.InventoryIntegrationTest | test-log | artifacts/evidence/surefire-reports/com.example.inventory.InventoryIntegrationTest.txt (XML: TEST-com.example.inventory.InventoryIntegrationTest.xml) | PASS |
| com.example.inventory.OrderIntegrationTest | test-log | artifacts/evidence/surefire-reports/com.example.inventory.OrderIntegrationTest.txt (XML: TEST-com.example.inventory.OrderIntegrationTest.xml) | PASS |
| com.example.inventory.ProductIntegrationTest | test-log | artifacts/evidence/surefire-reports/com.example.inventory.ProductIntegrationTest.txt (XML: TEST-com.example.inventory.ProductIntegrationTest.xml) | PASS |
| com.example.inventory.UserIntegrationTest | test-log | artifacts/evidence/surefire-reports/com.example.inventory.UserIntegrationTest.txt (XML: TEST-com.example.inventory.UserIntegrationTest.xml) | PASS |

## メタデータ

- 保存先: `artifacts/evidence/metadata.json`（日時・実行環境・スイート集計を含む）
- 失敗ケース: なし（隠蔽対象なし）

