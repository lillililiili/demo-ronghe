"""Run the real publishing loop across a reconnect completed between loop polls."""
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import compile_scene
from server import Runtime
from test_engine import scene


OK = SimpleNamespace(is_failure=False)


class FastReconnectClient:
    def __init__(self, runtime):
        self.runtime = runtime
        self.connected = False
        self.subscriptions = 0
        self.publishes = 0
        self.reconnected_subscription = False

    def reconnect_delay_set(self, **kwargs): pass
    def connect(self, *args): pass
    def loop_start(self):
        self.connected = True
        self.on_connect(self, None, {}, OK, None)
    def loop_stop(self): pass
    def disconnect(self):
        self.connected = False
        self.on_disconnect(self, None, None, None, None)
    def is_connected(self): return self.connected

    def subscribe(self, topics):
        self.subscriptions += 1
        mid = self.subscriptions
        # A network callback follows subscribe() returning its packet id.
        threading.Timer(.01, lambda: self.on_subscribe(self, None, mid, [OK] * len(topics), None)).start()
        return 0, mid

    def publish(self, *args, **kwargs):
        self.publishes += 1
        if self.publishes == 1:
            self.disconnect()
            self.loop_start()  # Clean-session reconnect completes before the next loop poll.
        else:
            self.reconnected_subscription = self.subscriptions == 2
            self.runtime.cancel.set()
        return SimpleNamespace(wait_for_publish=lambda **kw: None, is_published=lambda: True)


class MqttRecoveryTests(unittest.TestCase):
    def test_fast_reconnect_resubscribes_even_when_main_loop_never_sees_disconnected(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.batch = 'sim-reconnect'
            (Path(root) / runtime.batch).mkdir()
            raw = scene()
            raw['targets'] = []
            raw['risks'] = []
            raw['sites'][0]['devices'][0]['kind'] = 'ifr'
            raw['sites'][0]['devices'][0]['protocolB'] = {}
            runtime.scene, devices, runtime.targets, runtime.skipped = compile_scene(raw)
            runtime.broker = {'host': '127.0.0.1', 'port': 1883}
            runtime.manifest = {'provider': 'reconnect', 'source_mode': 'replay',
                                'devices': {'d1': {'external_id': 'fault-1', 'platform_id': 'p-1', 'kind': 'ifr'}}}
            runtime.session.platform = SimpleNamespace(prepare_devices=Mock(),
                wait_for_subscriptions=Mock(return_value=True), call=Mock(return_value={}))
            client = FastReconnectClient(runtime)
            with patch('paho.mqtt.client.Client', return_value=client):
                runtime.run(devices)
            self.assertEqual(runtime.error, '')
            self.assertGreaterEqual(client.publishes, 2)
            self.assertTrue(client.reconnected_subscription, 'second connection must restore control subscriptions')
            self.assertEqual(client.subscriptions, 2)


class SubscriptionCorrelationTests(unittest.TestCase):
    def test_wrong_or_previous_suback_cannot_open_current_connection(self):
        from mqtt_recovery import CommandSubscriptions
        for topic in ('command/one', 'command/other'):
            with self.subTest(topic=topic):
                state = CommandSubscriptions([topic])
                client = SimpleNamespace(subscribe=Mock(side_effect=[(0, 11), (0, 12)]))
                state.on_connect(client)
                state.on_subscribe(client, None, 99, [OK], None)
                self.assertFalse(state.ready.is_set())
                state.on_disconnect()
                state.on_connect(client)
                state.on_subscribe(client, None, 11, [OK], None)
                self.assertFalse(state.ready.is_set())
                state.on_subscribe(client, None, 12, [OK], None)
                self.assertTrue(state.wait_ready(threading.Event()))

    def test_failed_or_incomplete_suback_fails_closed(self):
        from mqtt_recovery import CommandSubscriptions
        for codes in ([], [SimpleNamespace(is_failure=True)]):
            state = CommandSubscriptions(['command/a'])
            client = SimpleNamespace(subscribe=Mock(return_value=(0, 5)))
            state.on_connect(client)
            state.on_subscribe(client, None, 5, codes, None)
            with self.assertRaisesRegex(ValueError, '订阅失败'):
                state.wait_ready(threading.Event())
            self.assertFalse(state.ready.is_set())

    def test_subscribe_send_failure_and_ack_timeout_are_not_ready(self):
        from mqtt_recovery import CommandSubscriptions
        for rc in (0, 4):
            state = CommandSubscriptions(['command/a'])
            state.on_connect(SimpleNamespace(subscribe=Mock(return_value=(rc, 5))))
            with self.assertRaises(ValueError):
                state.wait_ready(threading.Event(), timeout=.01)
            self.assertFalse(state.ready.is_set())

    def test_disconnect_and_cancel_stop_waiting_without_false_readiness(self):
        from mqtt_recovery import CommandSubscriptions
        state = CommandSubscriptions(['command/a'])
        state.on_connect(SimpleNamespace(subscribe=Mock(return_value=(0, 5))))
        cancelled = threading.Event()
        cancelled.set()
        self.assertFalse(state.wait_ready(cancelled))
        state.on_disconnect()
        state.on_subscribe(None, None, 5, [OK], None)
        self.assertFalse(state.wait_ready(threading.Event()))

    def test_no_control_topics_does_not_issue_invalid_empty_subscription(self):
        from mqtt_recovery import CommandSubscriptions
        state = CommandSubscriptions([])
        client = SimpleNamespace(subscribe=Mock())
        state.on_connect(client)
        self.assertTrue(state.wait_ready(threading.Event()))
        client.subscribe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
