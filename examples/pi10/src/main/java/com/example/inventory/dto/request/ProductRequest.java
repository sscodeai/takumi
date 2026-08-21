package com.example.inventory.dto.request;

import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Digits;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;

public class ProductRequest {

    @NotBlank(message = "必須項目です")
    @Size(max = 255, message = "255 文字以内で入力してください")
    private String name;

    @NotNull(message = "必須項目です")
    @DecimalMin(value = "0.00", message = "0 以上の値を入力してください")
    @Digits(integer = 8, fraction = 2, message = "最大 99,999,999.99 です")
    private BigDecimal price;

    @NotNull(message = "必須項目です")
    @Min(value = 0, message = "0 以上の整数を入力してください")
    private Integer stock;

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public BigDecimal getPrice() {
        return price;
    }

    public void setPrice(BigDecimal price) {
        this.price = price;
    }

    public Integer getStock() {
        return stock;
    }

    public void setStock(Integer stock) {
        this.stock = stock;
    }
}
