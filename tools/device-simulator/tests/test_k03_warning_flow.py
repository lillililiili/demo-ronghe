import copy
import json
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import compile_scene, coordinates, messages, metres, target_reporting, target_sample
from full_scenario import allocate_identities
from fullchain import FullChain, stable_airspace_no
from k03_warning_flow import FILES, build_scene, build_scenes
from realtime_control import prepare_scene
from test_fullchain import FakePlatform, TEST_NOW


def inside(point, ring):
    """Independent ray-crossing assertion over the actual delivered ring coordinates."""
    x, y = point
    result = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


class K03WarningFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.variants = [
            dict(identity='flow9-first', longitude=118.6104, latitude=37.464, radius=900, speed=30,
                 inner_radius=1000, outer_radius=1600, action_seconds=240, duration_seconds=300),
            dict(identity='other-inputs', longitude=118.681, latitude=37.517, radius=850, speed=28,
                 inner_radius=950, outer_radius=1550, action_seconds=220, duration_seconds=280),
        ]
        cls.packages = [(params, build_scenes(**params)) for params in cls.variants]

    def compiled(self, raw):
        return compile_scene(prepare_scene(copy.deepcopy(raw), {'mode': 'normal'}))

    def chain(self, scene, devices, batch):
        manifest = dict(batch=batch, provider='map-sim', created_at=TEST_NOW, plans={}, zones={},
                        targets=allocate_identities(scene, batch),
                        devices={key: dict(platform_id='registered-' + key, external_id='external-' + key,
                                           kind=device['kind']) for key, device in devices.items()})
        platform = FakePlatform()
        chain = FullChain(platform, scene, manifest, {'owner_org_id': 'test-org', 'district_id': 'test-district'},
                          lambda: None, clock=lambda: TEST_NOW + 1000)
        return chain, platform, manifest

    def test_two_variants_compile_with_shared_devices_and_matching_plan(self):
        for params, scenes in self.packages:
            identities, zones = [], []
            for variant, raw in scenes.items():
                with self.subTest(params=params['identity'], variant=variant):
                    scene, devices, targets, skipped = self.compiled(raw)
                    self.assertEqual(skipped, [])
                    self.assertEqual(scene['coordinate_system'], 'WGS84')
                    self.assertEqual(scene['fullchain']['acceptanceFlow'], 9)
                    self.assertEqual(scene['fullchain']['predictionVariant'], variant)
                    self.assertTrue(scene['fullchain']['enabled'])
                    self.assertFalse(scene['fullchain']['airspaceLifecycle'])
                    self.assertNotIn('observationSourceCount', scene['fullchain'])
                    self.assertEqual(scene['risks'], [])
                    self.assertEqual({d['kind'] for d in devices.values()}, {'radar', 'tdoa'})
                    target = next(iter(targets.values()))
                    self.assertEqual(target['notificationBehavior'], 'none')
                    self.assertEqual(target['path'], scene['plans'][0]['points'])
                    self.assertEqual(target['planId'], scene['plans'][0]['id'])
                    self.assertEqual((target['height'], target['heightAgl'], target['altitudeDatum']), (100, 80, 'AMSL'))
                    self.assertEqual(scene['zones'][0]['kindCode'], 'PROHIBITED')
                    self.assertEqual(len(scene['zones'][0]['holes']), 1)
                    identities.append(set(devices))
                    zones.append(scene['zones'][0])
            self.assertTrue(all(ids == identities[0] for ids in identities))
            self.assertEqual(zones[0]['id'], zones[1]['id'])

    def test_pre_action_samples_stay_in_hole_and_current_velocity_crosses_ring(self):
        for params, scenes in self.packages:
            for variant, raw in scenes.items():
                with self.subTest(params=params['identity'], variant=variant):
                    scene, _, targets, _ = self.compiled(raw)
                    target = next(iter(targets.values()))
                    shell = [coordinates(p) for p in scene['zones'][0]['points']]
                    hole = [coordinates(p) for p in scene['zones'][0]['holes'][0]]
                    through = params['action_seconds'] if variant == 'enter' else params['duration_seconds']
                    for second in range(through + 1):
                        sample = target_sample(target, second)
                        observed = [sample['longitude'], sample['latitude']]
                        self.assertTrue(inside(observed, hole), (variant, second))
                        if 10 <= second < params['action_seconds']:
                            self.assertAlmostEqual(sample['speed'], params['speed'], delta=.001)
                            horizon = [sample['longitude'] + sample['speed_x'] * 30 / (111320 * math.cos(math.radians(sample['latitude']))),
                                       sample['latitude'] + sample['speed_y'] * 30 / 111320]
                            self.assertTrue(inside(horizon, shell) and not inside(horizon, hole), (variant, second))
                    # This is geometry consistency of the input, not a replacement forecast implementation.
                    self.assertGreaterEqual(params['action_seconds'], 200)

    def test_avoid_turn_occurs_at_configured_time_then_flies_to_center_and_keeps_reporting(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                _, _, targets, _ = self.compiled(scenes['avoid'])
                target = next(iter(targets.values()))
                elapsed = sum(metres(a, b) for a, b in zip(target['path'][:-2], target['path'][1:-1])) / params['speed']
                self.assertAlmostEqual(elapsed, params['action_seconds'], delta=.001)
                center = coordinates(target['path'][-1])
                before = target_sample(target, params['action_seconds'] - 1)
                inward = target_sample(target, params['action_seconds'] + 15)
                distance = lambda s: math.hypot((s['longitude'] - center[0]) * math.cos(math.radians(center[1])), s['latitude'] - center[1])
                self.assertLess(distance(inward), distance(before) * .6)
                stopped = target_sample(target, params['action_seconds'] + params['radius'] / params['speed'] + 1)
                self.assertEqual(stopped['speed'], 0)
                self.assertAlmostEqual(stopped['longitude'], params['longitude'])
                self.assertAlmostEqual(stopped['latitude'], params['latitude'])
                self.assertTrue(target_reporting(target, params['duration_seconds'] - 1))

    def test_fullchain_delivers_hole_and_bound_plan_then_withdraws_its_own_zone(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                scene, devices, targets, _ = self.compiled(scenes['avoid'])
                target = next(iter(targets.values()))
                chain, platform, manifest = self.chain(scene, devices, params['identity'])
                chain.prepare()
                airspaces = [body for _, path, body, _ in platform.calls if path.endswith('/airspaces')]
                self.assertEqual(len(airspaces), 1)
                payload = airspaces[0]
                expected = [[coordinates(p) for p in ring] for ring in [scene['zones'][0]['points'], *scene['zones'][0]['holes']]]
                for ring in expected:
                    if ring[0] != ring[-1]:
                        ring.append(ring[0])
                self.assertEqual(payload['boundary'], {'type': 'Polygon', 'coordinates': expected})
                self.assertEqual((payload['min_altitude_m'], payload['max_altitude_m'], payload['altitude_datum']), (0, 300, 'AMSL'))
                plans = [body for _, path, body, _ in platform.calls if path.endswith('/plans')]
                self.assertEqual(len(plans), 1)
                self.assertEqual(plans[0]['uav_sn'], manifest['targets'][target['id']]['uav_sn'])
                self.assertEqual(plans[0]['source_mode'], 'replay')
                source = next(body for _, path, body, _ in platform.calls if path.endswith('/observation-devices'))
                self.assertEqual(source['origin_ops_device_id'], manifest['devices'][target['deviceId']]['platform_id'])
                self.assertFalse(any('verifications' in path or '/disposal' in path or '/predictions' in path for _, path, _, _ in platform.calls))
                platform.airspace_items = [dict(state='ACCEPTED', action='UPSERT', revision=payload['revision'],
                    airspace_no=payload['airspace_no'], payload=payload)]
                platform.calls.clear()
                self.assertEqual(chain.withdraw_zones()[0]['ok'], True)
                withdrawn = [body for _, path, body, _ in platform.calls if path.endswith('/airspaces')]
                self.assertEqual(len(withdrawn), 1)
                self.assertEqual(withdrawn[0]['action'], 'WITHDRAW')
                self.assertEqual(withdrawn[0]['airspace_no'], stable_airspace_no(scene['zones'][0]['id']))
                self.assertGreater(withdrawn[0]['effective_at'], payload['valid_from'])

    def test_packaged_files_match_the_portable_generator_and_keep_two_variants(self):
        folder = ROOT / 'scenarios' / 'acceptance-flows-1-7-20261008'
        scenes = build_scenes()
        for variant, filename in FILES.items():
            with self.subTest(variant=variant):
                saved = json.loads((folder / filename).read_text(encoding='utf-8'))
                self.assertEqual(saved, scenes[variant])
                self.assertEqual(saved['duration'], 6 if variant == 'enter' else 5)
                self.assertNotIn('artifacts', json.dumps(saved))
        self.assertEqual(set(scenes), {'avoid', 'enter'})
        self.assertEqual(set(FILES), {'avoid', 'enter'})
        self.assertFalse((folder / 'flow-9-prediction-silence.json').exists())
        self.assertEqual(build_scene('enter'), scenes['enter'])

    def test_entry_continues_tangentially_into_zone_then_holds_within_existing_coverage(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                scene, devices, targets, _ = self.compiled(scenes['enter'])
                target = next(iter(targets.values()))
                shell = [coordinates(p) for p in scene['zones'][0]['points']]
                hole = [coordinates(p) for p in scene['zones'][0]['holes'][0]]
                duration = int(scene['duration'] * 60)
                self.assertEqual(duration, max(params['duration_seconds'], params['action_seconds'] + 120))
                self.assertEqual(target.get('silenceWindows', []), [])
                before = target_sample(target, params['action_seconds'] - .001)
                after = target_sample(target, params['action_seconds'] + .001)
                self.assertAlmostEqual(before['heading'], after['heading'], delta=.001)
                self.assertAlmostEqual(before['speed'], after['speed'], delta=.001)
                first_inside, first_stopped, previous = None, None, None
                for tick in range(duration * 4 + 1):
                    second = tick / 4
                    sample = target_sample(target, second)
                    observed = [sample['longitude'], sample['latitude']]
                    self.assertTrue(inside(observed, shell), second)
                    is_inside = not inside(observed, hole)
                    if first_inside is None and is_inside:
                        first_inside = second
                    if first_inside is not None:
                        self.assertTrue(is_inside, second)
                    if first_stopped is None and sample['speed'] == 0:
                        first_stopped = second
                    self.assertTrue(target_reporting(target, second))
                    local = [(sample['longitude'] - 118.56) / .00012, (37.50 - sample['latitude']) / .00012]
                    if previous is not None:
                        self.assertLessEqual(metres(previous, local), params['speed'] / 4 + .001)
                    previous = local
                self.assertGreater(first_inside, params['action_seconds'])
                self.assertLess(first_inside, params['action_seconds'] + 20)
                self.assertGreaterEqual(duration - first_inside, 100)
                self.assertGreaterEqual(duration - first_stopped, 60)
                self.assertEqual(target_sample(target, duration)['speed'], 0)
                radar = devices[target['deviceId']]
                self.assertLess(metres(target['path'][-1], [radar['x'], radar['y']]), 950)

    def test_entry_normalized_and_mqtt_observations_keep_identity_before_inside_and_while_holding(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                scene, devices, targets, _ = self.compiled(scenes['enter'])
                target = next(iter(targets.values()))
                chain, platform, manifest = self.chain(scene, devices, params['identity'] + '-entry')
                chain.prepare()
                for index, second in enumerate([params['action_seconds'] - 1, params['action_seconds'] + 20,
                                                int(scene['duration'] * 60) - 1], 1):
                    platform.calls.clear()
                    chain.tick(targets, second, index)
                    normalized = [body for _, route, body, _ in platform.calls if route.endswith('/target-observations')]
                    self.assertEqual(len(normalized), 1)
                    packets = messages(scene, devices, targets, manifest, second, TEST_NOW + second * 1000, {}, index)
                    frames = [body for _, body in packets if body.get('objects')]
                    self.assertEqual(len(frames), 1)
                    actual, secondary = normalized[0]['items'][0], frames[0]['objects'][0]
                    self.assertEqual(actual['uav_sn'], secondary['extension']['uavSN'])
                    self.assertEqual(actual['uav_sn'], manifest['targets'][target['id']]['uav_sn'])
                    self.assertAlmostEqual(actual['longitude'], secondary['longitude'])
                    self.assertAlmostEqual(actual['latitude'], secondary['latitude'])
                    self.assertEqual(actual['coordinate_system'], 'WGS84')
                    self.assertEqual(secondary['coordinate_system'], 'WGS84')
                    self.assertFalse(any('verifications' in route or '/disposal' in route or '/predictions' in route
                                         for _, route, _, _ in platform.calls))

    def test_invalid_geometry_timing_and_variants_fail_without_generating_partial_inputs(self):
        cases = [dict(latitude=89), dict(longitude=float('nan')), dict(speed=0), dict(radius=True),
                 dict(inner_radius=900), dict(inner_radius=900.01), dict(outer_radius=950),
                 dict(action_seconds=240.5), dict(action_seconds=280), dict(duration_seconds=1201),
                 dict(identity='../unsafe'), dict(speed=100, radius=100)]
        for params in cases:
            with self.subTest(params=params), self.assertRaises(ValueError):
                build_scenes(**params)
    def test_removed_silence_and_unknown_variants_are_rejected(self):
        for variant in ['silence', 'entered', 'unknown', '../flow-9-prediction-silence.json']:
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'avoid 或 enter'):
                build_scene(variant)


if __name__ == '__main__':
    unittest.main()
