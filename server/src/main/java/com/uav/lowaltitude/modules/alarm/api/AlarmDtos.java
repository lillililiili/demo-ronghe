package com.uav.lowaltitude.modules.alarm.api;

import java.util.List;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.SerializerProvider;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.annotation.JsonSerialize;
import java.io.IOException;

/** 阶段 4 只暴露告警安全摘要，不返回来源原始 JSON、凭据或设备内部字段。 */
public final class AlarmDtos {
    private AlarmDtos() { }

    public record PageDto<T>(List<T> items, int page, int size, long total) { }
    public static final class AlarmDto {
        private final String alarmId, state, alarmType, severity, sourceCode, sourceMode, ownerOrgId, districtId, targetId;
        private final EventId eventId;
        private final Long occurredAt;
        private final long receivedAt;
        public AlarmDto(String alarmId, String eventId, String state, String alarmType, String severity, Long occurredAt,
                long receivedAt, String sourceCode, String sourceMode, String ownerOrgId, String districtId, String targetId) {
            this.alarmId = alarmId; this.eventId = new EventId(eventId); this.state = state; this.alarmType = alarmType; this.severity = severity;
            this.occurredAt = occurredAt; this.receivedAt = receivedAt; this.sourceCode = sourceCode; this.sourceMode = sourceMode;
            this.ownerOrgId = ownerOrgId; this.districtId = districtId; this.targetId = targetId;
        }
        public String getAlarmId() { return alarmId; }
        /** 无事件是稳定业务事实；包装值非空而序列化结果为 null，避免改全局 NON_NULL。 */
        @JsonInclude(JsonInclude.Include.ALWAYS) @JsonSerialize(using = EventIdSerializer.class) public EventId getEventId() { return eventId; }
        public String getState() { return state; }
        public String getAlarmType() { return alarmType; }
        public String getSeverity() { return severity; }
        public Long getOccurredAt() { return occurredAt; }
        public long getReceivedAt() { return receivedAt; }
        public String getSourceCode() { return sourceCode; }
        public String getSourceMode() { return sourceMode; }
        public String getOwnerOrgId() { return ownerOrgId; }
        public String getDistrictId() { return districtId; }
        public String getTargetId() { return targetId; }
    }
    public record EventId(String value) { }
    public static final class EventIdSerializer extends JsonSerializer<EventId> {
        @Override public void serialize(EventId value, JsonGenerator generator, SerializerProvider provider) throws IOException {
            if (value == null || value.value() == null) generator.writeNull(); else generator.writeString(value.value());
        }
    }
    public record UavEventDto(String eventId, String alarmId, String targetId, String state, long version,
            long createdAt, long updatedAt, List<String> allowedActions) { }
    public record VerificationDto(String historyId, String previousState, String resultingState, String conclusion,
            String note, long version, String actorId, long createdAt) { }
    public record VerifyRequest(String conclusion, String note, Long expectedVersion) { }
}
