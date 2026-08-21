package com.example.inventory.exception;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * アプリケーション例外。エラーコード・メッセージ・フィールドエラーを保持する。
 */
public class ApiException extends RuntimeException {

    private final ErrorCode errorCode;
    private final Map<String, String> fieldErrors = new LinkedHashMap<>();

    public ApiException(ErrorCode errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public ApiException(ErrorCode errorCode, String message, Map<String, String> fieldErrors) {
        super(message);
        this.errorCode = errorCode;
        if (fieldErrors != null) {
            this.fieldErrors.putAll(fieldErrors);
        }
    }

    public ErrorCode getErrorCode() {
        return errorCode;
    }

    public Map<String, String> getFieldErrors() {
        return fieldErrors;
    }
}
