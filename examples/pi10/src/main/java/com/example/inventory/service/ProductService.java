package com.example.inventory.service;

import com.example.inventory.dto.request.ProductRequest;
import com.example.inventory.dto.response.PageResponse;
import com.example.inventory.dto.response.ProductResponse;
import com.example.inventory.entity.Product;
import com.example.inventory.exception.ApiException;
import com.example.inventory.exception.ErrorCode;
import com.example.inventory.repository.OrderItemRepository;
import com.example.inventory.repository.ProductRepository;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;

/**
 * 商品 CRUD（API-INV-001/002、A-02 追加分）
 */
@Service
public class ProductService {

    private final ProductRepository productRepository;
    private final OrderItemRepository orderItemRepository;

    public ProductService(ProductRepository productRepository,
                          OrderItemRepository orderItemRepository) {
        this.productRepository = productRepository;
        this.orderItemRepository = orderItemRepository;
    }

    @Transactional(readOnly = true)
    public PageResponse<ProductResponse> search(String name, int page, int size) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 100), Sort.by("id").ascending());
        Page<Product> result = StringUtils.hasText(name)
                ? productRepository.findByNameContainingIgnoreCase(name.trim(), pageable)
                : productRepository.findAll(pageable);
        List<ProductResponse> items = result.getContent().stream().map(this::toResponse).toList();
        return new PageResponse<>(items, result.getTotalElements(), result.getNumber(), result.getSize());
    }

    @Transactional(readOnly = true)
    public ProductResponse get(long id) {
        return toResponse(findOrThrow(id));
    }

    @Transactional
    public ProductResponse create(ProductRequest request) {
        Product product = new Product();
        apply(product, request);
        return toResponse(productRepository.save(product));
    }

    @Transactional
    public ProductResponse update(long id, ProductRequest request) {
        Product product = findOrThrow(id);
        apply(product, request);
        return toResponse(productRepository.save(product));
    }

    @Transactional
    public void delete(long id) {
        Product product = findOrThrow(id);
        if (orderItemRepository.existsByProduct_Id(id)) {
            throw new ApiException(ErrorCode.E_409, "受注明細から参照されているため削除できません");
        }
        productRepository.delete(product);
    }

    private Product findOrThrow(long id) {
        return productRepository.findById(id)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "商品が見つかりません"));
    }

    private void apply(Product product, ProductRequest request) {
        product.setName(request.getName());
        product.setPrice(request.getPrice());
        product.setStock(request.getStock());
    }

    private ProductResponse toResponse(Product product) {
        return new ProductResponse(product.getId(), product.getName(), product.getPrice(), product.getStock());
    }
}
