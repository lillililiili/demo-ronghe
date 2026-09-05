package com.uav.lowaltitude.modules.identity.domain;

public enum PermissionCode {
    DEVICE_READ("device:read"),
    TARGET_READ("target:read"),
    ALARM_READ("alarm:read"),
    // 阶段 3 将计划、航线、空域和研判拆成独立动作，双权限接口不得用任一单项权限替代。
    FLIGHT_READ("flight:read"),
    ROUTE_READ("route:read"),
    AIRSPACE_READ("airspace:read"),
    ASSESSMENT_READ("assessment:read");

    private final String value;

    PermissionCode(String value) {
        this.value = value;
    }

    public String value() {
        return value;
    }
}
