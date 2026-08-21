package com.example.inventory.dto.response;

import java.math.BigDecimal;

public record ProductResponse(Long id, String name, BigDecimal price, Integer stock) {
}
