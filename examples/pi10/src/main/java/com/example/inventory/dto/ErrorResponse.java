package com.example.inventory.dto;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 共通エラー形式（詳細設計書 §2 / §8.1）
 */
public class ErrorResponse {

    public record FieldError(String field, String message) {
    }

    private final String code;
    private final String message;
    private final Instant timestamp;
    private final List<FieldError> errors;

    public ErrorResponse(String code, String message, Instant timestamp, List<FieldError> errors) {
        this.code = code;
        this.message = message;
        this.timestamp = timestamp;
        this.errors = errors == null ? new ArrayList<>() : errors;
    }

    public String getCode() {
        return code;
    }

    public String getMessage() {
        return message;
    }

    public Instant getTimestamp() {
        return timestamp;
    }

    public List<FieldError> getErrors() {
        return errors;
    }
}
