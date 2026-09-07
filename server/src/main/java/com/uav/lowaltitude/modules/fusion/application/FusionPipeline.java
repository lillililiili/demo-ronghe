package com.uav.lowaltitude.modules.fusion.application;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.modules.fusion.FusionContracts.FusionDomainKey;
import com.uav.lowaltitude.modules.fusion.FusionContracts.FusionParams;
import com.uav.lowaltitude.modules.fusion.FusionContracts.FusedLayerWriter;
import com.uav.lowaltitude.modules.fusion.FusionContracts.PointKind;
import com.uav.lowaltitude.modules.fusion.FusionContracts.SourceEstimate;
import com.uav.lowaltitude.modules.fusion.FusionContracts.TargetFrameResult;
import com.uav.lowaltitude.modules.fusion.FusionContracts.TrackStatus;
import com.uav.lowaltitude.modules.fusion.domain.AlphaBetaFilter;
import com.uav.lowaltitude.modules.fusion.domain.AlphaBetaFilter.Measurement;
import com.uav.lowaltitude.modules.fusion.domain.AlphaBetaFilter.State;
import com.uav.lowaltitude.modules.fusion.domain.AlphaBetaFilter.Update;
import com.uav.lowaltitude.modules.fusion.domain.AssociationCost;
import com.uav.lowaltitude.modules.fusion.domain.AssociationCost.Candidate;
import com.uav.lowaltitude.modules.fusion.domain.Associator;
import com.uav.lowaltitude.modules.fusion.domain.IdentityStateMachine;
import com.uav.lowaltitude.modules.fusion.domain.IdentityStateMachine.TrackState;
import com.uav.lowaltitude.modules.fusion.domain.IdentityStateMachine.Transition;
import com.uav.lowaltitude.modules.fusion.domain.SourceObservation;
import com.uav.lowaltitude.modules.fusion.ingest.FrameMapper.Frame;
import com.uav.lowaltitude.modules.fusion.ingest.FrameMapper.Item;
import com.uav.lowaltitude.modules.fusion.ingest.InboxSourceRouter;
import com.uav.lowaltitude.modules.fusion.infrastructure.AssociationPendingRepository;
import com.uav.lowaltitude.modules.fusion.infrastructure.FusionInboxRepository.InboxRow;
import com.uav.lowaltitude.modules.fusion.infrastructure.IdentityRepository;
import com.uav.lowaltitude.modules.fusion.infrastructure.IdentityRepository.ActiveTarget;
import com.uav.lowaltitude.modules.fusion.infrastructure.ObservationRepository;
import com.uav.lowaltitude.modules.fusion.infrastructure.ObservationRepository.DeviceMeta;
import com.uav.lowaltitude.modules.fusion.infrastructure.ObservationRepository.SourceMeta;
import com.uav.lowaltitude.modules.fusion.infrastructure.RawTrackRepository;
import com.uav.lowaltitude.modules.fusion.infrastructure.RawTrackRepository.LinkRow;
import com.uav.lowaltitude.modules.fusion.infrastructure.RawTrackRepository.LinkState;
import com.uav.lowaltitude.modules.fusion.infrastructure.RawTrackRepository.TrackRow;

/**
 * 一帧（一个来源一个时刻的多目标观测）的处理：解析 → 按分区分组 → α-β 滤波 → 门限/匈牙利关联 → ID 状态机 → 写原始层 → 交融合层。
 * 事务边界在调用方（{@link FusionIngestWorker} 或种子的同步 drain）：整帧一个事务，任何一步失败整帧回滚并把 inbox 置 FAILED，
 * 不允许留下半帧数据（一半观测入库、另一半没有会让后续关联建立在残缺证据上）。
 * 跨 source_mode 或跨归属元组永不关联：回放与实测、不同辖区的目标不是同一物理对象的证据。
 * 迟到帧（observed_at 早于目标最新观测）照写原始层，但在 TargetFrameResult 里如实带上 observedAt，由融合层决定不回退 latest_state。
 */
@Service
public class FusionPipeline {
    public static final String ALGO_VERSION = "fusion-e1-v1";
    private static final Logger log = LoggerFactory.getLogger(FusionPipeline.class);

    private final ObservationRepository observations;
    private final RawTrackRepository rawTracks;
    private final IdentityRepository identities;
    private final AssociationPendingRepository pendings;
    private final FusionConfigLoader configLoader;
    private final ObjectProvider<FusedLayerWriter> fusedLayerWriter;
    private final InboxSourceRouter router;
    private final ObjectMapper json;

    public FusionPipeline(ObservationRepository observations, RawTrackRepository rawTracks, IdentityRepository identities,
            AssociationPendingRepository pendings, FusionConfigLoader configLoader, ObjectProvider<FusedLayerWriter> fusedLayerWriter,
            InboxSourceRouter router, ObjectMapper json) {
        this.observations = observations; this.rawTracks = rawTracks; this.identities = identities; this.pendings = pendings;
        this.configLoader = configLoader; this.fusedLayerWriter = fusedLayerWriter; this.router = router; this.json = json;
    }

    public record FrameOutcome(int observationCount, int targetCount, List<String> targetIds) { }

    public FrameOutcome processFrame(InboxRow inbox) {
        FusionParams params = configLoader.active();
        AlphaBetaFilter filter = new AlphaBetaFilter(params);
        Associator associator = new Associator(new AssociationCost(params));
        IdentityStateMachine machine = new IdentityStateMachine(params);

        SourceMeta source = observations.findSource(inbox.sourceId());
        if (source == null || !source.enabled()) throw new IllegalStateException("回放来源不存在或已停用: " + inbox.sourceId());
        DeviceMeta device = observations.findDeviceForSource(inbox.sourceId());
        Frame frame = router.map(inbox);
        Instant receivedAt = Instant.ofEpochMilli(inbox.receivedAtMillis());
        FusionDomainKey domain = new FusionDomainKey(source.sourceMode(), device == null ? null : device.ownerOrgId(), device == null ? null : device.districtId());

        List<SourceObservation> parsed = new ArrayList<>();
        for (Item item : frame.items()) {
            parsed.add(new SourceObservation(UUID.randomUUID().toString(), inbox.inboxId(), source.sourceId(), source.sourceCode(), source.sourceType(), source.schemaStatus(),
                    device == null ? null : device.deviceId(), frame.sessionKey(), item.externalTargetId(), item.externalTrackId(), frame.observedAt(), receivedAt,
                    item.longitude(), item.latitude(), item.positionAccuracyM(), item.altitudeAmslM(), item.heightAglM(), item.speedMps(), item.headingDeg(),
                    item.classCode(), item.classConfidence(), item.identityClue(), null, item.latencyMs(), new LinkedHashMap<>(item.quality()), source.sourceMode(),
                    domain.ownerOrgId(), domain.districtId(), frame.recordNo(), item.pilotLongitude(), item.pilotLatitude(), item.classSource()));
        }

        // ① 滤波：每条观测按其 link 的现有状态更新；缺精度用目录缺省并在 quality 标记。
        List<Double> accuracies = new ArrayList<>();
        List<Update> updates = new ArrayList<>();
        for (SourceObservation observation : parsed) {
            LinkRow link = rawTracks.findLink(observation.sourceId(), observation.sourceSessionKey(), observation.externalTargetId());
            State existing = null;
            if (link != null) {
                TrackRow open = rawTracks.findOpenRawTrack(link.linkId(), link.targetId());
                existing = open == null || open.filterStateJson() == null ? null : State.fromMap(readMap(open.filterStateJson()));
            }
            Update update = observation.hasPosition()
                    ? filter.update(existing, new Measurement(observation.longitude(), observation.latitude(), observation.positionAccuracyM(), observation.observedMillis()), observation.sourceType())
                    : null;
            updates.add(update);
            double accuracy = update != null ? update.accuracyUsedM() : (observation.positionAccuracyM() == null ? Double.NaN : observation.positionAccuracyM());
            accuracies.add(accuracy);
            if (update != null && update.accuracyDefaulted()) observation.quality().put("accuracy_defaulted", true);
            if (!observation.hasPosition()) observation.quality().put("position", "REFERENCE_UNKNOWN");
            if (update != null && update.outOfOrder()) observation.quality().put("out_of_order", true);
            observation.quality().put("schema_status", observation.schemaStatus() == null ? "UNKNOWN" : observation.schemaStatus());
        }

        // ② 关联：先按已有 link 直连（同一来源同一外部目标号就是同一条 link），其余按门限 + 匈牙利匹配。
        List<ActiveTarget> active = identities.activeTargets(domain);
        Map<String, ActiveTarget> byTarget = new LinkedHashMap<>();
        for (ActiveTarget candidate : active) byTarget.put(candidate.target().targetId(), candidate);
        Map<String, State> predicted = predictStates(filter, active, frame.observedAt());

        String[] assignedTarget = new String[parsed.size()];
        List<Integer> unlinked = new ArrayList<>();
        for (int i = 0; i < parsed.size(); i++) {
            SourceObservation observation = parsed.get(i);
            LinkRow link = rawTracks.findLink(observation.sourceId(), observation.sourceSessionKey(), observation.externalTargetId());
            if (link != null) {
                String resolved = identities.resolveAlias(link.targetId());
                if (byTarget.containsKey(resolved)) { assignedTarget[i] = resolved; continue; }
            }
            unlinked.add(i);
        }
        if (!unlinked.isEmpty()) {
            List<SourceObservation> subset = new ArrayList<>();
            List<Double> subsetAccuracies = new ArrayList<>();
            for (int index : unlinked) { subset.add(parsed.get(index)); subsetAccuracies.add(accuracies.get(index)); }
            Set<String> taken = new LinkedHashSet<>();
            for (String target : assignedTarget) if (target != null) taken.add(target);
            List<Candidate> candidates = new ArrayList<>();
            for (ActiveTarget candidate : active) {
                if (taken.contains(candidate.target().targetId())) continue;
                State state = predicted.get(candidate.target().targetId());
                if (state == null) continue;
                candidates.add(new Candidate(candidate.target().targetId(), candidate.target().domain(), state.longitude(), state.latitude(), state.accuracyM(),
                        null, null, state.speedMps(), state.headingDeg(), candidate.target().objectTypeCode(),
                        candidate.status().state().lastObservedAt() == null ? frame.observedAt().toEpochMilli() : candidate.status().state().lastObservedAt().toEpochMilli(),
                        candidate.status().state().confirmHits(), candidate.status().state().missFrames()));
            }
            Associator.Result association = associator.associate(subset, subsetAccuracies, candidates);
            for (Associator.Match match : association.matches()) assignedTarget[unlinked.get(match.observationIndex())] = match.targetId();
            for (Associator.Ambiguity ambiguity : association.ambiguities()) {
                SourceObservation observation = subset.get(ambiguity.observationIndex());
                recordPending(domain, observation, ambiguity.candidateTargetIds(), "GATE_AMBIGUOUS", frame.observedAt());
            }
        }

        // ③ 身份与原始层写入。
        Map<String, List<SourceEstimate>> estimatesByTarget = new LinkedHashMap<>();
        Map<String, Instant> observedByTarget = new LinkedHashMap<>();
        for (int i = 0; i < parsed.size(); i++) {
            SourceObservation observation = parsed.get(i);
            observations.insert(observation);
            String targetId = assignedTarget[i];
            if (targetId == null) targetId = createTarget(observation, machine, frame.observedAt());
            else identities.touchTarget(targetId, observation.observedAt(), receivedAt);
            assignedTarget[i] = targetId;
            SourceEstimate estimate = writeRawLayer(observation, updates.get(i), accuracies.get(i), targetId, params, receivedAt);
            estimatesByTarget.computeIfAbsent(targetId, k -> new ArrayList<>()).add(estimate);
            observedByTarget.merge(targetId, observation.observedAt(), (a, b) -> a.isAfter(b) ? a : b);
        }

        // ④ 状态推进：本帧命中的目标走 onHit，同分区其余活跃目标走 onFrame（可能转 SHORT_LOST/TERMINATED）。
        Map<String, TrackStatus> statuses = new LinkedHashMap<>();
        Map<String, Integer> missFrames = new LinkedHashMap<>();
        for (Map.Entry<String, List<SourceEstimate>> entry : estimatesByTarget.entrySet()) {
            IdentityRepository.StatusRow status = identities.findStatus(entry.getKey());
            TrackState state = status == null ? TrackState.created(frame.observedAt()) : status.state();
            Transition transition = machine.onHit(state, observedByTarget.get(entry.getKey()));
            String primarySource = entry.getValue().get(0).sourceId();
            identities.updateStatus(entry.getKey(), transition.state(), primarySource, receivedAt);
            if (status != null && status.primarySourceId() != null && !status.primarySourceId().equals(primarySource)) {
                identities.insertLineage("SWITCH", frame.observedAt(), entry.getKey(), null, write(List.of(entry.getKey())), write(List.of()),
                        write(Map.of("from_source_id", status.primarySourceId(), "to_source_id", primarySource)), ALGO_VERSION, params.configVersion(), write(Map.of()));
            }
            if (transition.changed()) {
                identities.insertLineage("STATUS", frame.observedAt(), entry.getKey(), null, write(List.of(entry.getKey())), write(List.of()),
                        write(Map.of("status", transition.state().status().name())), ALGO_VERSION, params.configVersion(), write(Map.of()));
            }
            statuses.put(entry.getKey(), transition.state().status());
            missFrames.put(entry.getKey(), transition.state().missFrames());
        }
        for (ActiveTarget candidate : active) {
            String targetId = candidate.target().targetId();
            if (estimatesByTarget.containsKey(targetId)) continue;
            Transition transition = machine.onFrame(candidate.status().state(), frame.observedAt());
            if (transition.changed() || transition.state().missFrames() != candidate.status().state().missFrames()) {
                identities.updateStatus(targetId, transition.state(), candidate.status().primarySourceId(), receivedAt);
            }
            if (transition.changed()) {
                identities.insertLineage("STATUS", frame.observedAt(), targetId, null, write(List.of(targetId)), write(List.of()),
                        write(Map.of("status", transition.state().status().name())), ALGO_VERSION, params.configVersion(), write(Map.of()));
                if (transition.state().status() == TrackStatus.TERMINATED) rawTracks.endOpenRawTracks(targetId, frame.observedAt());
            }
            statuses.put(targetId, transition.state().status());
            missFrames.put(targetId, transition.state().missFrames());
            estimatesByTarget.putIfAbsent(targetId, List.of());
            observedByTarget.putIfAbsent(targetId, frame.observedAt());
        }

        // ⑤ 交给融合层（E2）。E2 未落地时 ObjectProvider 取不到 Bean，用无操作实现，原始层照常入库。
        FusedLayerWriter writer = fusedLayerWriter.getIfAvailable(() -> f -> { });
        List<String> targetIds = new ArrayList<>();
        for (Map.Entry<String, List<SourceEstimate>> entry : estimatesByTarget.entrySet()) {
            targetIds.add(entry.getKey());
            writer.write(new TargetFrameResult(entry.getKey(), domain, observedByTarget.get(entry.getKey()), entry.getValue(),
                    statuses.getOrDefault(entry.getKey(), TrackStatus.TENTATIVE), missFrames.getOrDefault(entry.getKey(), 0), params.configVersion()));
        }
        return new FrameOutcome(parsed.size(), targetIds.size(), List.copyOf(targetIds));
    }

    private String createTarget(SourceObservation observation, IdentityStateMachine machine, Instant frameAt) {
        String targetId = UUID.randomUUID().toString();
        String targetNo = identities.nextTargetNo(observation.observedAt());
        identities.insertTarget(targetId, targetNo, observation.classCode(), null, observation.observedAt(), observation.domain(), observation.receivedAt());
        identities.insertStatus(targetId, TrackState.created(frameAt), observation.receivedAt());
        identities.insertLineage("CREATE", observation.observedAt(), targetId, null, write(List.of(targetId)), write(List.of()),
                write(Map.of("source_code", observation.sourceCode(), "external_target_id", observation.externalTargetId())), ALGO_VERSION,
                configLoader.active().configVersion(), write(Map.of()));
        return targetId;
    }

    private SourceEstimate writeRawLayer(SourceObservation observation, Update update, double accuracyM, String targetId, FusionParams params, Instant receivedAt) {
        LinkRow link = rawTracks.findLink(observation.sourceId(), observation.sourceSessionKey(), observation.externalTargetId());
        String linkId;
        if (link == null) {
            linkId = UUID.randomUUID().toString();
            rawTracks.insertLink(linkId, targetId, observation.sourceId(), observation.deviceId(), observation.sourceSessionKey(), observation.externalTargetId(), observation.receivedAt());
        } else {
            linkId = link.linkId();
            if (!targetId.equals(link.targetId())) rawTracks.relink(linkId, targetId);
        }
        TrackRow open = rawTracks.findOpenRawTrack(linkId, targetId);
        String trackId;
        String stateJson = update == null ? null : write(update.state().toMap());
        if (open == null || (update != null && update.reinitialized() && open.filterStateJson() != null)) {
            if (open != null) rawTracks.endTrack(open.trackId(), observation.observedAt());
            trackId = UUID.randomUUID().toString();
            String externalTrackId = (observation.externalTrackId() == null ? observation.externalTargetId() : observation.externalTrackId()) + ":" + observation.observedMillis();
            rawTracks.insertRawTrack(trackId, targetId, linkId, externalTrackId, observation.observedAt(), params.configVersion(), stateJson);
        } else {
            trackId = open.trackId();
            if (stateJson != null) rawTracks.updateFilterState(trackId, stateJson);
        }
        if (observation.hasPosition()) {
            rawTracks.insertPoint(UUID.randomUUID().toString(), trackId, observation.inboxId(), observation.pointSeq(), observation.observedAt(), receivedAt,
                    observation.longitude(), observation.latitude(), observation.altitudeAmslM(), observation.heightAglM(), observation.observationId(), accuracyM, PointKind.MEAS.name());
        }
        State state = update == null ? null : update.state();
        // 三元表达式两侧一个是 Double、一个是 double 会触发自动拆箱：没有位置的来源（AOA 只给方位）在这里会 NPE。
        // 显式装箱保留"没有位置"这件事，让它一路带到融合层，而不是在管线里炸掉整帧。
        Double estimateLongitude = state == null ? observation.longitude() : Double.valueOf(state.longitude());
        Double estimateLatitude = state == null ? observation.latitude() : Double.valueOf(state.latitude());
        return new SourceEstimate(observation.sourceId(), observation.sourceCode(), observation.sourceType(), observation.schemaStatus(), linkId, trackId,
                observation.observationId(), observation.observedAt(), estimateLongitude, estimateLatitude,
                state == null ? null : state.accuracyM(), observation.altitudeAmslM(), observation.heightAglM(),
                observation.speedMps() != null ? observation.speedMps() : (state == null ? null : state.speedMps()),
                observation.headingDeg() != null ? observation.headingDeg() : (state == null ? null : state.headingDeg()),
                observation.classCode(), observation.classConfidence(), observation.identityClue(), observation.identityConfidence(),
                PointKind.MEAS, Map.copyOf(observation.quality()), observation.pilotLongitude(), observation.pilotLatitude(), observation.classSource());
    }

    private Map<String, State> predictStates(AlphaBetaFilter filter, List<ActiveTarget> active, Instant at) {
        Map<String, State> out = new HashMap<>();
        List<String> ids = new ArrayList<>();
        for (ActiveTarget candidate : active) ids.add(candidate.target().targetId());
        for (LinkState link : rawTracks.linkStates(ids)) {
            if (link.filterStateJson() == null) continue;
            State state = filter.predict(State.fromMap(readMap(link.filterStateJson())), at.toEpochMilli());
            State existing = out.get(link.targetId());
            // 一个目标多条 link 时取精度更好的那条作为门限中心。
            if (existing == null || state.accuracyM() < existing.accuracyM()) out.put(link.targetId(), state);
        }
        return out;
    }

    private void recordPending(FusionDomainKey domain, SourceObservation observation, List<String> candidateTargetIds, String reason, Instant at) {
        String pendingKey = reason + "|" + observation.sourceId() + "|" + observation.externalTargetId() + "|" + String.join(",", candidateTargetIds.stream().sorted().toList());
        AssociationPendingRepository.PendingRow existing = pendings.findOpen(domain.asKey(), pendingKey);
        if (existing == null) pendings.insert(domain.asKey(), observation.observationId(), write(candidateTargetIds), reason, pendingKey, at);
        else pendings.touch(existing.pendingId(), at, existing.framesSeen() + 1);
    }

    /** 回放信封 frame 部分。 */
    /**
     * 读 JSON 列：H2 把 CAST(? AS JSON) 的字符串存成 JSON 文本，读回是"带引号的字符串"，PostgreSQL 直接是对象；
     * 两种形态都要能解开，否则同一份代码在 H2 绿、在真实库红（阶段 7 的教训）。
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> readMap(String value) {
        try {
            JsonNode node = json.readTree(value);
            if (node != null && node.isTextual()) node = json.readTree(node.textValue());
            if (node == null || !node.isObject()) throw new IllegalStateException("滤波状态不是 JSON 对象");
            return json.convertValue(node, Map.class);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("滤波状态无法解析", ex);
        }
    }

    private String write(Object value) {
        try { return json.writeValueAsString(value); }
        catch (JsonProcessingException ex) { throw new IllegalStateException("融合中间结果无法序列化", ex); }
    }
}
