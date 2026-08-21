package com.example.inventory.exception;

import org.springframework.http.HttpStatus;

/**
 * エラーコード（詳細設計書 §8.1）
 */
public enum ErrorCode {

    E_400("E-400", HttpStatus.BAD_REQUEST),
    E_401("E-401", HttpStatus.UNAUTHORIZED),
    E_403("E-403", HttpStatus.FORBIDDEN),
    E_404("E-404", HttpStatus.NOT_FOUND),
    E_409("E-409", HttpStatus.CONFLICT),
    E_500("E-500", HttpStatus.INTERNAL_SERVER_ERROR);

    private final String code;
    private final HttpStatus httpStatus;

    ErrorCode(String code, HttpStatus httpStatus) {
        this.code = code;
        this.httpStatus = httpStatus;
    }

    public String getCode() {
        return code;
    }

    public HttpStatus getHttpStatus() {
        return httpStatus;
    }
}
