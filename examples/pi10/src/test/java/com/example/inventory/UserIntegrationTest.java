package com.example.inventory;

import com.example.inventory.entity.User;
import com.example.inventory.entity.UserRole;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * §5.5 ユーザー（UT-USR-001〜010）
 */
class UserIntegrationTest extends BaseIntegrationTest {

    @Test
    void utUsr001_createUser() throws Exception {
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"user1\",\"password\":\"Passw0rd1\",\"role\":\"user\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.username").value("user1"))
                .andExpect(jsonPath("$.role").value("user"))
                .andExpect(jsonPath("$.password").doesNotExist())
                .andExpect(jsonPath("$.passwordHash").doesNotExist());

        User saved = userRepository.findByUsername("user1").orElseThrow();
        org.junit.jupiter.api.Assertions.assertTrue(
                passwordEncoder.matches("Passw0rd1", saved.getPasswordHash()),
                "パスワードは BCrypt ハッシュで保存されること");
        org.junit.jupiter.api.Assertions.assertNotEquals("Passw0rd1", saved.getPasswordHash());
    }

    @Test
    void utUsr002_duplicateUsername() throws Exception {
        ensureUser("user1", "Passw0rd1", UserRole.USER);
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"user1\",\"password\":\"Passw0rd1\",\"role\":\"user\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));
    }

    @Test
    void utUsr003_invalidUsernameFormat() throws Exception {
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"user-1!\",\"password\":\"Passw0rd1\",\"role\":\"user\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='username')]").exists());

        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"ab\",\"password\":\"Passw0rd1\",\"role\":\"user\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='username')]").exists());
    }

    @Test
    void utUsr004_invalidPasswordPolicy() throws Exception {
        // 8 文字未満
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"user2\",\"password\":\"Short1\",\"role\":\"user\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='password')]").exists());

        // 数字なし
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"user3\",\"password\":\"password\",\"role\":\"user\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='password')]").exists());

        // 英字なし
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"user4\",\"password\":\"12345678\",\"role\":\"user\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='password')]").exists());
    }

    @Test
    void utUsr005_invalidRole() throws Exception {
        mvc.perform(post("/api/users")
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"username\":\"user5\",\"password\":\"Passw0rd1\",\"role\":\"superadmin\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("E-400"))
                .andExpect(jsonPath("$.errors[?(@.field=='role')]").exists());
    }

    @Test
    void utUsr006_updateUserRoleWithoutPassword() throws Exception {
        User target = ensureUser("user1", "Passw0rd1", UserRole.USER);
        String beforeHash = target.getPasswordHash();

        mvc.perform(put("/api/users/" + target.getId())
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"admin\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.role").value("admin"));

        User updated = userRepository.findById(target.getId()).orElseThrow();
        org.junit.jupiter.api.Assertions.assertEquals(UserRole.ADMIN, updated.getRole());
        org.junit.jupiter.api.Assertions.assertEquals(beforeHash, updated.getPasswordHash(),
                "パスワード省略時は変更されないこと");
    }

    @Test
    void utUsr007_deleteUser() throws Exception {
        User target = ensureUser("user1", "Passw0rd1", UserRole.USER);
        mvc.perform(delete("/api/users/" + target.getId())
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isNoContent());
        org.junit.jupiter.api.Assertions.assertTrue(userRepository.findById(target.getId()).isEmpty());
    }

    @Test
    void utUsr008_deleteOrDemoteLastAdmin() throws Exception {
        User admin = userRepository.findByUsername("admin").orElseThrow();
        mvc.perform(delete("/api/users/" + admin.getId())
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));

        mvc.perform(put("/api/users/" + admin.getId())
                        .header("Authorization", auth(adminToken()))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"role\":\"user\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));
    }

    @Test
    void utUsr009_deleteSelf() throws Exception {
        User admin = userRepository.findByUsername("admin").orElseThrow();
        mvc.perform(delete("/api/users/" + admin.getId())
                        .header("Authorization", auth(adminToken())))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("E-409"));
    }

    @Test
    void utUsr010_listUsersAsUser() throws Exception {
        mvc.perform(get("/api/users")
                        .header("Authorization", auth(userToken())))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("E-403"));
    }
}
