package com.example.inventory.dto.response;

public record AllocatedStock(Long productId, Integer quantity, Integer remainingStock) {
}
