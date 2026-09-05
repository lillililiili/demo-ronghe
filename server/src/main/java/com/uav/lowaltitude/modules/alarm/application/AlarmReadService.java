package com.uav.lowaltitude.modules.alarm.application;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;

import com.uav.lowaltitude.modules.alarm.api.AlarmDtos.AlarmDto;
import com.uav.lowaltitude.modules.alarm.api.AlarmDtos.PageDto;
import com.uav.lowaltitude.modules.alarm.infrastructure.AlarmReadRepository;
import com.uav.lowaltitude.modules.alarm.infrastructure.AlarmReadRepository.AlarmQuery;
import com.uav.lowaltitude.modules.alarm.infrastructure.AlarmReadRepository.AlarmRow;
import com.uav.lowaltitude.modules.identity.application.AccessControlService;
import com.uav.lowaltitude.modules.identity.domain.AccessDecision;
import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.platform.api.ApiException;

@Service
public class AlarmReadService {
    private static final Set<String> ALLOWED = Set.of("state", "severity", "target_id", "occurred_from", "occurred_to", "owner_org_id", "district_id", "source_mode", "page", "size");
    private final AccessControlService access;
    private final AlarmReadRepository repository;

    public AlarmReadService(AccessControlService access, AlarmReadRepository repository) {
        this.access = access; this.repository = repository;
    }

    @Transactional(readOnly = true)
    public PageDto<AlarmDto> list(MultiValueMap<String, String> values) {
        AccessDecision decision = access.require(PermissionCode.ALARM_READ);
        // 筛选字段本身已是关联目标的探测入口；在解析其值（甚至分页）之前完成 target:read 鉴权。
        AccessDecision targetDecision = values.containsKey("target_id") ? access.require(PermissionCode.TARGET_READ) : null;
        Request request = new Request(values);
        Page page = request.page();
        AlarmQuery query = new AlarmQuery(request.optional("state", 32), request.optional("severity", 16),
                request.optional("target_id", 36), request.timeFrom(), request.timeTo(),
                request.optional("owner_org_id", 36), request.optional("district_id", 36), request.optional("source_mode", 8));
        if (query.targetId() != null) {
            // target_id 是关联对象筛选，不允许仅以告警读权限用 total 是否变化猜测目标存在或归属。
            if (!repository.targetReadable(query.targetId(), targetDecision)) throw new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "无权筛选该关联目标");
        }
        long total = repository.count(query, decision);
        return new PageDto<>(repository.list(query, decision, page.offset(), page.size()).stream().map(this::dto).toList(), page.page(), page.size(), total);
    }

    @Transactional(readOnly = true)
    public AlarmDto detail(String alarmId) {
        AccessDecision decision = access.require(PermissionCode.ALARM_READ);
        AlarmRow row = repository.find(id(alarmId), decision);
        if (row == null) throw new ApiException(HttpStatus.NOT_FOUND, "ALARM_NOT_FOUND", "告警不存在");
        return dto(row);
    }

    private AlarmDto dto(AlarmRow row) {
        // target_id 是独立敏感引用：没有 target:read 时宁可省略，也不能以 0 坐标或可猜 ID 替代。
        String targetId = targetReferenceVisible(row.targetId(), row.ownerOrgId(), row.districtId()) ? row.targetId() : null;
        return new AlarmDto(row.alarmId(), row.eventId(), row.state(), row.alarmType(), row.severity(), millis(row.occurredAt()),
                requiredMillis(row.receivedAt()), row.sourceCode(), row.sourceMode(), row.ownerOrgId(), row.districtId(), targetId);
    }

    private boolean targetReferenceVisible(String targetId, String orgId, String districtId) {
        try { return repository.targetVisible(targetId, orgId, districtId, access.require(PermissionCode.TARGET_READ)); }
        catch (ApiException ignored) { return false; }
    }

    private static String id(String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty() || normalized.length() > 36) throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "ID 格式无效");
        return normalized;
    }
    private static Long millis(OffsetDateTime value) { return value == null ? null : value.toInstant().toEpochMilli(); }
    private static long requiredMillis(OffsetDateTime value) { if (value == null) throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "服务内部错误"); return value.toInstant().toEpochMilli(); }

    private static final class Request {
        private final MultiValueMap<String, String> values;
        private Request(MultiValueMap<String, String> values) {
            this.values = values;
            values.keySet().stream().filter(key -> !ALLOWED.contains(key)).findFirst().ifPresent(key -> { throw invalid("参数无效"); });
        }
        private Page page() { int page = integer("page", 1), size = integer("size", 20); if (page < 1 || size < 1 || size > 100) throw invalid("分页参数无效"); return new Page(page, size); }
        private int integer(String name, int fallback) { if (!values.containsKey(name)) return fallback; String value = single(name); try { return Integer.parseInt(value); } catch (RuntimeException ex) { throw invalid("分页参数无效"); } }
        private String optional(String name, int max) { if (!values.containsKey(name)) return null; String value = single(name); if (value.length() > max) throw invalid(name + " 参数无效"); return value; }
        private OffsetDateTime timeFrom() { return time("occurred_from", true); }
        private OffsetDateTime timeTo() { OffsetDateTime to = time("occurred_to", false); OffsetDateTime from = time("occurred_from", false); if ((from == null) != (to == null) || (from != null && !from.isBefore(to))) throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_TIME_RANGE", "时间范围无效"); return to; }
        private OffsetDateTime time(String name, boolean ignored) { if (!values.containsKey(name)) return null; try { return Instant.ofEpochMilli(Long.parseLong(single(name))).atOffset(ZoneOffset.UTC); } catch (RuntimeException ex) { throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_TIME_RANGE", "时间范围无效"); } }
        private String single(String name) { List<String> found = values.get(name); if (found == null || found.size() != 1 || found.get(0) == null || found.get(0).isBlank()) throw invalid(name + " 参数无效"); return found.get(0).trim(); }
        private static ApiException invalid(String message) { return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message); }
    }
    private record Page(int page, int size) { private int offset() { try { return Math.multiplyExact(page - 1, size); } catch (ArithmeticException ex) { throw Request.invalid("分页参数无效"); } } }
}
