package com.uav.lowaltitude.modules.evidence.api;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;

public final class EvidenceDtos {
    private EvidenceDtos() { }

    public record PageDto<T>(List<T> items, int page, int size, long total) { }

    public record EvidenceSummaryDto(String evidenceId, String evidenceNo, String kindCode, String originalName,
            String contentType, Long sizeBytes, String status, Long capturedAt, Long storedAt, boolean held,
            int linkCount) { }

    public record EvidenceDetailDto(String evidenceId, String evidenceNo, String kindCode, String originalName,
            String contentType, Long sizeBytes, String sha256, String status, Long capturedAt, Long storedAt,
            @JsonInclude(JsonInclude.Include.NON_NULL) Long retainUntil, boolean held, String sourceMode,
            String ownerOrgId, String districtId, long version, long createdAt, long updatedAt,
            List<LinkDto> links, List<HoldDto> holds) { }

    public record LinkDto(String linkId, String subjectKind, String subjectId,
            @JsonInclude(JsonInclude.Include.NON_NULL) String subjectNo) { }

    public record HoldDto(String holdId, String reason, String heldBy, long createdAt,
            @JsonInclude(JsonInclude.Include.NON_NULL) Long releasedAt,
            @JsonInclude(JsonInclude.Include.NON_NULL) String releasedBy) { }

    public record CreatedLinkDto(String linkId, String evidenceId, String subjectKind, String subjectId) { }

    public record VerifyDto(String evidenceId, String status, String sha256, boolean matches) { }

    public record HoldRequest(String reason) { }

    public record LinkRequest(String subjectKind, String subjectId) { }

    public record AccessLogDto(String accessId, String action, String result,
            @JsonInclude(JsonInclude.Include.NON_NULL) String reasonCode, long createdAt, String userId) { }
}
