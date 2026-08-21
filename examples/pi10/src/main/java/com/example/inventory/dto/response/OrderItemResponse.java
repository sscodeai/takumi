package com.example.inventory.dto.response;

import java.math.BigDecimal;

public record OrderItemResponse(Long productId, String productName, Integer quantity, BigDecimal unitPrice) {
}
