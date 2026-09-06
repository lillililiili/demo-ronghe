package com.uav.lowaltitude.modules.identity.domain;

public enum PermissionCode {
    DEVICE_READ("device:read"),
    TARGET_READ("target:read"),
    ALARM_READ("alarm:read"),
    // 读和核实分权：拥有核实动作不应绕过来源告警的可见范围。
    ALARM_VERIFY("alarm:verify"),
    // 阶段 3 将计划、航线、空域和研判拆成独立动作，双权限接口不得用任一单项权限替代。
    FLIGHT_READ("flight:read"),
    ROUTE_READ("route:read"),
    AIRSPACE_READ("airspace:read"),
    ASSESSMENT_READ("assessment:read"),
    // 飞行风险拥有独立状态机，读取和核验不能借用计划或研判权限。
    RISK_READ("risk:read"),
    RISK_VERIFY("risk:verify"),
    // 工作台只聚合三类源事项，仍需逐项校验源模块读权限；workbench:read 不能扩大任何源的可见范围。
    WORKBENCH_READ("workbench:read"),
    // 交接是独立于源状态的记录：读交接、发起交接分权，发起还必须同时具备源对象读权限。
    HANDOFF_READ("handoff:read"),
    HANDOFF_CREATE("handoff:create"),
    // 阶段 7：规则集读取/激活分权；引擎评估、人工复核、转告警是三种不同动作，缺任一不能借研判读权限替代。
    RULE_READ("rule:read"),
    RULE_MANAGE("rule:manage"),
    ASSESSMENT_EVALUATE("assessment:evaluate"),
    ASSESSMENT_REVISE("assessment:revise"),
    ASSESSMENT_ESCALATE("assessment:escalate");

    private final String value;

    PermissionCode(String value) {
        this.value = value;
    }

    public String value() {
        return value;
    }
}
