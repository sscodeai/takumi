package com.example.inventory.repository;

import com.example.inventory.entity.OrderItem;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrderItemRepository extends JpaRepository<OrderItem, Long> {

    boolean existsByProduct_Id(Long productId);
}
