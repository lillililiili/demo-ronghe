"""New batch frames must wait for the backend's confirmed MQTT subscriptions."""
import copy
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from platform_client import Platform
from server import Runtime


class ClockEvent:
    def __init__(self):
        self.now = 0
        self.stopped = False
        self.on_wait = None

    def is_set(self):
        return self.stopped

    def wait(self, seconds):
        self.now += seconds
        if self.on_wait:
            self.on_wait()
        return self.stopped


class SubscriptionReadinessTests(unittest.TestCase):
    def setUp(self):
        self.api = Platform('http://127.0.0.1:8081/api/v1')
        self.cancel = ClockEvent()
        self.broker = {'broker_id': 'broker'}
        self.manifest = {'devices': {
            'radar': {'platform_id': 'one', 'external_id': 'batch-1'},
            'eo': {'platform_id': 'two', 'external_id': 'batch-2'}}}
        self.ready = [dict(device_id=d['platform_id'], source_mode='replay', details=dict(
            broker_id='broker', external_device_id=d['external_id'],
            connection_state='CONNECTED', broker_enabled=True, subscribed=True))
            for d in self.manifest['devices'].values()]

    def wait(self, timeout=1):
        with patch('platform_client.time.monotonic', side_effect=lambda: self.cancel.now):
            return self.api.wait_for_subscriptions(self.manifest, self.broker, self.cancel, timeout)

    def test_waits_for_last_device_and_rechecks_earlier_devices(self):
        pending = copy.deepcopy(self.ready[1])
        pending['details']['subscribed'] = False
        disconnected = copy.deepcopy(self.ready[0])
        disconnected['details']['connection_state'] = 'DISCONNECTED'
        self.api.call = Mock(side_effect=[self.ready[0], pending, disconnected, self.ready[1], *self.ready])
        self.assertTrue(self.wait())
        self.assertEqual(self.api.call.call_count, 6)
        self.assertEqual(self.cancel.now, .5)

    def test_missing_false_or_string_subscription_and_disabled_broker_never_ready(self):
        for change in ({'subscribed': False}, {'subscribed': None}, {'subscribed': 'true'},
                       {'broker_enabled': False}, {'connection_state': 'DISCONNECTED'}):
            with self.subTest(change=change):
                self.cancel = ClockEvent()
                def read(method, path, **kwargs):
                    status = copy.deepcopy(self.ready[0 if '/one/' in path else 1])
                    status['details'].update(change)
                    return status
                self.api.call = Mock(side_effect=read)
                with self.assertRaisesRegex(ValueError, '订阅等待超时'):
                    self.wait()
                self.assertEqual(self.cancel.now, 1)

    def test_wrong_batch_identity_or_live_source_fails_closed(self):
        for field, value in [('device_id', 'wrong'), ('source_mode', 'live'),
                             ('broker_id', 'wrong'), ('external_device_id', 'old-batch')]:
            status = copy.deepcopy(self.ready[0])
            (status if field in status else status['details'])[field] = value
            self.api.call = Mock(return_value=status)
            with self.assertRaisesRegex(ValueError, '绑定不一致'):
                self.wait()

    def test_cancel_during_wait_and_http_failure_do_not_report_ready(self):
        pending = copy.deepcopy(self.ready[0])
        pending['details']['subscribed'] = False
        self.api.call = Mock(side_effect=[pending, self.ready[1]])
        self.cancel.on_wait = lambda: setattr(self.cancel, 'stopped', True)
        self.assertFalse(self.wait())
        self.cancel = ClockEvent()
        self.api.call = Mock(side_effect=ValueError('会话已失效'))
        with self.assertRaisesRegex(ValueError, '会话已失效'):
            self.wait()

    def test_runtime_does_not_create_publisher_on_timeout_or_cancel(self):
        for failure in (ValueError('订阅等待超时'), None):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                runtime = Runtime(root)
                runtime.batch = 'sim-test'
                (Path(root) / runtime.batch).mkdir()
                runtime.manifest = {'batch': runtime.batch, 'created_at': 1}
                runtime.phase = 'PREPARING'
                runtime.seed = SimpleNamespace(database=None, create=Mock())
                wait = Mock(side_effect=failure) if failure else Mock(return_value=False)
                runtime.session.platform = SimpleNamespace(prepare_devices=Mock(), wait_for_subscriptions=wait)
                with patch('paho.mqtt.client.Client') as publisher:
                    runtime.run({})
                    publisher.assert_not_called()
                self.assertEqual(runtime.sent, 0)
                self.assertEqual(runtime.elapsed, 0)
                self.assertEqual(runtime.phase, 'FAILED' if failure else 'STOPPED')
                self.assertNotIn('subscriptions_ready_at', runtime.manifest)


if __name__ == '__main__':
    unittest.main()
