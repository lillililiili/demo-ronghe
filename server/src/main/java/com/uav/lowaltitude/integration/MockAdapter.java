package com.uav.lowaltitude.integration;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "app.source-mode", havingValue = "mock")
public class MockAdapter implements DeviceAdapterPort {

    @Override
    public String protocolCode() { return com.uav.lowaltitude.integration.device.DeviceProtocolCodes.MOCK; }

    @Override
    public boolean supportsReboot() { return true; }

    @Override
    public SourceMode mode() {
        return SourceMode.mock;
    }

    @Override
    public AdapterResult reboot(RebootWork work) {
        return new AdapterResult(true, "MOCK_REBOOTED", "开发模拟适配器已生成重启完成回执");
    }

    @Override
    public AdapterResult connect(CommissionWork work) {
        return new AdapterResult(true, "MOCK_CONNECTED", "开发模拟适配器已建立逻辑连接");
    }

    @Override
    public CommissionResult commission(CommissionWork work) {
        return new CommissionResult(true, "MOCK_PASSED", "开发模拟流程完成，不代表真实设备验收通过", java.util.List.of(
                new CommissionItem("TRANSPORT", "通信连通性", "PASSED", "reachable", null, "DEVELOPMENT_SIMULATION"),
                new CommissionItem("PAYLOAD", "接口数据校验", "PASSED", "schema accepted", null, "DEVELOPMENT_SIMULATION"),
                new CommissionItem("COORDINATE", "坐标字段检查", "PASSED", "WGS-84", null, "DEVELOPMENT_SIMULATION"),
                new CommissionItem("CLOCK", "时钟字段检查", "PASSED", "timestamp present", null, "DEVELOPMENT_SIMULATION")));
    }
}
