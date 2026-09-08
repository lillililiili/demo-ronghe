package com.uav.lowaltitude.modules.device.application;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.uav.lowaltitude.modules.device.domain.EoEdgeConfiguration.Binding;
import com.uav.lowaltitude.modules.device.infrastructure.EoEdgeRepository;

@Service
public class EoAutoTrackService {
    private static final Set<String> HIGH = Set.of("HIGH", "CRITICAL");
    private final EoEdgeRepository edges;
    private final EoEdgeCommandService commands;
    private final ObjectMapper json;
    private final boolean mqttEnabled;
    private final int batch;

    public EoAutoTrackService(EoEdgeRepository edges, EoEdgeCommandService commands, ObjectMapper json,
                              @Value("${app.mqtt.enabled:true}") boolean mqttEnabled,
                              @Value("${app.eo-edge.auto-track-batch:20}") int batch) {
        this.edges = edges; this.commands = commands; this.json = json; this.mqttEnabled = mqttEnabled; this.batch = batch;
    }

    @Scheduled(fixedDelayString = "${app.eo-edge.poll-millis:1000}")
    public void scheduled() {
        if (mqttEnabled) poll();
    }

    @Transactional
    public int poll() {
        var cursor = edges.lockCursor();
        if (cursor == null) return 0;
        OffsetDateTime created = time(cursor.get("last_created_at"));
        String eventId = String.valueOf(cursor.get("last_event_id"));
        int handled = 0;
        OffsetDateTime lastCreated = created;
        String lastEvent = eventId;
        for (var row : edges.pendingStableEvents(created, eventId, batch)) {
            OffsetDateTime at = time(row.get("created_at"));
            String id = String.valueOf(row.get("event_id"));
            consider(row);
            lastCreated = at; lastEvent = id; handled++;
        }
        if (handled > 0) edges.advanceCursor(lastCreated, lastEvent);
        return handled;
    }

    private void consider(Map<String, Object> row) {
        String eventId = String.valueOf(row.get("event_id"));
        String targetId = String.valueOf(row.get("target_id"));
        JsonNode payload = node(row.get("payload_text"));
        if (!trigger(payload)) return;
        JsonNode latest = payload.path("latest_state");
        if (!latest.path("longitude").isNumber() || !latest.path("latitude").isNumber()) return;
        String classCode = payload.path("class_code").isTextual() ? payload.path("class_code").asText() : null;
        if (!"UAV".equals(classCode) && !"BIRD".equals(classCode)) return;
        if (edges.targetHasOpenTask(targetId)) return;
        var target = edges.target(targetId);
        if (target == null || target.get("owner_org_id") == null || target.get("district_id") == null) return;
        Binding device = edges.idleDevice(String.valueOf(target.get("owner_org_id")), String.valueOf(target.get("district_id")));
        if (device == null) return;
        String notes = missingNotes(latest);
        Map<String, Object> bootstrap = bootstrap(targetId, classCode, latest, payload);
        commands.enqueueBegin(device, UUID.randomUUID().toString(), targetId, eventId, notes, bootstrap, null);
    }

    private boolean trigger(JsonNode payload) {
        if (payload.path("alarm_active").isBoolean() && payload.path("alarm_active").asBoolean()) return true;
        return payload.path("max_risk_severity").isTextual() && HIGH.contains(payload.path("max_risk_severity").asText());
    }

    private Map<String, Object> bootstrap(String targetId, String classCode, JsonNode latest, JsonNode payload) {
        Map<String, Object> objectData = new LinkedHashMap<>();
        objectData.put("latitude", latest.path("latitude").asDouble());
        objectData.put("longitude", latest.path("longitude").asDouble());
        objectData.put("altitude", latest.path("altitude_raw").isNumber() ? latest.path("altitude_raw").asDouble() : 0d);
        double[] ned = ned(latest);
        objectData.put("speedX", ned[0]);
        objectData.put("speedY", ned[1]);
        objectData.put("speedZ", 0d);
        objectData.put("dataId", targetId);
        objectData.put("length", 0d);
        objectData.put("width", 0d);
        objectData.put("height", 0d);
        objectData.put("objectType", "UAV".equals(classCode) ? 30 : 40);
        objectData.put("probability", payload.path("class_confidence").isNumber() ? payload.path("class_confidence").asDouble() : 0d);
        Map<String, Object> aiData = new LinkedHashMap<>();
        aiData.put("className", "UAV".equals(classCode) ? "drone" : "bird");
        aiData.put("isDetect", 1);
        aiData.put("isTrack", 1);
        Map<String, Object> extention = new LinkedHashMap<>();
        extention.put("mode", "full-auto");
        extention.put("bootstrapSourceId", targetId);
        extention.put("bootstrapSourceType", 0);
        extention.put("msgId", UUID.randomUUID().toString());
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("objectData", objectData);
        root.put("aiData", aiData);
        root.put("extention", extention);
        return root;
    }

    private static double[] ned(JsonNode latest) {
        if (!latest.path("speed_mps").isNumber() || !latest.path("heading_deg").isNumber()) return new double[] {0d, 0d};
        double speed = latest.path("speed_mps").asDouble();
        double rad = Math.toRadians(latest.path("heading_deg").asDouble());
        return new double[] {speed * Math.cos(rad), speed * Math.sin(rad)};
    }

    private static String missingNotes(JsonNode latest) {
        StringBuilder notes = new StringBuilder();
        if (!latest.path("speed_mps").isNumber() || !latest.path("heading_deg").isNumber()) notes.append("HORIZONTAL_SPEED_NOT_PROVIDED ");
        notes.append("VERTICAL_SPEED_NOT_PROVIDED SIZE_NOT_PROVIDED");
        return notes.toString().trim();
    }

    private JsonNode node(Object value) {
        try {
            JsonNode parsed = json.readTree(String.valueOf(value));
            if (parsed != null && parsed.isTextual()) parsed = json.readTree(parsed.asText());
            return parsed == null || parsed.isMissingNode() ? json.createObjectNode() : parsed;
        } catch (Exception ex) { return json.createObjectNode(); }
    }
    private static OffsetDateTime time(Object value) {
        if (value instanceof OffsetDateTime t) return t;
        if (value instanceof Timestamp t) return t.toInstant().atOffset(ZoneOffset.UTC);
        if (value instanceof Instant i) return i.atOffset(ZoneOffset.UTC);
        return Instant.EPOCH.atOffset(ZoneOffset.UTC);
    }
}
