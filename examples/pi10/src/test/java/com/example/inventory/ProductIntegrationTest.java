package com.example.inventory;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * §5.2 商品（UT-PROD-001〜010）
 */
class ProductIntegrationTest extends BaseIntegrationTest {

    @Test
    void utProd001_createProduct() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品A\",\"price\":1000.00,\"stock\":5}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("商品A"))
                .andExpect(jsonPath("$.price").value(1000.00))
                .andExpect(jsonPath("$.stock").value(5));
    }

    @Test
    void utProd002_priceZero() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品B\",\"price\":0,\"stock\":0}"))
                .andExpect(status().isCreated());
    }

    @Test
    void utProd003_priceMax() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品C\",\"price\":99999999.99,\"stock\":0}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.price").value(99999999.99));
    }

    @Test
    void utProd004_priceNegative() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品D\",\"price\":-1,\"stock\":0}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='price')]").exists());
    }

    @Test
    void utProd005_priceTooLarge() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品E\",\"price\":100000000.00,\"stock\":0}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='price')]").exists());
    }

    @Test
    void utProd006_nameBlankAndTooLong() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"\",\"price\":100,\"stock\":0}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='name')]").exists());

        String longName = "あ".repeat(256);
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"" + longName + "\",\"price\":100,\"stock\":0}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='name')]").exists());
    }

    @Test
    void utProd007_stockZeroAndNegative() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品F\",\"price\":100,\"stock\":0}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.stock").value(0));

        mvc.perform(post("/api/products")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品G\",\"price\":100,\"stock\":-1}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='stock')]").exists());
    }

    @Test
    void utProd008_getNonexistentProduct() throws Exception {
        mvc.perform(get("/api/products/999999")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("E-404"));
    }

    @Test
    void utProd009_updateProduct() throws Exception {
        long id = createProduct("商品A", "1000.00", 5);
        mvc.perform(put("/api/products/" + id)
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品A改\",\"price\":1200.00,\"stock\":8}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("商品A改"))
                .andExpect(jsonPath("$.price").value(1200.00))
                .andExpect(jsonPath("$.stock").value(8));
    }

    @Test
    void utProd010_createProductAsUser() throws Exception {
        mvc.perform(post("/api/products")
                        .header("Authorization", auth(userToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"商品H\",\"price\":100,\"stock\":0}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E-403"));
    }
}
