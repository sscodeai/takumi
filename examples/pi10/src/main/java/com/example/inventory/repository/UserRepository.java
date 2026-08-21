package com.example.inventory.repository;

import com.example.inventory.entity.User;
import com.example.inventory.entity.UserRole;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Optional;

public interface UserRepository extends JpaRepository<User, Long> {

    Optional<User> findByUsername(String username);

    boolean existsByUsername(String username);

    long countByRole(UserRole role);
}
