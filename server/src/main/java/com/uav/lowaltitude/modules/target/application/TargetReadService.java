package com.uav.lowaltitude.modules.target.application;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;

import com.uav.lowaltitude.modules.identity.application.AccessControlService;
import com.uav.lowaltitude.modules.identity.domain.AccessDecision;
import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.modules.target.api.TargetDtos.FieldIssueDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.LocationDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.PageDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.TargetDetailDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.TargetSourceLinkDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.TargetStateDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.TargetSummaryDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.TrackPointDto;
import com.uav.lowaltitude.modules.target.api.TargetDtos.TrackSummaryDto;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.Coordinate;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.PointRow;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.SourceLinkRow;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.TargetQuery;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.TargetRow;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.TimeQuery;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.TrackQuery;
import com.uav.lowaltitude.modules.target.infrastructure.TargetReadRepository.TrackRow;
import com.uav.lowaltitude.platform.api.ApiException;

@Service
public class TargetReadService {

    private static final Set<String> ISSUE_REASONS = Set.of(
            "NOT_REPORTED", "INVALID_VALUE", "REFERENCE_UNKNOWN", "TIME_UNTRUSTED",
            "NOT_APPLICABLE", "UNSUPPORTED");
    private static final Set<String> ISSUE_FIELDS = Set.of(
            "location", "altitude_amsl_m", "height_agl_m", "speed_mps", "heading_deg",
            "classification_confidence", "fusion_confidence");

    private final AccessControlService accessControl;
    private final TargetReadRepository repository;
    private final ObjectMapper objectMapper;

    public TargetReadService(
            AccessControlService accessControl,
            TargetReadRepository repository,
            ObjectMapper objectMapper) {
        this.accessControl = accessControl;
        this.repository = repository;
        this.objectMapper = objectMapper;
    }

    @Transactional(readOnly = true)
    public PageDto<TargetSummaryDto> targets(MultiValueMap<String, String> parameters) {
        AccessDecision access = accessControl.require(PermissionCode.TARGET_READ);
        RequestValues request = new RequestValues(parameters);
        Pagination page = request.pagination();
        TimeRange seen = request.timeRange("seen_from", "seen_to");
        TargetQuery query = new TargetQuery(
                request.optional("source_code", 64),
                request.optional("device_id", 36),
                request.optional("object_type_code", 32),
                seen.from, seen.to,
                request.optional("owner_org_id", 36),
                request.optional("district_id", 36));
        long total = repository.countTargets(query, access);
        List<TargetSummaryDto> items = repository.listTargets(query, access, page.offset(), page.size).stream()
                .map(this::summary)
                .toList();
        return new PageDto<>(items, page.page, page.size, total);
    }

    @Transactional(readOnly = true)
    public TargetDetailDto target(String targetId) {
        AccessDecision access = accessControl.require(PermissionCode.TARGET_READ);
        String id = pathId(targetId);
        TargetRow row = repository.findTarget(id, access);
        if (row == null) throw notFound("TARGET_NOT_FOUND", "目标不存在");
        List<TargetSourceLinkDto> links = repository.sourceLinks(id, access).stream().map(this::sourceLink).toList();
        return new TargetDetailDto(
                row.targetId(), row.targetNo(), millis(row.firstSeenAt()), millis(row.lastSeenAt()),
                row.objectTypeCode(), row.subtype(), row.uavSn(), row.sourceMode(), row.ownerOrgId(),
                row.districtId(), state(row), links, requiredMillis(row.createdAt()), requiredMillis(row.updatedAt()));
    }

    @Transactional(readOnly = true)
    public PageDto<TrackSummaryDto> tracks(String targetId, MultiValueMap<String, String> parameters) {
        AccessDecision access = accessControl.require(PermissionCode.TARGET_READ);
        String id = pathId(targetId);
        RequestValues request = new RequestValues(parameters);
        Pagination page = request.pagination();
        TimeRange started = request.timeRange("started_from", "started_to");
        TrackQuery query = new TrackQuery(started.from, started.to,
                request.optional("source_code", 64), request.optional("device_id", 36));
        if (repository.findTarget(id, access) == null) throw notFound("TARGET_NOT_FOUND", "目标不存在");
        long total = repository.countTracks(id, query, access);
        List<TrackSummaryDto> items = repository.listTracks(id, query, access, page.offset(), page.size).stream()
                .map(this::track)
                .toList();
        return new PageDto<>(items, page.page, page.size, total);
    }

    @Transactional(readOnly = true)
    public PageDto<TrackPointDto> points(String trackId, MultiValueMap<String, String> parameters) {
        AccessDecision access = accessControl.require(PermissionCode.TARGET_READ);
        String id = pathId(trackId);
        RequestValues request = new RequestValues(parameters);
        Pagination page = request.pagination();
        TimeRange time = request.timeRange("time_from", "time_to");
        TimeQuery query = new TimeQuery(time.from, time.to);
        if (!repository.accessibleValidTrack(id, access)) throw notFound("TRACK_NOT_FOUND", "轨迹不存在");
        long total = repository.countPoints(id, query, access);
        List<TrackPointDto> items = repository.listPoints(id, query, access, page.offset(), page.size).stream()
                .map(this::point)
                .toList();
        return new PageDto<>(items, page.page, page.size, total);
    }

    private TargetSummaryDto summary(TargetRow row) {
        return new TargetSummaryDto(
                row.targetId(), row.targetNo(), millis(row.firstSeenAt()), millis(row.lastSeenAt()),
                row.objectTypeCode(), row.subtype(), row.uavSn(), row.sourceMode(), row.ownerOrgId(),
                row.districtId(), state(row));
    }

    private TargetStateDto state(TargetRow row) {
        if (row.stateObservedAt() == null) return null;
        return new TargetStateDto(
                requiredMillis(row.stateObservedAt()), requiredMillis(row.stateReceivedAt()), issues(row),
                location(row.location()), row.altitudeAmslM(), row.heightAglM(), row.speedMps(), row.headingDeg(),
                row.classificationConfidence(), row.fusionConfidence());
    }

    private List<FieldIssueDto> issues(TargetRow row) {
        List<FieldIssueDto> issues = new ArrayList<>();
        JsonNode root;
        try {
            root = objectMapper.readTree(row.unknownFields());
        } catch (Exception ignored) {
            throw internalError();
        }
        if (root == null || !root.isArray()) throw internalError();
        for (JsonNode issue : root) {
            String field = issue.path("field").asText("");
            String reason = issue.path("reason_code").asText("");
            if (ISSUE_FIELDS.contains(field) && ISSUE_REASONS.contains(reason)
                    && unavailable(row, field)) {
                issues.add(new FieldIssueDto(field, reason));
            }
        }
        issues.sort(Comparator.comparing(FieldIssueDto::field).thenComparing(FieldIssueDto::reasonCode));
        return List.copyOf(issues);
    }

    private static boolean unavailable(TargetRow row, String field) {
        return switch (field) {
            case "location" -> row.location() == null;
            case "altitude_amsl_m" -> row.altitudeAmslM() == null;
            case "height_agl_m" -> row.heightAglM() == null;
            case "speed_mps" -> row.speedMps() == null;
            case "heading_deg" -> row.headingDeg() == null;
            case "classification_confidence" -> row.classificationConfidence() == null;
            case "fusion_confidence" -> row.fusionConfidence() == null;
            default -> false;
        };
    }

    private TargetSourceLinkDto sourceLink(SourceLinkRow row) {
        return new TargetSourceLinkDto(
                row.linkId(), row.sourceId(), row.sourceCode(), row.sourceMode(), row.sourceSessionKey(),
                row.externalTargetId(), row.deviceId(), row.protocolVersion());
    }

    private TrackSummaryDto track(TrackRow row) {
        return new TrackSummaryDto(
                row.trackId(), row.targetId(), row.linkId(), row.externalTrackId(), row.sourceId(),
                row.sourceCode(), row.sourceMode(), row.deviceId(), millis(row.startedAt()));
    }

    private TrackPointDto point(PointRow row) {
        if (row.location() == null) {
            throw internalError();
        }
        OffsetDateTime sortTime = row.observedAt() == null ? row.receivedAt() : row.observedAt();
        return new TrackPointDto(
                row.pointId(), row.trackId(), row.pointSeq(), requiredMillis(sortTime),
                row.observedAt() == null ? "RECEIVED" : "OBSERVED", requiredMillis(row.receivedAt()),
                millis(row.observedAt()), location(row.location()), row.altitudeAmslM(), row.heightAglM());
    }

    private static LocationDto location(Coordinate coordinate) {
        return coordinate == null ? null
                : new LocationDto(coordinate.longitude(), coordinate.latitude(), "WGS84");
    }

    private static String pathId(String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty() || normalized.length() > 36) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "ID 格式无效");
        }
        return normalized;
    }

    private static Long millis(OffsetDateTime value) {
        return value == null ? null : value.toInstant().toEpochMilli();
    }

    private static long requiredMillis(OffsetDateTime value) {
        if (value == null) {
            throw internalError();
        }
        return value.toInstant().toEpochMilli();
    }

    private static ApiException notFound(String code, String message) {
        return new ApiException(HttpStatus.NOT_FOUND, code, message);
    }

    private static ApiException internalError() {
        return new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "服务内部错误");
    }

    private static final class RequestValues {
        private final MultiValueMap<String, String> values;

        private RequestValues(MultiValueMap<String, String> values) {
            this.values = values;
        }

        private Pagination pagination() {
            int page = integer("page", 1);
            int size = integer("size", 20);
            if (page < 1 || size < 1 || size > 100) throw invalidPage();
            return new Pagination(page, size);
        }

        private int integer(String name, int defaultValue) {
            if (!values.containsKey(name)) return defaultValue;
            List<String> found = values.get(name);
            if (found == null || found.size() != 1) throw invalidPage();
            String value = found.get(0);
            if (value == null || value.isBlank()) throw invalidPage();
            try {
                return Integer.parseInt(value);
            } catch (NumberFormatException ex) {
                throw invalidPage();
            }
        }

        private String optional(String name, int maxLength) {
            if (!values.containsKey(name)) return null;
            List<String> found = values.get(name);
            if (found == null || found.size() != 1) throw validation(name);
            String value = found.get(0);
            if (value == null || value.isBlank() || value.length() > maxLength) throw validation(name);
            return value;
        }

        private TimeRange timeRange(String fromName, String toName) {
            boolean hasFrom = values.containsKey(fromName);
            boolean hasTo = values.containsKey(toName);
            if (!hasFrom && !hasTo) return new TimeRange(null, null);
            if (!hasFrom || !hasTo) throw invalidTime();
            List<String> fromValues = values.get(fromName);
            List<String> toValues = values.get(toName);
            if (fromValues == null || toValues == null || fromValues.size() != 1 || toValues.size() != 1) {
                throw invalidTime();
            }
            try {
                String fromText = fromValues.get(0);
                String toText = toValues.get(0);
                if (fromText == null || toText == null || fromText.isBlank() || toText.isBlank()) throw invalidTime();
                long fromMillis = Long.parseLong(fromText);
                long toMillis = Long.parseLong(toText);
                if (fromMillis > toMillis) throw invalidTime();
                return new TimeRange(
                        Instant.ofEpochMilli(fromMillis).atOffset(ZoneOffset.UTC),
                        Instant.ofEpochMilli(toMillis).atOffset(ZoneOffset.UTC));
            } catch (NumberFormatException ex) {
                throw invalidTime();
            }
        }

        private static ApiException invalidPage() {
            return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_PAGE", "分页参数无效");
        }

        private static ApiException invalidTime() {
            return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_TIME_RANGE", "时间范围无效");
        }

        private static ApiException validation(String name) {
            return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", name + " 参数无效");
        }
    }

    private record Pagination(int page, int size) {
        private int offset() {
            try {
                return Math.multiplyExact(page - 1, size);
            } catch (ArithmeticException ex) {
                throw RequestValues.invalidPage();
            }
        }
    }

    private record TimeRange(OffsetDateTime from, OffsetDateTime to) {
    }
}
