package com.example.inventory.repository;

import com.example.inventory.entity.StockTransaction;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface StockTransactionRepository extends JpaRepository<StockTransaction, Long> {

    Page<StockTransaction> findAll(Pageable pageable);

    Page<StockTransaction> findByProduct_Id(Long productId, Pageable pageable);
}
