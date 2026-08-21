package com.example.inventory.service;

import com.example.inventory.dto.request.OrderItemRequest;
import com.example.inventory.dto.request.OrderRequest;
import com.example.inventory.dto.response.AllocatedStock;
import com.example.inventory.dto.response.ConfirmResponse;
import com.example.inventory.dto.response.OrderItemResponse;
import com.example.inventory.dto.response.OrderResponse;
import com.example.inventory.dto.response.PageResponse;
import com.example.inventory.dto.response.StatusResponse;
import com.example.inventory.entity.Order;
import com.example.inventory.entity.OrderItem;
import com.example.inventory.entity.OrderStatus;
import com.example.inventory.entity.Product;
import com.example.inventory.exception.ApiException;
import com.example.inventory.exception.ErrorCode;
import com.example.inventory.repository.OrderRepository;
import com.example.inventory.repository.ProductRepository;
import jakarta.persistence.criteria.Predicate;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * 受注 CRUD・状態遷移（API-ORD-001〜006、REQ-ORDER）
 */
@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final ProductRepository productRepository;
    private final InventoryService inventoryService;

    public OrderService(OrderRepository orderRepository,
                        ProductRepository productRepository,
                        InventoryService inventoryService) {
        this.orderRepository = orderRepository;
        this.productRepository = productRepository;
        this.inventoryService = inventoryService;
    }

    @Transactional(readOnly = true)
    public PageResponse<OrderResponse> search(String customerName, String status, int page, int size) {
        Specification<Order> spec = (root, query, cb) -> {
            List<Predicate> predicates = new ArrayList<>();
            if (StringUtils.hasText(customerName)) {
                predicates.add(cb.like(cb.lower(root.get("customerName")),
                        "%" + customerName.trim().toLowerCase() + "%"));
            }
            if (StringUtils.hasText(status)) {
                predicates.add(cb.equal(root.get("status"), OrderStatus.valueOf(status)));
            }
            return cb.and(predicates.toArray(new Predicate[0]));
        };
        Pageable pageable = PageRequest.of(page, Math.min(size, 100),
                Sort.by("createdAt").descending());
        Page<Order> result = orderRepository.findAll(spec, pageable);
        List<OrderResponse> items = result.getContent().stream().map(this::toResponse).toList();
        return new PageResponse<>(items, result.getTotalElements(), result.getNumber(), result.getSize());
    }

    @Transactional
    public OrderResponse create(OrderRequest request) {
        Order order = new Order();
        order.setCustomerName(request.getCustomerName());
        order.setStatus(OrderStatus.DRAFT);
        for (OrderItemRequest item : request.getItems()) {
            Product product = resolveProduct(item.getProductId());
            order.addItem(newItem(product, item.getQuantity()));
        }
        return toResponse(orderRepository.save(order));
    }

    @Transactional(readOnly = true)
    public OrderResponse get(long id) {
        return toResponse(findOrThrow(id));
    }

    @Transactional
    public OrderResponse update(long id, OrderRequest request) {
        Order order = orderRepository.findByIdForUpdate(id)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "受注が見つかりません"));
        if (order.getStatus() != OrderStatus.DRAFT) {
            throw new ApiException(ErrorCode.E_409, "確定/取消済みの受注は編集できません");
        }
        order.setCustomerName(request.getCustomerName());
        order.clearItems();
        for (OrderItemRequest item : request.getItems()) {
            Product product = resolveProduct(item.getProductId());
            order.addItem(newItem(product, item.getQuantity()));
        }
        return toResponse(orderRepository.save(order));
    }

    @Transactional
    public ConfirmResponse confirm(long id) {
        Order order = orderRepository.findByIdForUpdate(id)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "受注が見つかりません"));
        if (order.getStatus() != OrderStatus.DRAFT) {
            throw new ApiException(ErrorCode.E_409, "下書き状態の受注のみ確定できます");
        }

        // デッドロック回避のため product_id 昇順で行ロック（詳細設計書 §3.2）
        List<Long> productIds = order.getItems().stream()
                .map(i -> i.getProduct().getId())
                .distinct()
                .sorted()
                .toList();
        List<Product> locked = productRepository.findAllByIdForUpdate(productIds);
        if (locked.size() != productIds.size()) {
            throw new ApiException(ErrorCode.E_404, "商品が見つかりません");
        }
        Map<Long, Product> productById = locked.stream()
                .collect(Collectors.toMap(Product::getId, p -> p, (a, b) -> a, LinkedHashMap::new));

        // 在庫充足を全明細分確認してから減算（不足なら全量ロールバック）
        for (OrderItem item : order.getItems()) {
            Product product = productById.get(item.getProduct().getId());
            if (product.getStock() < item.getQuantity()) {
                throw new ApiException(ErrorCode.E_409,
                        "在庫不足です（現在在庫 " + product.getStock() + "）");
            }
        }

        List<AllocatedStock> allocated = new ArrayList<>();
        for (OrderItem item : order.getItems()) {
            Product product = productById.get(item.getProduct().getId());
            inventoryService.applyOut(product, item.getQuantity(), order);
            allocated.add(new AllocatedStock(
                    product.getId(), item.getQuantity(), product.getStock()));
        }
        order.setStatus(OrderStatus.CONFIRMED);
        orderRepository.save(order);
        return new ConfirmResponse(order.getId(), order.getStatus().name(), allocated);
    }

    @Transactional
    public StatusResponse cancel(long id) {
        Order order = orderRepository.findByIdForUpdate(id)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "受注が見つかりません"));
        if (order.getStatus() == OrderStatus.CANCELED) {
            throw new ApiException(ErrorCode.E_409, "既にキャンセル済みです");
        }
        if (order.getStatus() == OrderStatus.CONFIRMED) {
            // 確定済みキャンセルは在庫を戻し入れ（A-05）
            for (OrderItem item : order.getItems()) {
                inventoryService.applyIn(item.getProduct(), item.getQuantity(), order);
            }
        }
        order.setStatus(OrderStatus.CANCELED);
        orderRepository.save(order);
        return new StatusResponse(order.getId(), order.getStatus().name());
    }

    private Order findOrThrow(long id) {
        return orderRepository.findById(id)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "受注が見つかりません"));
    }

    private Product resolveProduct(Long productId) {
        return productRepository.findById(productId)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "商品が見つかりません"));
    }

    private OrderItem newItem(Product product, int quantity) {
        OrderItem item = new OrderItem();
        item.setProduct(product);
        item.setQuantity(quantity);
        return item;
    }

    private OrderResponse toResponse(Order order) {
        List<OrderItemResponse> items = order.getItems().stream()
                .map(i -> new OrderItemResponse(
                        i.getProduct().getId(),
                        i.getProduct().getName(),
                        i.getQuantity(),
                        i.getProduct().getPrice()))
                .toList();
        return new OrderResponse(
                order.getId(),
                order.getCustomerName(),
                order.getStatus().name(),
                items.size(),
                order.getCreatedAt(),
                items);
    }
}
