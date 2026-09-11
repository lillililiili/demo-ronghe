package com.uav.lowaltitude.modules.handoff.infrastructure;

import java.time.OffsetDateTime;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.handoff.domain.HandoffChannelPort;
import com.uav.lowaltitude.modules.handoff.domain.HandoffRules;

/**
 * local 缺省模拟上级：提交即已送达、已回执，三个时刻各差 1 秒，不发网络请求。
 * 配置了 mock 不等于已对接真实上级接口。
 */
@Component
@ConditionalOnProperty(prefix = "app.handoff", name = "channel", havingValue = "mock")
public class MockSuperiorHandoffChannel implements HandoffChannelPort {
    @Override public boolean simulated() { return true; }

    @Override
    public DeliveryOutcome deliver(HandoffDispatch dispatch) {
        OffsetDateTime submitted = dispatch.at();
        // 本地演示：风险通知一律回"已驱离"，让闭环在演示里走得完（决策 18-14）。
        // 处罚移送没有这个字段——移送的结果是案件办没办，不是驱离与否。
        String result = HandoffRules.TYPE_RISK_NOTICE.equals(dispatch.handoffType()) ? HandoffRules.RECEIPT_DISPERSED : null;
        return new DeliveryOutcome("DELIVERED", "ACKNOWLEDGED", result, null,
                submitted, submitted.plusSeconds(1), submitted.plusSeconds(2));
    }
}
