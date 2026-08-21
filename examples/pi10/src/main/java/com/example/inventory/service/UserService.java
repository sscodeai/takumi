package com.example.inventory.service;

import com.example.inventory.dto.request.UserRequest;
import com.example.inventory.dto.request.UserUpdateRequest;
import com.example.inventory.dto.response.PageResponse;
import com.example.inventory.dto.response.UserResponse;
import com.example.inventory.entity.User;
import com.example.inventory.entity.UserRole;
import com.example.inventory.exception.ApiException;
import com.example.inventory.exception.ErrorCode;
import com.example.inventory.repository.UserRepository;
import com.example.inventory.security.LoginUser;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.util.List;

/**
 * ユーザー管理（API-USR-002〜005、REQ-USER）
 */
@Service
public class UserService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;

    public UserService(UserRepository userRepository, PasswordEncoder passwordEncoder) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Transactional(readOnly = true)
    public PageResponse<UserResponse> list(int page, int size) {
        Pageable pageable = PageRequest.of(page, Math.min(size, 100), Sort.by("id").ascending());
        Page<User> result = userRepository.findAll(pageable);
        List<UserResponse> items = result.getContent().stream().map(this::toResponse).toList();
        return new PageResponse<>(items, result.getTotalElements(), result.getNumber(), result.getSize());
    }

    @Transactional
    public UserResponse create(UserRequest request) {
        if (userRepository.existsByUsername(request.getUsername())) {
            throw new ApiException(ErrorCode.E_409, "ユーザー名が既に使用されています");
        }
        User user = new User();
        user.setUsername(request.getUsername());
        user.setPasswordHash(passwordEncoder.encode(request.getPassword()));
        user.setRole(UserRole.valueOf(request.getRole().toUpperCase()));
        return toResponse(userRepository.save(user));
    }

    @Transactional
    public UserResponse update(long id, UserUpdateRequest request) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "ユーザーが見つかりません"));

        UserRole newRole = UserRole.valueOf(request.getRole().toUpperCase());
        if (user.getRole() == UserRole.ADMIN && newRole != UserRole.ADMIN
                && userRepository.countByRole(UserRole.ADMIN) <= 1) {
            throw new ApiException(ErrorCode.E_409, "最後の admin は降格できません");
        }
        user.setRole(newRole);

        if (StringUtils.hasText(request.getPassword())) {
            user.setPasswordHash(passwordEncoder.encode(request.getPassword()));
        }
        return toResponse(userRepository.save(user));
    }

    @Transactional
    public void delete(long id) {
        User user = userRepository.findById(id)
                .orElseThrow(() -> new ApiException(ErrorCode.E_404, "ユーザーが見つかりません"));

        LoginUser current = currentUser();
        if (current != null && current.getId().equals(id)) {
            throw new ApiException(ErrorCode.E_409, "自分自身は削除できません");
        }
        if (user.getRole() == UserRole.ADMIN && userRepository.countByRole(UserRole.ADMIN) <= 1) {
            throw new ApiException(ErrorCode.E_409, "最後の admin は削除できません");
        }
        userRepository.delete(user);
    }

    private LoginUser currentUser() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof LoginUser loginUser) {
            return loginUser;
        }
        return null;
    }

    private UserResponse toResponse(User user) {
        return new UserResponse(user.getId(), user.getUsername(), user.getRole().name().toLowerCase(), user.getCreatedAt());
    }
}
