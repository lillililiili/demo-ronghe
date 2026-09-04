package com.uav.lowaltitude.platform.audit;

import java.util.Locale;
import java.util.Map;

final class AuditLabels {

    private static final Map<String, String> MODULES = Map.of(
            "authentication", "认证登录",
            "users", "用户管理",
            "roles", "角色管理",
            "audit", "审计日志",
            "devices", "设备管理",
            "alarms", "告警事件",
            "system", "系统");

    private static final Map<String, String> ACTIONS = Map.ofEntries(
            Map.entry("login_success", "登录成功"),
            Map.entry("login_fail", "登录失败"),
            Map.entry("logout", "退出登录"),
            Map.entry("password_changed", "修改密码"),
            Map.entry("user_created", "创建用户"),
            Map.entry("user_deleted", "删除用户"),
            Map.entry("user_profile_updated", "更新用户资料"),
            Map.entry("user_status_changed", "变更用户状态"),
            Map.entry("user_password_reset", "重置用户密码"),
            Map.entry("user_access_updated", "调整用户角色"),
            Map.entry("user_creation_requested", "申请创建用户"),
            Map.entry("user_access_requested", "申请调整用户权限"),
            Map.entry("organization_created", "创建组织"),
            Map.entry("organization_updated", "更新组织"),
            Map.entry("organization_status_changed", "变更组织状态"),
            Map.entry("organization_deleted", "删除组织"),
            Map.entry("district_created", "创建区域"),
            Map.entry("district_updated", "更新区域"),
            Map.entry("district_status_changed", "变更区域状态"),
            Map.entry("role_created", "创建角色"),
            Map.entry("role_description_updated", "更新角色说明"),
            Map.entry("role_permissions_updated", "更新角色权限"),
            Map.entry("role_deleted", "删除角色"),
            Map.entry("role_access_requested", "申请调整角色权限"),
            Map.entry("role_deletion_requested", "申请删除角色"),
            Map.entry("access_change_approved", "批准权限变更"),
            Map.entry("access_change_rejected", "驳回权限变更"),
            Map.entry("audit_export_requested", "导出审计日志"),
            Map.entry("super_admin_recovered", "恢复超级管理员"));

    private static final Map<String, String> METHODS = Map.of(
            "GET", "查询", "POST", "提交", "PUT", "更新", "PATCH", "更新", "DELETE", "删除");

    private static final Map<String, String> PATHS = Map.of(
            "/organizations", "组织",
            "/districts", "区域",
            "/users", "用户",
            "/roles", "角色",
            "/permissions", "权限",
            "/audit-logs", "审计日志",
            "/auth", "认证",
            "/devices", "设备",
            "/commission", "设备调测",
            "/alarms", "告警");

    private AuditLabels() {
    }

    static String role(String roleCode) {
        if (roleCode == null || roleCode.isBlank()) return "";
        if ("ROLE-ADMIN".equals(roleCode)) return "超级管理员";
        return roleCode;
    }

    static String module(String moduleCode) {
        if (moduleCode == null || moduleCode.isBlank()) return "";
        return MODULES.getOrDefault(moduleCode, moduleCode);
    }

    static String action(String action) {
        if (action == null || action.isBlank()) return "";
        String mapped = ACTIONS.get(action);
        if (mapped != null) return mapped;
        String[] parts = action.split("\\s+", 2);
        if (parts.length != 2) return action;
        String method = METHODS.get(parts[0].toUpperCase(Locale.ROOT));
        if (method == null) return action;
        for (Map.Entry<String, String> path : PATHS.entrySet()) {
            if (parts[1].contains(path.getKey())) return method + path.getValue();
        }
        return method + "接口";
    }

    static String result(String result) {
        if ("SUCCESS".equals(result)) return "成功";
        if ("FAILURE".equals(result)) return "失败";
        return result == null ? "" : result;
    }
}
