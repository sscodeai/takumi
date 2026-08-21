package com.example.inventory.dto.response;

import java.util.List;

public record ConfirmResponse(Long id, String status, List<AllocatedStock> allocatedStock) {
}
