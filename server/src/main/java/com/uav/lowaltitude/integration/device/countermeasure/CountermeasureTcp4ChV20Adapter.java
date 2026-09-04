package com.uav.lowaltitude.integration.device.countermeasure;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.List;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import com.uav.lowaltitude.integration.DeviceAdapterPort;
import com.uav.lowaltitude.integration.SourceMode;
import com.uav.lowaltitude.integration.device.AdapterConfiguration;
import com.uav.lowaltitude.integration.device.DeviceProtocolCodes;
import com.uav.lowaltitude.integration.device.NetworkTargetPolicy;
import com.uav.lowaltitude.integration.device.ProtocolException;
import com.uav.lowaltitude.integration.device.countermeasure.Countermeasure4ChCodec.RelayState;
import com.uav.lowaltitude.integration.device.countermeasure.Countermeasure4ChCodec.WireEncoding;

@Component
public class CountermeasureTcp4ChV20Adapter implements DeviceAdapterPort {

    private final ObjectMapper mapper;
    private final NetworkTargetPolicy networkPolicy;

    public CountermeasureTcp4ChV20Adapter(ObjectMapper mapper, NetworkTargetPolicy networkPolicy) {
        this.mapper = mapper;
        this.networkPolicy = networkPolicy;
    }

    @Override public SourceMode mode() { return SourceMode.live; }
    @Override public String protocolCode() { return DeviceProtocolCodes.COUNTERMEASURE_TCP_4CH_V2_0; }

    @Override
    public AdapterResult reboot(RebootWork work) {
        return new AdapterResult(false, "DEVICE_NOT_OPERABLE", "四通道网络控制器协议未声明重启能力");
    }

    @Override
    public AdapterResult connect(CommissionWork work) {
        try {
            AdapterConfiguration config = AdapterConfiguration.parse(mapper, work.configurationJson());
            config.validateEndpoint();
            List<InetAddress> addresses = networkPolicy.resolveAllowed(config.host(), config.allowedCidrs());
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(addresses.get(0), config.port()), config.timeoutMillis());
            }
            return new AdapterResult(true, "COUNTERMEASURE_TCP_OK", "TCP 端口可达，编码探测和状态查询在开始协议调测时执行");
        } catch (ProtocolException ex) {
            return new AdapterResult(false, ex.code(), ex.getMessage());
        } catch (IOException ex) {
            return new AdapterResult(false, "ADAPTER_UNAVAILABLE", safe(ex));
        }
    }

    @Override
    public CommissionResult commission(CommissionWork work) {
        try {
            ProbeResult result = query(work.configurationJson());
            RelayState state = result.state();
            List<CommissionItem> items = new ArrayList<>();
            items.add(new CommissionItem("TCP", "TCP 连接", "PASSED", "reachable", null, "SOCKET_CONNECT"));
            items.add(new CommissionItem("WIRE_ENCODING", "编码探测", "PASSED", result.encoding().name(), null, "SAFE_QUERY_0x10"));
            items.add(new CommissionItem("ADDRESS_CHECKSUM", "地址与校验和", "PASSED", "valid", null, "PROTOCOL_V2_0"));
            state.channels().forEach((band, on) -> items.add(new CommissionItem("CHANNEL_" + band.replace(".", "_"),
                    band + " 通道状态", "PASSED", on ? "ON" : "OFF", null, "READ_ONLY_RELAY_BITMAP")));
            return new CommissionResult(true, "COUNTERMEASURE_QUERY_PASSED",
                    "连接和状态查询通过；不包含射频发射能力验证", items);
        } catch (ProtocolException ex) {
            return failed(ex.code(), ex.getMessage());
        } catch (IOException ex) {
            return failed("ADAPTER_UNAVAILABLE", safe(ex));
        }
    }

    public ProbeResult query(String json) throws IOException {
        AdapterConfiguration config = AdapterConfiguration.parse(mapper, json);
        config.validateEndpoint();
        int address = config.protocol().path("device_address").asInt(1);
        WireEncoding configured;
        try { configured = WireEncoding.valueOf(config.protocol().path("wire_encoding").asText("AUTO")); }
        catch (IllegalArgumentException ex) { throw new ProtocolException("PROTOCOL_NOT_CONFIGURED", "wire_encoding 无效"); }
        List<WireEncoding> candidates = configured == WireEncoding.AUTO
                ? List.of(WireEncoding.RAW_BYTES, WireEncoding.ASCII_HEX_SPACED, WireEncoding.ASCII_HEX_COMPACT)
                : List.of(configured);
        List<InetAddress> addresses = networkPolicy.resolveAllowed(config.host(), config.allowedCidrs());
        String lastError = null;
        for (WireEncoding candidate : candidates) {
            try {
                byte[] response = exchange(addresses.get(0), config.port(), config.timeoutMillis(), address, candidate);
                RelayState state = Countermeasure4ChCodec.parseResponse(
                        Countermeasure4ChCodec.decodeWire(response, candidate), address);
                return new ProbeResult(candidate, state);
            } catch (IOException | ProtocolException ex) {
                lastError = ex.getMessage();
            }
        }
        throw new ProtocolException("PROTOCOL_FRAME_INVALID", "三种只读查询编码均未收到有效响应：" + lastError);
    }

    private byte[] exchange(InetAddress address, int port, int timeout, int deviceAddress,
                            WireEncoding encoding) throws IOException {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(address, port), timeout);
            socket.setSoTimeout(timeout);
            byte[] request = Countermeasure4ChCodec.encodeWire(Countermeasure4ChCodec.query(deviceAddress), encoding);
            socket.getOutputStream().write(request);
            socket.getOutputStream().flush();
            return readResponse(socket, encoding);
        }
    }

    private static byte[] readResponse(Socket socket, WireEncoding encoding) throws IOException {
        int expected = encoding == WireEncoding.RAW_BYTES ? 8 : encoding == WireEncoding.ASCII_HEX_COMPACT ? 16 : 23;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        while (out.size() < expected + 2) {
            try {
                int value = socket.getInputStream().read();
                if (value < 0) break;
                out.write(value);
                if (encoding != WireEncoding.RAW_BYTES && (value == '\n' || value == '\r') && out.size() >= 16) break;
                if (encoding == WireEncoding.RAW_BYTES && out.size() == 8) break;
            } catch (SocketTimeoutException ex) {
                break;
            }
        }
        byte[] value = out.toByteArray();
        if (value.length == 0) throw new SocketTimeoutException("状态查询超时");
        return value;
    }

    private static CommissionResult failed(String code, String detail) {
        return new CommissionResult(false, code, detail,
                List.of(new CommissionItem("READ_ONLY_QUERY", "只读状态查询", "FAILED", detail, null, code)));
    }

    private static String safe(Exception ex) {
        String message = ex.getMessage();
        return message == null || message.isBlank() ? ex.getClass().getSimpleName() : message;
    }

    public record ProbeResult(WireEncoding encoding, RelayState state) { }
}
