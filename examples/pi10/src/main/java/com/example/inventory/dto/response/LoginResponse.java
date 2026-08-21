package com.example.inventory.dto.response;

public record LoginResponse(String token, String tokenType, long expiresIn, UserInfo user) {
}
