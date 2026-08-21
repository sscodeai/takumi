package com.example.inventory.entity;

import jakarta.persistence.AttributeConverter;
import jakarta.persistence.Converter;

/**
 * users.role は DB 上 lowercase（'admin'/'user'、CHECK 制約と一致）。
 * エンティティ上は enum（大文字）として扱い、DB/JSON は lowercase で表現する。
 */
@Converter
public class UserRoleConverter implements AttributeConverter<UserRole, String> {

    @Override
    public String convertToDatabaseColumn(UserRole attribute) {
        return attribute == null ? null : attribute.name().toLowerCase();
    }

    @Override
    public UserRole convertToEntityAttribute(String dbData) {
        return dbData == null ? null : UserRole.valueOf(dbData.toUpperCase());
    }
}
