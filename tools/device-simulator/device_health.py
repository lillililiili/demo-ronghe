"""设备开始上报、恢复上报时，顺带向本机系统报一条模拟健康状态（新-11 / 确认书 6-10）。

协议 A 心跳只带工作状态，不带健康码，平台里模拟设备的“健康”就一直是“未知”，设备运维的恢复核验
永远过不了（“连接或健康指标未知”）。这里在设备的心跳发出之前，经本机受控状态接口
POST /local-interface-simulator/device-status（只在 local,qa 运行时开放）报一条：
正常的报“良好”，模拟故障的报“故障”。先报状态再发心跳，心跳随后照常刷新在线和心跳时刻。

只在状况变了的时候报：开始上报、停发后恢复上报、暂停后继续、故障开始、故障结束。停发期间不报，
平台照常按心跳超时判离线。光电走自己的协议、没有 MQTT 设备绑定，接口不收，不报；规范化观测来源
不是设备，也不报。接口没开（404）或账号没有权限（403）时本批不再报，只记一条日志；
其余失败随下一条心跳再试，同一台连续失败 3 次后等它状况变了再试。
"""
import time
import uuid

from engine import device_condition

STATUS_PATH = '/local-interface-simulator/device-status'
# 状况 → 连接、健康码、有无告警。故障时心跳的工作状态是 2，平台记“异常”，这里一致。
REPORTS = {'ok': ('ONLINE', 'GOOD', False), 'fault': ('ABNORMAL', 'BAD', True)}
LABELS = {'ok': '良好', 'fault': '故障'}
MAX_FAILURES = 3


class DeviceHealthReporter:
    def __init__(self, platform, manifest, devices, log, clock=time.time):
        self.platform, self.manifest, self.devices, self.log, self.clock = platform, manifest, devices, log, clock
        self.prefix = 'bridge/' + str(manifest.get('provider')) + '/device/'
        entries = manifest.get('devices', {})
        self.by_external = {entries[key].get('external_id'): key for key in devices if key in entries}
        self.reported = {}
        self.failures = {}
        self.disabled = False

    def observe(self, scene, elapsed):
        """停发的设备忘掉上次报过的状况，恢复上报时随第一条心跳重新报。"""
        for device_id, device in self.devices.items():
            if device_condition(scene, device_id, device, elapsed) == 'offline':
                self.reported.pop(device_id, None)
                self.failures.pop(device_id, None)

    def forget(self):
        """暂停期间什么也不发；继续时每台设备随下一条心跳重新报一次。"""
        self.reported.clear()
        self.failures.clear()

    def before_publish(self, topic, payload):
        """心跳发出前调用；只看协议 A 心跳，其他报文直接放过。返回是否报了一条。"""
        if self.disabled or not topic.startswith(self.prefix) or 'workState' not in payload:
            return False
        device_id = self.by_external.get(payload.get('deviceId'))
        entry = self.manifest.get('devices', {}).get(device_id) if device_id else None
        if not entry or entry.get('kind') == 'eo' or not entry.get('platform_id') or not entry.get('source_id'):
            return False
        condition = 'fault' if payload.get('workState') == 2 else 'ok'
        if self.reported.get(device_id) == condition:
            return False
        failure = self.failures.get(device_id)
        if failure and failure[0] == condition and failure[1] >= MAX_FAILURES:
            return False
        connectivity, health, alarm = REPORTS[condition]
        body = {'message_id': 'sim-health-' + uuid.uuid4().hex, 'device_id': entry['platform_id'],
                'source_id': entry['source_id'], 'observed_at': int(self.clock() * 1000),
                'connectivity': connectivity, 'health_code': health, 'has_alarm': alarm}
        try:
            self.platform.call('POST', STATUS_PATH, body, body['message_id'], timeout=3)
        except Exception as error:  # 报不上不影响心跳和目标照常发送
            message = str(error)
            if '返回 404' in message or '返回 403' in message:
                self.disabled = True
                reason = ('系统未开放模拟设备状态接口（只在 local,qa 运行时开放）' if '返回 404' in message
                          else '当前账号没有上报模拟设备状态的权限')
                self.log('DEVICE_HEALTH_OFF', reason + '；本批不再报设备健康状态，设备健康在系统里仍显示未知')
                return False
            count = failure[1] + 1 if failure and failure[0] == condition else 1
            self.failures[device_id] = (condition, count)
            if count == 1 or count == MAX_FAILURES:
                self.log('DEVICE_HEALTH_FAILED', '设备健康状态未报上：' + message
                         + ('；下一条心跳再试' if count < MAX_FAILURES else '；等它状况变了再试'),
                         device=payload.get('deviceId'), health=LABELS[condition])
            return False
        self.reported[device_id] = condition
        self.failures.pop(device_id, None)
        self.log('DEVICE_HEALTH', '已向系统报设备健康：' + LABELS[condition],
                 device=payload.get('deviceId'), health=LABELS[condition])
        return True
