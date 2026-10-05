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

    def test_missing_plan_leaves_no_live_transports(self):
        with self.assertRaisesRegex(ValueError, '模拟计划'):
            self.controller.start()
        self.assertFalse(self.controller.active())
        self.assertIsNone(self.controller.presence_lock)
        self.assertFalse(self.controller.snapshot()['countermeasure']['listening'])

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


if __name__ == '__main__':
    unittest.main()
