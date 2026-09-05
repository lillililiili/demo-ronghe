package com.uav.lowaltitude.modules.risk.api;

import java.math.BigDecimal;
import java.util.List;

public final class RiskDtos {
    private RiskDtos() { }

    public record PageDto<T>(List<T> items, int page, int size, long total) { }
    public record RiskDto(String riskId, String sourceRiskId, String planId, String routeVersionId,
            String assessmentId, String targetId, String trackId, String riskType, String severity, String state,
            String reasonCode, String reasonText, Long occurredAt, long receivedAt, BigDecimal observedAltitudeM,
            String observedAltitudeDatum, String heightRelation, String sourceCode, String sourceMode,
            String ownerOrgId, String districtId, long version, List<String> allowedActions) { }
    public record VerificationDto(String historyId, long version, String previousState, String resultingState,
            String conclusion, String note, String actorId, long createdAt) { }
    public record VerifyRequest(String conclusion, String note, Long expectedVersion) { }
}
