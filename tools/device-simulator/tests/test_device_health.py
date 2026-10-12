"""设备变化立即报健康，持续运行每30秒补报；停发不冒充恢复。"""
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


def compiled(risks=(), health='正常', heartbeat='持续上报', include_eo=False):
    raw = scene()
    raw['duration'] = 10
    raw['targets'] = []
    raw['risks'] = [dict(r, id='r' + str(index), enabled=True, name=r['type']) for index, r in enumerate(risks, 1)]
    raw['sites'][0]['devices'][0].update(health=health, heartbeat=heartbeat)
    raw['sites'][0]['devices'].append({'id': 'eo1', 'name': '光电', 'kind': 'eo', 'health': '正常',
                                       'heartbeat': '持续上报', 'interval': 1})
    if not include_eo:
        raw['sites'][0]['devices'] = raw['sites'][0]['devices'][:1]
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
    def test_first_radar_heartbeat_reports_good_once(self):
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

    def test_other_failures_retry_with_the_next_heartbeat_then_back_off(self):
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


    def test_periodic_explicit_health_remains_fresh_for_ten_minutes(self):
        for health, expected in (('正常', 'GOOD'), ('故障', 'BAD')):
            with self.subTest(health=health):
                compiled_scene, devices, targets, manifest = compiled(health=health)
                platform, log = FakePlatform(), Mock()
                now = [1_800_000_000.0]
                reporter = DeviceHealthReporter(platform, manifest, devices, log, clock=lambda: now[0])
                for second in range(601):
                    now[0] = 1_800_000_000 + second
                    drive(reporter, compiled_scene, devices, targets, manifest, [second])
                self.assertEqual(len(platform.calls), 21)
                self.assertEqual({body['health_code'] for _, _, body, _, _ in platform.calls}, {expected})
                self.assertEqual([body['observed_at'] for _, _, body, _, _ in platform.calls],
                                 [(1_800_000_000 + second) * 1000 for second in range(0, 601, 30)])
                self.assertEqual(len({body['message_id'] for _, _, body, _, _ in platform.calls}), 21)
                # 重复明确健康不是一次新业务动作，不逐条刷运行日志。
                self.assertEqual(log.call_count, 1)

    def test_failed_reports_resume_after_cooldown_without_a_condition_change(self):
        compiled_scene, devices, targets, manifest = compiled()
        platform = FakePlatform(['temporary network error'] * 3)
        now = [1_800_000_000.0]
        reporter = DeviceHealthReporter(platform, manifest, devices, Mock(), clock=lambda: now[0])
        for second in range(64):
            now[0] = 1_800_000_000 + second
            drive(reporter, compiled_scene, devices, targets, manifest, [second])
        self.assertEqual([body['observed_at'] for _, _, body, _, _ in platform.calls],
                         [(1_800_000_000 + second) * 1000 for second in (0, 1, 2, 32, 62)])
        self.assertEqual(reporter.failures, {})

    def test_condition_change_bypasses_failure_cooldown(self):
        compiled_scene, devices, targets, manifest = compiled(risks=(
            {'type': 'fault', 'deviceId': 'd1', 'at': 4, 'seconds': 10},))
        platform = FakePlatform(['temporary network error'] * 3)
        now = [1_800_000_000.0]
        reporter = DeviceHealthReporter(platform, manifest, devices, Mock(), clock=lambda: now[0])
        for second in range(7):
            now[0] = 1_800_000_000 + second
            drive(reporter, compiled_scene, devices, targets, manifest, [second])
        self.assertEqual([body['health_code'] for _, _, body, _, _ in platform.calls], ['GOOD', 'GOOD', 'GOOD', 'BAD'])
        self.assertEqual(platform.calls[-1][2]['observed_at'], 1_800_000_004_000)

    def test_offline_window_cancels_periodic_health_and_resume_reports_first(self):
        for offset in (30, 47):
            with self.subTest(offset=offset):
                compiled_scene, devices, targets, manifest = compiled(risks=(
                    {'type': 'offline', 'deviceId': 'd1', 'at': offset, 'seconds': 150},))
                platform = FakePlatform()
                now = [1_800_000_000.0]
                reporter = DeviceHealthReporter(platform, manifest, devices, Mock(), clock=lambda: now[0])
                for second in range(offset + 160):
                    now[0] = 1_800_000_000 + second
                    drive(reporter, compiled_scene, devices, targets, manifest, [second])
                report_seconds = [body['observed_at'] // 1000 - 1_800_000_000 for _, _, body, _, _ in platform.calls]
                self.assertFalse(any(offset <= second < offset + 150 for second in report_seconds))
                self.assertIn(offset + 150, report_seconds)

    def test_unknown_work_state_does_not_report_good(self):
        _, devices, _, manifest = compiled()
        platform = FakePlatform()
        reporter = DeviceHealthReporter(platform, manifest, devices, Mock())
        for work_state in (0, 3, None, 'unknown'):
            reporter.before_publish('bridge/map-sim/device/radar/sim-radar',
                                    {'deviceId': 'sim-radar', 'workState': work_state})
        self.assertEqual(platform.calls, [])

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


class EoHealthTests(unittest.TestCase):
    def test_registered_eo_reports_explicit_health_through_offline_and_resume_for_ten_minutes(self):
        for offset, suffix in ((30, 'alpha'), (47, 'beta')):
            with self.subTest(offset=offset, suffix=suffix):
                scene_, devices, targets, manifest = compiled(include_eo=True, risks=(
                    {'type': 'offline', 'deviceId': 'eo1', 'at': offset, 'seconds': 40},))
                entry = manifest['devices']['eo1']
                entry.update(external_id='eo-' + suffix, edge_id='edge-' + suffix,
                             platform_id='platform-' + suffix, source_id='source-' + suffix)
                now = [1_800_000_000.0]
                platform = FakePlatform()
                reporter = DeviceHealthReporter(platform, manifest, devices, Mock(), clock=lambda: now[0])
                for second in range(601):
                    now[0] = 1_800_000_000 + second
                    drive(reporter, scene_, devices, targets, manifest, [second])
                bodies = [body for _, _, body, _, _ in platform.calls if body['device_id'] == entry['platform_id']]
                times = [(body['observed_at'] // 1000) - 1_800_000_000 for body in bodies]
                self.assertTrue(all(not offset <= t < offset + 40 for t in times))
                self.assertIn(offset + 40, times)
                self.assertGreaterEqual(times[-1], 570)
                self.assertEqual({(b['source_id'], b['health_code'], b['has_alarm']) for b in bodies},
                                 {(entry['source_id'], 'GOOD', False)})

    def test_eo_needs_matching_identity_and_explicit_scene_facts_not_work_state(self):
        import copy
        scene_, devices, targets, manifest = compiled(include_eo=True)
        platform = FakePlatform()
        reporter = DeviceHealthReporter(platform, manifest, devices, Mock())
        topic, payload = next((t, p) for t, p in messages(scene_, devices, targets, manifest, 0, 1000, {}, 1)
                              if p.get('event') == 'HeartBeat')
        self.assertFalse(reporter.before_publish(topic, payload))  # No scene evidence yet.
        reporter.observe(scene_, 0)
        for field in ('topic', 'edgeId', 'deviceId', 'event', 'source_id'):
            with self.subTest(field=field):
                changed = copy.deepcopy(payload)
                selected_topic = topic
                source = manifest['devices']['eo1'].get('source_id')
                if field == 'topic': selected_topic += '-other'
                elif field == 'deviceId': changed['metadata'][field] += '-other'
                elif field == 'source_id': manifest['devices']['eo1']['source_id'] = None
                else: changed[field] = 'other'
                self.assertFalse(reporter.before_publish(selected_topic, changed))
                manifest['devices']['eo1']['source_id'] = source
        payload['metadata']['workState'] = 2  # Busy/tracking is not a known health fault code.
        self.assertTrue(reporter.before_publish(topic, payload))
        self.assertEqual(platform.reports(), [('platform-eo', 'ONLINE', 'GOOD', False)])
        reporter.forget()
        self.assertFalse(reporter.before_publish(topic, payload))
        devices['eo1']['heartbeat'] = '停止心跳'
        reporter.observe(scene_, 5)
        self.assertFalse(reporter.before_publish(topic, payload))

    def test_eo_failure_is_visible_and_retried_without_changing_protocol_messages(self):
        scene_, devices, targets, manifest = compiled(include_eo=True, heartbeat='停止心跳')
        now = [1_800_000_000.0]
        platform, log = FakePlatform(['temporary failure'] * 3), Mock()
        reporter = DeviceHealthReporter(platform, manifest, devices, log, clock=lambda: now[0])
        for second in range(34):
            now[0] = 1_800_000_000 + second
            drive(reporter, scene_, devices, targets, manifest, [second])
        self.assertEqual(len(platform.calls), 4)
        self.assertEqual([call.args[0] for call in log.call_args_list],
                         ['DEVICE_HEALTH_FAILED', 'DEVICE_HEALTH_FAILED', 'DEVICE_HEALTH'])
        self.assertEqual(reporter.failures, {})


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


    def test_pause_during_batch_or_wait_prevents_later_health_and_heartbeats(self):
        for pause_at in ('health', 'publish', 'message_reconnect', 'outer_reconnect', 'message_subscription'):
            with self.subTest(pause_at=pause_at), tempfile.TemporaryDirectory() as root:
                runtime = Runtime(root)
                runtime.batch = 'sim-pause-health'
                (Path(root) / runtime.batch).mkdir()
                raw = scene()
                raw['targets'], raw['risks'] = [], []
                raw['sites'][0]['devices'].append(dict(raw['sites'][0]['devices'][0], id='d2'))
                runtime.scene, devices, runtime.targets, runtime.skipped = compile_scene(raw)
                runtime.broker = {'host': '127.0.0.1', 'port': 1883}
                runtime.manifest = {'provider': 'map-sim', 'source_mode': 'replay', 'devices': {
                    key: {'external_id': 'sim-' + key, 'platform_id': 'platform-' + key,
                          'kind': 'radar', 'source_id': 'source-' + key} for key in ('d1', 'd2')}}
                order = []
                def pause():
                    with runtime.lock: runtime.phase = 'PAUSED'
                def call(method, path, body=None, key=None, **kwargs):
                    if path == STATUS_PATH:
                        order.append(('health', body['device_id']))
                        if pause_at == 'health': pause()
                    return {}
                runtime.session.platform = SimpleNamespace(prepare_devices=Mock(),
                    wait_for_subscriptions=Mock(return_value=True), call=Mock(side_effect=call))
                client = RecordingClient(runtime, order)
                def publish(topic, *args, **kwargs):
                    order.append(('publish', topic))
                    if pause_at == 'publish': pause()
                    return SimpleNamespace(wait_for_publish=lambda **kw: None, is_published=lambda: True)
                client.publish = publish
                def reconnect(_client):
                    pause()
                    client.connected = True
                    return True
                runtime.wait_for_mqtt_reconnect = Mock(side_effect=reconnect)
                if pause_at == 'outer_reconnect':
                    runtime.check_session = Mock(side_effect=lambda _: setattr(client, 'connected', False))
                def packets(*args):
                    for index, message in enumerate(messages(*args)):
                        if index == 0 and pause_at == 'message_reconnect': client.connected = False
                        yield message
                from mqtt_recovery import CommandSubscriptions
                original_ready = CommandSubscriptions.wait_ready
                ready_calls = []
                def ready(subscription, cancelled, timeout=6):
                    result = original_ready(subscription, cancelled, timeout)
                    ready_calls.append(result)
                    # Initial subscribe, outer frame, then the first per-message wait.
                    if pause_at == 'message_subscription' and len(ready_calls) == 3: pause()
                    return result
                def finish_frame(timeout=None):
                    runtime.cancel.set()
                    return True
                with patch('paho.mqtt.client.Client', return_value=client), \
                     patch('server.messages', side_effect=packets), \
                     patch.object(CommandSubscriptions, 'wait_ready', ready), \
                     patch.object(runtime.cancel, 'wait', side_effect=finish_frame):
                    runtime.run(devices)
                self.assertEqual(runtime.error, '')
                expected = [('health', 'platform-d1')] if pause_at in ('health', 'publish') else []
                if pause_at == 'publish': expected.append(('publish', 'bridge/map-sim/device/radar/sim-d1'))
                self.assertEqual(order, expected)
                self.assertEqual(runtime.sent, 1 if pause_at == 'publish' else 0)
                if pause_at.endswith('reconnect'): runtime.wait_for_mqtt_reconnect.assert_called_once()


if __name__ == '__main__':
    unittest.main()
