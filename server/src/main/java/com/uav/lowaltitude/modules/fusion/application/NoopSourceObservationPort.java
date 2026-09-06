package com.uav.lowaltitude.modules.fusion.application;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.fusion.FusionContracts.SourceObservationPort;

/**
 * 实测雷达 ops → 阶段 2 提升的预留入口（决策 8-1：本阶段不实现）。
 * app.fusion.live-promotion.enabled=false 时任何调用都只记日志并丢弃，绝不把 ops 模型的数据写进统一目标库。
 */
@Component
public class NoopSourceObservationPort implements SourceObservationPort {
    private static final Logger log = LoggerFactory.getLogger(NoopSourceObservationPort.class);
    private final FusionProperties properties;

    public NoopSourceObservationPort(FusionProperties properties) { this.properties = properties; }

    @Override
    public void accept(List<Map<String, Object>> observations) {
        if (properties.getLivePromotion().isEnabled()) {
            throw new IllegalStateException("app.fusion.live-promotion.enabled=true 但实测提升尚未实现（决策 8-1）");
        }
        if (observations != null && !observations.isEmpty()) log.debug("live promotion disabled; dropped {} observations", observations.size());
    }
}
