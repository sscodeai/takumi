package com.example.inventory.dto.request;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

public class StockRequest {

    @NotNull(message = "必須項目です")
    private Long productId;

    @NotNull(message = "必須項目です")
    @Min(value = 1, message = "1 以上の整数を入力してください")
    private Integer quantity;

    public Long getProductId() {
        return productId;
    }

    public void setProductId(Long productId) {
        this.productId = productId;
    }

    public Integer getQuantity() {
        return quantity;
    }

    public void setQuantity(Integer quantity) {
        this.quantity = quantity;
    }
}
