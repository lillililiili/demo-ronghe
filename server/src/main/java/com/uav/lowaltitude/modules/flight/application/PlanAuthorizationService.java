package com.uav.lowaltitude.modules.flight.application;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.modules.flight.api.FlightActualsDtos.AuthorizationDto;
import com.uav.lowaltitude.modules.flight.api.FlightActualsDtos.AuthorizationsDto;
import com.uav.lowaltitude.modules.flight.api.FlightActualsDtos.RecordedAuthorizationDto;
import com.uav.lowaltitude.modules.flight.infrastructure.FlightReadRepository;
import com.uav.lowaltitude.modules.flight.infrastructure.FlightReadRepository.PlanRow;
import com.uav.lowaltitude.modules.flight.infrastructure.PlanAuthorizationRepository;
import com.uav.lowaltitude.modules.flight.infrastructure.PlanAuthorizationRepository.AuthorizationRow;
import com.uav.lowaltitude.modules.identity.application.AccessControlService;
import com.uav.lowaltitude.modules.identity.application.IdempotencyGuard;
import com.uav.lowaltitude.modules.identity.domain.AccessDecision;
import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.platform.api.ApiException;
import com.uav.lowaltitude.platform.audit.AuditService;
import com.uav.lowaltitude.platform.security.AuthContext;
import com.uav.lowaltitude.platform.security.AuthUser;
import com.uav.lowaltitude.platform.time.AppClock;

import static com.uav.lowaltitude.modules.flight.api.FlightActualsDtos.AVAILABLE;

/**
 * 外部授权登记：把"某单位在某文号下批过这段飞行"记成一条只增的事实。
 *
 * 它**不是**本平台的审批流，因此绝不改动 {@code flight_plan.status_code}——计划状态由计划来源系统给出，
 * 平台不冒充审批机关（决策 9-10 的边界）。同一计划同一文号只能登记一次：重复提交不是新事实。
 *
 * 事务顺序与阶段 5/7/8/9.1 一致：鉴权（flight:read → flight:authorize）→ 严格解析 body → 取计划（越权即 404）
 * → claim 幂等键 → 写入 → 成功审计（同事务）。失败审计由全局异常处理在事务外落库。
 */
@Service
public class PlanAuthorizationService {
    static final String MODULE = "flights", OBJECT_TYPE = "flight_plan";
    private static final Set<String> FIELDS = Set.of("document_no", "issuer", "granted_from", "granted_to", "scope_note");
    private static final int DOCUMENT_MAX = 128, ISSUER_MAX = 128, NOTE_MAX = 500;

    private final AccessControlService access;
    private final FlightReadRepository plans;
    private final PlanAuthorizationRepository repository;
    private final IdempotencyGuard idempotency;
    private final AuditService audit;
    private final AppClock clock;
    private final ObjectMapper json;

    public PlanAuthorizationService(AccessControlService access, FlightReadRepository plans,
            PlanAuthorizationRepository repository, IdempotencyGuard idempotency, AuditService audit,
            AppClock clock, ObjectMapper json) {
        this.access = access; this.plans = plans; this.repository = repository;
        this.idempotency = idempotency; this.audit = audit; this.clock = clock; this.json = json;
    }

    @Transactional(readOnly = true)
    public AuthorizationsDto list(String planId) {
        AccessDecision decision = access.require(PermissionCode.FLIGHT_READ);
        PlanRow plan = requirePlan(planId, decision);
        List<AuthorizationDto> items = repository.list(plan.planId()).stream()
                .map(FlightActualsService::authorization).toList();
        return new AuthorizationsDto(AVAILABLE, items);
    }

    @Transactional
    public RecordedAuthorizationDto record(String planId, String rawBody, String idempotencyKey) {
        // 读权限先于写权限：没有计划读权限的人不该通过登记接口的报错差异探测计划是否存在。
        AccessDecision decision = access.require(PermissionCode.FLIGHT_READ);
        access.require(PermissionCode.FLIGHT_AUTHORIZE);
        Request request = parse(rawBody);
        PlanRow plan = requirePlan(planId, decision);
        idempotency.claim(idempotencyKey, framed("plan-authorization") + framed(plan.planId()) + framed(request.documentNo())
                + framed(Long.toString(request.grantedFrom().toEpochMilli())) + framed(Long.toString(request.grantedTo().toEpochMilli())));
        if (repository.documentNoExists(plan.planId(), request.documentNo())) throw exists();

        Instant now = clock.now();
        AuthUser actor = AuthContext.require();
        String authorizationId = UUID.randomUUID().toString();
        try {
            repository.insert(new AuthorizationRow(authorizationId, plan.planId(), request.documentNo(), request.issuer(),
                    request.grantedFrom(), request.grantedTo(), request.scopeNote(), actor.userId(), now, "MANUAL", null));
        } catch (DataIntegrityViolationException duplicate) {
            // 上面的存在性预检挡不住并发：唯一约束才是最终保障，这里把它翻成契约的 409 而不是 500。
            throw exists();
        }
        audit.record(actor.userId(), actor.account(), actor.roleCode(), MODULE, "plan_authorization_recorded", OBJECT_TYPE,
                plan.planId(), "document_no=" + request.documentNo() + "; issuer=" + request.issuer(), "SUCCESS", "", "");
        return new RecordedAuthorizationDto(plan.planId(), authorizationId);
    }

    private PlanRow requirePlan(String planId, AccessDecision decision) {
        PlanRow plan = plans.findPlan(FlightActualsService.identifier(planId), decision);
        if (plan == null) throw new ApiException(HttpStatus.NOT_FOUND, "FLIGHT_PLAN_NOT_FOUND", "飞行计划不存在");
        return plan;
    }

    record Request(String documentNo, String issuer, Instant grantedFrom, Instant grantedTo, String scopeNote) { }

    private Request parse(String rawBody) {
        JsonNode node = strictObject(rawBody);
        String documentNo = requiredText(node, "document_no", DOCUMENT_MAX);
        String issuer = requiredText(node, "issuer", ISSUER_MAX);
        Instant grantedFrom = requiredTime(node, "granted_from");
        Instant grantedTo = requiredTime(node, "granted_to");
        // 零长度或倒挂的授权区间说不清"哪段时间是被授权的"。
        if (!grantedFrom.isBefore(grantedTo)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_VALIDITY", "授权结束时间必须晚于开始时间");
        }
        return new Request(documentNo, issuer, grantedFrom, grantedTo, optionalText(node, "scope_note", NOTE_MAX));
    }

    private JsonNode strictObject(String rawBody) {
        if (rawBody == null || rawBody.isBlank()) throw invalidRequest();
        try (JsonParser parser = json.getFactory().createParser(rawBody)) {
            parser.enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
            JsonNode node = json.readTree(parser);
            if (node == null || !node.isObject() || parser.nextToken() != null) throw invalidRequest();
            node.fieldNames().forEachRemaining(name -> {
                if (!FIELDS.contains(name)) throw new ApiException(HttpStatus.BAD_REQUEST, "UNKNOWN_FIELD", "请求体包含未知字段 " + name);
            });
            return node;
        } catch (java.io.IOException ex) {
            throw invalidRequest();
        }
    }

    private static String requiredText(JsonNode node, String field, int max) {
        String value = optionalText(node, field, max);
        if (value == null) throw validation(field + " 必填");
        return value;
    }

    private static String optionalText(JsonNode node, String field, int max) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) return null;
        if (!value.isTextual()) throw validation(field + " 必须是字符串");
        String text = value.textValue().trim();
        if (text.isEmpty()) return null;
        if (text.length() > max) throw validation(field + " 超出长度限制");
        return text;
    }

    private static Instant requiredTime(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) throw validation(field + " 必填");
        if (!value.isIntegralNumber() || !value.canConvertToLong()) throw validation(field + " 必须是毫秒时间戳");
        return Instant.ofEpochMilli(value.longValue());
    }

    private static String framed(String value) {
        String text = value == null ? "" : value;
        return text.getBytes(StandardCharsets.UTF_8).length + ":" + text;
    }

    private static ApiException exists() {
        return new ApiException(HttpStatus.CONFLICT, "AUTHORIZATION_EXISTS", "该计划已登记过同一文号的授权");
    }

    private static ApiException validation(String message) {
        return new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR", message);
    }

    private static ApiException invalidRequest() {
        return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "请求体无效");
    }
}
