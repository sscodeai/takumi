package com.example.inventory.service;

import com.example.inventory.dto.request.StockRequest;
import com.example.inventory.dto.response.PageResponse;
import com.example.inventory.dto.response.StockResult;
import com.example.inventory.dto.response.StockTransactionResponse;
import com.example.inventory.entity.Order;
import com.example.inventory.entity.Product;
import com.example.inventory.entity.StockTransaction;
import com.example.inventory.entity.TransactionType;
import com.example.inventory.exception.ApiException;
import com.example.inventory.exception.ErrorCode;
import com.example.inventory.repository.ProductRepository;
import com.example.inventory.repository.StockTransactionRepository;
import com.example.inventory.security.LoginUser;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 入出庫・履歴参照（API-INV-003/004、A-07）。
 * 受注確定/キャンセルからの再利用のため、行ロック済み Product に対する
 * 在庫加減算 + 履歴記録（applyIn/applyOut）を公開している。
 */
@Service
public class InventoryService {

    private final ProductRepository productRepository;
    private final StockTransactionRepository stockTransactionRepository;

    public InventoryService(ProductRepository productRepository,
                            StockTransactionRepository stockTransactionRepository) {
        this.productRepository = productRepository;
        this.stockTransactionRepository = stockTransactionRepository;
    }

    @Transactional
    public StockResult receipt(StockRequest request) {
        Product product = productRepository.findByIdForUpdate(request.getProductId())
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "商品が見つかりません"));
        int previous = product.getStock();
        applyIn(product, request.getQuantity(), null);
        return new StockResult(product.getId(), previous, request.getQuantity(), product.getStock());
    }

    @Transactional
    public StockResult shipment(StockRequest request) {
        Product product = productRepository.findByIdForUpdate(request.getProductId())
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "商品が見つかりません"));
        int previous = product.getStock();
        if (previous < request.getQuantity()) {
            throw new ApiException(ErrorCode.E_409, "在庫不足です（現在在庫 " + previous + "）");
        }
        applyOut(product, request.getQuantity(), null);
        return new StockResult(product.getId(), previous, request.getQuantity(), product.getStock());
    }

    @Transactional(readOnly = true)
    public PageResponse<StockTransactionResponse> list(Long productId, int page, int size) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 100),
                Sort.by("createdAt").descending());
        Page<StockTransaction> result = productId == null
                ? stockTransactionRepository.findAll(pageable)
                : stockTransactionRepository.findByProduct_Id(productId, pageable);
        List<StockTransactionResponse> items = result.getContent().stream()
                .map(t -> new StockTransactionResponse(
                        t.getId(),
                        t.getProduct().getId(),
                        t.getType().name(),
                        t.getQuantity(),
                        t.getRelatedOrder() == null ? null : t.getRelatedOrder().getId(),
                        t.getCreatedBy(),
                        t.getCreatedAt()))
                .toList();
        return new PageResponse<>(items, result.getTotalElements(), result.getNumber(), result.getSize());
    }

    /** 在庫加算 + IN 履歴記録（呼び出し元トランザクションに参加）。 */
    public void applyIn(Product product, int quantity, Order relatedOrder) {
        product.setStock(product.getStock() + quantity);
        record(product, TransactionType.IN, quantity, relatedOrder);
    }

    /** 在庫減算 + OUT 履歴記録（在庫充足は呼び出し元で確認済みであること）。 */
    public void applyOut(Product product, int quantity, Order relatedOrder) {
        product.setStock(product.getStock() - quantity);
        record(product, TransactionType.OUT, quantity, relatedOrder);
    }

    private void record(Product product, TransactionType type, int quantity, Order relatedOrder) {
        StockTransaction txn = new StockTransaction();
        txn.setProduct(product);
        txn.setType(type);
        txn.setQuantity(quantity);
        txn.setRelatedOrder(relatedOrder);
        txn.setCreatedBy(currentUsername());
        stockTransactionRepository.save(txn);
    }

    private String currentUsername() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof LoginUser loginUser) {
            return loginUser.getUsername();
        }
        return "system";
    }
}
