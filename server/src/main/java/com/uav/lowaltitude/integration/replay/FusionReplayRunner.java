package com.uav.lowaltitude.integration.replay;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.integration.replay.FusionReplayDatasetGenerator.Dataset;
import com.uav.lowaltitude.integration.replay.FusionReplayDatasetGenerator.ProtocolDataset;
import com.uav.lowaltitude.integration.replay.FusionReplayDatasetGenerator.ProtocolRecord;
import com.uav.lowaltitude.integration.replay.FusionReplayDatasetGenerator.Record;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusionInboxRepository;

/**
 * 把生成的数据集按 t02 信封写入 inbox_message（status=RECEIVED），供摄取管线消费。
 * 同键同哈希幂等（已写过就跳过），同键不同哈希抛 SOURCE_MESSAGE_CONFLICT——回放数据集一旦发布就不能被悄悄改写。
 * 只在非 production 注册；是否在启动时写入由 app.fusion.replay.run-on-start 决定（默认 false），测试与种子直接调用 {@link #load}。
 */
@Component
@Profile("!production")
public class FusionReplayRunner {
    private static final Logger log = LoggerFactory.getLogger(FusionReplayRunner.class);

    private final FusionReplayDatasetGenerator generator;
    private final FusionReplayReader reader;
    private final FusionInboxRepository inbox;
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;

    public FusionReplayRunner(FusionReplayDatasetGenerator generator, FusionReplayReader reader, FusionInboxRepository inbox, JdbcTemplate jdbc, ObjectMapper json) {
        this.generator = generator; this.reader = reader; this.inbox = inbox; this.jdbc = jdbc; this.json = json;
    }

    /** v2 数据集实际用到的直连前缀（雷达帧由助手的实测端口写入，不由本生成器产出）。 */
    private static final List<String> DIRECT_ACCESS_PREFIXES = List.of("lingyun:", "eo-edge:");

    public record LoadReport(String datasetId, int records, int inserted, int skipped) { }

    /** 生成数据集并写 inbox；返回写入与跳过的条数。 */
    public LoadReport load() {
        Dataset dataset = generator.generate();
        Map<String, String> sourceIds = sourceIdsByCode();
        int inserted = 0, skipped = 0;
        for (Record record : dataset.records()) {
            String sourceId = sourceIds.get(record.sourceCode());
            if (sourceId == null) throw new IllegalStateException("回放来源未登记: " + record.sourceCode());
            String line = envelope(dataset.datasetId(), record);
            FusionReplayReader.Envelope envelope = reader.read(line);
            boolean added = inbox.insertEnvelope(envelope.source(), Long.toString(envelope.recordNo()), envelope.receivedAtMillis(), sourceId,
                    envelope.payloadHash(), envelope.payloadJson());
            if (added) inserted++; else skipped++;
        }
        log.info("fusion replay dataset loaded: dataset={}, records={}, inserted={}, skipped={}", dataset.datasetId(), dataset.records().size(), inserted, skipped);
        return new LoadReport(dataset.datasetId(), dataset.records().size(), inserted, skipped);
    }

    public List<String> ndjson() {
        Dataset dataset = generator.generate();
        List<String> lines = new ArrayList<>();
        for (Record record : dataset.records()) lines.add(envelope(dataset.datasetId(), record));
        return List.copyOf(lines);
    }

    /** 数据集是否已经全部写入 inbox（用于种子跳过判断）。 */
    public boolean alreadyLoaded(String datasetId) {
        return inbox.countBySourcePrefix("replay:") >= generator.generate().records().size();
    }

    // ---------- 阶段 8.5：数据集 v2（直连报文） ----------

    /**
     * 写入直连回放数据集：inbox 的 payload 就是设备原样上报的凌云报文，source 用契约 §2 的前缀，
     * 由 {@code InboxSourceRouter} 决定交给哪个映射器。信封（{@link FusionReplayReader}）仍是 v1 的形状，
     * 只用于归档与哈希复算，不再夹在设备报文与 inbox 之间——夹一层会让"库里存的就是设备发来的原文"这句话不成立。
     */
    public LoadReport loadV2() {
        ProtocolDataset dataset = generator.generateV2();
        Map<String, String> sourceIds = sourceIdsByCode();
        int inserted = 0, skipped = 0;
        for (ProtocolRecord record : dataset.records()) {
            String sourceId = sourceIds.get(record.sourceCode());
            if (sourceId == null) throw new IllegalStateException("回放来源未登记: " + record.sourceCode());
            String payload = payloadJson(record.payload());
            boolean added = inbox.insertEnvelope(record.inboxSource(), Long.toString(record.recordNo()), record.receivedAtMillis(), sourceId,
                    FusionReplayReader.sha256(payload), payload);
            if (added) inserted++; else skipped++;
        }
        log.info("fusion direct-access dataset loaded: dataset={}, records={}, inserted={}, skipped={}",
                dataset.datasetId(), dataset.records().size(), inserted, skipped);
        return new LoadReport(dataset.datasetId(), dataset.records().size(), inserted, skipped);
    }

    /** v2 数据集是否已全部写入：按直连前缀合计计数（回放前缀属于 v1，不计）。 */
    public boolean alreadyLoadedV2() {
        long written = 0;
        for (String prefix : DIRECT_ACCESS_PREFIXES) written += inbox.countBySourcePrefix(prefix);
        return written >= generator.generateV2().records().size();
    }

    /**
     * 规范化报文（字段按字母序）。包内可见供 {@link LingyunMqttReplayExporter} 复用：
     * 导出物的 payload 必须与写进 inbox 的原文逐字一致，两处各写一遍序列化早晚会漂。
     */
    String payloadJson(Map<String, Object> payload) {
        try {
            return json.writer().with(com.fasterxml.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
                    .writeValueAsString(new java.util.TreeMap<>(payload));
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("直连报文无法序列化", ex);
        }
    }

    private Map<String, String> sourceIdsByCode() {
        Map<String, String> out = new LinkedHashMap<>();
        jdbc.query("SELECT source_id, source_code FROM integration_source WHERE source_mode='replay'", rs -> { out.put(rs.getString("source_code"), rs.getString("source_id")); });
        return out;
    }

    private String envelope(String datasetId, Record record) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("source_code", record.sourceCode());
        frame.put("observed_at", record.observedAtMillis());
        frame.put("items", record.items());
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("dataset_id", datasetId);
        root.put("record_no", record.recordNo());
        root.put("received_at", record.receivedAtMillis());
        root.put("frame", frame);
        try {
            String payload = json.writer().with(com.fasterxml.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
                    .writeValueAsString(new java.util.TreeMap<>(root));
            root.put("payload_hash", FusionReplayReader.sha256(payload));
            return json.writeValueAsString(root);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("回放信封无法序列化", ex);
        }
    }
}
