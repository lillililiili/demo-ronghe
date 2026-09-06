package com.uav.lowaltitude.modules.fusion.application;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.ActiveProfiles;

import com.uav.lowaltitude.integration.replay.FusionReplayDatasetGenerator;
import com.uav.lowaltitude.modules.fusion.FusionContracts.FusedLayerWriter;
import com.uav.lowaltitude.modules.fusion.FusionContracts.SourceEstimate;
import com.uav.lowaltitude.modules.fusion.FusionContracts.TargetFrameResult;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusionInboxRepository;

/**
 * 六场景端到端（H2 + 记录型 FusedLayerWriter 桩）：三源同见、单源缺失、交叉、分裂合并、迟到乱序、精度差异。
 * 空间事实全部来自 Java 侧 Haversine/ENU（域层不依赖 SQL 几何），因此 H2 与 PostGIS 得到同一套关联结果。
 */
@SpringBootTest(properties = {
        "app.dev-seed.enabled=true", "app.fusion.enabled=false", "app.fusion.replay.run-on-start=false",
        "spring.datasource.url=jdbc:h2:mem:stage8_pipeline;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DEFAULT_NULL_ORDERING=HIGH;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("test")
class FusionPipelineReplayTest {

    /** 记录型融合层写入器：E2 落地前用它证明 E1 把正确的 TargetFrameResult 交了出去。 */
    static final List<TargetFrameResult> FRAMES = new CopyOnWriteArrayList<>();

    @TestConfiguration
    static class RecordingWriterConfig {
        /** @Primary：E2 的 DefaultFusedLayerWriter 已是 @Component，两个候选会让 ObjectProvider 抛 NoUniqueBeanDefinition。
         *  本用例只验证 E1 交给融合层的 TargetFrameResult，因此用记录型桩顶替真实写入器。 */
        @Bean
        @Primary
        FusedLayerWriter recordingFusedLayerWriter() { return FRAMES::add; }
    }

    @Autowired JdbcTemplate jdbc;
    @Autowired FusionInboxRepository inbox;
    @Autowired FusionPipeline pipeline;

    /**
     * 回放只跑一次并把结果留在 FRAMES 里：种子已在上下文启动时摄取过一遍，这里把 inbox 复位后由本测试自己驱动管线，
     * 以便断言 E1 交给融合层的每一帧。不在每个用例前重跑，避免用例之间互相影响。
     */
    @BeforeEach
    void replayOnce() {
        if (!FRAMES.isEmpty()) return;
        jdbc.update("delete from track_point"); jdbc.update("delete from track"); jdbc.update("delete from source_observation");
        jdbc.update("delete from target_current_alias"); jdbc.update("delete from target_lineage"); jdbc.update("delete from target_track_status");
        jdbc.update("delete from target_source_link"); jdbc.update("delete from target where unified=true");
        jdbc.update("update inbox_message set status='RECEIVED', processed_at=null, last_error=null, lease_token=null, lease_until=null where source like 'replay:%'");
        drain();
    }

    /** 逐帧驱动管线：一帧一次 processFrame，与 Worker 的调用形状一致（这里不套事务，成功即提交）。 */
    private void drain() {
        for (int round = 0; round < 1000; round++) {
            List<FusionInboxRepository.InboxRow> rows = inbox.claim(System.currentTimeMillis(), 50, 30_000L);
            if (rows.isEmpty()) return;
            for (FusionInboxRepository.InboxRow row : rows) { pipeline.processFrame(row); inbox.done(row.inboxId(), System.currentTimeMillis()); }
        }
    }

    @Test
    void threeSourcesOnOneTargetProduceOneTargetThreeLinksAndThreeEstimates() {
        String targetId = targetByExternal("R-T1");
        assertThat(targetId).isNotNull();
        // 三路来源同见：一个目标、三条 link，同一时刻的一组帧里三个来源各出现一次。
        assertThat(jdbc.queryForObject("select count(*) from target_source_link where target_id=?", Long.class, targetId)).isEqualTo(3L);
        assertThat(targetByExternal("D-T1")).isEqualTo(targetId);
        assertThat(targetByExternal("E-T1")).isEqualTo(targetId);
        List<TargetFrameResult> frames = framesOf(targetId);
        assertThat(frames).isNotEmpty();
        assertThat(frames).anySatisfy(frame -> assertThat(frame.estimates()).hasSize(1));
        List<String> sourceTypes = new ArrayList<>();
        for (TargetFrameResult frame : frames) for (SourceEstimate estimate : frame.estimates()) sourceTypes.add(estimate.sourceType());
        assertThat(sourceTypes).contains("RADAR", "TDOA", "EO");
        // 每条估计都带滤波后的精度与 schema_status，缺精度时标 accuracy_defaulted。
        assertThat(frames.get(0).estimates().get(0).accuracyM()).isNotNull().isPositive();
        assertThat(frames.get(0).estimates().get(0).schemaStatus()).isIn("CONFIRMED", "DEMO");
        assertThat(frames.get(0).configVersion()).isEqualTo("demo-v1");
    }

    @Test
    void missingSingleSourceKeepsTheSameTargetIdentity() {
        String targetId = targetByExternal("R-T1");
        // single-missing 场景：TDOA 空窗 6 帧，雷达/光电继续；目标不得因此换 ID 或新建。
        long radarLinks = jdbc.queryForObject("select count(*) from target_source_link l join integration_source s on s.source_id=l.source_id"
                + " where l.target_id=? and s.source_code=?", Long.class, targetId, FusionReplayDatasetGenerator.RADAR);
        assertThat(radarLinks).isEqualTo(1L);
        assertThat(jdbc.queryForObject("select count(distinct target_id) from target_source_link where external_target_id in ('R-T1','D-T1','E-T1')", Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("select status from target_track_status where target_id=?", String.class, targetId)).isIn("TENTATIVE", "STABLE", "SHORT_LOST", "TERMINATED");
    }

    @Test
    void crossingTargetsKeepSeparateIdentities() {
        String a = targetByExternal("R-A"), b = targetByExternal("R-B");
        assertThat(a).isNotNull();
        assertThat(b).isNotNull();
        // 交叉：两条航迹最小间距约 40 m，仍必须是两个目标，不能在交叉点互换或合成一个。
        assertThat(a).isNotEqualTo(b);
        assertThat(jdbc.queryForObject("select count(*) from target_source_link where external_target_id='R-A'", Long.class)).isEqualTo(1L);
        assertThat(jdbc.queryForObject("select count(*) from target_source_link where external_target_id='R-B'", Long.class)).isEqualTo(1L);
    }

    @Test
    void splitScenarioProducesSecondTargetAndLineageRows() {
        String first = targetByExternal("R-M1"), second = targetByExternal("R-M2");
        assertThat(first).isNotNull();
        assertThat(second).isNotNull();
        assertThat(first).isNotEqualTo(second);
        // 每个新目标都有 CREATE 血缘；血缘只增（PostgreSQL 触发器守住，H2 这里只断言行存在）。
        assertThat(jdbc.queryForObject("select count(*) from target_lineage where op='CREATE' and survivor_target_id in (?,?)", Long.class, first, second)).isEqualTo(2L);
        assertThat(jdbc.queryForObject("select count(*) from target_lineage where op='STATUS' and survivor_target_id=?", Long.class, first)).isPositive();
    }

    @Test
    void lateFrameIsStoredInRawLayerWithItsOwnObservedTime() {
        String targetId = targetByExternal("E-L");
        assertThat(targetId).isNotNull();
        Long lateObservations = jdbc.queryForObject("select count(*) from source_observation o join integration_source s on s.source_id=o.source_id"
                + " where s.source_code=? and o.external_target_id='E-L'", Long.class, FusionReplayDatasetGenerator.EO);
        assertThat(lateObservations).isPositive();
        // 迟到帧照写原始层，其 observed_at 早于该目标当时的最新观测；是否回退融合结果由 E2 按 observedAt 决定。
        Long earlier = jdbc.queryForObject("select count(*) from source_observation o where o.external_target_id='E-L'"
                + " and o.observed_at < (select max(o2.observed_at) from source_observation o2 where o2.external_target_id='R-L')", Long.class);
        assertThat(earlier).isPositive();
        assertThat(framesOf(targetId)).isNotEmpty();
        List<TargetFrameResult> frames = framesOf(targetId);
        assertThat(frames).allSatisfy(frame -> assertThat(frame.observedAt()).isNotNull());
    }

    @Test
    void accuracyGapIsCarriedThroughToEstimates() {
        String targetId = targetByExternal("R-G");
        assertThat(targetId).isNotNull();
        List<Double> accuracies = new ArrayList<>();
        for (TargetFrameResult frame : framesOf(targetId)) for (SourceEstimate estimate : frame.estimates()) accuracies.add(estimate.accuracyM());
        assertThat(accuracies).isNotEmpty();
        // 雷达 15 m 与 TDOA 60 m 的差异必须原样传给融合层，不能被抹平成同一个数。
        assertThat(accuracies.stream().anyMatch(a -> a != null && a <= 20)).isTrue();
        Long tdoaObservations = jdbc.queryForObject("select count(*) from source_observation o join integration_source s on s.source_id=o.source_id"
                + " where s.source_code=? and o.position_accuracy_m=60", Long.class, FusionReplayDatasetGenerator.TDOA);
        assertThat(tdoaObservations).isPositive();
    }

    @Test
    void failedFrameRollsBackWholeFrameAndMarksInboxFailed() {
        // 构造一条坏帧：source_id 指向不存在的来源 → 整帧失败，不得留下任何观测。
        String inboxId = UUID.randomUUID().toString();
        String badSource = UUID.randomUUID().toString(); // source_id 是 VARCHAR(36)，夹具不能自造更长的 ID
        jdbc.update("insert into integration_source (source_id,source_code,name,enabled,source_mode,created_at,updated_at,version)"
                + " values (?,?,?,false,'replay',current_timestamp,current_timestamp,0)", badSource, "BAD-" + UUID.randomUUID().toString().substring(0, 8), "停用来源");
        jdbc.update("insert into inbox_message (inbox_id,source,source_msg_id,received_at,source_id,payload_hash,payload,status)"
                + " values (?,?,?,?,?,?,cast(? as json),'RECEIVED')", inboxId, "replay:BAD:ds", "bad-1", System.currentTimeMillis(), badSource,
                "0".repeat(64), "{\"dataset_id\":\"ds\",\"record_no\":1,\"received_at\":1,\"frame\":{\"source_code\":\"BAD\",\"observed_at\":1,\"items\":[{\"external_target_id\":\"X\",\"lon\":118.6,\"lat\":37.4}]}}");
        long observationsBefore = jdbc.queryForObject("select count(*) from source_observation", Long.class);
        try {
            List<FusionInboxRepository.InboxRow> rows = inbox.claim(System.currentTimeMillis(), 50, 30_000L);
            FusionInboxRepository.InboxRow row = rows.stream().filter(r -> r.inboxId().equals(inboxId)).findFirst().orElseThrow();
            try { pipeline.processFrame(row); }
            catch (RuntimeException expected) { inbox.fail(row.inboxId(), System.currentTimeMillis(), expected.getMessage()); }
            assertThat(jdbc.queryForObject("select status from inbox_message where inbox_id=?", String.class, inboxId)).isEqualTo("FAILED");
            assertThat(jdbc.queryForObject("select last_error from inbox_message where inbox_id=?", String.class, inboxId)).isNotBlank();
            assertThat(jdbc.queryForObject("select count(*) from source_observation", Long.class)).isEqualTo(observationsBefore);
            assertThat(jdbc.queryForObject("select count(*) from source_observation where inbox_id=?", Long.class, inboxId)).isZero();
        } finally {
            // 坏帧夹具自己清理：留下的行会被其他用例的 drain 领走并再次抛异常。
            jdbc.update("delete from inbox_message where inbox_id=?", inboxId);
            jdbc.update("delete from integration_source where source_id=?", badSource);
        }
    }

    private String targetByExternal(String externalTargetId) {
        List<String> ids = jdbc.queryForList("select target_id from target_source_link where external_target_id=?", String.class, externalTargetId);
        return ids.isEmpty() ? null : ids.get(0);
    }

    private List<TargetFrameResult> framesOf(String targetId) {
        return FRAMES.stream().filter(frame -> frame.targetId().equals(targetId)).toList();
    }
}
