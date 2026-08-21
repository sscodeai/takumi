package com.example.inventory;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * §5.4 受注（UT-ORD-001〜015）
 */
class OrderIntegrationTest extends BaseIntegrationTest {

    @Test
    void utOrd001_createOrderWithMultipleItems() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 10);
        long p2 = createProduct("商品B", "500.00", 10);
        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客A\",\"items\":["
                                + "{\"productId\":" + p1 + ",\"quantity\":3},"
                                + "{\"productId\":" + p2 + ",\"quantity\":2}]}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("DRAFT"))
                .andExpect(jsonPath("$.itemCount").value(2))
                .andExpect(jsonPath("$.items.length()").value(2));
    }

    @Test
    void utOrd002_createOrderQuantityOne() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 10);
        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客B\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":1}]}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("DRAFT"));
    }

    @Test
    void utOrd003_createOrderQuantityZeroAndNegative() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 10);
        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客C\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":0}]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='items[0].quantity')]").exists());

        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客C\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":-1}]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='items[0].quantity')]").exists());
    }

    @Test
    void utOrd004_createOrderWithNoItems() throws Exception {
        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客D\",\"items\":[]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='items')]").exists());
    }

    @Test
    void utOrd005_createOrderBlankAndTooLongCustomerName() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 10);
        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":1}]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='customerName')]").exists());

        String longName = "あ".repeat(256);
        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"" + longName + "\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":1}]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='customerName')]").exists());
    }

    @Test
    void utOrd006_createOrderWithNonexistentProduct() throws Exception {
        mvc.perform(post("/api/orders")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客E\",\"items\":[{\"productId\":999999,\"quantity\":1}]}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("E-404"));
    }

    @Test
    void utOrd007_updateDraftOrder() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 10);
        long orderId = createOrder("顧客A", p1, 1);
        mvc.perform(put("/api/orders/" + orderId)
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客A改\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":5}]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.customerName").value("顧客A改"))
                .andExpect(jsonPath("$.items[0].quantity").value(5));
    }

    @Test
    void utOrd008_updateConfirmedAndCanceledOrder() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 10);
        long confirmedId = createOrder("顧客F", p1, 2);
        confirm(confirmedId);
        mvc.perform(put("/api/orders/" + confirmedId)
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客F\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":1}]}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));

        long canceledId = createOrder("顧客G", p1, 1);
        mvc.perform(post("/api/orders/" + canceledId + "/cancel")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk());
        mvc.perform(put("/api/orders/" + canceledId)
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"customerName\":\"顧客G\",\"items\":[{\"productId\":" + p1 + ",\"quantity\":1}]}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));
    }

    @Test
    void utOrd009_confirmDraftOrder() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 5);
        long orderId = createOrder("顧客H", p1, 3);
        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.allocatedStock[0].remainingStock").value(2));

        mvc.perform(get("/api/products/" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(2));

        mvc.perform(get("/api/inventory/transactions?productId=" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].type").value("OUT"))
                .andExpect(jsonPath("$.items[0].quantity").value(3))
                .andExpect(jsonPath("$.items[0].relatedOrderId").value(orderId));
    }

    @Test
    void utOrd010_confirmWithInsufficientStock() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 5);
        long orderId = createOrder("顧客I", p1, 10);
        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));

        mvc.perform(get("/api/products/" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(5));

        mvc.perform(get("/api/orders/" + orderId)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("DRAFT"));
    }

    @Test
    void utOrd011_confirmAlreadyConfirmed() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 10);
        long orderId = createOrder("顧客J", p1, 2);
        confirm(orderId);
        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));
    }

    @Test
    void utOrd012_cancelDraftOrder() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 5);
        long orderId = createOrder("顧客K", p1, 3);
        mvc.perform(post("/api/orders/" + orderId + "/cancel")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELED"));

        mvc.perform(get("/api/products/" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(5));

        mvc.perform(get("/api/inventory/transactions?productId=" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(0));
    }

    @Test
    void utOrd013_cancelConfirmedOrderRestoresStock() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 5);
        long orderId = createOrder("顧客L", p1, 3);
        confirm(orderId);

        mvc.perform(get("/api/products/" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(2));

        mvc.perform(post("/api/orders/" + orderId + "/cancel")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CANCELED"));

        mvc.perform(get("/api/products/" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(5));

        mvc.perform(get("/api/inventory/transactions?productId=" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].type").value("IN"))
                .andExpect(jsonPath("$.items[0].quantity").value(3))
                .andExpect(jsonPath("$.items[0].relatedOrderId").value(orderId));
    }

    @Test
    void utOrd014_cancelAlreadyCanceled() throws Exception {
        long p1 = createProduct("商品A", "1000.00", 5);
        long orderId = createOrder("顧客M", p1, 1);
        mvc.perform(post("/api/orders/" + orderId + "/cancel")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk());
        mvc.perform(post("/api/orders/" + orderId + "/cancel")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));
    }

    @Test
    void utOrd015_concurrentConfirmRowLock() throws Exception {
        // 同一商品への 2 受注の確定を順次実行し、行ロック相当の在庫整合を検証する。
        // （単一 JVM では真の並行実行は行わない。実ロック検証は複数接続/DB 固有の検証に委ねる。）
        long p1 = createProduct("商品A", "1000.00", 5);
        long orderA = createOrder("顧客N", p1, 3);
        long orderB = createOrder("顧客O", p1, 3);

        mvc.perform(post("/api/orders/" + orderA + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CONFIRMED"));

        mvc.perform(post("/api/orders/" + orderB + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));

        mvc.perform(get("/api/products/" + p1)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(2));
    }

    private void confirm(long orderId) throws Exception {
        mvc.perform(post("/api/orders/" + orderId + "/confirm")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk());
    }
}
