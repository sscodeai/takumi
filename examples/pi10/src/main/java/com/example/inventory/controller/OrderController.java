package com.example.inventory.controller;

import com.example.inventory.dto.request.OrderRequest;
import com.example.inventory.dto.response.ConfirmResponse;
import com.example.inventory.dto.response.OrderResponse;
import com.example.inventory.dto.response.PageResponse;
import com.example.inventory.dto.response.StatusResponse;
import com.example.inventory.service.OrderService;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 受注 API（API-ORD-001〜006）
 */
@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;

    public OrderController(OrderService orderService) {
        this.orderService = orderService;
    }

    @GetMapping
    public PageResponse<OrderResponse> search(
            @RequestParam(required = false) String customerName,
            @RequestParam(required = false) String status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return orderService.search(customerName, status, page, size);
    }

    @PostMapping
    public ResponseEntity<OrderResponse> create(@Valid @RequestBody OrderRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(orderService.create(request));
    }

    @GetMapping("/{id}")
    public OrderResponse get(@PathVariable long id) {
        return orderService.get(id);
    }

    @PutMapping("/{id}")
    public OrderResponse update(@PathVariable long id, @Valid @RequestBody OrderRequest request) {
        return orderService.update(id, request);
    }

    @PostMapping("/{id}/confirm")
    public ConfirmResponse confirm(@PathVariable long id) {
        return orderService.confirm(id);
    }

    @PostMapping("/{id}/cancel")
    public StatusResponse cancel(@PathVariable long id) {
        return orderService.cancel(id);
    }
}
