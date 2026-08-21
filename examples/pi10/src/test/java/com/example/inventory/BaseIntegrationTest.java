package com.example.inventory;

import com.example.inventory.entity.Order;
import com.example.inventory.entity.Product;
import com.example.inventory.entity.User;
import com.example.inventory.entity.UserRole;
import com.example.inventory.repository.OrderItemRepository;
import com.example.inventory.repository.OrderRepository;
import com.example.inventory.repository.ProductRepository;
import com.example.inventory.repository.StockTransactionRepository;
import com.example.inventory.repository.UserRepository;
import com.example.inventory.security.JwtTokenProvider;
import com.example.inventory.security.LoginUser;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;

import java.math.BigDecimal;

/**
 * 統合テスト共通基盤。
 * H2（PostgreSQL モード）+ Flyway V1 スキーマで起動し、各テスト前にデータをリセットする。
 */
@SpringBootTest
@AutoConfigureMockMvc
public abstract class BaseIntegrationTest {

    @Autowired
    protected MockMvc mvc;

    @Autowired
    protected ObjectMapper mapper;

    @Autowired
    protected ProductRepository productRepository;

    @Autowired
    protected OrderRepository orderRepository;

    @Autowired
    protected OrderItemRepository orderItemRepository;

    @Autowired
    protected StockTransactionRepository stockTransactionRepository;

    @Autowired
    protected UserRepository userRepository;

    @Autowired
    protected PasswordEncoder passwordEncoder;

    @Autowired
    protected JwtTokenProvider tokenProvider;

    @BeforeEach
    void resetDatabase() {
        // FK 依存順に削除（stock_transactions → order_items → orders → products → users）
        stockTransactionRepository.deleteAll();
        orderItemRepository.deleteAll();
        orderRepository.deleteAll();
        productRepository.deleteAll();
        userRepository.deleteAll();

        // DataInitializer 相当の admin を毎回再作成
        User admin = new User();
        admin.setUsername("admin");
        admin.setPasswordHash(passwordEncoder.encode("admin123"));
        admin.setRole(UserRole.ADMIN);
        userRepository.save(admin);
    }

    protected String adminToken() {
        User admin = userRepository.findByUsername("admin").orElseThrow();
        return tokenProvider.generateToken(LoginUser.from(admin));
    }

    protected String userToken() {
        User user = ensureUser("testuser", "Passw0rd1", UserRole.USER);
        return tokenProvider.generateToken(LoginUser.from(user));
    }

    protected User ensureUser(String username, String rawPassword, UserRole role) {
        return userRepository.findByUsername(username).orElseGet(() -> {
            User u = new User();
            u.setUsername(username);
            u.setPasswordHash(passwordEncoder.encode(rawPassword));
            u.setRole(role);
            return userRepository.save(u);
        });
    }

    protected long createProduct(String name, String price, int stock) {
        Product p = new Product();
        p.setName(name);
        p.setPrice(new BigDecimal(price));
        p.setStock(stock);
        return productRepository.save(p).getId();
    }

    protected long createOrder(String customerName, Object... productIdQuantityPairs) {
        Order order = new Order();
        order.setCustomerName(customerName);
        for (int i = 0; i < productIdQuantityPairs.length; i += 2) {
            long productId = ((Number) productIdQuantityPairs[i]).longValue();
            int quantity = ((Number) productIdQuantityPairs[i + 1]).intValue();
            order.addItem(newItem(order, productId, quantity));
        }
        return orderRepository.save(order).getId();
    }

    private com.example.inventory.entity.OrderItem newItem(Order order, long productId, int quantity) {
        com.example.inventory.entity.OrderItem item = new com.example.inventory.entity.OrderItem();
        item.setOrder(order);
        item.setProduct(productRepository.findById(productId).orElseThrow());
        item.setQuantity(quantity);
        return item;
    }

    protected String auth(String token) {
        return "Bearer " + token;
    }
}
