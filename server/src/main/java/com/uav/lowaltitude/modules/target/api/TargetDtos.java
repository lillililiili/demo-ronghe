package com.uav.lowaltitude.modules.target.api;

import java.math.BigDecimal;
import java.util.List;

public final class TargetDtos {

    private TargetDtos() {
    }

    public record PageDto<T>(List<T> items, int page, int size, long total) {
    }

    public record LocationDto(BigDecimal longitude, BigDecimal latitude, String coordinateSystem) {
    }

    public record FieldIssueDto(String field, String reasonCode) {
    }

    public record TargetStateDto(
            long observedAt,
            long receivedAt,
            List<FieldIssueDto> fieldIssues,
            LocationDto location,
            BigDecimal altitudeAmslM,
            BigDecimal heightAglM,
            BigDecimal speedMps,
            BigDecimal headingDeg,
            BigDecimal classificationConfidence,
            BigDecimal fusionConfidence) {
    }

    public record TargetSummaryDto(
            String targetId,
            String targetNo,
            Long firstSeenAt,
            Long lastSeenAt,
            String objectTypeCode,
            String subtype,
            String uavSn,
            String sourceMode,
            String ownerOrgId,
            String districtId,
            TargetStateDto latestState) {
    }

    public record TargetDetailDto(
            String targetId,
            String targetNo,
            Long firstSeenAt,
            Long lastSeenAt,
            String objectTypeCode,
            String subtype,
            String uavSn,
            String sourceMode,
            String ownerOrgId,
            String districtId,
            TargetStateDto latestState,
            List<TargetSourceLinkDto> sourceLinks,
            long createdAt,
            long updatedAt) {
    }

    public record TargetSourceLinkDto(
            String linkId,
            String sourceId,
            String sourceCode,
            String sourceMode,
            String sourceSessionKey,
            String externalTargetId,
            String deviceId,
            String protocolVersion) {
    }

    public record TrackSummaryDto(
            String trackId,
            String targetId,
            String linkId,
            String externalTrackId,
            String sourceId,
            String sourceCode,
            String sourceMode,
            String deviceId,
            Long startedAt) {
    }

    public record TrackPointDto(
            String pointId,
            String trackId,
            long pointSeq,
            long sortTime,
            String timeBasis,
            long receivedAt,
            Long observedAt,
            LocationDto location,
            BigDecimal altitudeAmslM,
            BigDecimal heightAglM) {
    }
}
