package com.uav.lowaltitude.modules.fusion.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import com.uav.lowaltitude.modules.fusion.FusionContracts.FusedLayerWriter;
import com.uav.lowaltitude.modules.fusion.FusionContracts.FusionDomainKey;
import com.uav.lowaltitude.modules.fusion.FusionContracts.PointKind;
import com.uav.lowaltitude.modules.fusion.FusionContracts.SourceEstimate;
import com.uav.lowaltitude.modules.fusion.FusionContracts.TargetFrameResult;
import com.uav.lowaltitude.modules.fusion.FusionContracts.TrackStatus;

/**
 * 阶段 8.5（决策 8.5-5）：飞手位置取"身份主源"的 pilot 字段落 target_latest_state.pilot_location。
 * C02-6 要的是目标级飞手位置，而只有身份类来源（TDOA/DCD/RID）带这个字段；
 * 取任意来源会把别的传感器的站址当成飞手位置，缺失时也绝不补 (0,0)。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class DefaultFusedLayerWriterPilotLocationTest {

    private static final String TARGET = "seed-target-uav-wgs84";      // 阶段 2 种子目标（mock 分区）
    private static final String SOURCE = "seed-stage2-source-mock";    // 阶段 2 种子来源
    private static final String LINK = "seed-link-uav-001";
    private static final FusionDomainKey DOMAIN = new FusionDomainKey("mock", null, null);

    @Autowired FusedLayerWriter writer;
    @Autowired JdbcTemplate jdbc;

    @Test
    void identityPrimarySourcePilotPositionLandsInLatestState() {
        Instant t0 = Instant.parse("2026-09-06T01:00:00Z");
        writer.write(new TargetFrameResult(TARGET, DOMAIN, t0, List.of(estimate(t0, 118.60, 37.40)), TrackStatus.STABLE, 0, "demo-v1"));
        assertThat(pilotLocation()).contains("118.6").contains("37.4");

        // 同一目标的下一帧没有飞手位置：写 NULL，而不是留着上一帧的旧位置冒充现在的飞手所在。
        Instant t1 = t0.plusSeconds(20);
        writer.write(new TargetFrameResult(TARGET, DOMAIN, t1, List.of(estimate(t1, null, null)), TrackStatus.STABLE, 0, "demo-v1"));
        assertThat(pilotLocation()).isNull();
    }

    private String pilotLocation() {
        Object value = jdbc.queryForMap("select cast(pilot_location as varchar) as pilot from target_latest_state where target_id=?", TARGET).get("pilot");
        return value == null ? null : String.valueOf(value);
    }

    /** 身份主源：唯一来源即身份主源，携带（或不携带）飞手位置。 */
    private static SourceEstimate estimate(Instant at, Double pilotLon, Double pilotLat) {
        return new SourceEstimate(SOURCE, SOURCE, "TDOA", "CONFIRMED", LINK, null, null, at,
                118.5, 37.4, 15.0, 120.0, null, 8.0, 90.0, "UAV", null, "SN-8501", 0.9, PointKind.MEAS, Map.of(),
                pilotLon, pilotLat, "SENSE_DATA");
    }
}
