package com.uav.lowaltitude.integration.device.countermeasure;

import java.nio.charset.StandardCharsets;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

import com.uav.lowaltitude.integration.device.ProtocolException;

/** 固定式四通道网络控制器 v2.0，只暴露无副作用的 0x10 状态查询。 */
public final class Countermeasure4ChCodec {

    public static final int REQUEST_HEADER = 0x55;
    public static final int RESPONSE_HEADER = 0x22;
    public static final int FUNCTION_QUERY = 0x10;
    public static final int BROADCAST_ADDRESS = 245;

    private Countermeasure4ChCodec() {
    }

    public static byte[] query(int address) {
        validateAddress(address);
        // 资料查询例为 55 01 10 00 00 00 01 67；查哪一路都返回全板状态，数据末字节用 1。
        byte[] frame = new byte[] { (byte) REQUEST_HEADER, (byte) address, (byte) FUNCTION_QUERY, 0, 0, 0, 1, 0 };
        frame[7] = checksum(frame, 0, 7);
        return frame;
    }

    /** 仅用于协议金样，不能由适配器、Outbox 或 REST 调用。 */
    public static int documentedForceLandMaskForTestOnly() { return 0x0F; }
    /** 仅用于协议金样，不能由适配器、Outbox 或 REST 调用。 */
    public static int documentedDriveAwayMaskForTestOnly() { return 0x0D; }

    public static byte[] encodeWire(byte[] frame, WireEncoding encoding) {
        return switch (encoding) {
            case RAW_BYTES -> frame.clone();
            case ASCII_HEX_SPACED -> (HexFormat.ofDelimiter(" ").withUpperCase().formatHex(frame) + "\r\n")
                    .getBytes(StandardCharsets.US_ASCII);
            case ASCII_HEX_COMPACT -> (HexFormat.of().withUpperCase().formatHex(frame) + "\r\n")
                    .getBytes(StandardCharsets.US_ASCII);
            case AUTO -> throw new IllegalArgumentException("AUTO 必须先完成会话探测");
        };
    }

    public static byte[] decodeWire(byte[] bytes, WireEncoding encoding) {
        if (bytes == null) throw invalid("反制响应为空");
        if (encoding == WireEncoding.RAW_BYTES) return bytes.clone();
        String value = new String(bytes, StandardCharsets.US_ASCII).trim().replace(" ", "");
        try {
            return HexFormat.of().parseHex(value);
        } catch (IllegalArgumentException ex) {
            throw invalid("反制响应不是有效 ASCII Hex");
        }
    }

    public static RelayState parseResponse(byte[] logicalFrame, int expectedAddress) {
        validateAddress(expectedAddress);
        if (logicalFrame == null || logicalFrame.length != 8) throw invalid("反制响应逻辑帧必须为 8 字节");
        if (Byte.toUnsignedInt(logicalFrame[0]) != RESPONSE_HEADER) throw invalid("反制响应帧头不是 0x22");
        if (Byte.toUnsignedInt(logicalFrame[1]) != expectedAddress) throw invalid("反制响应设备地址不匹配");
        if (Byte.toUnsignedInt(logicalFrame[2]) != FUNCTION_QUERY) throw invalid("反制响应功能码不是无副作用查询 0x10");
        if (logicalFrame[7] != checksum(logicalFrame, 0, 7)) throw invalid("反制响应累加和错误");
        long word = Integer.toUnsignedLong((Byte.toUnsignedInt(logicalFrame[3]) << 24)
                | (Byte.toUnsignedInt(logicalFrame[4]) << 16)
                | (Byte.toUnsignedInt(logicalFrame[5]) << 8)
                | Byte.toUnsignedInt(logicalFrame[6]));
        int low = Byte.toUnsignedInt(logicalFrame[6]);
        Map<String, Boolean> channels = new LinkedHashMap<>();
        channels.put("900M", (low & 0x01) != 0);
        channels.put("1.5G", (low & 0x02) != 0);
        channels.put("2.4G", (low & 0x04) != 0);
        channels.put("5.8G", (low & 0x08) != 0);
        return new RelayState(word, channels);
    }

    public static byte checksum(byte[] bytes, int offset, int length) {
        int sum = 0;
        for (int i = offset; i < offset + length; i++) sum += Byte.toUnsignedInt(bytes[i]);
        return (byte) sum;
    }

    private static void validateAddress(int address) {
        if (address < 1 || address >= BROADCAST_ADDRESS)
            throw new ProtocolException("PROTOCOL_FRAME_INVALID", "反制设备地址必须为 1–244，禁止广播地址 245");
    }

    private static ProtocolException invalid(String message) {
        return new ProtocolException("PROTOCOL_FRAME_INVALID", message);
    }

    public enum WireEncoding { AUTO, RAW_BYTES, ASCII_HEX_SPACED, ASCII_HEX_COMPACT }
    public record RelayState(long rawStatusWord, Map<String, Boolean> channels) {
        public RelayState { channels = Map.copyOf(channels); }
    }
}
