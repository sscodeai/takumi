package com.example.inventory.dto.response;

import java.time.Instant;
import java.util.List;

public record OrderResponse(
        Long id,
        String customerName,
        String status,
        int itemCount,
        Instant createdAt,
        List<OrderItemResponse> items) {
}
