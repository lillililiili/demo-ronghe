package com.uav.lowaltitude.platform.security;

public record AuthUser(String userId, String account, String name, String roleCode) {
}
