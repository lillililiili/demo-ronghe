"""Continuous scenes keep real MQTT timestamps and stop only via controls/errors."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
from server import Runtime
from test_engine import scene


class ContinuousTests(unittest.TestCase):
    def test_running_loop_continues_after_deadline_and_honors_stop(self):
        for duration, count, phase in [(0, 2, 'STOPPED'), (1, 0, 'COMPLETED')]:
            with self.subTest(duration=duration), tempfile.TemporaryDirectory() as root:
                runtime = Runtime(root)
                runtime.scene, devices, runtime.targets, _ = engine.compile_scene(dict(scene(), duration=duration))
                runtime.batch = 'sim-continuous-test'
                (Path(root) / runtime.batch).mkdir()
                runtime.broker = dict(name='test', host='localhost', port=1883)
                runtime.manifest = dict(created_at=1000, provider='test',
                    devices={'d1': {'external_id': 'radar', 'platform_id': 'test-device', 'kind': 'radar'}},
                    targets={'t1': {'uav_sn': 'TEST'}})
                runtime.session.platform = Mock()
                client = Mock()
                client.connect.side_effect = lambda *_: client.on_connect(client, None, None, SimpleNamespace(is_failure=False), None)
                def publish(*args, **kwargs):
                    if client.publish.call_count == 2:
                        runtime.control('stop')
                    return Mock(is_published=Mock(return_value=True))
                client.publish.side_effect = publish
                with patch('paho.mqtt.client.Client', return_value=client), \
                     patch('server.NotificationResponse') as notice, \
                     patch('server.time.monotonic', side_effect=[0, 1201]):
                    notice.return_value.snapshot.return_value = {}
                    runtime.run(devices)
                self.assertEqual(runtime.error, '')
                self.assertEqual(runtime.phase, phase)
                self.assertEqual(client.publish.call_count, count)
                client.disconnect.assert_called_once()

    def test_continuous_scene_sends_new_observations_after_twenty_minutes(self):
        raw = scene()
        raw['duration'] = 0
        compiled, devices, targets, _ = engine.compile_scene(raw)
        manifest = {'provider': 'test', 'devices': {'d1': {'external_id': 'radar'}},
                    'targets': {'t1': {'uav_sn': 'TEST'}}}
        frames = [engine.messages(compiled, devices, targets, manifest, elapsed, now, {}, seq)
                  for elapsed, now, seq in [(1201, 2000000, 1), (1202, 2001000, 2)]]
        self.assertEqual(compiled['duration'], 0)
        self.assertEqual(len(frames[0]), 2)
        self.assertEqual(frames[1][1][1]['objects'][0]['time'], 2001000)
        self.assertEqual(frames[0][1][1]['objects'][0]['objectId'], frames[1][1][1]['objects'][0]['objectId'])
        self.assertEqual(frames[1][0][1]['ptTime'], 2001000)
        self.assertFalse(engine.duration_reached(compiled, 86401))

    def test_timed_scene_still_finishes_at_original_deadline(self):
        compiled, *_ = engine.compile_scene(scene())
        deadline = compiled['duration'] * 60
        self.assertFalse(engine.duration_reached(compiled, deadline - .01))
        self.assertTrue(engine.duration_reached(compiled, deadline))

    def test_invalid_durations_remain_rejected(self):
        for duration in (-1, .001, 21, None, float('inf'), float('nan'), True, False):
            with self.subTest(duration=duration):
                raw = scene()
                raw['duration'] = duration
                with self.assertRaises(ValueError):
                    engine.compile_scene(raw)

    def test_continuous_fault_window_remains_finite(self):
        raw = scene()
        raw['duration'] = 0
        raw['risks'].append(dict(id='fault', name='设备故障', type='fault', enabled=True,
                                deviceId='d1', at=1800, seconds=60))
        engine.compile_scene(raw)
        for seconds in (float('inf'), 86400):
            invalid = copy.deepcopy(raw)
            invalid['risks'][-1]['seconds'] = seconds
            with self.assertRaises(ValueError):
                engine.compile_scene(invalid)

    def test_continuous_controls_preserve_elapsed_and_request_stop(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.scene = dict(scene(), duration=0)
            runtime.phase = 'RUNNING'
            runtime.elapsed = 3600
            self.assertEqual(runtime.control('pause')['phase'], 'PAUSED')
            self.assertEqual(runtime.control('resume')['elapsed'], 3600)
            result = runtime.control('stop')
            self.assertEqual(result['phase'], 'STOPPING')
            self.assertTrue(runtime.cancel.is_set())

    def test_restart_keeps_continuous_scene_but_does_not_auto_publish(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / 'sim-continuous-test'
            folder.mkdir()
            (folder / 'scene.json').write_text(json.dumps(dict(scene(), duration=0)), encoding='utf-8')
            (folder / 'manifest.json').write_text(json.dumps(dict(batch=folder.name, phase='RUNNING', elapsed=3600, sent=7200)), encoding='utf-8')
            runtime = Runtime(root)
            self.assertEqual(runtime.scene['duration'], 0)
            self.assertEqual(runtime.phase, 'STOPPED')
            self.assertIsNone(runtime.thread)
            self.assertIsNone(runtime.platform)


if __name__ == '__main__':
    unittest.main()
