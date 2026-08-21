package com.example.inventory;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * §5.1 認証（UT-AUTH-001〜007）
 */
class AuthIntegrationTest extends BaseIntegrationTest {

    @Test
    void utAuth001_loginWithValidCredentials() throws Exception {
        mvc.perform(post("/api/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"admin123\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.token").isNotEmpty())
                .andExpect(jsonPath("$.tokenType").value("Bearer"))
                .andExpect(jsonPath("$.expiresIn").value(3600))
                .andExpect(jsonPath("$.user.username").value("admin"))
                .andExpect(jsonPath("$.user.role").value("admin"));
    }

    @Test
    void utAuth002_loginWithWrongPassword() throws Exception {
        mvc.perform(post("/api/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"admin\",\"password\":\"WrongPass1\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("E-401"));
    }

    @Test
    void utAuth003_loginWithUnknownUsername() throws Exception {
        mvc.perform(post("/api/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"no_such_user\",\"password\":\"admin123\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("E-401"));
    }

    @Test
    void utAuth004_loginWithBlankFields() throws Exception {
        mvc.perform(post("/api/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"\",\"password\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='username')]").exists())
                .andExpect(jsonPath("$.errors[?(@.field=='password')]").exists());
    }

    @Test
    void utAuth005_protectedApiWithValidToken() throws Exception {
        mvc.perform(get("/api/products")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isOk());
    }

    @Test
    void utAuth006_protectedApiWithInvalidToken() throws Exception {
        mvc.perform(get("/api/products")
                        .header("Authorization", "Bearer invalid.token.here"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("E-401"));
    }

    @Test
    void utAuth007_logout() throws Exception {
        mvc.perform(post("/api/logout")
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isNoContent());
    }

}
