package com.example.inventory.dto.request;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

public class UserUpdateRequest {

    @Pattern(regexp = "^(?=.*[A-Za-z])(?=.*[0-9]).{8,}$",
            message = "8 文字以上で英字と数字をそれぞれ 1 文字以上含めてください")
    private String password;

    @NotBlank(message = "必須項目です")
    @Pattern(regexp = "^(admin|user)$", message = "admin / user のいずれかを指定してください")
    private String role;

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        this.password = password;
    }

    public String getRole() {
        return role;
    }

    public void setRole(String role) {
        this.role = role;
    }
}
