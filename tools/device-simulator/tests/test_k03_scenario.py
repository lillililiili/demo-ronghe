import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import compile_scene, coordinates, messages, target_reporting, target_sample
from fullchain import FullChain
from k03_scenario import build_scenes
from realtime_control import prepare_scene


class K03ScenarioTests(unittest.TestCase):
    def variants(self):
        return [dict(identity='sample-a'), dict(identity='different-device-set', longitude=118.76, latitude=37.62,
                speed=15, entry_seconds=100, action_seconds=85, duration_seconds=200)]

    def test_compiles_same_package_devices_and_explicit_coordinate_contract(self):
        for params in self.variants():
            with self.subTest(params=params):
                scenes = build_scenes(**params)
                identities = []
                for case, raw in scenes.items():
                    scene, devices, targets, skipped = compile_scene(raw)
                    self.assertEqual(skipped, [])
                    self.assertEqual(scene['coordinate_system'], 'WGS84')
                    self.assertTrue(scene['fullchain']['enabled'])
                    self.assertNotIn('observationSourceCount', scene['fullchain'])
                    self.assertEqual(scene['risks'], [])
                    self.assertEqual(scene['zones'][0]['kindCode'], 'PROHIBITED')
                    self.assertEqual(len(targets), 1)
                    identities.append(set(devices))
                self.assertTrue(all(ids == identities[0] for ids in identities))
        self.assertNotEqual(build_scenes()['avoid']['sites'][0]['devices'][0]['id'], build_scenes()['avoid']['sites'][0]['devices'][0]['id'])

    def test_stable_approach_then_avoid_or_enter_with_changed_location_and_speed(self):
        for params in self.variants():
            speed = params.get('speed', 20)
            action = params.get('action_seconds', 80)
            entry = params.get('entry_seconds', 90)
            boundary = params.get('longitude', 118.62)
            scenes = build_scenes(**params)
            for case in ['avoid', 'enter']:
                _, _, targets, _ = compile_scene(scenes[case])
                target = next(iter(targets.values()))
                samples = [target_sample(target, second) for second in range(11)]
                self.assertTrue(all(target_reporting(target, second) for second in range(11)))
                self.assertTrue(all(abs(sample['speed'] - speed) < .001 for sample in samples))
                self.assertTrue(all(abs(sample['heading'] - 90) < .001 for sample in samples))
                self.assertLess(target_sample(target, action - 1)['longitude'], boundary)
                if case == 'avoid':
                    later = target_sample(target, action + 20)
                    self.assertLess(later['longitude'], boundary)
                    self.assertAlmostEqual(later['heading'], 0, places=3)
                    self.assertGreater(later['latitude'], samples[0]['latitude'])
                else:
                    self.assertGreater(target_sample(target, entry + 5)['longitude'], boundary)

    def test_normalized_main_and_mqtt_secondary_share_motion_and_silence_keeps_heartbeat(self):
        for params in self.variants():
            raw = build_scenes(**params)['silence']
            action = params.get('action_seconds', 80)
            prepared = prepare_scene(raw, {'mode': 'normal'})
            scene, devices, targets, _ = compile_scene(prepared)
            target = next(iter(targets.values()))
            self.assertEqual(FullChain.normalized_device_ids(target, devices), [target['deviceId']])
            manifest = {'provider': 'test-provider', 'batch': 'test-batch',
                'devices': {key: {'external_id': 'external-' + key} for key in devices},
                'targets': {target['id']: {'uav_sn': 'test-synthetic-serial'}}}
            packets = messages(scene, devices, targets, manifest, action - 1, 10000, {}, 1)
            reports = [packet for _, packet in packets if packet.get('objects')]
            self.assertEqual(len(reports), 1)
            self.assertEqual(reports[0]['deviceId'], manifest['devices'][target['secondaryDeviceId']]['external_id'])
            observation = reports[0]['objects'][0]
            self.assertEqual(observation['extension']['uavSN'], 'test-synthetic-serial')
            self.assertEqual(observation['coordinate_system'], 'WGS84')
            self.assertAlmostEqual(observation['longitude'], target_sample(target, action - 1)['longitude'])
            self.assertFalse(target_reporting(target, action))
            silent = messages(scene, devices, targets, manifest, action + 1, 12000, {}, 2)
            self.assertEqual(len(silent), 2)
            self.assertFalse(any(packet.get('objects') for _, packet in silent))
            self.assertTrue(all(packet['coordinate_system'] == 'WGS84' for _, packet in silent))

    def test_invalid_geometry_or_timing_is_rejected(self):
        for params in [dict(latitude=89), dict(speed=0), dict(action_seconds=89), dict(duration_seconds=100), dict(longitude=float('nan')), dict(identity='../invalid')]:
            with self.subTest(params=params), self.assertRaises(ValueError):
                build_scenes(**params)


if __name__ == '__main__':
    unittest.main()
