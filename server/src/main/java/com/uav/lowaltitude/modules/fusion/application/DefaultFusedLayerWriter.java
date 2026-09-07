package com.uav.lowaltitude.modules.fusion.application;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.stereotype.Component;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.modules.fusion.FusionContracts.FusedLayerWriter;
import com.uav.lowaltitude.modules.fusion.FusionContracts.FusionParams;
import com.uav.lowaltitude.modules.fusion.FusionContracts.PointKind;
import com.uav.lowaltitude.modules.fusion.FusionContracts.SourceEstimate;
import com.uav.lowaltitude.modules.fusion.FusionContracts.TargetFrameResult;
import com.uav.lowaltitude.modules.fusion.FusionContracts.TrackStatus;
import com.uav.lowaltitude.modules.fusion.domain.AttributeSelector.UnknownField;
import com.uav.lowaltitude.modules.fusion.domain.DegradationEvaluator;
import com.uav.lowaltitude.modules.fusion.domain.DegradationEvaluator.Degradation;
import com.uav.lowaltitude.modules.fusion.domain.WeightedFuser;
import com.uav.lowaltitude.modules.fusion.domain.WeightedFuser.Contribution;
import com.uav.lowaltitude.modules.fusion.domain.WeightedFuser.FusedState;
import com.uav.lowaltitude.modules.fusion.infrastructure.DegradationRepository;
import com.uav.lowaltitude.modules.fusion.infrastructure.DegradationRepository.DegradationRow;
import com.uav.lowaltitude.modules.fusion.infrastructure.DegradationRepository.SelectionRow;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusedTrackRepository;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusedTrackRepository.FusedPoint;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusedTrackRepository.FusedTrackRow;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusedTrackRepository.LastPoint;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusedTrackRepository.LatestState;
import com.uav.lowaltitude.platform.time.AppClock;

/**
 * 融合层写入（E1 在管线第 ⑥ 步、在它自己的一帧事务内调用；这里不开事务）。
 * 一帧一个目标：属性优选 + 加权融合 → 降级评估 → FUSED 层 track/track_point → target_latest_state →
 * target_attribute_selection / target_degradation → fusion_event。不递增 target.version（决策 8-6）。
 */
@Component
public class DefaultFusedLayerWriter implements FusedLayerWriter {
    private static final int COORD_SCALE = 7, METRIC_SCALE = 2, CONF_SCALE = 5, SPEED_SCALE = 3;
    private final WeightedFuser fuser = new WeightedFuser();
    private final DegradationEvaluator degradations = new DegradationEvaluator();
    private final FusionConfigService config;
    private final FusedTrackRepository tracks;
    private final DegradationRepository states;
    private final FusionEventEmitter events;
    private final AppClock clock;
    private final ObjectMapper json;

    public DefaultFusedLayerWriter(FusionConfigService config, FusedTrackRepository tracks, DegradationRepository states, FusionEventEmitter events, AppClock clock, ObjectMapper json) {
        this.config = config; this.tracks = tracks; this.states = states; this.events = events; this.clock = clock; this.json = json;
    }

    @Override
    public void write(TargetFrameResult frame) {
        FusionParams params = config.params(frame.configVersion());
        OffsetDateTime observedAt = frame.observedAt().atOffset(ZoneOffset.UTC);
        OffsetDateTime now = clock.now().atOffset(ZoneOffset.UTC);
        SelectionRow previousSelection = states.findSelection(frame.targetId());
        DegradationRow previousDegradation = states.findDegradation(frame.targetId());
        List<SourceEstimate> estimates = frame.estimates() == null ? List.of() : frame.estimates();
        FusedState fused = fuser.fuse(estimates, params, previousSelection == null ? null : previousSelection.positionSourceId());
        Degradation degradation = degradations.evaluate(estimates, frame.missFrames(), previousDegradation == null ? null : previousDegradation.deficit().doubleValue(), params);

        // 迟到帧：观测时刻早于已落库的最新状态时，只补融合层历史点，不回退 latest_state / 属性优选 / 降级——
        // 页面与告警看到的“当前状态”必须单调向前，否则乱序到达会让目标在地图上倒退。
        OffsetDateTime latestObserved = tracks.latestStateObservedAt(frame.targetId());
        boolean late = latestObserved != null && observedAt.isBefore(latestObserved);

        FusedTrackRow track = openTrack(frame, observedAt, now, params);
        writePoint(frame, track, fused, degradation, observedAt, now, params);
        if (late) return;
        // 关闭融合轨迹放在迟到判定之后：迟到的 TERMINATED 帧若用更早的 observed_at 关掉当前轨迹，
        // 下一帧就会另开一条 fused:<target>:<ms>，融合层被切成碎片（审查建议）。
        if (frame.status() == TrackStatus.TERMINATED) tracks.endTrack(track.trackId(), observedAt);

        boolean manualOverride = previousSelection != null && previousSelection.manualClassOverride();
        writeLatestState(frame, track, fused, degradation, manualOverride, previousSelection, observedAt, now);
        writeSelection(frame, fused, manualOverride, previousSelection, observedAt, now, params);
        writeDegradation(frame, degradation, previousDegradation, observedAt, now);
        emitEvents(frame, degradation, previousDegradation, track, observedAt);
    }

    private FusedTrackRow openTrack(TargetFrameResult frame, OffsetDateTime observedAt, OffsetDateTime now, FusionParams params) {
        FusedTrackRow open = tracks.findOpenTrack(frame.targetId());
        if (open != null) return open;
        String trackId = UUID.randomUUID().toString();
        String external = "fused:" + frame.targetId() + ":" + observedAt.toInstant().toEpochMilli();
        tracks.insertTrack(trackId, frame.targetId(), external, observedAt, params.configVersion(), now);
        return new FusedTrackRow(trackId, frame.targetId(), external, observedAt, null, params.configVersion());
    }

    /** 有位置的实测/桥接帧写 MEAS/BRIDGE；无源帧在 pred_max_frames 内写 PRED（位置保留最后可信点，不外推）。 */
    private void writePoint(TargetFrameResult frame, FusedTrackRow track, FusedState fused, Degradation degradation, OffsetDateTime observedAt, OffsetDateTime now, FusionParams params) {
        String contributing = write(fused.contributions().stream().map(c -> Map.of("source_id", c.sourceId(), "observation_id", c.observationId() == null ? "" : c.observationId(), "weight", round(c.weight(), CONF_SCALE))).toList());
        if (fused.longitude() != null) {
            PointKind kind = frame.estimates().stream().anyMatch(e -> e.kind() == PointKind.MEAS) ? PointKind.MEAS : PointKind.BRIDGE;
            String observationId = frame.estimates().stream().filter(e -> e.sourceId().equals(fused.selection().positionSourceId())).map(SourceEstimate::observationId).filter(java.util.Objects::nonNull).findFirst().orElse(null);
            tracks.insertPoint(new FusedPoint(UUID.randomUUID().toString(), track.trackId(), tracks.nextPointSeq(track.trackId()), observedAt, now, fused.longitude(), fused.latitude(),
                    decimal(fused.altitudeAmslM(), METRIC_SCALE), decimal(fused.heightAglM(), METRIC_SCALE), now, kind.name(), observationId, decimal(fused.accuracyM(), METRIC_SCALE),
                    contributing, fused.selection().positionSourceId(), fused.sourceSwitched(), degradation.level().name()));
            return;
        }
        if (!frame.estimates().isEmpty() || frame.missFrames() > params.integer("filter", "pred_max_frames")) return;
        LastPoint last = tracks.lastPoint(track.trackId());
        if (last == null || last.locationText() == null) return;
        double[] lonLat = parse(last.locationText());
        if (lonLat == null) return;
        tracks.insertPoint(new FusedPoint(UUID.randomUUID().toString(), track.trackId(), last.pointSeq() + 1, observedAt, now, lonLat[0], lonLat[1], last.altitudeAmslM(), last.heightAglM(), now,
                PointKind.PRED.name(), null, last.positionAccuracyM(), "[]", null, false, degradation.level().name()));
    }

    private void writeLatestState(TargetFrameResult frame, FusedTrackRow track, FusedState fused, Degradation degradation, boolean manualOverride, SelectionRow previous, OffsetDateTime observedAt, OffsetDateTime now) {
        // 人工修订过类别的目标：置信度固定为 1（人工结论），来源类别不再覆盖。
        BigDecimal classConfidence = manualOverride ? BigDecimal.ONE : decimal(fused.classConfidence(), CONF_SCALE);
        Set<UnknownField> unknown = new LinkedHashSet<>();
        fused.unknownFields().stream().filter(u -> !(manualOverride && "classification_confidence".equals(u.field()))).forEach(unknown::add);
        unknown.addAll(degradation.unknownFields());
        if (fused.longitude() == null) {
            // 无位置帧：位置保留本帧所在融合轨迹的最后可信点，只刷新其它字段；这里不写 (0,0)。
            // 必须用本帧的 track 而不是再查"开放轨迹"：TERMINATED 帧在此之前已把该轨迹 ended_at 关闭，
            // 再查开放轨迹会得到 null，最新状态就会丢掉位置（真实 PostgreSQL 验收时暴露）。
            LastPoint keep = tracks.lastPoint(track.trackId());
            double[] lonLat = keep == null || keep.locationText() == null ? null : parse(keep.locationText());
            if (lonLat != null) unknown.removeIf(u -> "location".equals(u.field()));
            tracks.upsertLatestState(new LatestState(frame.targetId(), lonLat == null ? null : lonLat[0], lonLat == null ? null : lonLat[1], decimal(fused.altitudeAmslM(), METRIC_SCALE),
                    decimal(fused.heightAglM(), METRIC_SCALE), decimal(fused.speedMps(), SPEED_SCALE), decimal(fused.headingDeg(), METRIC_SCALE), classConfidence,
                    decimal(degradation.fusionConfidence(), CONF_SCALE), observedAt, now, write(unknownList(unknown)), now));
            return;
        }
        tracks.upsertLatestState(new LatestState(frame.targetId(), fused.longitude(), fused.latitude(), decimal(fused.altitudeAmslM(), METRIC_SCALE), decimal(fused.heightAglM(), METRIC_SCALE),
                decimal(fused.speedMps(), SPEED_SCALE), decimal(fused.headingDeg(), METRIC_SCALE), classConfidence, decimal(degradation.fusionConfidence(), CONF_SCALE),
                observedAt, now, write(unknownList(unknown)), now));
    }

    private void writeSelection(TargetFrameResult frame, FusedState fused, boolean manualOverride, SelectionRow previous, OffsetDateTime observedAt, OffsetDateTime now, FusionParams params) {
        String classCode = manualOverride ? previous.classCode() : fused.classCode();
        BigDecimal classConfidence = manualOverride ? previous.classConfidence() : decimal(fused.classConfidence(), CONF_SCALE);
        String classSource = manualOverride ? null : fused.selection().classSourceId();
        states.upsertSelection(frame.targetId(), fused.selection().positionSourceId(), classSource, fused.selection().identitySourceId(), fused.selection().motionSourceId(),
                classCode, classConfidence, fused.identityClue(), observedAt, params.configVersion(), manualOverride, now);
    }

    private void writeDegradation(TargetFrameResult frame, Degradation degradation, DegradationRow previous, OffsetDateTime observedAt, OffsetDateTime now) {
        boolean sameLevel = previous != null && previous.level().equals(degradation.level().name()) && previous.determined() == degradation.determined();
        OffsetDateTime since = sameLevel ? previous.since() : observedAt;
        states.upsertDegradation(frame.targetId(), degradation.level().name(), write(degradation.availableSourceIds()), round(degradation.deficit(), CONF_SCALE), degradation.determined(), since, now);
    }

    private void emitEvents(TargetFrameResult frame, Degradation degradation, DegradationRow previous, FusedTrackRow track, OffsetDateTime observedAt) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("status", frame.status().name());
        payload.put("degradation_level", degradation.level().name());
        payload.put("determined", degradation.determined());
        if (frame.status() == TrackStatus.STABLE) events.stableOnce(frame.targetId(), observedAt, track.startedAt(), payload);
        boolean wasDetermined = previous == null || previous.determined();
        if (!degradation.determined() && wasDetermined) events.emit(FusionEventEmitter.UNDETERMINED, frame.targetId(), observedAt, payload);
    }

    private static List<Map<String, String>> unknownList(Set<UnknownField> unknown) {
        List<Map<String, String>> out = new ArrayList<>();
        for (UnknownField u : unknown) out.add(Map.of("field", u.field(), "reason_code", u.reasonCode()));
        return out;
    }

    private String write(Object value) {
        try { return json.writeValueAsString(value); }
        catch (JsonProcessingException ex) { throw new IllegalStateException("fusion payload unserializable", ex); }
    }

    private static BigDecimal decimal(Double value, int scale) {
        return value == null || value.isNaN() ? null : round(value, scale);
    }
    private static BigDecimal round(double value, int scale) { return BigDecimal.valueOf(value).setScale(scale, RoundingMode.HALF_UP); }

    /** 解析 H2/PG 回读的 POINT 文本（'SRID=4326;POINT (lon lat)' 或 WKB 十六进制时返回 null）。 */
    static double[] parse(String text) {
        int open = text.indexOf('('), close = text.indexOf(')');
        if (open < 0 || close < open) return null;
        String[] parts = text.substring(open + 1, close).trim().split("\\s+");
        if (parts.length != 2) return null;
        try { return new double[] { Double.parseDouble(parts[0]), Double.parseDouble(parts[1]) }; }
        catch (NumberFormatException ex) { return null; }
    }
}
