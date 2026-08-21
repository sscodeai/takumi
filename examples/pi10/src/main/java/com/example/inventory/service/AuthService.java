package com.example.inventory.service;

import com.example.inventory.dto.request.LoginRequest;
import com.example.inventory.dto.response.LoginResponse;
import com.example.inventory.dto.response.UserInfo;
import com.example.inventory.entity.User;
import com.example.inventory.exception.ApiException;
import com.example.inventory.exception.ErrorCode;
import com.example.inventory.repository.UserRepository;
import com.example.inventory.security.JwtTokenProvider;
import com.example.inventory.security.LoginUser;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * ログイン認証とトークン発行（API-USR-001）
 */
@Service
public class AuthService {

    private final UserRepository userRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtTokenProvider tokenProvider;

    public AuthService(UserRepository userRepository,
                       PasswordEncoder passwordEncoder,
                       JwtTokenProvider tokenProvider) {
        this.userRepository = userRepository;
        this.passwordEncoder = passwordEncoder;
        this.tokenProvider = tokenProvider;
    }

    public LoginResponse login(LoginRequest request) {
        User user = userRepository.findByUsername(request.getUsername())
                .orElseThrow(() -> new ApiException(
                        ErrorCode.E_401, "ID またはパスワードが違います"));

        if (!passwordEncoder.matches(request.getPassword(), user.getPasswordHash())) {
            throw new ApiException(ErrorCode.E_401, "ID またはパスワードが違います");
        }

        LoginUser loginUser = LoginUser.from(user);
        String token = tokenProvider.generateToken(loginUser);
        return new LoginResponse(
                token,
                "Bearer",
                tokenProvider.getExpirationMs() / 1000,
                new UserInfo(user.getId(), user.getUsername(), user.getRole().name().toLowerCase()));
    }
}
