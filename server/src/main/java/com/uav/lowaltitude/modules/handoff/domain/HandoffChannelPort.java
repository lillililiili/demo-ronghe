package com.uav.lowaltitude.modules.handoff.domain;

import java.time.OffsetDateTime;

/**
 * 交接投递渠道。提交服务只消费返回的投递/回执事实，不在这里发网络请求的语义之外再改交接状态。
 * 决策 15-52：缺省 none 保持“待投递 · 未接通”；local mock 不发真实上级请求。
 */
public interface HandoffChannelPort {

    DeliveryOutcome deliver(HandoffDispatch dispatch);

    record HandoffDispatch(String handoffId, String sourceKind, String sourceId, String handoffType,
                           String recipientId, String recipientName, String snapshot, OffsetDateTime at) { }

    record DeliveryOutcome(String deliveryStatus, String receiptStatus, String blockedReason,
                           OffsetDateTime submittedAt, OffsetDateTime deliveredAt, OffsetDateTime acknowledgedAt) {
        public static DeliveryOutcome notConnected() {
            return new DeliveryOutcome(HandoffRules.PENDING_DELIVERY, HandoffRules.NOT_EXPECTED,
                    HandoffRules.CHANNEL_NOT_CONNECTED, null, null, null);
        }
    }
}
