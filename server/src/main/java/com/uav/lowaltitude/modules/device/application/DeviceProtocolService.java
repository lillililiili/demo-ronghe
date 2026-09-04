package com.uav.lowaltitude.modules.device.application;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Service;

import com.uav.lowaltitude.integration.device.DeviceProtocolCodes;

@Service
public class DeviceProtocolService {

    private final DeviceAccessPolicy access;

    public DeviceProtocolService(DeviceAccessPolicy access) { this.access = access; }

    public List<ProtocolDescriptor> catalog() {
        access.requireDevicesRead();
        return List.of(
                new ProtocolDescriptor(DeviceProtocolCodes.RADAR_TCP_V3_0_0, "T02/兼容机扫雷达 TCP", "3.0.0",
                        List.of("LOGIN_DATA", "HEARTBEAT", "TARGET_RECEIVE", "TRACK_RECEIVE", "RTK", "STATUS_READ"),
                        List.of(new Field("login_role", "enum", true, "固定为 DATA"),
                                new Field("recognition_code_ref", "credential_ref", false, "非零识别码的凭据引用"),
                                new Field("rtk_enabled", "boolean", true, "是否采集 RTK"),
                                new Field("coordinate_transform_enabled", "boolean", true, "具备验证参考值后才派生经纬度")),
                        Map.of("host", "192.168.8.168", "port", 5001), false),
                new ProtocolDescriptor(DeviceProtocolCodes.COUNTERMEASURE_TCP_4CH_V2_0, "固定式四通道网络控制器", "2.0",
                        List.of("SAFE_STATUS_QUERY", "WIRE_ENCODING_DETECTION", "FOUR_CHANNEL_NORMALIZATION"),
                        List.of(new Field("device_address", "integer", true, "1–244，禁止广播地址 245"),
                                new Field("wire_encoding", "enum", true, "AUTO/RAW_BYTES/ASCII_HEX_SPACED/ASCII_HEX_COMPACT"),
                                new Field("poll_interval_millis", "integer", true, "1000–60000")),
                        Map.of("host", "192.168.0.7", "port", 10006), false));
    }

    public record ProtocolDescriptor(String protocolCode, String name, String version,
                                     List<String> capabilities, List<Field> configurationFields,
                                     Map<String, Object> connectionHints, boolean controlEnabled) { }
    public record Field(String name, String type, boolean required, String description) { }
}
