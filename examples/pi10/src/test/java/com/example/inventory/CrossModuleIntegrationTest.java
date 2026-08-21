package com.example.inventory;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 結合テスト（モジュール間連携）IT-001〜IT-008。
 *
 * 単体テスト（UT-*）で担保済みの単一 API の正常/異常系は重複させず、
 * 「複数モジュールの連携境界」が正しくつながるかに集中する。
 * 全て HTTP 経由で実行し、以下の境界を跨いだ実データの流れを検証する：
 *   SecurityFilterChain / JwtAuthenticationFilter → Controller → Service → Service（他モジュール）→ Repository → DB
 */
class CrossModuleIntegrationTest extends BaseIntegrationTest {

    /**
     * IT-001 認証 → 認可 → 商品照会 の連携。
     * 連携境界: AuthService（JWT 発行）→ JwtAuthenticationFilter（検証・SecurityContext 設定）
     *          → SecurityConfig（認可）→ ProductController → ProductService → ProductRepository → DB
     */
    @Test
    void it001_loginTokenDrivesProtectedProductQuery() throws Exception {
        String token = login("admin", "admin123");

        // 認証フローで得た JWT が、保護 API（GET /api/products）でそのまま使えること
        mvc.perform(get("/api/products")
                        .header("Authorization", auth(token)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(0));
    }

    /**
     * IT-002 ユーザー管理 → 認証 の連携。
     * 連携境界: UserService（BCrypt ハッシュ保存）→ UserRepository → DB
     *          → AuthService（PasswordEncoder 照合）→ JwtTokenProvider（JWT 発行）
     * 単体では「作る」と「ログインする」が別々にしか見えないため、
     * 作成したユーザーがそのままログインできることを結合で担保する。
     */
    @Test
    void it002_createdUserCanImmediatelyLogin() throws Exception {
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"integuser1\",\"password\":\"Passw0rd1\",\"role\":\"user\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.username").value("integuser1"));

        // 別モジュール（認証）が、UserService が保存した BCrypt ハッシュを照合できること
        String token = login("integuser1", "Passw0rd1");
        mvc.perform(get("/api/orders")
                        .header("Authorization", auth(token)))
                .andExpect(status().isOk());
    }

    /**
     * IT-003 受注確定 → 在庫引き当て → 履歴記録 の一括連携。
     * 連携境界: OrderService（confirm）→ InventoryService.applyOut（行ロック済み Product を減算）
     *          → ProductRepository / StockTransactionRepository → DB（同一トランザクション）
     */
    @Test
    void it003_orderConfirmAllocatesStockAndRecordsHistoryAcrossModules() throws Exception {
        long productId = createProduct("結合商品A", "1000.00", 10);

        long orderId = createOrder("顧客-IT003", productId, 3);

        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.allocatedStock[0].remainingStock").value(7));

        // 商品モジュール側の在庫数が引き当てを反映
        mvc.perform(get("/api/products/" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(7));

        // 在庫モジュール側の履歴が受注由来（relatedOrderId）を保持
        mvc.perform(get("/api/inventory/transactions?productId=" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].type").value("OUT"))
                .andExpect(jsonPath("$.items[0].quantity").value(3))
                .andExpect(jsonPath("$.items[0].relatedOrderId").value(orderId));
    }

    /**
     * IT-004 受注確定（在庫不足）時の全量ロールバックとエラー伝播。
     * 連携境界: OrderService → InventoryService への減算要求が ApiException(E-409) に変換され、
     *          GlobalExceptionHandler を経て共通エラー形式で返る。
     *          トランザクション境界を跨いでも部分更新が残らないこと（在庫不変・DRAFT 維持・履歴なし）。
     */
    @Test
    void it004_insufficientStockRollsBackWholeChainAndReturnsCommonError() throws Exception {
        long productId = createProduct("結合商品B", "2000.00", 5);
        long orderId = createOrder("顧客-IT004", productId, 10);

        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));

        // 在庫不変（在庫モジュール側）
        mvc.perform(get("/api/products/" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(5));

        // 受注状態不変（受注モジュール側）
        mvc.perform(get("/api/orders/" + orderId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("DRAFT"));

        // 履歴が残っていない（在庫モジュール側）
        mvc.perform(get("/api/inventory/transactions?productId=" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(0));
    }

    /**
     * IT-005 確定受注キャンセル → 在庫戻し入れ → 履歴記録 の一括連携。
     * 連携境界: OrderService（cancel）→ InventoryService.applyIn（在庫戻し）→ StockTransactionRepository
     */
    @Test
    void it005_cancelConfirmedOrderRestoresStockAcrossModules() throws Exception {
        long productId = createProduct("結合商品C", "500.00", 8);
        long orderId = createOrder("顧客-IT005", productId, 3);

        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.allocatedStock[0].remainingStock").value(5));

        mvc.perform(post("/api/orders/" + orderId + "/cancel")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELED"));

        mvc.perform(get("/api/products/" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(8));

        mvc.perform(get("/api/inventory/transactions?productId=" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].type").value("IN"))
                .andExpect(jsonPath("$.items[0].quantity").value(3))
                .andExpect(jsonPath("$.items[0].relatedOrderId").value(orderId));
    }

    /**
     * IT-006 入出庫 → 在庫照会 → 履歴（実行者記録）の連携。
     * 連携境界: SecurityContext（認証済みユーザー名）→ InventoryService.currentUsername()
     *          → StockTransactionRepository（createdBy）→ InventoryController（transactions 応答）
     * 単体テストではモック化されがちな「実行者の引き継ぎ」を実 HTTP 経由で検証する。
     */
    @Test
    void it006_authenticatedUsernamePropagatesToStockHistory() throws Exception {
        long productId = createProduct("結合商品D", "800.00", 5);

        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + productId + ",\"quantity\":7}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentStock").value(12));

        mvc.perform(post("/api/inventory/shipment")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + productId + ",\"quantity\":2}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentStock").value(10));

        mvc.perform(get("/api/products/" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(10));

        mvc.perform(get("/api/inventory/transactions?productId=" + productId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(2))
                .andExpect(jsonPath("$.items[?(@.type=='IN')].createdBy").value(org.hamcrest.Matchers.hasItem("admin")))
                .andExpect(jsonPath("$.items[?(@.type=='OUT')].createdBy").value(org.hamcrest.Matchers.hasItem("admin")));
    }

    /**
     * IT-007 権限マトリクス（認可境界）の横断検証。
     * 連携境界: SecurityConfig.authorizeHttpRequests（ロール判定）→ JwtAuthenticationFilter
     *          → 各 Controller。user ロールのトークンで admin 専用 API と許可 API の応答を対比する。
     */
    @Test
    void it007_roleMatrixEnforcedAcrossControllers() throws Exception {
        String userJwt = userToken();

        // user は admin 専用 API を 403 で拒否される
        mvc.perform(get("/api/users")
                        .header("Authorization", auth(userJwt)))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E-403"));

        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(userJwt))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":1,\"quantity\":1}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E-403"));

        // user は許可された API（受注一覧）にアクセスできる
        mvc.perform(get("/api/orders")
                        .header("Authorization", auth(userJwt)))
                .andExpect(status().isOk());
    }

    /**
     * IT-008 共通エラー形式のモジュール横断検証。
     * 連携境界: 各 Service が送出する ApiException / Bean Validation 違反
     *          → GlobalExceptionHandler → ErrorResponse（code/message/timestamp/errors）
     * エラー種別ごとに HTTP ステータスとコードの対応を実応答で確認する。
     */
    @Test
    void it008_commonErrorShapePropagatesAcrossModules() throws Exception {
        // 認可エラー（Security → 401 系と異なる経路: 認可 403 は SecurityConfig が生成）
        mvc.perform(get("/api/users")
                        .header("Authorization", auth(userToken())))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E-403"));

        // 存在しない商品（ProductService → E-404 → GlobalExceptionHandler）
        mvc.perform(get("/api/products/999999")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("E-404"));

        // 入力検証エラー（Bean Validation → E-400 → 共通形式・フィールド単位）
        mvc.perform(post("/api/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"\",\"password\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='username')]").exists())
                .andExpect(jsonPath("$.errors[?(@.field=='password')]").exists());

        // 状態遷移不正（OrderService → E-409 → GlobalExceptionHandler）
        long productId = createProduct("結合商品E", "3000.00", 10);
        long orderId = createOrder("顧客-IT008", productId, 1);
        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk());
        mvc.perform(put("/api/orders/" + orderId)
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客-IT008\",\"items\":[{\"productId\":" + productId + ",\"quantity\":1}]}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));
    }

    /** ログインして JWT を返すヘルパー。 */
    private String login(String username, String password) throws Exception {
        var body = mapper.readTree(
                mvc.perform(post("/api/login")
                                .contentType(MediaType.APPLICATION_JSON)
                                .content("{\"username\":\"" + username + "\",\"password\":\"" + password + "\"}"))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString());
        return body.get("token").asText();
    }
}
