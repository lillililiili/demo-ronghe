package com.uav.lowaltitude.integration;

import java.util.List;

/**
 * 平台设备用例与厂商协议之间的稳定边界。真实协议只实现本接口，不能把厂商报文暴露给前端。
 */
public interface DeviceAdapterPort extends AdapterPort {

    /** 厂商协议代码；Mock 使用 MOCK_DEVICE 并可承接 mock 数据。 */
    String protocolCode();

    default boolean supportsReboot() { return false; }

    AdapterResult reboot(RebootWork work);

    AdapterResult connect(CommissionWork work);

    CommissionResult commission(CommissionWork work);

    record RebootWork(String commandId, String commandNo, String deviceId, String deviceNo, String reason) {
    }

    record CommissionWork(String taskId, String taskNo, String deviceId, String deviceNo,
                          String protocolCode, String configurationJson) {
    }

    record AdapterResult(boolean success, String resultCode, String detail) {
    }

    record CommissionItem(String code, String label, String result, String value, String unit, String basis) {
    }

    record CommissionResult(boolean success, String resultCode, String detail, List<CommissionItem> items) {
    }
}
