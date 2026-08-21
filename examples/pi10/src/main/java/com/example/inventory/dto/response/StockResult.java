package com.example.inventory.dto.response;

public record StockResult(Long productId, Integer previousStock, Integer quantity, Integer currentStock) {
}
