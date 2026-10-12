"""设备开始上报、恢复上报时，顺带向本机系统报一条模拟健康状态（新-11 / 确认书 6-10）。

协议 A 心跳只带工作状态，不带健康码，平台里模拟设备的“健康”就一直是“未知”，设备运维的恢复核验
永远过不了（“连接或健康指标未知”）。这里在设备的心跳发出之前，经本机受控状态接口
POST /local-interface-simulator/device-status（只在 local,qa 运行时开放）报一条：
正常的报“良好”，模拟故障的报“故障”。先报状态再发心跳，心跳随后照常刷新在线和心跳时刻。

状况变化立即上报，状况不变每 30 秒明确上报健康和告警，避免新心跳续期旧健康。停发期间不报，
平台照常按心跳超时判离线。光电按已登记的边缘节点和设备身份走同一受控模拟状态接口，
健康依据来自场景配置，不从光电工作状态或相机状态推断；规范化观测来源不是设备，不报。接口没开（404）或账号没有权限（403）时本批不再报，只记一条日志；
其余失败先随下一条心跳重试，连续失败 3 次后每 30 秒重试；状况变化立即重试。
"""
import time
import uuid

from engine import device_condition

STATUS_PATH = '/local-interface-simulator/device-status'
# 状况 → 连接、健康码、有无告警。故障时心跳的工作状态是 2，平台记“异常”，这里一致。
REPORTS = {'ok': ('ONLINE', 'GOOD', False), 'fault': ('ABNORMAL', 'BAD', True)}
LABELS = {'ok': '良好', 'fault': '故障'}
MAX_FAILURES = 3
REPORT_INTERVAL_SECONDS = 30


class DeviceHealthReporter:
    def __init__(self, platform, manifest, devices, log, clock=time.time):
        self.platform, self.manifest, self.devices, self.log, self.clock = platform, manifest, devices, log, clock
        self.prefix = 'bridge/' + str(manifest.get('provider')) + '/device/'
        entries = manifest.get('devices', {})
        self.by_external = {entries[key].get('external_id'): key for key in devices if key in entries}
        self.conditions = {}
        self.reported = {}
        self.failures = {}
        self.reported_at = {}
        self.retry_at = {}
        self.disabled = False

    def observe(self, scene, elapsed):
        """停发的设备忘掉上次报过的状况，恢复上报时随第一条心跳重新报。"""
        for device_id, device in self.devices.items():
            self.conditions[device_id] = device_condition(scene, device_id, device, elapsed)
            if self.conditions[device_id] == 'offline':
                self.reported.pop(device_id, None)
                self.failures.pop(device_id, None)
                self.reported_at.pop(device_id, None)
                self.retry_at.pop(device_id, None)

    def forget(self):
        """暂停期间什么也不发；继续时每台设备随下一条心跳重新报一次。"""
        self.conditions.clear()
        self.reported.clear()
        self.failures.clear()
        self.reported_at.clear()
        self.retry_at.clear()

    def before_publish(self, topic, payload):
        """只随将要发送且身份吻合的心跳补充明确模拟状态；不推断光电健康。"""
        if self.disabled:
            return False
        eo_heartbeat = payload.get('event') == 'HeartBeat'
        external = (payload.get('metadata') or {}).get('deviceId') if eo_heartbeat else payload.get('deviceId')
        device_id = self.by_external.get(external)
        entry = self.manifest.get('devices', {}).get(device_id) if device_id else None
        if not entry or not entry.get('platform_id') or not entry.get('source_id'):
            return False
        if entry.get('kind') == 'eo':
            if (not eo_heartbeat or not entry.get('edge_id') or payload.get('edgeId') != entry['edge_id']
                    or topic != 'iot-reporting/cmlc/edge/' + entry['edge_id']):
                return False
            # 场景已验证光电不支持故障码。正常/离线来自明确场景配置，追踪工作状态不作健康码。
            if self.conditions.get(device_id) != 'ok' or self.devices[device_id].get('health') != '正常':
                return False
            condition = 'ok'
        else:
            if topic != self.prefix + str(entry.get('kind')) + '/' + str(external) or payload.get('workState') not in (1, 2):
                return False
            condition = 'fault' if payload['workState'] == 2 else 'ok'
        now = self.clock()
        failure = self.failures.get(device_id)
        if failure and failure[0] == condition and now < self.retry_at.get(device_id, 0):
            return False
        if not failure and self.reported.get(device_id) == condition and 0 <= now - self.reported_at.get(device_id, 0) < REPORT_INTERVAL_SECONDS:
            return False
        connectivity, health, alarm = REPORTS[condition]
        body = {'message_id': 'sim-health-' + uuid.uuid4().hex, 'device_id': entry['platform_id'],
                'source_id': entry['source_id'], 'observed_at': int(now * 1000),
                'connectivity': connectivity, 'health_code': health, 'has_alarm': alarm}
        try:
            self.platform.call('POST', STATUS_PATH, body, body['message_id'], timeout=3)
        except Exception as error:  # 报不上不影响心跳和目标照常发送
            message = str(error)
            if '返回 404' in message or '返回 403' in message:
                self.disabled = True
                reason = ('系统未开放模拟设备状态接口（只在 local,qa 运行时开放）' if '返回 404' in message
                          else '当前账号没有上报模拟设备状态的权限')
                self.log('DEVICE_HEALTH_OFF', reason + '；本批健康来源不可用，不能据此确认设备恢复')
                return False
            count = failure[1] + 1 if failure and failure[0] == condition else 1
            self.failures[device_id] = (condition, count)
            self.retry_at[device_id] = now + REPORT_INTERVAL_SECONDS if count >= MAX_FAILURES else now
            if count == 1 or count == MAX_FAILURES:
                self.log('DEVICE_HEALTH_FAILED', '设备健康状态未报上：' + message
                         + ('；下一条心跳再试' if count < MAX_FAILURES else '；每 30 秒继续重试，状况变化立即重试'),
                         device=external, health=LABELS[condition])
            return False
        changed = self.reported.get(device_id) != condition or bool(failure)
        self.reported[device_id] = condition
        self.reported_at[device_id] = now
        self.failures.pop(device_id, None)
        self.retry_at.pop(device_id, None)
        if changed: self.log('DEVICE_HEALTH', '已向系统报设备健康：' + LABELS[condition],
                 device=external, health=LABELS[condition])
        return True
