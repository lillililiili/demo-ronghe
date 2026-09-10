package com.uav.lowaltitude.modules.handoff.infrastructure;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;

import org.junit.jupiter.api.Test;

import com.uav.lowaltitude.modules.handoff.domain.HandoffChannelPort.DeliveryOutcome;
import com.uav.lowaltitude.modules.handoff.domain.HandoffChannelPort.HandoffDispatch;
import com.uav.lowaltitude.modules.handoff.domain.HandoffRules;

/** 决策 15-52：模拟上级接口必须立即"已送达 · 已回执"，未接通渠道必须保持"待投递 · 未接通"。 */
class MockSuperiorHandoffChannelTest {
    private final OffsetDateTime at = OffsetDateTime.of(2026, 9, 8, 12, 0, 0, 0, ZoneOffset.UTC);
    private final HandoffDispatch dispatch = new HandoffDispatch("h-1", "RISK", "r-1", "RISK_NOTICE", "rcpt-1", "民航监管部门", "{}", at);

    @Test
    void mockChannelDeliversAndAcknowledgesImmediately() {
        DeliveryOutcome outcome = new MockSuperiorHandoffChannel().deliver(dispatch);
        assertThat(outcome.deliveryStatus()).isEqualTo("DELIVERED");
        assertThat(outcome.receiptStatus()).isEqualTo("ACKNOWLEDGED");
        assertThat(outcome.blockedReason()).isNull();
        assertThat(outcome.submittedAt()).isEqualTo(at);
        assertThat(outcome.deliveredAt()).isEqualTo(at.plusSeconds(1));
        assertThat(outcome.acknowledgedAt()).isEqualTo(at.plusSeconds(2));
        assertThat(HandoffRules.DELIVERY_STATUSES).contains(outcome.deliveryStatus());
        assertThat(HandoffRules.RECEIPT_STATUSES).contains(outcome.receiptStatus());
    }

    @Test
    void noChannelStaysPendingWithBlockedReason() {
        DeliveryOutcome outcome = new NoHandoffChannel().deliver(dispatch);
        assertThat(outcome.deliveryStatus()).isEqualTo(HandoffRules.PENDING_DELIVERY);
        assertThat(outcome.receiptStatus()).isEqualTo(HandoffRules.NOT_EXPECTED);
        assertThat(outcome.blockedReason()).isEqualTo(HandoffRules.CHANNEL_NOT_CONNECTED);
        assertThat(outcome.deliveredAt()).isNull();
    }
}
