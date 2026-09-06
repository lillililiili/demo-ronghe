package com.uav.lowaltitude.platform.audit;

import java.util.Locale;
import java.util.Map;

final class AuditLabels {

    // Map.of 最多 10 对；模块目录已超过上限，统一用 Map.ofEntries 承载。
    private static final Map<String, String> MODULES = Map.ofEntries(
            Map.entry("authentication", "认证登录"),
            Map.entry("users", "用户管理"),
            Map.entry("roles", "角色管理"),
            Map.entry("audit", "审计日志"),
            Map.entry("devices", "设备管理"),
            Map.entry("alarms", "告警事件"),
            // 阶段 4/5：风险、交接、工作台是独立模块，失败审计与列表展示都按各自模块归档。
            Map.entry("risk", "飞行风险"),
            Map.entry("handoff", "业务交接"),
            Map.entry("workbench", "工作台"),
            // 阶段 7：研判与规则引擎分开归档；飞行监管只读接口也有自己的模块名。
            Map.entry("assessment", "合法性研判"),
            Map.entry("rules", "规则引擎"),
            Map.entry("flights", "飞行计划"),
            Map.entry("airspace", "空域规则"),
            Map.entry("system", "系统"));

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
            Map.entry("super_admin_recovered", "恢复超级管理员"),
            Map.entry("uav_event_verified", "核实无人机事件"),
            Map.entry("risk_verified", "核验飞行风险"),
            Map.entry("handoff_created", "提交业务交接"),
            Map.entry("legality_evaluation_revised", "复核合法性研判"),
            Map.entry("legality_evaluation_recomputed", "重新研判"),
            Map.entry("legality_evaluation_escalated", "研判转告警"),
            Map.entry("legality_evaluation_triggered", "手动触发研判"),
            Map.entry("rule_set_activated", "激活规则集版本"),
            Map.entry("rule_set_rolled_back", "回滚规则集版本"),
            Map.entry("rule_set_shadow_changed", "调整规则集阴影版本"));

    private static final Map<String, String> METHODS = Map.of(
            "GET", "查询", "POST", "提交", "PUT", "更新", "PATCH", "更新", "DELETE", "删除");

    private static final Map<String, String> PATHS = Map.ofEntries(
            Map.entry("/organizations", "组织"),
            Map.entry("/districts", "区域"),
            Map.entry("/users", "用户"),
            Map.entry("/roles", "角色"),
            Map.entry("/permissions", "权限"),
            Map.entry("/audit-logs", "审计日志"),
            Map.entry("/auth", "认证"),
            Map.entry("/devices", "设备"),
            Map.entry("/commission", "设备调测"),
            Map.entry("/alarms", "告警"),
            Map.entry("/uav-events", "无人机事件"),
            Map.entry("/risks", "飞行风险"),
            Map.entry("/handoff-recipients", "交接接收方"),
            Map.entry("/handoffs", "业务交接"),
            Map.entry("/workbench", "工作台"),
            Map.entry("/legality-evaluations", "合法性研判"),
            Map.entry("/legality-assessments", "合法性研判"),
            Map.entry("/rule-effects", "规则效果"),
            Map.entry("/rule-set-versions", "规则集版本"),
            Map.entry("/rule-sets", "规则集"),
            Map.entry("/rule-runs", "规则运行"),
            Map.entry("/flight-plans", "飞行计划"),
            Map.entry("/airspace", "空域"));

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
