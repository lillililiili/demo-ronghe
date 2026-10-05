"""Continuous movement and independently sourced target observations."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import compile_scene, coordinates, messages, metres, target_motion, target_reporting, target_sample
from test_engine import scene


def fixture(**target_fields):
    raw = scene()
    raw['risks'] = []
    raw['targets'][0].update(target_fields)
    return compile_scene(raw)


def packets(compiled, devices, targets, elapsed):
    manifest = {'provider': 'test', 'devices': {'d1': {'external_id': 'radar'}},
                'targets': {'t1': {'uav_sn': 'TEST'}}}
    return messages(compiled, devices, targets, manifest, elapsed, 1000, {}, 1)


class FullMotionTests(unittest.TestCase):
    def test_no_risk_target_reports_from_its_own_source(self):
        compiled, devices, targets, _ = fixture()
        objects = [p['objects'] for _, p in packets(compiled, devices, targets, 0) if 'objects' in p]
        self.assertEqual(len(objects), 1)
        self.assertEqual(objects[0][0]['extension']['objectType'], 30)
        self.assertEqual(len(compiled['risks']), 0)

    def test_loop_closes_by_moving_across_final_segment(self):
        _, _, targets, _ = fixture(path=[[450, 300], [451, 300]], speed=5, motionMode='loop')
        target = targets['t1']
        leg = metres(target['path'][0], target['path'][1]) / 5
        before = target_sample(target, leg - .001)
        after = target_sample(target, leg + .001)
        self.assertLess(abs(before['longitude'] - after['longitude']), .000001)
        self.assertGreater(before['speed_x'], 0)
        self.assertLess(after['speed_x'], 0)
        self.assertEqual(target_motion(target, leg * 2)[0], target['path'][0])

    def test_pingpong_reverses_without_teleporting(self):
        _, _, targets, _ = fixture(path=[[450, 300], [451, 300]], speed=5, motionMode='pingpong')
        target = targets['t1']
        leg = metres(target['path'][0], target['path'][1]) / 5
        left = target_sample(target, leg - .001)
        right = target_sample(target, leg + .001)
        self.assertLess(abs(left['longitude'] - right['longitude']), .000001)
        self.assertGreater(left['speed_x'], 0)
        self.assertLess(right['speed_x'], 0)

    def test_altitude_and_velocity_derive_from_same_segment(self):
        compiled, devices, targets, _ = fixture(path=[[450, 300], [451, 300]],
                                                altitudePath=[50, 70], speed=5)
        target = targets['t1']
        half = metres(target['path'][0], target['path'][1]) / 10
        sample = target_sample(target, half)
        self.assertAlmostEqual(sample['altitude'], 60)
        self.assertAlmostEqual(sample['speed_z'], 20 / (half * 2))
        self.assertAlmostEqual(sample['speed'], math.hypot(sample['speed_x'], sample['speed_z']))
        obj = next(p['objects'][0] for _, p in packets(compiled, devices, targets, half) if 'objects' in p)
        self.assertAlmostEqual(obj['altitude'], sample['altitude'])
        self.assertAlmostEqual(obj['extension']['speedZ'], sample['speed_z'])
        self.assertAlmostEqual(obj['speed'], sample['speed'])

    def test_dwell_and_silence_resume(self):
        compiled, devices, targets, _ = fixture(path=[[450, 300], [451, 300]],
                                                dwellSeconds=[2, 3], silenceWindows=[{'at': 1, 'seconds': 2}])
        target = targets['t1']
        self.assertEqual(target_motion(target, 1), ([450, 300], 0.0, 0.0))
        self.assertFalse(target_reporting(target, 1))
        self.assertFalse(any('objects' in p for _, p in packets(compiled, devices, targets, 1)))
        self.assertTrue(any('objects' in p for _, p in packets(compiled, devices, targets, 3)))
        end = 2 + metres(target['path'][0], target['path'][1]) / target['speed']
        self.assertEqual(target_motion(target, end + 1), ([451, 300], 0.0, 0.0))

    def test_notification_departure_preserves_current_altitude(self):
        _, _, targets, _ = fixture(path=[[450, 300], [451, 300]], altitudePath=[50, 70])
        target = targets['t1']
        at = metres(target['path'][0], target['path'][1]) / (target['speed'] * 2)
        origin = target_motion(target, at)[0]
        altitude = target_sample(target, at)['altitude']
        target['_notification_motion'] = {'at_elapsed': at, 'origin': origin,
                                          'path': [origin, [452, 300]], 'speed': 8}
        self.assertAlmostEqual(target_sample(target, at)['altitude'], altitude)
        self.assertAlmostEqual(target_sample(target, at + .5)['altitude'], altitude)

    def test_classification_codes_and_normalized_balloon(self):
        for kind, expected in [('unknown', 0), ('identifying', 255), ('person', 3),
                               ('vehicle', 7), ('ship', 50), ('remote_controller', 100),
                               ('bird', 40), ('uav', 30)]:
            with self.subTest(kind=kind):
                compiled, devices, targets, _ = fixture(kind=kind)
                obj = next(p['objects'][0] for _, p in packets(compiled, devices, targets, 0) if 'objects' in p)
                self.assertEqual(obj['extension']['objectType'], expected)
                self.assertEqual('uavSN' in obj['extension'], kind == 'uav')
        compiled, devices, targets, _ = fixture(kind='balloon', transport='normalized')
        self.assertFalse(any('objects' in p for _, p in packets(compiled, devices, targets, 0)))

    def test_source_and_array_validation(self):
        for fields in ({'deviceId': 'missing'}, {'altitudePath': [50]},
                       {'dwellSeconds': [-1, 0, 0]}, {'kind': 'balloon', 'transport': 'mqtt'},
                       {'altitudeDatum': 'AGL'}, {'motionMode': 'teleport'},
                       {'silenceWindows': [{'at': 10, 'seconds': 90000}]}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                fixture(**fields)


if __name__ == '__main__':
    unittest.main()
