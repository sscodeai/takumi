package com.example.inventory.dto.request;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

import java.util.ArrayList;
import java.util.List;

public class OrderRequest {

    @NotBlank(message = "必須項目です")
    @Size(max = 255, message = "255 文字以内で入力してください")
    private String customerName;

    @NotEmpty(message = "明細を 1 件以上指定してください")
    @Valid
    private List<OrderItemRequest> items = new ArrayList<>();

    public String getCustomerName() {
        return customerName;
    }

    public void setCustomerName(String customerName) {
        this.customerName = customerName;
    }

    public List<OrderItemRequest> getItems() {
        return items;
    }

    public void setItems(List<OrderItemRequest> items) {
        this.items = items;
    }
}
