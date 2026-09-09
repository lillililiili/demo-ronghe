package com.uav.lowaltitude.modules.handoff.infrastructure;

import java.time.OffsetDateTime;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.handoff.domain.HandoffChannelPort;

/**
 * local 缺省模拟上级：提交即已送达、已回执，三个时刻各差 1 秒，不发网络请求。
 * 配置了 mock 不等于已对接真实上级接口。
 */
@Component
@ConditionalOnProperty(prefix = "app.handoff", name = "channel", havingValue = "mock")
public class MockSuperiorHandoffChannel implements HandoffChannelPort {

    @Override
    public DeliveryOutcome deliver(HandoffDispatch dispatch) {
        OffsetDateTime submitted = dispatch.at();
        return new DeliveryOutcome("DELIVERED", "ACKNOWLEDGED", null,
                submitted, submitted.plusSeconds(1), submitted.plusSeconds(2));
    }
}
