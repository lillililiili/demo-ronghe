package com.uav.lowaltitude.modules.handoff.application;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Set;
import java.util.UUID;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.modules.handoff.api.HandoffDtos.CreateRequest;
import com.uav.lowaltitude.modules.handoff.api.HandoffDtos.CreatedDto;
import com.uav.lowaltitude.modules.handoff.api.HandoffDtos.MaterialDto;
import com.uav.lowaltitude.modules.handoff.api.HandoffDtos.ReferenceMaterialDto;
import com.uav.lowaltitude.modules.handoff.api.HandoffDtos.RiskMaterialDto;
import com.uav.lowaltitude.modules.handoff.api.HandoffDtos.VerificationMaterialDto;
import com.uav.lowaltitude.modules.handoff.domain.DisposalCompletionPort;
import com.uav.lowaltitude.modules.handoff.domain.HandoffRules;
import com.uav.lowaltitude.modules.handoff.infrastructure.HandoffRepository;
import com.uav.lowaltitude.modules.handoff.infrastructure.HandoffRepository.DeliveryInsert;
import com.uav.lowaltitude.modules.handoff.infrastructure.HandoffRepository.HandoffInsert;
import com.uav.lowaltitude.modules.handoff.infrastructure.HandoffRepository.RecipientRow;
import com.uav.lowaltitude.modules.identity.application.AccessControlService;
import com.uav.lowaltitude.modules.identity.application.IdempotencyGuard;
import com.uav.lowaltitude.modules.identity.domain.AccessDecision;
import com.uav.lowaltitude.modules.identity.domain.PermissionCode;
import com.uav.lowaltitude.modules.risk.api.RiskDtos.RiskDto;
import com.uav.lowaltitude.modules.risk.application.RiskReadService;
import com.uav.lowaltitude.modules.risk.infrastructure.RiskRepository;
import com.uav.lowaltitude.modules.risk.infrastructure.RiskRepository.RiskRow;
import com.uav.lowaltitude.modules.risk.infrastructure.RiskRepository.VerificationRow;
import com.uav.lowaltitude.platform.api.ApiException;
import com.uav.lowaltitude.platform.audit.AuditService;
import com.uav.lowaltitude.platform.security.AuthContext;
import com.uav.lowaltitude.platform.security.AuthUser;
import com.uav.lowaltitude.platform.time.AppClock;

@Service
public class HandoffSubmissionService {
    private static final Set<String> BODY_FIELDS = Set.of("source_kind", "source_id", "handoff_type", "recipient_id", "expected_version");
    private static final int HISTORY_LIMIT = 1000;
    private final AccessControlService access;
    private final HandoffRepository repository;
    private final RiskRepository risks;
    private final RiskReadService riskRead;
    private final IdempotencyGuard idempotency;
    private final AppClock clock;
    private final AuditService audit;
    private final ObjectMapper objectMapper;
    private final DisposalCompletionPort disposals;

    public HandoffSubmissionService(AccessControlService access, HandoffRepository repository, RiskRepository risks, RiskReadService riskRead,
            IdempotencyGuard idempotency, AppClock clock, AuditService audit, ObjectMapper objectMapper,
            DisposalCompletionPort disposals) {
        this.access = access; this.repository = repository; this.risks = risks; this.riskRead = riskRead;
        this.idempotency = idempotency; this.clock = clock; this.audit = audit; this.objectMapper = objectMapper;
        this.disposals = disposals;
    }

    /**
     * 事务顺序：鉴权 → 解析 → 锁源风险 → claim 幂等键 → 版本/状态/接收方/逻辑唯一检查 → 交接头 + 快照 + 首条投递 + 成功审计。
     * 任何一步失败整体回滚；失败审计由全局异常处理在事务外单独落库，不能放在这里——它会和业务写入一起被回滚而丢失留痕。
     */
    @Transactional
    public CreatedDto create(String rawRequest, String key) {
        // 两个动作权限都先于请求体、ID、对象与幂等解析：缺任一权限统一 403，不给探测 400/404 差异的机会。
        access.require(PermissionCode.HANDOFF_CREATE);
        AccessDecision riskDecision = access.require(PermissionCode.RISK_READ);
        CreateRequest request = parse(rawRequest);
        String sourceId = HandoffReadService.id(request.sourceId());
        String recipientId = HandoffReadService.id(request.recipientId());
        // 前提要拿到 source_id 才能查"这一件事有没有完成的处置授权"，因此排在解析之后（决策 13-6）；
        // 但仍排在 requireKindSupportsType 之前——否则 (RISK, UAV_PUNISHMENT) 会先被判成 400 INVALID_KIND，
        // 而阶段 5 起对这一组合的回答一直是 409 HANDOFF_PREREQUISITE_UNAVAILABLE。改动机制不该改掉既有答复。
        HandoffRules.requirePrerequisite(request.handoffType(), request.sourceKind(), sourceId, disposals);
        HandoffRules.requireKindSupportsType(request.sourceKind(), request.handoffType());
        if (HandoffRules.TYPE_UAV_PUNISHMENT.equals(request.handoffType())) {
            // 前提已经成立（该事件确有完成的处置授权），但**处罚交接的材料包还没有定义**：
            // 现有快照结构（MaterialDto）整套是风险形状——风险字段 + 风险核实历史，装不下无人机事件与授权证据。
            // 与其把事件硬塞进风险字段、或者悄悄落一份空材料，不如在这里明说：
            // 送交公安的材料包含哪些内容是业务决定，不该由实现顺手定下来。
            throw new ApiException(HttpStatus.CONFLICT, "HANDOFF_MATERIALS_NOT_DEFINED",
                    "处罚交接的材料包尚未定义，暂不能提交");
        }
        // 先锁源风险却不改它的状态或版本：锁只用来串行化同一风险的并发提交并冻结版本核对；
        // “已通知”需要真实送达/回执事实，交接提交本身不是风险状态迁移。
        RiskRow risk = risks.lock(sourceId, riskDecision);
        if (risk == null) throw new ApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "源对象不存在或不可见");
        // 幂等键与逻辑唯一同时存在：幂等键只识别“同一个客户端请求的重放”，逻辑唯一才保证“不同人、不同键”对同一事项只落一份交接。
        idempotency.claim(key, operation(request.sourceKind(), sourceId, request.handoffType(), recipientId, request.expectedVersion()));
        if (risk.version() != request.expectedVersion()) throw new ApiException(HttpStatus.CONFLICT, "VERSION_CONFLICT", "风险已被其他操作更新");
        HandoffRules.requireNotifiable(risk.state());
        if (!repository.anyEnabledRecipient(request.handoffType())) {
            throw new ApiException(HttpStatus.CONFLICT, "RECIPIENT_NOT_CONFIGURED", "尚未配置可用的交接接收方");
        }
        RecipientRow recipient = repository.findEnabledRecipient(recipientId, request.handoffType());
        if (recipient == null) throw new ApiException(HttpStatus.NOT_FOUND, "RECIPIENT_NOT_FOUND", "接收方不存在或不可用");
        // 源风险已加锁，这里的预检对同一风险是可靠的；数据库唯一约束仍是最终保障。
        if (repository.logicalExists(request.sourceKind(), sourceId, request.handoffType(), recipientId)) throw alreadyExists();
        OffsetDateTime at = clock.now().atOffset(ZoneOffset.UTC);
        AuthUser actor = AuthContext.require();
        String handoffId = UUID.randomUUID().toString();
        MaterialDto material = material(risk, riskDecision);
        try {
            repository.insertHandoff(new HandoffInsert(handoffId, request.sourceKind(), sourceId, sourceId, null, request.handoffType(),
                    recipientId, risk.version(), risk.ownerOrgId(), risk.districtId(), risk.sourceMode(), actor.userId(), at));
        } catch (DuplicateKeyException ex) {
            throw alreadyExists();
        }
        repository.insertSnapshot(handoffId, HandoffRules.SNAPSHOT_SCHEMA_VERSION, json(material), at);
        // 提交不等于送达：本期没有接通任何通知渠道，首条投递记录只能是待投递并标明阻断原因，送达与回执必须来自后续外部事实。
        repository.insertDelivery(new DeliveryInsert(UUID.randomUUID().toString(), handoffId, 1, HandoffRules.PENDING_DELIVERY,
                HandoffRules.NOT_EXPECTED, HandoffRules.CHANNEL_NOT_CONNECTED, at, null, null, null));
        audit.record(actor.userId(), actor.account(), actor.roleCode(), "handoff", "handoff_created", "handoff", handoffId,
                "source_kind=" + request.sourceKind() + "; source_id=" + sourceId + "; handoff_type=" + request.handoffType()
                        + "; recipient_id=" + recipientId + "; source_version=" + risk.version(), "SUCCESS", "", "");
        return new CreatedDto(handoffId, request.sourceKind(), sourceId, request.handoffType(), recipientId, risk.version(),
                HandoffRules.PENDING_DELIVERY, HandoffRules.NOT_EXPECTED, HandoffRules.CHANNEL_NOT_CONNECTED, at.toInstant().toEpochMilli());
    }

    /** 白名单快照：风险安全字段、核实历史、提交者当时可见的关联引用。没有文件就没有任何文件字段。 */
    private MaterialDto material(RiskRow risk, AccessDecision riskDecision) {
        RiskDto visible = riskRead.dto(risk);
        List<VerificationMaterialDto> history = risks.verifications(risk.riskId(), riskDecision, 0, HISTORY_LIMIT).stream()
                .map(HandoffSubmissionService::verification).toList();
        ReferenceMaterialDto references = new ReferenceMaterialDto(visible.planId(), visible.routeVersionId(), visible.assessmentId(),
                visible.targetId(), visible.trackId());
        RiskMaterialDto material = new RiskMaterialDto(risk.riskId(), risk.sourceRiskId(), risk.riskType(), risk.severity(), risk.state(),
                risk.reasonCode(), risk.reasonText(), risk.occurredAt() == null ? null : risk.occurredAt().toInstant().toEpochMilli(),
                risk.receivedAt().toInstant().toEpochMilli(), risk.version());
        return new MaterialDto(HandoffRules.SNAPSHOT_SCHEMA_VERSION, material, history, empty(references) ? null : references);
    }

    private static boolean empty(ReferenceMaterialDto references) {
        return references.planId() == null && references.routeVersionId() == null && references.assessmentId() == null
                && references.targetId() == null && references.trackId() == null;
    }

    private static VerificationMaterialDto verification(VerificationRow row) {
        return new VerificationMaterialDto(row.conclusion(), row.note(), row.resultingState(), row.version(),
                row.createdAt().toInstant().toEpochMilli(), row.actorId());
    }

    private String json(MaterialDto material) {
        try { return objectMapper.writeValueAsString(material); }
        catch (JsonProcessingException ex) { throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "服务内部错误"); }
    }

    private CreateRequest parse(String rawRequest) {
        if (rawRequest == null || rawRequest.isBlank()) throw invalidRequest();
        try (JsonParser parser = objectMapper.getFactory().createParser(rawRequest)) {
            parser.enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
            JsonNode node = objectMapper.readTree(parser);
            if (node == null || !node.isObject() || parser.nextToken() != null) throw invalidRequest();
            // 夹带 delivery_status/receipt_status/delivered_at 等任何非契约字段：客户端不能自行推进投递或回执。
            node.fieldNames().forEachRemaining(name -> { if (!BODY_FIELDS.contains(name)) throw new ApiException(HttpStatus.BAD_REQUEST, "UNKNOWN_FIELD", "请求体包含未知字段 " + name); });
            if (node.size() != BODY_FIELDS.size()) throw invalidRequest();
            for (String field : new String[]{"source_kind", "source_id", "handoff_type", "recipient_id"}) {
                if (!node.get(field).isTextual()) throw invalidRequest();
            }
            JsonNode version = node.get("expected_version");
            if (!version.isIntegralNumber() || !version.canConvertToLong() || version.longValue() < 0) throw invalidRequest();
            String kind = node.get("source_kind").textValue().trim(), type = node.get("handoff_type").textValue().trim();
            if (!HandoffRules.SOURCE_KINDS.contains(kind)) throw new ApiException(HttpStatus.BAD_REQUEST, "INVALID_KIND", "source_kind 无效");
            if (!HandoffRules.HANDOFF_TYPES.contains(type)) throw invalidRequest();
            return new CreateRequest(kind, node.get("source_id").textValue(), type, node.get("recipient_id").textValue(), version.longValue());
        } catch (java.io.IOException ex) {
            throw invalidRequest();
        }
    }

    private static String operation(String kind, String sourceId, String type, String recipientId, long expected) {
        // 长度前缀序列化：ID 可含分隔符，直接拼接会把不同请求误判为 replay。
        return framed("handoff") + framed(kind) + framed(sourceId) + framed(type) + framed(recipientId) + framed(Long.toString(expected));
    }
    private static String framed(String value) { return value.getBytes(StandardCharsets.UTF_8).length + ":" + value; }
    private static ApiException invalidRequest() { return new ApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "请求体无效"); }
    private static ApiException alreadyExists() { return new ApiException(HttpStatus.CONFLICT, "HANDOFF_ALREADY_EXISTS", "该事项已向此接收方提交过交接"); }
}
