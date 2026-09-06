package com.uav.lowaltitude.modules.handoff.api;

import java.util.List;

public final class HandoffDtos {
    private HandoffDtos() { }

    public record PageDto<T>(List<T> items, int page, int size, long total) { }
    public record RecipientDto(String recipientId, String displayName, String handoffType) { }
    public record RecipientListDto(List<RecipientDto> items) { }
    public record CreateRequest(String sourceKind, String sourceId, String handoffType, String recipientId, long expectedVersion) { }
    /** POST 成功体固定为契约列出的字段；提交成功只代表材料入库，delivery_status 只可能是 PENDING_DELIVERY。 */
    public record CreatedDto(String handoffId, String sourceKind, String sourceId, String handoffType, String recipientId,
            long sourceVersion, String deliveryStatus, String receiptStatus, String blockedReason, long createdAt) { }
    public record HandoffDto(String handoffId, String sourceKind, String sourceId, String handoffType, String recipientId,
            String recipientName, long sourceVersion, String ownerOrgId, String districtId, String sourceMode, String submittedBy,
            long createdAt, String deliveryStatus, String receiptStatus, String blockedReason,
            String ownerOrgName, String districtName, String submittedByName, String sourceNo) { }
    public record DeliveryDto(String deliveryId, String handoffId, int attemptNo, String deliveryStatus, String receiptStatus,
            String blockedReason, long createdAt, Long submittedAt, Long deliveredAt, Long acknowledgedAt) { }
    public record HandoffDetailDto(String handoffId, String sourceKind, String sourceId, String handoffType, String recipientId,
            String recipientName, long sourceVersion, String ownerOrgId, String districtId, String sourceMode, String submittedBy,
            long createdAt, String deliveryStatus, String receiptStatus, String blockedReason, MaterialDto material,
            DeliveryDto latestDelivery, AvailabilityDto availability,
            String ownerOrgName, String districtName, String submittedByName, String sourceNo) { }
    /** material：AVAILABLE / FORBIDDEN（读者缺 risk:read）/ SOURCE_NOT_VISIBLE（源风险已不在读者可见范围）。 */
    public record AvailabilityDto(String material) { }

    /* 材料快照 schema_version=1：只冻结白名单结构化字段。没有文件就没有文件名、哈希或下载链接字段。 */
    public record MaterialDto(int schemaVersion, RiskMaterialDto risk, List<VerificationMaterialDto> verifications,
            ReferenceMaterialDto references) { }
    public record RiskMaterialDto(String riskId, String sourceRiskId, String riskType, String severity, String state,
            String reasonCode, String reasonText, Long occurredAt, long receivedAt, long version) { }
    public record VerificationMaterialDto(String conclusion, String note, String resultingState, long version, long createdAt,
            String actorId) { }
    /** 只记录提交当时操作者可见的关联引用；读取时再按当前权限裁剪，不可见的字段直接省略。 */
    public record ReferenceMaterialDto(String planId, String routeVersionId, String assessmentId, String targetId, String trackId) { }
}
