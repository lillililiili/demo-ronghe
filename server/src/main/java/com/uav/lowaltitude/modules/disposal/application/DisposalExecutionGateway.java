package com.uav.lowaltitude.modules.disposal.application;

import java.util.Map;

import org.springframework.stereotype.Component;

import com.uav.lowaltitude.modules.device.application.LingyunControlService;
import com.uav.lowaltitude.modules.device.domain.MqttConfiguration.Binding;
import com.uav.lowaltitude.modules.device.infrastructure.DeviceRepository;
import com.uav.lowaltitude.modules.device.infrastructure.MqttRepository;
import com.uav.lowaltitude.integration.mqtt.LingyunControlEnvelope;
import com.uav.lowaltitude.modules.disposal.domain.DisposalPolicy;
import com.uav.lowaltitude.modules.disposal.domain.DisposalRules;
import com.uav.lowaltitude.platform.api.ApiException;

/**
 * 通往协作者 A 设备控制面的唯一出口。B 不自己拼协议、不自己发 MQTT，只调 A 的 enqueue（决策 13-3）。
 *
 * A 的拒绝**分四种**（决策 13-14 / 13-22），因为补救的人不同：设备本身没能力要换设备、
 * 指令码未开通要等厂家、没登记 MQTT 运维补一条就行、设备离线是现场的事。
 * 压成"不可用"一个码，运维会把自己五分钟能修的事当成厂家的事一直挂着。
 *
 * 本期的事实：A 的 LingyunControlEnvelope.family() 只映射 radar/oe/aoa/tdoa，
 * 处置要用的 60002/60003/70001/50002 一律没有设备类型缩写，enqueue 抛 PROTOCOL_UNSUPPORTED
 * （A 自己的 LingyunControlMqttTest 对 50002 就是这么断言的，用例名"诱骗未开放"）。
 * 也就是说 LINGYUN_B 通道现在发不出任何一条处置指令；等 A 开通映射后这条路不改代码就能活。
 */
@Component
public class DisposalExecutionGateway {
    /** 设备侧没有自动执行能力（四通道反制等 B 侧预检）。 */
    public static final String EVENT_NO_CAPABILITY = "DEVICE_CONTROL_UNAVAILABLE";
    /** 指令码在 A 的协议面尚未开通。 */
    public static final String EVENT_PROTOCOL_NOT_OPENED = "PROTOCOL_NOT_OPENED";
    /** 设备未登记凌云 MQTT。 */
    public static final String EVENT_NOT_BOUND = "DEVICE_NOT_BOUND";
    /** 设备未启用或不在线。 */
    public static final String EVENT_OFFLINE = "DEVICE_OFFLINE";

    private final LingyunControlService control;
    private final MqttRepository mqtt;
    private final DeviceRepository devices;

    public DisposalExecutionGateway(LingyunControlService control, MqttRepository mqtt, DeviceRepository devices) {
        this.control = control; this.mqtt = mqtt; this.devices = devices;
    }

    /** 设备是否已登记凌云 MQTT 绑定；停止路径据此区分 NOT_BOUND 与 UNAVAILABLE（停止路径仍是二分，13-11）。 */
    public boolean bound(String deviceId) {
        if (deviceId == null) return false;
        Binding binding = mqtt.binding(deviceId, false);
        return binding != null;
    }

    /**
     * 经协议 B 下发一条处置指令。
     *
     * **四种受阻原因一律先自检，不靠捕获 A 的异常。** 原因是硬的：A 的 enqueue 带 @Transactional，
     * 它在我的事务里抛异常会把整个事务标成 rollback-only——即使我 catch 住，随后写的"受阻事件"
     * 也提交不了，最终以 UnexpectedRollbackException 变成 500。也就是说"捕获后记事件"这条路根本走不通。
     * 先检查再调用，则正常路径上 A 根本不会抛，事件能踏实落库。
     *
     * 自检用的是 A 自己的公开判据（family 映射、绑定表、设备行），不复制它的规则：
     * 判据变了这里会跟着变，不会各说各话。
     *
     * 仍然可能抛：A 还有别的拒绝理由（指令码与设备类型不匹配、参数非法等）。那些是请求本身的问题，
     * 不是"设备侧受阻"，原样上抛让调用方看见真实原因，也不该记进授权的事件流（13-14）。
     */
    public Result dispatch(String deviceId, String idempotencyKey, String authorizationId, DisposalPolicy policy,
                           String actionType, Map<String, Object> operationParams, String reason) {
        DisposalPolicy.Command command = policy.command(actionType);
        // 顺序有意：先判"指令码开没开通"。它一旦没开通，补绑定、把设备弄上线都没用——
        // 先报 NOT_BOUND 会把运维支去做一件做完仍然执行不了的事。三条各自独立成立时，报最靠前那条。
        // ① 指令码在 A 的协议面还没开通（本期四种处置动作都卡在这一条）——补救方是厂家。
        if (LingyunControlEnvelope.family(command.operationCmd()) == null) {
            return new Rejected(EVENT_PROTOCOL_NOT_OPENED, "DEVICE_CONTROL_UNAVAILABLE",
                    "指令码 " + command.operationCmd() + " 对应的设备类型缩写尚未确认，协议面未开通，不能下发");
        }
        // ② 设备没登记凌云 MQTT——补救方是运维。
        if (!bound(deviceId)) {
            return new Rejected(EVENT_NOT_BOUND, "DEVICE_NOT_BOUND", "该设备未登记凌云 MQTT，不能按协议 B 下发处置指令");
        }
        // ③ 设备未启用或不在线——补救方是现场。
        Map<String, Object> device = devices.find(deviceId);
        if (device != null && !operable(device)) {
            return new Rejected(EVENT_OFFLINE, "DEVICE_OFFLINE", "设备未启用或不在线，暂不能下发处置指令");
        }
        String commandId = control.enqueue(deviceId, idempotencyKey, authorizationId, command.operationType(),
                command.operationCmd(), operationParams, reason);
        return new Accepted(commandId);
    }

    private static boolean operable(Map<String, Object> device) {
        Object enabled = device.get("enabled");
        boolean on = enabled instanceof Boolean b ? b : enabled != null && Boolean.parseBoolean(String.valueOf(enabled));
        return on && "ONLINE".equals(String.valueOf(device.get("connectivity")));
    }

    /** 四通道反制适配器只有状态查询、没有执行能力：B 侧预检直接判定，不去打扰 A（决策 13-3）。 */
    public static Rejected noCapability(String channel) {
        return new Rejected(EVENT_NO_CAPABILITY, "DEVICE_CONTROL_UNAVAILABLE",
                "该通道（" + channel + "）的设备只有状态查询能力，本期不能自动执行处置");
    }

    /** 下发结果。Accepted 才允许把授权推进到 EXECUTING。 */
    public sealed interface Result permits Accepted, Rejected { }

    public record Accepted(String commandId) implements Result { }

    /** eventKind 进事件流并据此推导 execution_block_reason；errorCode 是给调用方的 HTTP 错误码。 */
    public record Rejected(String eventKind, String errorCode, String detail) implements Result { }

    public static boolean deviceChannel(String channel) {
        return DisposalRules.LINGYUN_B.equals(channel) || DisposalRules.COUNTERMEASURE_4CH.equals(channel);
    }
}
