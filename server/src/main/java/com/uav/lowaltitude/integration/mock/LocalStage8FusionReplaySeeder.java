package com.uav.lowaltitude.integration.mock;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Profile;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import com.uav.lowaltitude.integration.replay.FusionReplayDatasetGenerator;
import com.uav.lowaltitude.integration.replay.FusionReplayRunner;
import com.uav.lowaltitude.integration.replay.FusionReplayRunner.LoadReport;
import com.uav.lowaltitude.modules.fusion.application.FusionPipeline;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusionInboxRepository;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusionInboxRepository.InboxRow;

/**
 * 阶段 8 回放夹具（双门禁：!production 且 local/test，且 app.dev-seed.enabled=true）：
 * 登记三个合成来源与其设备，写入回放 inbox，然后同步跑完管线（不依赖 Worker 调度，测试与本地启动都能立刻看到融合结果）。
 * 全部 source_mode='replay'：生产不生成回放数据，也不会把回放目标混进实测统一目标库。
 * 已写过同一数据集就跳过：重启不重复摄取，也不覆盖任何已有目标或人工修订。
 */
@Component
@Profile("!production & (local | test)")
@ConditionalOnProperty(prefix = "app.dev-seed", name = "enabled", havingValue = "true")
@Order(75)
public class LocalStage8FusionReplaySeeder implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(LocalStage8FusionReplaySeeder.class);
    public static final String ORG = stableId("demo-org:platform");
    public static final String DISTRICT = stableId("demo-district:dongying");
    public static final List<SourceSeed> SOURCES = List.of(
            new SourceSeed(FusionReplayDatasetGenerator.RADAR, "RADAR", "阶段八回放雷达", "seed-stage8-source-radar", "seed-stage8-device-radar", "DEV-STAGE8-RADAR-001"),
            new SourceSeed(FusionReplayDatasetGenerator.TDOA, "TDOA", "阶段八回放 TDOA", "seed-stage8-source-tdoa", "seed-stage8-device-tdoa", "DEV-STAGE8-TDOA-001"),
            new SourceSeed(FusionReplayDatasetGenerator.EO, "EO", "阶段八回放光电", "seed-stage8-source-eo", "seed-stage8-device-eo", "DEV-STAGE8-EO-001"));
    private static final Timestamp CREATED_AT = Timestamp.from(Instant.parse("2026-09-05T00:00:00Z"));

    private final JdbcTemplate jdbc;
    private final FusionReplayRunner runner;
    private final FusionInboxRepository inbox;
    private final FusionPipeline pipeline;

    public LocalStage8FusionReplaySeeder(JdbcTemplate jdbc, FusionReplayRunner runner, FusionInboxRepository inbox, FusionPipeline pipeline) {
        this.jdbc = jdbc; this.runner = runner; this.inbox = inbox; this.pipeline = pipeline;
    }

    public record SourceSeed(String sourceCode, String sourceType, String name, String sourceId, String deviceId, String deviceNo) { }

    @Override
    @Transactional
    public void run(ApplicationArguments args) {
        ensureScope();
        SOURCES.forEach(this::ensureSource);
        LoadReport report = runner.load();
        int frames = drain();
        log.info("stage 8 replay seed: records={}, inserted={}, skipped={}, frames processed={}", report.records(), report.inserted(), report.skipped(), frames);
    }

    /** 同步跑完所有待处理回放帧；每帧一次调用，失败帧记 FAILED 后继续（与 Worker 行为一致）。 */
    public int drain() {
        int processed = 0;
        for (int round = 0; round < 1000; round++) {
            List<InboxRow> rows = inbox.claim(System.currentTimeMillis(), 50, 30_000L);
            if (rows.isEmpty()) return processed;
            for (InboxRow row : rows) {
                try {
                    pipeline.processFrame(row);
                    inbox.done(row.inboxId(), System.currentTimeMillis());
                    processed++;
                } catch (RuntimeException ex) {
                    String reason = ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage();
                    inbox.fail(row.inboxId(), System.currentTimeMillis(), reason.length() > 1000 ? reason.substring(0, 1000) : reason);
                    throw ex;
                }
            }
        }
        return processed;
    }

    private void ensureScope() {
        jdbc.update("insert into app_org (org_id,org_code,name,enabled,created_at,updated_at,version) select ?,?,?,true,0,0,0 where not exists (select 1 from app_org where org_id=?)",
                ORG, "DEMO-PLATFORM", "演示平台机构", ORG);
        jdbc.update("insert into app_district (district_id,district_code,name,enabled,created_at,updated_at,version) select ?,?,?,true,0,0,0 where not exists (select 1 from app_district where district_id=?)",
                DISTRICT, "DEMO-DONGYING", "东营演示区域", DISTRICT);
    }

    private void ensureSource(SourceSeed seed) {
        jdbc.update("insert into integration_source (source_id,source_code,name,protocol_code,protocol_version,enabled,source_mode,source_type,created_at,updated_at,version)"
                + " select ?,?,?,null,null,true,'replay',?,?,?,0 where not exists (select 1 from integration_source where source_id=?)",
                seed.sourceId(), seed.sourceCode(), seed.name(), seed.sourceType(), CREATED_AT, CREATED_AT, seed.sourceId());
        // 已存在的来源补上类型：迁移 050 新增该列时旧行为 NULL，融合需要它来取缺省精度与权重。
        jdbc.update("update integration_source set source_type=? where source_id=? and source_type is null", seed.sourceType(), seed.sourceId());
        jdbc.update("insert into device (device_id,source_id,external_device_id,device_no,name,device_type_code,enabled,source_mode,owner_org_id,district_id,created_at,updated_at,version)"
                + " select ?,?,?,?,?,?,true,'replay',?,?,?,?,0 where not exists (select 1 from device where device_id=?)",
                seed.deviceId(), seed.sourceId(), "external-" + seed.sourceCode(), seed.deviceNo(), seed.name(), seed.sourceType(), ORG, DISTRICT, CREATED_AT, CREATED_AT, seed.deviceId());
    }

    private static String stableId(String value) { return UUID.nameUUIDFromBytes(value.getBytes(StandardCharsets.UTF_8)).toString(); }
}
