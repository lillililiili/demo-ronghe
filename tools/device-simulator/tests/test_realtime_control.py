import copy
import json
import sys
import tempfile
import unittest
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from test_realtime_notification_receiver import FakeProxy, message
from realtime_notification_receiver import Receiver


class FrozenOutcomeTests(unittest.TestCase):
    def test_stop_interrupts_batch_before_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            proxy = FakeProxy(message())
            receiver = Receiver(proxy, folder)
            receiver.stop_event.set()
            self.assertFalse(receiver.step())
            self.assertEqual([], proxy.calls)

    def test_received_policy_survives_switch_and_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'outcomes.json'
            path.write_text('{"RISK_NOTICE":"no_receipt"}', encoding='utf-8')
            proxy = FakeProxy(message('RISK_NOTICE'))
            Receiver(proxy, folder, outcome_file=path).step()
            path.write_text('{}', encoding='utf-8')
            Receiver(proxy, folder, outcome_file=path).step()
            self.assertEqual([], proxy.outcomes())

    def test_play_duration_is_frozen_with_message(self):
        with tempfile.TemporaryDirectory() as folder:
            now = [100.0]
            proxy = FakeProxy(message('ADVISORY_VOICE'))
            proxy.row['created_at'] = 100000
            Receiver(proxy, folder, play_seconds=10, clock=lambda: now[0]).step()
            now[0] += 4
            Receiver(proxy, folder, play_seconds=1, clock=lambda: now[0]).step()
            self.assertEqual(['ANSWERED'], proxy.outcomes())


class RealtimeConfigurationTests(unittest.TestCase):
    def test_normal_preserves_input_and_business_risks(self):
        from realtime_control import prepare_scene, validate_config
        scene = {'duration': 20, 'sites': [{'devices': [{'health': '故障', 'heartbeat': '停止心跳'}]}],
                 'targets': [{'notificationBehavior': 'drop_sms'}],
                 'risks': [{'type': 'offline', 'enabled': True}, {'type': 'zone', 'enabled': True}]}
        original = copy.deepcopy(scene)
        result = prepare_scene(scene, validate_config({}))
        self.assertEqual(original, scene)
        self.assertEqual(0, result['duration'])
        self.assertFalse(result['risks'][0]['enabled'])
        self.assertTrue(result['risks'][1]['enabled'])
        self.assertEqual('持续上报', result['sites'][0]['devices'][0]['heartbeat'])
        self.assertEqual('none', result['targets'][0]['notificationBehavior'])

    def test_reject_unknown_config_or_voice_mode_on_sms(self):
        from realtime_control import validate_config
        for value in ({'password': 'secret'}, {'mode': 'garbage'},
                      {'outcomes': {'ADVISORY_SMS': 'answered_only'}}, {'play_seconds': float('nan')}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_config(value)

    def test_countermeasure_position_is_a_full_wgs84_pair_or_nothing(self):
        from realtime_control import validate_config
        self.assertIsNone(validate_config({})['countermeasure_longitude'])
        config = validate_config({'countermeasure_longitude': 118.6, 'countermeasure_latitude': 37.46})
        self.assertEqual((118.6, 37.46), (config['countermeasure_longitude'], config['countermeasure_latitude']))
        for value, message in (({'countermeasure_longitude': 118.6}, '要一起填'),
                               ({'countermeasure_longitude': 181, 'countermeasure_latitude': 37.46}, '经度须在 -180 到 180 之间'),
                               ({'countermeasure_longitude': 118.6, 'countermeasure_latitude': float('nan')}, '纬度须在 -90 到 90 之间'),
                               ({'countermeasure_longitude': True, 'countermeasure_latitude': 37.46}, '经度'),
                               ({'countermeasure_longitude': '118.6', 'countermeasure_latitude': 37.46}, '经度')):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, message):
                validate_config(value)

    def test_position_defaults_to_the_first_radar_and_a_typed_position_wins(self):
        from engine import coordinates
        from full_scenario import full_scene
        from realtime_control import countermeasure_position, validate_config
        scene = {'sites': [{'x': 10, 'y': 10, 'devices': [{'kind': 'eo'}]},
                           {'x': 100, 'y': 50, 'devices': [{'kind': 'tdoa'}, {'kind': 'radar'}]},
                           {'x': 300, 'y': 300, 'devices': [{'kind': 'radar'}]}]}
        expected = [round(value, 7) for value in coordinates([100, 50])]
        self.assertEqual({'longitude': expected[0], 'latitude': expected[1]}, countermeasure_position(validate_config({}), scene))
        typed = validate_config({'countermeasure_longitude': 118.7, 'countermeasure_latitude': 37.4})
        self.assertEqual({'longitude': 118.7, 'latitude': 37.4}, countermeasure_position(typed, scene))
        self.assertIsNone(countermeasure_position(validate_config({}), {'sites': [{'x': 1, 'y': 1, 'devices': [{'kind': 'eo'}]}]}))
        self.assertIsNone(countermeasure_position(validate_config({}), None))
        # 一键全量场景有雷达，反制设备跟它放在一起。
        self.assertIsNotNone(countermeasure_position(validate_config({}), full_scene()))

    def test_anomaly_scene_retains_windows_and_duration_option(self):
        from realtime_control import prepare_scene, validate_config
        scene = {'duration': 5, 'sites': [], 'targets': [], 'risks': [{'type': 'offline', 'enabled': True}]}
        self.assertEqual(scene, prepare_scene(scene, validate_config({'mode': 'abnormal', 'continuous': False})))


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        from realtime_control import RealtimeController
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.proxy = FakeProxy(message())
        self.session = SimpleNamespace(version='first', platform=True)
        self.session.request = lambda c: self.proxy.call(c['method'], c['path'], c.get('body'), c.get('key'))
        self.session.connection_scope = lambda: {'owner_org_id': None, 'district_id': None,
            'message': '未找到启用的回放 MQTT 连接 local-lingyun-replay，请手动选择归属单位与区县'}
        self.runtime = SimpleNamespace(data_dir=Path(self.temp.name), platform=True, session=self.session,
                                       lock=threading.RLock(), phase='STOPPED', cancel=threading.Event())
        self.controller = RealtimeController(self.runtime, port=19871)
        self.addCleanup(self.controller.stop)

    def test_stopped_configuration_and_restart_never_auto_receive(self):
        from realtime_control import RealtimeController
        config = {'countermeasure_enabled': False, 'mode': 'abnormal', 'outcomes': {'ADVISORY_SMS': 'no_receipt'}}
        self.controller.configure(config)
        restored = RealtimeController(self.runtime, port=19871)
        self.assertEqual('STOPPED', restored.snapshot()['state'])
        self.assertFalse(restored.active())
        self.controller.start()
        self.assertEqual('RUNNING', self.controller.snapshot()['state'])
        self.assertEqual(1, self.controller.snapshot()['notifications']['received_count'])
        with self.assertRaises(ValueError):
            self.controller.configure({})
        self.assertEqual([], self.proxy.outcomes())
        self.controller.stop()
        self.assertEqual('STOPPED', self.controller.snapshot()['state'])
        self.assertIsNone(self.controller.snapshot()['notifications']['lease_expires_at'])
        self.assertTrue(any(c[2] and c[2].get('enabled') is False for c in self.proxy.calls))

    def test_missing_scope_leaves_no_live_transports(self):
        with self.assertRaisesRegex(ValueError, '所属单位和区县'):
            self.controller.start()
        self.assertFalse(self.controller.active())
        self.assertIsNone(self.controller.presence_lock)
        self.assertFalse(self.controller.snapshot()['countermeasure']['listening'])

    def test_missing_platform_connection_says_where_to_create_it(self):
        with self.assertRaisesRegex(ValueError, '还没有启用的设备数据连接.*接口配置 → 设备数据连接'):
            self.controller.start()
        self.session.connection_scope = lambda: {'owner_org_id': None, 'district_id': None,
            'message': '模拟器连接读取失败，请手动选择归属单位与区县'}
        with self.assertRaisesRegex(ValueError, '读取设备数据连接失败'):
            self.controller.start()
        self.assertFalse(self.controller.active())

    def test_first_start_after_login_follows_the_platform_connection(self):
        # Login clears runtime.broker; the receiver must not need a scene run or a manual scope first.
        from countermeasure_tcp import CountermeasureSimulator
        from test_countermeasure_tcp import free_port
        registered = []
        def request(command):
            if command['path'].endswith('/countermeasure-device'):
                registered.append(command.get('body'))
                return {'device': {'device_id': 'cm-test'}}
            return {}
        self.session.request = request
        self.session.connection_scope = lambda: {'owner_org_id': 'org-conn', 'district_id': 'district-conn',
                                                 'broker_name': 'local-lingyun-replay'}
        self.controller.configure({'notifications_enabled': False})
        transport = CountermeasureSimulator(port=free_port())
        with patch('countermeasure_tcp.CountermeasureSimulator', return_value=transport):
            self.controller.start()
        self.addCleanup(self.controller.stop)
        self.assertEqual('RUNNING', self.controller.snapshot()['state'])
        self.assertEqual([{'owner_org_id': 'org-conn', 'district_id': 'district-conn'}], registered)

    def test_countermeasure_device_is_registered_where_the_scene_radar_stands(self):
        from countermeasure_tcp import CountermeasureSimulator
        from engine import coordinates
        from test_countermeasure_tcp import free_port
        registered = []
        def request(command):
            if command['path'].endswith('/countermeasure-device'):
                body = command.get('body')
                registered.append(body)
                device = {'device_id': 'cm-test'}
                if 'longitude' in body:
                    device.update(longitude=body['longitude'], latitude=body['latitude'])
                return {'device': device}
            return {}
        self.session.request = request
        self.runtime.scene = {'sites': [{'x': 100, 'y': 50, 'devices': [{'kind': 'radar'}]}]}
        self.controller.configure({'notifications_enabled': False, 'countermeasure_scope': 'test-org|test-district'})
        radar = [round(value, 7) for value in coordinates([100, 50])]
        with patch('countermeasure_tcp.CountermeasureSimulator', return_value=CountermeasureSimulator(port=free_port())):
            self.controller.start()
        self.assertEqual({'owner_org_id': 'test-org', 'district_id': 'test-district',
                          'longitude': radar[0], 'latitude': radar[1]}, registered[-1])
        self.assertEqual({'longitude': radar[0], 'latitude': radar[1]}, self.controller.snapshot()['countermeasure_position'])
        self.controller.stop()
        # 开始模拟时用这次要跑的场景，不用上一次的。
        with patch('countermeasure_tcp.CountermeasureSimulator', return_value=CountermeasureSimulator(port=free_port())):
            self.controller.start({'sites': [{'x': 300, 'y': 0, 'devices': [{'kind': 'radar'}]}]})
        self.assertEqual(round(coordinates([300, 0])[0], 7), registered[-1]['longitude'])
        self.controller.stop()
        # 场景里没有雷达、也没填经纬度：照旧登记，只是不带位置。
        self.runtime.scene = {'sites': []}
        with patch('countermeasure_tcp.CountermeasureSimulator', return_value=CountermeasureSimulator(port=free_port())):
            self.controller.start()
        self.assertEqual({'owner_org_id': 'test-org', 'district_id': 'test-district'}, registered[-1])
        self.assertIsNone(self.controller.snapshot()['countermeasure_position'])

    def test_disabling_receiver_after_stop_does_not_reuse_it(self):
        self.controller.configure({'countermeasure_enabled': False})
        self.controller.start()
        self.controller.stop()
        self.proxy.calls.clear()
        self.controller.configure({'countermeasure_enabled': False, 'notifications_enabled': False})
        self.controller.start()
        time.sleep(.6)
        self.assertIsNone(self.controller.receiver)
        self.assertFalse(any(c[1].endswith('/bindings') for c in self.proxy.calls))

    def test_login_change_stops_receiver(self):
        self.controller.configure({'countermeasure_enabled': False})
        self.controller.start()
        self.session.version = 'second'
        self.runtime.platform = None
        deadline = time.monotonic() + 3
        while self.controller.active() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual('FAILED', self.controller.snapshot()['state'])
        self.assertTrue(self.runtime.cancel.is_set())

    def test_stop_waits_for_startup_and_leaves_no_receiver(self):
        self.controller.configure({'countermeasure_enabled': False})
        entered, release, stopped = threading.Event(), threading.Event(), threading.Event()
        original = self.session.request
        def request(command):
            if not entered.is_set():
                entered.set()
                release.wait(2)
            return original(command)
        self.session.request = request
        starter = threading.Thread(target=self.controller.start)
        stopper = threading.Thread(target=lambda: (self.controller.stop(), stopped.set()))
        starter.start()
        self.assertTrue(entered.wait(1))
        stopper.start()
        try:
            self.assertFalse(stopped.wait(.1))
        finally:
            release.set()
            starter.join(3)
            stopper.join(3)
        self.assertFalse(starter.is_alive())
        self.assertFalse(stopper.is_alive())
        self.assertFalse(self.controller.active())
        self.assertEqual('STOPPED', self.controller.snapshot()['state'])

    def test_cancelled_receiver_step_is_not_a_tcp_failure(self):
        self.controller.tcp = SimpleNamespace(stop=lambda: None, snapshot=lambda: {'listening': False})
        def interrupted():
            self.controller.cancel.set()
            return False
        self.controller.receiver = SimpleNamespace(step=interrupted, stop_event=threading.Event())
        with patch.object(self.controller, 'cleanup'), patch.object(self.controller, 'update_receiver_status'):
            self.controller.run(None)
        self.controller.receiver = None
        self.assertEqual('', self.controller.error)
        self.assertEqual('STOPPED', self.controller.state)

    def test_occupied_tcp_endpoint_is_rejected_without_sending_any_command(self):
        from countermeasure_tcp import CountermeasureSimulator
        from test_countermeasure_tcp import free_port
        owner = CountermeasureSimulator(port=free_port())
        owner.start()
        self.addCleanup(owner.stop)
        self.session.request = lambda command: ({'device': {'device_id': 'cm-test'}}
            if command['path'].endswith('/countermeasure-device') else {})
        for mode in ('success', 'no_receipt', 'unchanged'):
            self.controller.configure({'mode':'abnormal', 'command_mode':mode,
                'notifications_enabled':False, 'countermeasure_scope':'test-org|test-district'})
            contender = CountermeasureSimulator(port=owner.port, command_mode=mode)
            with patch('countermeasure_tcp.CountermeasureSimulator', return_value=contender):
                with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, '端口已被占用'):
                    self.controller.start()
            self.assertFalse(self.controller.active())
            self.assertIsNone(self.controller.presence_lock)
            self.assertFalse(self.controller.snapshot()['countermeasure']['listening'])
            self.assertEqual(0, owner.snapshot()['received'])

    def test_controller_modes_and_status_match_real_tcp_receipts(self):
        import socket
        from countermeasure_tcp import CountermeasureSimulator
        from test_countermeasure_tcp import free_port, frame, reply
        self.session.request = lambda command: ({'device': {'device_id': 'cm-test'}}
            if command['path'].endswith('/countermeasure-device') else {})
        for mode, response, mask in [('success', reply(0x12, 1), 1),
                                     ('no_receipt', b'', 0), ('unchanged', reply(0x12, 0), 0)]:
            self.controller.configure({'mode':'abnormal', 'command_mode':mode,
                'notifications_enabled':False, 'countermeasure_scope':'test-org|test-district'})
            transport = CountermeasureSimulator(port=free_port(), command_mode=mode)
            with patch('countermeasure_tcp.CountermeasureSimulator', return_value=transport) as factory:
                try:
                    self.controller.start()
                    self.assertEqual(mode, factory.call_args.kwargs['command_mode'])
                    with socket.create_connection(('127.0.0.1', transport.port), timeout=1) as conn:
                        conn.sendall(frame(0x12, 1))
                        self.assertEqual(response, conn.recv(8))
                    status = self.controller.snapshot()['countermeasure']
                    self.assertEqual(mask, status['relay_mask'])
                    self.assertEqual(1, status['received'])
                    self.assertIsNotNone(status['last_received_at'])
                finally:
                    self.controller.stop()


if __name__ == '__main__':
    unittest.main()
