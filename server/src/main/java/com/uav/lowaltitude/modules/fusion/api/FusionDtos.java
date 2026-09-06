package com.uav.lowaltitude.modules.fusion.api;

import java.math.BigDecimal;
import java.util.List;

/** 阶段 8 融合读写接口 DTO。可空字段一律省略（全局 non_null），不用空串或 0 占位。 */
public final class FusionDtos {
    private FusionDtos() { }

    public record PageDto<T>(List<T> items, int page, int size, long total) { }

    public record ConfigDto(String configVersion, String status, String schemaStatus, Object params, String note,
            Long createdAt, Long activatedAt, long version) { }

    public record ConfigOverviewDto(ConfigDto active, List<ConfigDto> versions) { }

    public record SourceStatusDto(String sourceCode, String sourceType, String schemaStatus, Long lastObservedAt, boolean online) { }

    /** data_interrupted：没有任何在线来源；as_of 取自 AppClock 本次读取。 */
    public record FusionStatusDto(List<SourceStatusDto> availableSources, boolean dataInterrupted, long asOf) { }

    public record LineageDto(String lineageId, String op, long occurredAt, String survivorTargetId, String originTargetId,
            List<String> memberTargetIds, List<String> sourceTargetIds, String algoVersion, String configVersion,
            String operatorKind, String operatorId, String note) { }

    public record ObservationDto(String observationId, String sourceCode, String sourceType, String externalTargetId,
            long observedAt, long receivedAt, BigDecimal longitude, BigDecimal latitude, BigDecimal positionAccuracyM,
            BigDecimal altitudeAmslM, BigDecimal heightAglM, BigDecimal speedMps, BigDecimal headingDeg,
            String classCode, BigDecimal classConfidence, String identityClue, String sourceMode) { }

    public record ClassificationRevisionDto(String revisionId, String targetId, String classCode, long version, long updatedAt) { }

    public record MergeResultDto(String lineageId, String survivorTargetId, List<String> mergedTargetIds) { }

    public record SplitResultDto(String lineageId, String originTargetId, List<String> newTargetIds) { }
}
