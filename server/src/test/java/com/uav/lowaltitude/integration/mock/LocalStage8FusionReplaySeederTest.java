package com.uav.lowaltitude.integration.mock;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Profiles;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import com.uav.lowaltitude.integration.replay.FusionReplayDatasetGenerator;

/** 阶段 8 种子：test profile 下三来源与回放数据存在、重跑不重复、目标全部 source_mode='replay'。 */
@SpringBootTest(properties = {
        "app.dev-seed.enabled=true", "app.fusion.enabled=false", "app.fusion.replay.run-on-start=false",
        "spring.datasource.url=jdbc:h2:mem:stage8_seed_" + "${random.uuid}" + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("test")
class LocalStage8FusionReplaySeederTest {
    @Autowired JdbcTemplate jdbc;
    @Autowired LocalStage8FusionReplaySeeder seeder;
    @Autowired ApplicationArguments arguments;

    @Test
    void seedsReplaySourcesAndDatasetIdempotently() {
        Map<String, Long> before = counts();
        seeder.run(arguments);
        // 重跑只会跳过已写入的记录，不产生第二份来源、设备、观测或目标。
        assertThat(counts()).isEqualTo(before);

        assertThat(jdbc.queryForList("select source_code from integration_source where source_mode='replay' order by source_code", String.class))
                .contains(FusionReplayDatasetGenerator.EO, FusionReplayDatasetGenerator.RADAR, FusionReplayDatasetGenerator.TDOA);
        // 只断言本种子登记的来源：迁移 040 也有一条 source_mode='replay' 的规则引擎来源（source_type 为空是它的正常状态）。
        assertThat(jdbc.queryForObject("select count(*) from integration_source where source_id like 'seed-stage8-%' and source_type is null", Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from device where device_id like 'seed-stage8-%' and enabled=true", Long.class)).isEqualTo(3L);
        assertThat(jdbc.queryForObject("select count(*) from inbox_message where source like 'replay:%'", Long.class)).isPositive();
        // 摄取完成：没有留下未处理或失败的回放帧。
        assertThat(jdbc.queryForObject("select count(*) from inbox_message where source like 'replay:%' and status<>'DONE'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from source_observation", Long.class)).isPositive();
        assertThat(jdbc.queryForObject("select count(*) from target where unified=true", Long.class)).isPositive();
        // 回放产物全部落在 replay 分区：不得混进 mock/live 的统一目标库。
        assertThat(jdbc.queryForObject("select count(*) from target where unified=true and source_mode<>'replay'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from source_observation where source_mode<>'replay'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from track where layer='RAW' and link_id is null", Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from track_point tp join track t on t.track_id=tp.track_id where t.layer='RAW' and tp.point_kind<>'MEAS'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from target_track_status s join target t on t.target_id=s.target_id where t.source_mode='replay'", Long.class)).isPositive();
        assertThat(jdbc.queryForObject("select count(*) from target_lineage where op='CREATE'", Long.class)).isPositive();
    }

    @Test
    void profileAndPropertyGatesExcludeProductionEvenWhenLocalIsAlsoActive() {
        Profile profile = LocalStage8FusionReplaySeeder.class.getAnnotation(Profile.class);
        ConditionalOnProperty property = LocalStage8FusionReplaySeeder.class.getAnnotation(ConditionalOnProperty.class);
        assertThat(profile).isNotNull();
        Profiles expression = Profiles.of(profile.value());
        assertThat(expression.matches(name -> Set.of("production", "local").contains(name))).isFalse();
        assertThat(expression.matches(name -> Set.of("production").contains(name))).isFalse();
        assertThat(expression.matches(name -> Set.of("test").contains(name))).isTrue();
        assertThat(expression.matches(name -> Set.of("local").contains(name))).isTrue();
        assertThat(property.havingValue()).isEqualTo("true");
        // 回放写入器与适配器同样不在生产注册（生产不生成、不消费回放数据）。
        Profiles runner = Profiles.of(com.uav.lowaltitude.integration.replay.FusionReplayRunner.class.getAnnotation(Profile.class).value());
        assertThat(runner.matches(name -> Set.of("production").contains(name))).isFalse();
        Profiles adapter = Profiles.of(com.uav.lowaltitude.integration.replay.ReplayAdapterPort.class.getAnnotation(Profile.class).value());
        assertThat(adapter.matches(name -> Set.of("production").contains(name))).isFalse();
    }

    @Test
    void replayInboxRowsCarryContractEnvelopeIdentity() {
        String source = jdbc.queryForObject("select source from inbox_message where source like 'replay:%' order by received_at, inbox_id fetch first 1 rows only", String.class);
        assertThat(source).startsWith("replay:").endsWith(":" + FusionReplayDatasetGenerator.DATASET_ID);
        assertThat(jdbc.queryForObject("select count(*) from inbox_message where source like 'replay:%' and (payload_hash is null or source_id is null or payload is null)", Long.class)).isZero();
        assertThat(jdbc.queryForObject("select count(*) from inbox_message where source like 'replay:%' and payload_hash not like '________________________________________________________________'", Long.class)).isZero();
        // ops 的 live-device 行不受影响（本测试库里没有，断言恒为 0 只是守住"融合不碰 ops inbox"这条边界）。
        assertThat(jdbc.queryForObject("select count(*) from inbox_message where source like 'live-device:%' and status='PROCESSING'", Long.class)).isZero();
    }

    private Map<String, Long> counts() {
        return Map.of(
                "integration_source", count("integration_source where source_id like 'seed-stage8-%'"),
                "device", count("device where device_id like 'seed-stage8-%'"),
                "inbox", count("inbox_message where source like 'replay:%'"),
                "observation", count("source_observation"),
                "target", count("target where unified=true"),
                "link", count("target_source_link l join target t on t.target_id=l.target_id where t.unified=true"),
                "track", count("track where layer='RAW'"),
                "lineage", count("target_lineage"));
    }

    private long count(String fromWhere) { return jdbc.queryForObject("select count(*) from " + fromWhere, Long.class); }
}
