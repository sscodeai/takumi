package com.example.inventory;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * §5.3 在庫（UT-INV-001〜009）
 */
class InventoryIntegrationTest extends BaseIntegrationTest {

    @Test
    void utInv001_receipt() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":10}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.previousStock").value(5))
                .andExpect(jsonPath("$.currentStock").value(15))
                .andExpect(jsonPath("$.quantity").value(10));

        mvc.perform(get("/api/inventory/transactions?productId=" + id)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.items[0].type").value("IN"))
                .andExpect(jsonPath("$.items[0].quantity").value(10));
    }

    @Test
    void utInv002_receiptQuantityOne() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentStock").value(6));
    }

    @Test
    void utInv003_receiptQuantityZeroAndNegative() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":0}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='quantity')]").exists());

        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":-1}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='quantity')]").exists());
    }

    @Test
    void utInv004_shipment() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(post("/api/inventory/shipment")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":3}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.previousStock").value(5))
                .andExpect(jsonPath("$.currentStock").value(2));

        mvc.perform(get("/api/inventory/transactions?productId=" + id)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.items[0].type").value("OUT"))
                .andExpect(jsonPath("$.items[0].quantity").value(3));
    }

    @Test
    void utInv005_shipmentAllStock() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(post("/api/inventory/shipment")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":5}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.currentStock").value(0));
    }

    @Test
    void utInv006_shipmentOverStock() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(post("/api/inventory/shipment")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":6}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("現在在庫 5")));

        mvc.perform(get("/api/products/" + id)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stock").value(5));
    }

    @Test
    void utInv007_receiptNonexistentProduct() throws Exception {
        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":999999,\"quantity\":1}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("E-404"));
    }

    @Test
    void utInv008_receiptAsUser() throws Exception {
        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(userToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":1,\"quantity\":1}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E-403"));
    }

    @Test
    void utInv009_listTransactions() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(post("/api/inventory/receipt")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"productId\":" + id + ",\"quantity\":2}"))
                .andExpect(status().isOk());

        mvc.perform(get("/api/inventory/transactions?productId=" + id)
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.items[0].productId").value(id));
    }
}
