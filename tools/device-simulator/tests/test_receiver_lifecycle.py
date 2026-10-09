"""Ending a scene keeps the notification receiver; only 停止全部收发 stops it."""
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
from server import Runtime
from test_engine import scene


class ReceiverLifecycleTests(unittest.TestCase):
    def run_scene(self, root, prepared, duration, stop_after):
        runtime = Runtime(root)
        runtime.scene, devices, runtime.targets, _ = engine.compile_scene(dict(scene(), duration=duration))
        runtime.scene.update(prepared)
        runtime.batch = 'sim-receiver-test'
        (Path(root) / runtime.batch).mkdir()
        runtime.broker = dict(broker_id='test-broker', name='test', host='localhost', port=1883)
        runtime.manifest = dict(created_at=1000, provider='test', source_mode='replay', broker_id='test-broker',
            plans={}, zones={},
            devices={'d1': {'external_id': 'radar', 'platform_id': 'test-device', 'kind': 'radar'}},
            targets={'t1': {'uav_sn': 'TEST'}})
        runtime.session.platform = Mock()
        runtime.realtime = MagicMock()
        client = Mock()
        client.connect.side_effect = lambda *_: client.on_connect(client, None, None, SimpleNamespace(is_failure=False), None)
        def publish(*args, **kwargs):
            if stop_after and client.publish.call_count == stop_after:
                runtime.control('stop')
            return Mock(is_published=Mock(return_value=True))
        client.publish.side_effect = publish
        with patch('paho.mqtt.client.Client', return_value=client), \
             patch('server.FullChain'), \
             patch('server.NotificationResponse') as notice, \
             patch('prerequisite_check.verify', return_value={}), \
             patch('server.time.monotonic', side_effect=[0, 1201]):
            notice.return_value.snapshot.return_value = {}
            runtime.run(devices)
        return runtime

    def test_stopping_or_finishing_a_scene_keeps_the_receiver_running(self):
        cases = [
            ('全量关联场景，停止场景上报', {'fullchain': {'enabled': True}}, 0, 2, 'STOPPED'),
            ('全量关联场景，跑满时长', {'fullchain': {'enabled': True}}, 1, 0, 'COMPLETED'),
            ('带计划的普通场景，停止场景上报', {'plans': [{'id': 'p1'}]}, 0, 2, 'STOPPED'),
        ]
        for name, prepared, duration, stop_after, phase in cases:
            with self.subTest(name), tempfile.TemporaryDirectory() as root:
                runtime = self.run_scene(root, prepared, duration, stop_after)
                self.assertEqual(runtime.error, '')
                self.assertEqual(runtime.phase, phase)
                self.assertIsNotNone(runtime.fullchain)
                runtime.realtime.stop.assert_not_called()

    def test_stop_all_still_stops_the_receiver(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self.run_scene(root, {'fullchain': {'enabled': True}}, 0, 2)
            runtime.stop_all()
            runtime.realtime.stop.assert_called_once()


if __name__ == '__main__':
    unittest.main()
