package com.uav.lowaltitude.integration.mqtt;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.uav.lowaltitude.integration.device.DeviceProtocolCodes;

/** Only the protocol envelope is interpreted here. Object semantics belong to fusion. */
public record LingyunEnvelope(String provider, String type, String externalId, boolean sensing,
                              String json, String hash, Long ptTime, Integer msgCnt, Integer workState) {
    public static final String PROTOCOL = DeviceProtocolCodes.LINGYUN_MQTT_V8_6;
    public static final Map<String, Integer> TYPES = Map.of("radar", 1, "5ga", 0, "tdoa", 10);
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    public static LingyunEnvelope decode(String topic, byte[] bytes) {
        if (bytes.length > 1_048_576) throw new Rejected("PAYLOAD_TOO_LARGE");
        String[] parts = topic.split("/", -1);
        if (parts.length != 5 || !parts[0].equals("bridge")
                || !(parts[2].equals("device") || parts[2].equals("device_data")))
            throw new Rejected("INVALID_TOPIC");
        if (!TYPES.containsKey(parts[3])) throw new Rejected("UNSUPPORTED_TYPE");
        final String raw;
        final JsonNode root;
        try {
            raw = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            root = JSON.readTree(raw);
        } catch (Exception ex) { throw new Rejected("INVALID_JSON_UTF8"); }
        if (root == null || !root.isObject()) throw new Rejected("INVALID_ENVELOPE");
        if (!root.path("deviceId").isTextual() || !root.path("deviceId").asText().equals(parts[4]))
            throw new Rejected("IDENTITY_MISMATCH");
        boolean sense = parts[2].equals("device_data");
        Long ptTime = root.has("ptTime") ? integer(root, "ptTime", Long.MAX_VALUE) : null;
        if (sense) {
            if (ptTime == null || !root.path("objects").isArray()) throw new Rejected("INVALID_ENVELOPE");
            int count = (int) integer(root, "msgCnt", Integer.MAX_VALUE);
            return new LingyunEnvelope(parts[1], parts[3], parts[4], true, raw, hash(bytes), ptTime, count, null);
        }
        if (!root.path("providerCode").isTextual() || !root.path("providerCode").asText().equals(parts[1])
                || integer(root, "deviceType", Integer.MAX_VALUE) != TYPES.get(parts[3]))
            throw new Rejected("IDENTITY_MISMATCH");
        if (!root.path("deviceName").isTextual() || root.path("deviceName").asText().isBlank())
            throw new Rejected("INVALID_ENVELOPE");
        int state = (int) integer(root, "workState", 2);
        return new LingyunEnvelope(parts[1], parts[3], parts[4], false, raw, hash(bytes), ptTime, null, state);
    }

    private static long integer(JsonNode root, String key, long max) {
        JsonNode value = root.path(key);
        if (!value.isIntegralNumber() || !value.canConvertToLong() || value.longValue() < 0 || value.longValue() > max)
            throw new Rejected("INVALID_" + key.toUpperCase(java.util.Locale.ROOT));
        return value.longValue();
    }

    public static String hash(byte[] raw) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(raw)); }
        catch (java.security.NoSuchAlgorithmException ex) { throw new IllegalStateException(ex); }
    }

    public static class Rejected extends RuntimeException {
        public Rejected(String reason) { super(reason); }
    }
}
