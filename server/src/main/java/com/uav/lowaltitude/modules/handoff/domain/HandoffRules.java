package com.uav.lowaltitude.modules.handoff.domain;

import java.util.Set;

import org.springframework.http.HttpStatus;

import com.uav.lowaltitude.platform.api.ApiException;

/**
 * 交接规则：交接是独立于源状态的记录，提交只表示材料入库，不推进源风险、不表示送达或办结。
 * 本期只允许已核验风险的 RISK_NOTICE；普通已核实无人机缺少可信反制/干扰完成事实，UAV_PUNISHMENT 一律阻断。
 */
public final class HandoffRules {
    public static final Set<String> SOURCE_KINDS = Set.of("RISK", "UAV_EVENT");
    public static final Set<String> HANDOFF_TYPES = Set.of("RISK_NOTICE", "UAV_PUNISHMENT");
    public static final Set<String> DELIVERY_STATUSES = Set.of("PENDING_DELIVERY", "SUBMITTED", "DELIVERED", "FAILED");
    public static final Set<String> RECEIPT_STATUSES = Set.of("NOT_EXPECTED", "PENDING", "ACKNOWLEDGED", "TIMEOUT");
    public static final Set<String> SOURCE_MODES = Set.of("mock", "replay", "live");
    public static final String KIND_RISK = "RISK";
    public static final String TYPE_RISK_NOTICE = "RISK_NOTICE";
    public static final String TYPE_UAV_PUNISHMENT = "UAV_PUNISHMENT";
    public static final String PENDING_DELIVERY = "PENDING_DELIVERY";
    public static final String NOT_EXPECTED = "NOT_EXPECTED";
    public static final String CHANNEL_NOT_CONNECTED = "CHANNEL_NOT_CONNECTED";
    public static final int SNAPSHOT_SCHEMA_VERSION = 1;

    private HandoffRules() { }

    /** 处罚交接的前提是反制/干扰完成事实，本期没有可信来源，任何 source_kind 都不能提交。 */
    public static void requirePrerequisite(String handoffType) {
        if (TYPE_UAV_PUNISHMENT.equals(handoffType)) {
            throw new ApiException(HttpStatus.CONFLICT, "HANDOFF_PREREQUISITE_UNAVAILABLE", "处罚交接前提事实尚未接入，本期不能提交");
        }
    }

    /** 本期只有风险通知这一种可提交组合；其他 kind 与类型组合在语义上不存在，按 400 拒绝。 */
    public static void requireKindSupportsType(String sourceKind, String handoffType) {
        if (!(KIND_RISK.equals(sourceKind) && TYPE_RISK_NOTICE.equals(handoffType))) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_KIND", "该来源类型不支持此交接类型");
        }
    }

    /** 只有核验后的待通知风险可以交接；待核验、已排除都不是可通知状态。 */
    public static void requireNotifiable(String riskState) {
        if (!"PENDING_NOTIFICATION".equals(riskState)) {
            throw new ApiException(HttpStatus.CONFLICT, "INVALID_TRANSITION", "当前风险状态不允许提交通知交接");
        }
    }
}
