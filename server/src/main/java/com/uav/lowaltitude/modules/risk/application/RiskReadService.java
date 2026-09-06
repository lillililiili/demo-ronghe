package com.uav.lowaltitude.modules.risk.application;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.MultiValueMap;

import com.uav.lowaltitude.modules.identity.application.AccessControlService;
import com.uav.lowaltitude.modules.identity.domain.AccessDecision;
import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.modules.risk.api.RiskDtos.PageDto;
import com.uav.lowaltitude.modules.risk.api.RiskDtos.RiskDto;
import com.uav.lowaltitude.modules.risk.domain.RiskState;
import com.uav.lowaltitude.modules.risk.infrastructure.RiskRepository;
import com.uav.lowaltitude.modules.risk.infrastructure.RiskRepository.RiskQuery;
import com.uav.lowaltitude.modules.risk.infrastructure.RiskRepository.RiskRow;
import com.uav.lowaltitude.platform.api.ApiException;

@Service
public class RiskReadService {
    private static final Set<String> ALLOWED = Set.of("state", "severity", "plan_id", "occurred_from", "occurred_to",
            "owner_org_id", "district_id", "source_mode", "page", "size");
    private static final Set<String> STATES=Set.of("PENDING_VERIFICATION","PENDING_NOTIFICATION","NOTIFIED","EXCLUDED");
    private static final Set<String> SEVERITIES=Set.of("LOW","MEDIUM","HIGH","CRITICAL");
    private static final Set<String> SOURCE_MODES=Set.of("mock","replay","live");
    private final AccessControlService access;
    private final RiskRepository repository;

    public RiskReadService(AccessControlService access, RiskRepository repository) {
        this.access = access; this.repository = repository;
    }

    @Transactional(readOnly = true)
    public PageDto<RiskDto> list(MultiValueMap<String, String> values) {
        // 鉴权必须先于参数解析，防止未授权调用者用 400/404 差异探测受保护接口。
        AccessDecision decision = access.require(PermissionCode.RISK_READ);
        // 原始请求只要出现 plan_id 就先要求关联读取动作；不能先解析其他坏参数泄露筛选能力。
        if(values.containsKey("plan_id"))access.require(PermissionCode.FLIGHT_READ);
        Request request = new Request(values);
        Page page = request.page();
        TimeRange occurred = request.timeRange();
        String planId=request.optional("plan_id",36);
        RiskQuery query = new RiskQuery(request.enumerated("state",STATES), request.enumerated("severity",SEVERITIES),
                planId, occurred.from, occurred.to, request.optional("owner_org_id", 36),
                request.optional("district_id", 36), request.enumerated("source_mode",SOURCE_MODES));
        long total = repository.count(query, decision);
        return new PageDto<>(repository.list(query, decision, page.offset(), page.size).stream().map(this::dto).toList(),
                page.page, page.size, total);
    }

    @Transactional(readOnly = true)
    public RiskDto detail(String riskId) {
        AccessDecision decision = access.require(PermissionCode.RISK_READ);
        RiskRow row = repository.find(id(riskId), decision);
        if (row == null) throw notFound();
        return dto(row);
    }

    public RiskDto dto(RiskRow row) {
        // 风险读取不隐含关联领域权限；即使有权限，也要再次校验关联对象仍属于风险的同一有效范围元组。
        String planId=visible(PermissionCode.FLIGHT_READ)&&repository.planReferenceVisible(row)?row.planId():null;
        String routeVersionId=visible(PermissionCode.ROUTE_READ)&&repository.routeReferenceVisible(row)?row.routeVersionId():null;
        String assessmentId=visible(PermissionCode.ASSESSMENT_READ)&&repository.assessmentReferenceVisible(row)?row.assessmentId():null;
        boolean targetVisible=visible(PermissionCode.TARGET_READ);
        String targetId=targetVisible&&repository.targetReferenceVisible(row)?row.targetId():null;
        String trackId=targetVisible&&repository.trackReferenceVisible(row)?row.trackId():null;
        return new RiskDto(row.riskId(), row.sourceRiskId(), planId, routeVersionId, assessmentId,
                targetId, trackId, row.riskType(), row.severity(), row.state(), row.reasonCode(), row.reasonText(),
                millis(row.occurredAt()), requiredMillis(row.receivedAt()), row.observedAltitudeM(), row.observedAltitudeDatum(),
                row.heightRelation(), row.sourceCode(), row.sourceMode(), row.ownerOrgId(), row.districtId(), row.version(),
                RiskState.verifiable(row.state())&&visible(PermissionCode.RISK_VERIFY) ? List.of("VERIFY") : List.of(),
                row.sourceName(), row.ownerOrgName(), row.districtName(), planId == null ? null : row.planNo(), targetId == null ? null : row.targetNo());
    }

    private boolean visible(PermissionCode permission){try{access.require(permission);return true;}catch(ApiException ignored){return false;}}

    public static String id(String value) {
        String id = value == null ? "" : value.trim();
        if (id.isEmpty() || id.length() > 36) throw new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", "ID 格式无效");
        return id;
    }
    public static ApiException notFound() { return new ApiException(HttpStatus.NOT_FOUND, "RISK_NOT_FOUND", "飞行风险不存在"); }
    private static Long millis(OffsetDateTime value) { return value == null ? null : value.toInstant().toEpochMilli(); }
    private static long requiredMillis(OffsetDateTime value) { if (value == null) throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "服务内部错误"); return value.toInstant().toEpochMilli(); }

    static final class Request {
        private final MultiValueMap<String, String> values;
        Request(MultiValueMap<String, String> values) {
            this.values = values;
            values.keySet().stream().filter(key -> !ALLOWED.contains(key)).findFirst().ifPresent(key -> { throw invalid(key + " 参数无效"); });
        }
        Page page() { int page=integer("page",1),size=integer("size",20); if(page<1||size<1||size>100)throw invalid("分页参数无效"); return new Page(page,size); }
        String optional(String name,int max) { if(!values.containsKey(name))return null; String value=single(name); if(value.length()>max)throw invalid(name+" 参数无效"); return value; }
        String enumerated(String name,Set<String> allowed){String value=optional(name,32);if(value!=null&&!allowed.contains(value))throw invalid(name+" 参数无效");return value;}
        TimeRange timeRange() {
            boolean hasFrom=values.containsKey("occurred_from"),hasTo=values.containsKey("occurred_to");
            if(!hasFrom&&!hasTo)return new TimeRange(null,null); if(hasFrom!=hasTo)throw badTime();
            try { OffsetDateTime from=Instant.ofEpochMilli(Long.parseLong(single("occurred_from"))).atOffset(ZoneOffset.UTC);
                OffsetDateTime to=Instant.ofEpochMilli(Long.parseLong(single("occurred_to"))).atOffset(ZoneOffset.UTC);
                if(!from.isBefore(to))throw badTime(); return new TimeRange(from,to); }
            catch(NumberFormatException ex){throw badTime();}
        }
        private int integer(String name,int fallback){if(!values.containsKey(name))return fallback;try{return Integer.parseInt(single(name));}catch(NumberFormatException ex){throw invalid("分页参数无效");}}
        private String single(String name){List<String> found=values.get(name);if(found==null||found.size()!=1||found.get(0)==null||found.get(0).isBlank())throw invalid(name+" 参数无效");return found.get(0).trim();}
        static ApiException invalid(String message){return new ApiException(HttpStatus.BAD_REQUEST,"VALIDATION_ERROR",message);}
        static ApiException badTime(){return new ApiException(HttpStatus.BAD_REQUEST,"INVALID_TIME_RANGE","时间范围无效");}
    }
    record Page(int page,int size){int offset(){try{return Math.multiplyExact(page-1,size);}catch(ArithmeticException ex){throw Request.invalid("分页参数无效");}}}
    record TimeRange(OffsetDateTime from,OffsetDateTime to){ }
}
