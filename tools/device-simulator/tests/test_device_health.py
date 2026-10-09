"""新-11：设备开始上报、恢复上报、故障起止时先报一条健康状态，再发心跳。"""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from device_health import DeviceHealthReporter, STATUS_PATH
from engine import compile_scene, messages
from server import Runtime
from test_engine import scene


class FakePlatform:
    def __init__(self, errors=()):
        self.calls = []
        self.errors = list(errors)

    def call(self, method, path, body=None, key=None, *, timeout=12):
        self.calls.append((method, path, body, key, timeout))
        if self.errors:
            error = self.errors.pop(0)
            if error: raise ValueError(error)
        return {'message_id': body['message_id']}

    def reports(self):
        return [(body['device_id'], body['connectivity'], body['health_code'], body['has_alarm'])
                for _, _, body, _, _ in self.calls]


def compiled(risks=(), health='正常', heartbeat='持续上报'):
    raw = scene()
    raw['duration'] = 1
    raw['targets'] = []
    raw['risks'] = [dict(r, id='r' + str(index), enabled=True, name=r['type']) for index, r in enumerate(risks, 1)]
    raw['sites'][0]['devices'][0].update(health=health, heartbeat=heartbeat)
    raw['sites'][0]['devices'].append({'id': 'eo1', 'name': '光电', 'kind': 'eo', 'health': '正常',
                                       'heartbeat': '持续上报', 'interval': 1})
    compiled_scene, devices, targets, _ = compile_scene(raw)
    manifest = {'provider': 'map-sim', 'devices': {
        'd1': {'external_id': 'sim-radar', 'platform_id': 'platform-radar', 'kind': 'radar', 'source_id': 'source-radar'},
        'eo1': {'external_id': 'sim-eo', 'edge_id': 'sim-eo-edge', 'platform_id': 'platform-eo', 'kind': 'eo', 'source_id': 'source-eo'}},
        'targets': {}}
    return compiled_scene, devices, targets, manifest


def drive(reporter, compiled_scene, devices, targets, manifest, seconds):
    """按发送循环的顺序：每帧先看停发，再在每条报文发出前交给上报器。"""
    last_sent, heartbeats = {}, []
    for elapsed in seconds:
        reporter.observe(compiled_scene, elapsed)
        for topic, payload in messages(compiled_scene, devices, targets, manifest, elapsed, 1_000_000 + elapsed, last_sent, 1):
            reporter.before_publish(topic, payload)
            if 'workState' in payload: heartbeats.append((elapsed, payload['workState']))
    return heartbeats


class DeviceHealthTests(unittest.TestCase):
    def test_first_heartbeat_reports_good_once_and_eo_is_left_alone(self):
        compiled_scene, devices, targets, manifest = compiled()
        platform, log = FakePlatform(), Mock()
        reporter = DeviceHealthReporter(platform, manifest, devices, log, clock=lambda: 1_700_000_000.5)
        drive(reporter, compiled_scene, devices, targets, manifest, range(4))
        self.assertEqual(platform.reports(), [('platform-radar', 'ONLINE', 'GOOD', False)])
        method, path, body, key, timeout = platform.calls[0]
        self.assertEqual((method, path, timeout), ('POST', STATUS_PATH, 3))
        self.assertEqual(body['source_id'], 'source-radar')
        self.assertEqual(body['observed_at'], 1_700_000_000_500)
        self.assertRegex(body['message_id'], r'^[A-Za-z0-9_-]{1,64}$')
        self.assertEqual(key, body['message_id'])
        log.assert_called_once()
        self.assertEqual(log.call_args.args[0], 'DEVICE_HEALTH')

    def test_device_configured_as_faulty_reports_bad_with_alarm(self):
        compiled_scene, devices, targets, manifest = compiled(health='故障')
        platform = FakePlatform()
        heartbeats = drive(DeviceHealthReporter(platform, manifest, devices, Mock()),
                           compiled_scene, devices, targets, manifest, range(3))
        self.assertEqual(platform.reports(), [('platform-radar', 'ABNORMAL', 'BAD', True)])
        self.assertEqual({state for _, state in heartbeats}, {2})

    def test_fault_window_and_resume_after_stopped_reporting_each_report_once(self):
        compiled_scene, devices, targets, manifest = compiled(risks=(
            {'type': 'fault', 'deviceId': 'd1', 'at': 3, 'seconds': 2},
            {'type': 'offline', 'deviceId': 'd1', 'at': 7, 'seconds': 2}))
        platform = FakePlatform()
        heartbeats = drive(DeviceHealthReporter(platform, manifest, devices, Mock()),
                           compiled_scene, devices, targets, manifest, range(12))
        # 心跳本身不变：故障窗口报工作状态 2，停发窗口什么也不发。
        self.assertEqual(heartbeats, [(0, 1), (1, 1), (2, 1), (3, 2), (4, 2), (5, 1), (6, 1), (9, 1), (10, 1), (11, 1)])
        self.assertEqual([health for _, _, health, _ in platform.reports()], ['GOOD', 'BAD', 'GOOD', 'GOOD'])

    def test_stopped_heartbeat_never_reports_a_fake_health(self):
        compiled_scene, devices, targets, manifest = compiled(heartbeat='停止心跳')
        platform = FakePlatform()
        drive(DeviceHealthReporter(platform, manifest, devices, Mock()), compiled_scene, devices, targets, manifest, range(5))
        self.assertEqual(platform.calls, [])

    def test_pause_reports_again_on_the_next_heartbeat(self):
        compiled_scene, devices, targets, manifest = compiled()
        platform = FakePlatform()
        reporter = DeviceHealthReporter(platform, manifest, devices, Mock())
        drive(reporter, compiled_scene, devices, targets, manifest, range(2))
        reporter.forget()
        drive(reporter, compiled_scene, devices, targets, manifest, range(2, 4))
        self.assertEqual(len(platform.calls), 2)

    def test_device_without_platform_source_is_skipped(self):
        compiled_scene, devices, targets, manifest = compiled()
        del manifest['devices']['d1']['source_id']
        platform = FakePlatform()
        drive(DeviceHealthReporter(platform, manifest, devices, Mock()), compiled_scene, devices, targets, manifest, range(2))
        self.assertEqual(platform.calls, [])

    def test_closed_interface_turns_reporting_off_with_one_log_line(self):
        for status, words in (('404', '未开放'), ('403', '没有上报')):
            with self.subTest(status=status):
                compiled_scene, devices, targets, manifest = compiled(risks=(
                    {'type': 'fault', 'deviceId': 'd1', 'at': 2, 'seconds': 2},))
                platform, log = FakePlatform([f'系统接口 {STATUS_PATH} 返回 {status}：'] * 5), Mock()
                drive(DeviceHealthReporter(platform, manifest, devices, log), compiled_scene, devices, targets, manifest, range(6))
                self.assertEqual(len(platform.calls), 1)
                log.assert_called_once()
                self.assertEqual(log.call_args.args[0], 'DEVICE_HEALTH_OFF')
                self.assertIn(words, log.call_args.args[1])

    def test_other_failures_retry_with_the_next_heartbeat_and_stop_after_three(self):
        compiled_scene, devices, targets, manifest = compiled()
        platform, log = FakePlatform(['无法连接系统 API'] * 2), Mock()
        reporter = DeviceHealthReporter(platform, manifest, devices, log)
        drive(reporter, compiled_scene, devices, targets, manifest, range(5))
        self.assertEqual([body['health_code'] for _, _, body, _, _ in platform.calls], ['GOOD'] * 3)
        self.assertEqual([call.args[0] for call in log.call_args_list], ['DEVICE_HEALTH_FAILED', 'DEVICE_HEALTH'])
        stuck_platform, stuck_log = FakePlatform(['系统接口 返回 409：旧状态不能覆盖设备的更新观测'] * 10), Mock()
        stuck = DeviceHealthReporter(stuck_platform, manifest, devices, stuck_log)
        drive(stuck, compiled_scene, devices, targets, manifest, range(8))
        self.assertEqual(len(stuck_platform.calls), 3)
        self.assertEqual([call.args[0] for call in stuck_log.call_args_list], ['DEVICE_HEALTH_FAILED'] * 2)


class RecordingClient:
    """发一条就停的 MQTT 假客户端，记下报健康和发心跳的先后。"""
    def __init__(self, runtime, order):
        self.runtime, self.order, self.connected = runtime, order, False

    def reconnect_delay_set(self, **kwargs): pass
    def connect(self, *args): pass
    def loop_start(self):
        self.connected = True
        self.on_connect(self, None, {}, SimpleNamespace(is_failure=False), None)
    def loop_stop(self): pass
    def disconnect(self): self.connected = False
    def is_connected(self): return self.connected
    def subscribe(self, topics):
        threading.Timer(.01, lambda: self.on_subscribe(self, None, 1, [SimpleNamespace(is_failure=False)] * len(topics), None)).start()
        return 0, 1

    def publish(self, topic, *args, **kwargs):
        self.order.append(('publish', topic))
        self.runtime.cancel.set()
        return SimpleNamespace(wait_for_publish=lambda **kw: None, is_published=lambda: True)


class SendLoopTests(unittest.TestCase):
    def test_send_loop_reports_health_before_the_first_heartbeat(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.batch = 'sim-health'
            (Path(root) / runtime.batch).mkdir()
            raw = scene()
            raw['targets'], raw['risks'] = [], []
            runtime.scene, devices, runtime.targets, runtime.skipped = compile_scene(raw)
            runtime.broker = {'host': '127.0.0.1', 'port': 1883}
            runtime.manifest = {'provider': 'map-sim', 'source_mode': 'replay', 'devices': {
                'd1': {'external_id': 'sim-radar', 'platform_id': 'platform-radar', 'kind': 'radar', 'source_id': 'source-radar'}}}
            order = []
            def call(method, path, body=None, key=None, **kwargs):
                if path == STATUS_PATH: order.append(('health', body['health_code']))
                return {}
            runtime.session.platform = SimpleNamespace(prepare_devices=Mock(),
                wait_for_subscriptions=Mock(return_value=True), call=Mock(side_effect=call))
            with patch('paho.mqtt.client.Client', return_value=RecordingClient(runtime, order)):
                runtime.run(devices)
            self.assertEqual(runtime.error, '')
            self.assertEqual(order, [('health', 'GOOD'), ('publish', 'bridge/map-sim/device/radar/sim-radar')])
            self.assertTrue(any(entry['kind'] == 'DEVICE_HEALTH' for entry in runtime.logs))


if __name__ == '__main__':
    unittest.main()
