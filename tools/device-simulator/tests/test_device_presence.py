import copy
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
MODULE = Path(__file__).resolve().parents[1] / 'device_presence.py'


def status():
    return {'phase': 'STOPPED', 'connected': True, 'session_version': 'session-one', 'batch': 'sim-one',
            'scene': {'sites': [{'id': 'site', 'x': 10, 'y': 20, 'devices': [
                {'id': 'radar', 'kind': 'radar', 'name': '雷达', 'health': '故障', 'heartbeat': '持续上报', 'interval': 1},
                {'id': 'tdoa', 'kind': 'tdoa', 'name': 'TDOA', 'health': '正常', 'heartbeat': '持续上报', 'interval': 1}]}],
                'targets': [{'id': 'old-target', 'kind': 'uav'}], 'risks': [{'type': 'no-plan', 'enabled': True}]},
            'manifest': {'batch': 'sim-one', 'source_mode': 'replay', 'provider': 'map-sim',
                         'devices': {'radar': {'kind': 'radar', 'external_id': 'sim-one-1', 'platform_id': 'platform-radar'},
                                     'tdoa': {'kind': 'tdoa', 'external_id': 'sim-one-2', 'platform_id': 'platform-tdoa'}},
                         'targets': {'old-target': {'uav_sn': 'must-never-send'}}}}


class FakeApi:
    def __init__(self):
        self.value = status()
        self.calls = []
        self.invalid = False
    def status(self):
        self.calls.append('status')
        return copy.deepcopy(self.value)
    def broker(self):
        self.calls.append('broker')
        return {'name': 'local-lingyun-replay', 'host': '127.0.0.1', 'port': 1883}
    def verify_session(self):
        self.calls.append('verify')
        if self.invalid:
            raise RuntimeError('session invalid')


class FakeMqtt:
    def __init__(self, broker):
        self.broker = broker
        self.connected = True
        self.closed = False
        self.sent = []
        self.timeout = False
    def publish(self, topic, payload):
        if self.timeout:
            raise RuntimeError('PUBACK timeout')
        self.sent.append((topic, copy.deepcopy(payload)))
    def close(self):
        self.closed = True
        self.connected = False


class PresenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if MODULE.exists():
            import device_presence
            cls.module = device_presence

    def setUp(self):
        self.assertTrue(MODULE.exists(), 'independent device presence implementation required')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.api = FakeApi()
        self.clients = []
        self.now = [time.time()]
        def factory(broker):
            client = FakeMqtt(broker)
            self.clients.append(client)
            return client
        self.presence = self.module.DevicePresence(self.api, self.root, mqtt_factory=factory, clock=lambda: self.now[0])

    def test_only_static_registered_devices_no_targets_and_fault_health_preserved(self):
        self.assertTrue(self.presence.step())
        sent = self.clients[0].sent
        self.assertEqual(2, len(sent))
        self.assertTrue(all('/device/' in topic and 'objects' not in payload for topic, payload in sent))
        self.assertEqual({'sim-one-1', 'sim-one-2'}, {payload['deviceId'] for _, payload in sent})
        self.assertEqual(2, sent[0][1]['workState'])
        persisted = json.loads((self.root / 'status.json').read_text(encoding='utf-8'))
        self.assertEqual('CONNECTED', persisted['state'])
        self.assertEqual(2, persisted['published_count'])
        self.assertEqual(int(self.now[0] * 1000), persisted['last_published_at'])

    def test_all_active_or_unknown_phases_pause_without_connect(self):
        for phase in ('RUNNING', 'PREPARING', 'PAUSED', 'STOPPING', 'FAILED', 'UNKNOWN'):
            with self.subTest(phase=phase):
                self.api.value['phase'] = phase
                self.assertTrue(self.presence.step())
                self.assertEqual([], self.clients)
                self.assertNotIn('broker', self.api.calls)
                self.assertEqual('PAUSED', self.presence.snapshot['state'])

    def test_scenario_start_disconnects_and_does_not_override_offline_injection(self):
        self.presence.step()
        original = self.clients[0]
        self.api.value['phase'] = 'RUNNING'
        self.now[0] += 2
        self.presence.step()
        self.assertTrue(original.closed)
        self.assertEqual(2, len(original.sent))

    def test_stop_heartbeat_and_send_false_are_respected(self):
        devices = self.api.value['scene']['sites'][0]['devices']
        devices[0]['heartbeat'] = '停止心跳'
        devices[1]['send'] = False
        self.presence.step()
        self.assertFalse(any(client.sent for client in self.clients))
        self.assertIsNone(self.presence.snapshot['last_published_at'])

    def test_invalid_session_stops_mqtt_and_five_second_check_is_real(self):
        self.presence.step()
        original = self.clients[0]
        self.api.invalid = True
        self.now[0] += 5
        with self.assertLogs(self.module.LOG, level='ERROR'):
            self.assertFalse(self.presence.step())
        self.assertTrue(original.closed)
        self.assertEqual(2, len(original.sent))
        self.assertEqual('INVALID', self.presence.snapshot['state'])
        self.api.invalid = False
        self.now[0] += 1
        self.assertTrue(self.presence.step())
        self.assertEqual(2, len(self.clients))

    def test_disconnected_login_is_detected_before_next_verification_deadline(self):
        self.presence.step()
        self.api.value['connected'] = False
        self.now[0] += 0.1
        with self.assertLogs(self.module.LOG, level='ERROR'):
            self.assertFalse(self.presence.step())
        self.assertTrue(self.clients[0].closed)

    def test_puback_timeout_never_updates_last_success_and_disconnects(self):
        self.presence.step()
        acknowledged = self.presence.snapshot['last_published_at']
        self.clients[0].timeout = True
        self.now[0] += 2
        with self.assertLogs(self.module.LOG, level='ERROR'):
            self.assertFalse(self.presence.step())
        self.assertEqual(acknowledged, self.presence.snapshot['last_published_at'])
        self.assertEqual(2, self.presence.snapshot['published_count'])
        self.assertTrue(self.clients[0].closed)

    def test_manifest_or_session_change_replaces_old_client(self):
        self.presence.step()
        self.api.value['scene']['sites'][0]['devices'][0]['health'] = '正常'
        self.now[0] += 2
        self.presence.step()
        self.assertTrue(self.clients[0].closed)
        self.assertEqual(2, len(self.clients))
        self.assertEqual(1, self.clients[1].sent[0][1]['workState'])
        self.api.value['session_version'] = 'session-two'
        self.presence.step()
        self.assertTrue(self.clients[1].closed)
        self.assertEqual(3, len(self.clients))

    def test_live_or_mismatched_device_manifest_cannot_publish(self):
        for field in ('live', 'mismatch'):
            with self.subTest(field=field):
                self.api.value = status()
                if field == 'live':
                    self.api.value['manifest']['source_mode'] = 'live'
                else:
                    self.api.value['manifest']['devices']['radar']['kind'] = 'tdoa'
                with self.assertLogs(self.module.LOG, level='ERROR'):
                    self.assertFalse(self.presence.step())
                self.assertEqual([], self.clients)

    def test_stop_file_prevents_start_and_disconnects_existing_client(self):
        self.presence.step()
        stop = self.root / 'stop'
        stop.touch()
        self.presence.run(stop)
        self.assertTrue(self.clients[0].closed)
        self.assertEqual('STOPPED', self.presence.snapshot['state'])

    def test_phase_change_between_connect_and_publish_sends_nothing(self):
        original_status = self.api.status
        count = [0]
        def changing_status():
            count[0] += 1
            if count[0] >= 2:
                self.api.value['phase'] = 'PAUSED'
            return original_status()
        self.api.status = changing_status
        self.presence.step()
        self.assertTrue(self.clients[0].closed)
        self.assertEqual([], self.clients[0].sent)
        self.assertIsNone(self.presence.snapshot['last_published_at'])

    def test_network_disconnect_stops_and_forces_session_revalidation_on_reconnect(self):
        self.presence.step()
        self.clients[0].connected = False
        self.now[0] += 1
        with self.assertLogs(self.module.LOG, level='ERROR'):
            self.assertFalse(self.presence.step())
        checks = self.api.calls.count('verify')
        self.now[0] += 1
        self.presence.step()
        self.assertEqual(checks + 1, self.api.calls.count('verify'))
        self.assertEqual(2, len(self.clients))

    def test_paho_publisher_uses_qos_one_waits_ack_and_rejects_timeout(self):
        client = MagicMock()
        client.connect.side_effect = lambda *_: client.on_connect(client, None, None, SimpleNamespace(is_failure=False), None)
        info = MagicMock()
        info.rc = 0
        info.is_published.return_value = True
        client.publish.return_value = info
        with patch('paho.mqtt.client.Client', return_value=client):
            publisher = self.module.MqttPublisher(self.api.broker())
            publisher.publish('bridge/map-sim/device/radar/one', {'deviceId': 'one'})
            self.assertEqual({'deviceId': 'one'}, json.loads(client.publish.call_args.args[1]))
            self.assertEqual({'qos': 1, 'retain': False}, client.publish.call_args.kwargs)
            info.wait_for_publish.assert_called_once_with(timeout=5)
            info.is_published.return_value = False
            with self.assertRaises(self.module.ReceiverError):
                publisher.publish('bridge/map-sim/device/radar/one', {'deviceId': 'one'})
            publisher.close()
            client.disconnect.assert_called_once()
            client.loop_stop.assert_called_once()

    def test_remote_broker_and_unavailable_credentials_are_rejected_before_connection(self):
        with patch('paho.mqtt.client.Client') as factory:
            for changes in ({'host': 'mqtt.example.com'}, {'tls': True}, {'auth_required': True}):
                with self.subTest(changes=changes), self.assertRaises(self.module.ReceiverError):
                    self.module.MqttPublisher({**self.api.broker(), **changes})
            factory.assert_not_called()


if __name__ == '__main__':
    unittest.main()
