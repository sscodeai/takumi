package com.example.inventory.dto.response;

import java.time.Instant;

public record StockTransactionResponse(
        Long id,
        Long productId,
        String type,
        Integer quantity,
        Long relatedOrderId,
        String createdBy,
        Instant createdAt) {
}
