package com.uav.lowaltitude.modules.identity.domain;

public enum PermissionCode {
    DEVICE_READ("device:read"),
    TARGET_READ("target:read"),
    ALARM_READ("alarm:read");

    private final String value;

    PermissionCode(String value) {
        this.value = value;
    }

    public String value() {
        return value;
    }
}
