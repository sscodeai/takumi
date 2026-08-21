package com.example.inventory.controller;

import com.example.inventory.dto.request.StockRequest;
import com.example.inventory.dto.response.PageResponse;
import com.example.inventory.dto.response.StockResult;
import com.example.inventory.dto.response.StockTransactionResponse;
import com.example.inventory.service.InventoryService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 在庫 API（API-INV-003/004、A-07 履歴）
 */
@RestController
@RequestMapping("/api/inventory")
public class InventoryController {

    private final InventoryService inventoryService;

    public InventoryController(InventoryService inventoryService) {
        this.inventoryService = inventoryService;
    }

    @PostMapping("/receipt")
    public StockResult receipt(@Valid @RequestBody StockRequest request) {
        return inventoryService.receipt(request);
    }

    @PostMapping("/shipment")
    public StockResult shipment(@Valid @RequestBody StockRequest request) {
        return inventoryService.shipment(request);
    }

    @GetMapping("/transactions")
    public PageResponse<StockTransactionResponse> transactions(
            @RequestParam(required = false) Long productId,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return inventoryService.list(productId, page, size);
    }
}
