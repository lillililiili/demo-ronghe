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
    """Independent ray-crossing assertion over delivered polygon coordinates."""
    x, y = point
    result = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


def local(sample, params):
    return ((sample['longitude'] - params['longitude']) * 111320 * math.cos(math.radians(params['latitude'])),
            (sample['latitude'] - params['latitude']) * 111320)


class K03WarningFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.variants = [
            dict(identity='flow9-first', longitude=118.6104, latitude=37.464, start_distance=1500, entry_start_distance=6000, speed=30,
                 turn_clearance=120, turn_radius=60, zone_width=900, zone_half_height=600,
                 return_distance=1500, duration_seconds=300),
            dict(identity='other-inputs', longitude=118.681, latitude=37.517, start_distance=1600, entry_start_distance=6400, speed=32,
                 turn_clearance=140, turn_radius=70, zone_width=1000, zone_half_height=650,
                 return_distance=1400, duration_seconds=320),
        ]
        cls.packages = [(params, build_scenes(**params)) for params in cls.variants]

    def compiled(self, raw):
        return compile_scene(prepare_scene(copy.deepcopy(raw), {'mode': 'normal'}))

    def chain(self, scene, devices, batch):
        manifest = dict(batch=batch, provider='map-sim', created_at=TEST_NOW, plans={}, zones={},
                        targets=allocate_identities(scene, batch),
                        devices={key: dict(platform_id='registered-' + key, external_id='external-' + key,
                                           kind=device['kind'], edge_id='edge-' + key) for key, device in devices.items()})
        platform = FakePlatform()
        chain = FullChain(platform, scene, manifest, {'owner_org_id': 'test-org', 'district_id': 'test-district'},
                          lambda: None, clock=lambda: TEST_NOW + 1000)
        return chain, platform, manifest

    def test_rectangle_identity_coexists_with_old_airspace_and_is_reused_on_rerun(self):
        for params, scenes in self.packages:
            for variant, raw in scenes.items():
                for old_action in ('UPSERT', 'WITHDRAW'):
                    with self.subTest(identity=params['identity'], variant=variant, old_action=old_action):
                        scene, devices, _, _ = self.compiled(raw)
                        old_number = stable_airspace_no('prohibited-' + params['identity'])
                        old = dict(airspace_no=old_number, airspace_id='historical-zone',
                                   airspace_version_id='historical-version', state='ACCEPTED',
                                   revision=7, action=old_action,
                                   payload=dict(name='Historical annular zone', owner_org_id='test-org',
                                                district_id='test-district', valid_from=TEST_NOW - 10000,
                                                valid_to=TEST_NOW + 3600000, effective_at=TEST_NOW - 5000))
                        chain, platform, manifest = self.chain(scene, devices, params['identity'] + '-' + variant)
                        platform.airspace_items = [copy.deepcopy(old)]
                        original_call = platform.call

                        def immutable_identity(method, path, body=None, key=None):
                            # The platform also enforces the last UPSERT identity after withdrawal.
                            if path.endswith('/airspaces') and body['airspace_no'] == old_number:
                                if body['action'] == 'UPSERT' and body['name'] != old['payload']['name']:
                                    raise ValueError('UPSTREAM_IDENTITY_CONFLICT')
                                self.fail('The rectangle scenario must not mutate the historical airspace')
                            return original_call(method, path, body, key)

                        platform.call = immutable_identity
                        chain.prepare()
                        sent = [body for _, path, body, _ in platform.calls if path.endswith('/airspaces')]
                        self.assertEqual(len(sent), 1)
                        payload = sent[0]
                        self.assertNotEqual(payload['airspace_no'], old_number)
                        self.assertEqual(payload['revision'], 1)
                        self.assertEqual(platform.airspace_items, [old])

                        # Another batch/branch uses the same new business object, not another zone.
                        receipt = manifest['zones'][scene['zones'][0]['id']]['receipt']
                        current = dict(receipt, airspace_no=payload['airspace_no'], state='ACCEPTED',
                                       action='UPSERT', payload=copy.deepcopy(payload))
                        platform.airspace_items.append(current)
                        next_chain, _, _ = self.chain(scene, devices, params['identity'] + '-next')
                        next_chain.api = platform
                        platform.calls.clear()
                        next_chain.prepare()
                        self.assertFalse(any(path.endswith('/airspaces') for _, path, _, _ in platform.calls))
                        self.assertTrue(next_chain.state['requests']['zone-' + scene['zones'][0]['id']]['reused_by_readback'])
                        self.assertTrue(next_chain.withdraw_zones()[0]['ok'])
                        withdrawals = [body for _, path, body, _ in platform.calls if path.endswith('/airspaces')]
                        self.assertEqual(len(withdrawals), 1)
                        self.assertEqual(withdrawals[0]['airspace_no'], payload['airspace_no'])
                        self.assertEqual(platform.airspace_items[0], old)

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
                    self.assertEqual({d['kind'] for d in devices.values()}, {'radar', 'tdoa', 'eo'})
                    target = next(iter(targets.values()))
                    self.assertEqual(target['notificationBehavior'], 'none')
                    self.assertEqual(target['path'], scene['plans'][0]['points'])
                    self.assertEqual(target['planId'], scene['plans'][0]['id'])
                    self.assertEqual((target['height'], target['heightAgl'], target['altitudeDatum']), (100, 80, 'AMSL'))
                    self.assertEqual(scene['zones'][0]['kindCode'], 'PROHIBITED')
                    self.assertEqual(scene['zones'][0].get('holes', []), [])
                    self.assertEqual(len(scene['zones'][0]['points']), 4)
                    identities.append(set(devices))
                    zones.append(scene['zones'][0])
            self.assertTrue(all(ids == identities[0] for ids in identities))
            self.assertEqual(zones[0], zones[1])

    def test_optical_device_covers_both_routes_and_uses_existing_heartbeat_protocol(self):
        for params, scenes in self.packages:
            for variant, raw in scenes.items():
                with self.subTest(identity=params['identity'], variant=variant):
                    scene, devices, targets, _ = self.compiled(raw)
                    optical = next(d for d in devices.values() if d['kind'] == 'eo')
                    self.assertEqual(optical['health'], '正常')
                    self.assertEqual(optical['heartbeat'], '持续上报')
                    self.assertEqual(optical['coverage']['fovDeg'], 220)
                    site = scene['sites'][0]
                    origin = [site['x'], site['y']]
                    site = [coordinates(origin)]
                    site_lon, site_lat = site[0]
                    site_east = (site_lon - params['longitude']) * 111320 * math.cos(math.radians(params['latitude']))
                    site_north = (site_lat - params['latitude']) * 111320
                    for point in scene['targets'][0]['path']:
                        self.assertLess(metres(origin, point), optical['coverage']['rangeM'])
                        self.assertLess(point[1], origin[1])  # north of the device
                        target_lon, target_lat = coordinates(point)
                        east = (target_lon - params['longitude']) * 111320 * math.cos(math.radians(params['latitude'])) - site_east
                        north = (target_lat - params['latitude']) * 111320 - site_north
                        bearing = math.degrees(math.atan2(east, north)) % 360
                        offset = abs((bearing - optical['coverage']['azimuthDeg'] + 180) % 360 - 180)
                        self.assertLessEqual(offset, optical['coverage']['fovDeg'] / 2)
                    target = next(iter(targets.values()))
                    self.assertNotEqual(target['deviceId'], optical['id'])
                    self.assertNotEqual(target['secondaryDeviceId'], optical['id'])

    def test_avoid_keeps_its_short_route_and_entry_has_a_full_simulated_warning_runway(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity'], variant='avoid'):
                scene, _, targets, _ = self.compiled(scenes['avoid'])
                target = next(iter(targets.values()))
                shell = [coordinates(p) for p in scene['zones'][0]['points']]
                turn_at = (params['start_distance'] - params['turn_clearance'] - params['turn_radius']) / params['speed']
                for second in (0, 10, turn_at - 1):
                    sample = target_sample(target, second)
                    east, north = local(sample, params)
                    self.assertAlmostEqual(east, -params['start_distance'] + params['speed'] * second, delta=.01)
                    self.assertAlmostEqual(north, 0, delta=.001)
                    self.assertFalse(inside([sample['longitude'], sample['latitude']], shell))
                self.assertGreater(turn_at - 10, 20)
            with self.subTest(params=params['identity'], variant='enter'):
                scene, _, targets, _ = self.compiled(scenes['enter'])
                target = next(iter(targets.values()))
                shell = [coordinates(p) for p in scene['zones'][0]['points']]
                warning_at = (params['entry_start_distance'] - 120 * params['speed']) / params['speed']
                entry_at = params['entry_start_distance'] / params['speed']
                for second in (0, 10, warning_at, entry_at - 120, entry_at - 1):
                    sample = target_sample(target, second)
                    east, north = local(sample, params)
                    self.assertAlmostEqual(east, -params['entry_start_distance'] + params['speed'] * second, delta=.01)
                    self.assertAlmostEqual(north, 0, delta=.001)
                    self.assertFalse(inside([sample['longitude'], sample['latitude']], shell))
                self.assertGreaterEqual(entry_at - warning_at, 120)
                self.assertLess(metres(target['path'][0], [scene['sites'][0]['x'], scene['sites'][0]['y']]), 7000)

    def test_avoid_follows_short_smooth_turn_then_retreats_without_entering_or_losing_reports(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                scene, _, targets, _ = self.compiled(scenes['avoid'])
                target = next(iter(targets.values()))
                path = target['path']
                self.assertEqual(len(path), 11)  # approach, eight short arc chords, one straight retreat
                self.assertEqual(target.get('silenceWindows', []), [])
                turn_at = metres(path[0], path[1]) / params['speed']
                self.assertAlmostEqual(turn_at, (params['start_distance'] - params['turn_clearance'] - params['turn_radius']) / params['speed'], delta=.001)
                arc_end = sum(metres(a, b) for a, b in zip(path[:-2], path[1:-1])) / params['speed']
                stopped_at = sum(metres(a, b) for a, b in zip(path, path[1:])) / params['speed']
                self.assertLess(arc_end - turn_at, 10)
                self.assertGreater(stopped_at - arc_end, 30)
                self.assertGreater(params['duration_seconds'] - stopped_at, 20)
                headings = [target_sample(target, (sum(metres(a, b) for a, b in zip(path[:i], path[1:i + 1])) + metres(path[i], path[i + 1]) / 2) / params['speed'])['heading']
                            for i in range(len(path) - 1)]
                for a, b in zip(headings, headings[1:]):
                    self.assertLess(abs((b - a + 180) % 360 - 180), 18)
                previous = None
                for tick in range(params['duration_seconds'] * 4 + 1):
                    second = tick / 4
                    sample = target_sample(target, second)
                    east, _ = local(sample, params)
                    self.assertLessEqual(east, -params['turn_clearance'] + .01, second)
                    self.assertTrue(target_reporting(target, second))
                    point = [(sample['longitude'] - 118.56) / .00012, (37.50 - sample['latitude']) / .00012]
                    if previous is not None:
                        self.assertLessEqual(metres(previous, point), params['speed'] / 4 + .001, second)
                    previous = point
                retreat = target_sample(target, arc_end + 20)
                self.assertLess(retreat['speed_x'], 0)
                self.assertGreater(retreat['speed_y'], 0)
                self.assertLess(local(retreat, params)[0], -400)
                self.assertEqual(target_sample(target, stopped_at + 1)['speed'], 0)

    def test_fullchain_delivers_rectangle_and_bound_plan_then_withdraws_its_own_zone(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                scene, devices, targets, _ = self.compiled(scenes['avoid'])
                target = next(iter(targets.values()))
                chain, platform, manifest = self.chain(scene, devices, params['identity'])
                chain.prepare()
                airspaces = [body for _, path, body, _ in platform.calls if path.endswith('/airspaces')]
                self.assertEqual(len(airspaces), 1)
                payload = airspaces[0]
                ring = [coordinates(p) for p in scene['zones'][0]['points']]
                ring.append(ring[0])
                self.assertEqual(payload['boundary'], {'type': 'Polygon', 'coordinates': [ring]})
                self.assertEqual((payload['min_altitude_m'], payload['max_altitude_m'], payload['altitude_datum']), (0, 300, 'AMSL'))
                plans = [body for _, path, body, _ in platform.calls if path.endswith('/plans')]
                self.assertEqual(len(plans), 1)
                self.assertEqual(plans[0]['uav_sn'], manifest['targets'][target['id']]['uav_sn'])
                self.assertEqual(plans[0]['source_mode'], 'replay')
                source = next(body for _, path, body, _ in platform.calls if path.endswith('/observation-devices'))
                self.assertEqual(source['origin_ops_device_id'], manifest['devices'][target['deviceId']]['platform_id'])
                self.assertFalse(any('verifications' in path or '/disposal' in path or '/predictions' in path for _, path, _, _ in platform.calls))
                platform.airspace_items = [dict(state='ACCEPTED', action='UPSERT', revision=payload['revision'], airspace_no=payload['airspace_no'], payload=payload)]
                platform.calls.clear()
                self.assertTrue(chain.withdraw_zones()[0]['ok'])
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

    def test_route_guide_times_and_markers_describe_actual_sampler_without_changing_motion(self):
        for params, scenes in self.packages:
            for variant, raw in scenes.items():
                with self.subTest(params=params['identity'], variant=variant):
                    _, _, targets, _ = self.compiled(raw)
                    target = next(iter(targets.values()))
                    guide = raw['mapGuide']
                    stages = raw['sceneGuide']['stages']
                    expected_action = (metres(target['path'][0], target['path'][1]) / params['speed'] if variant == 'avoid'
                                       else params['entry_start_distance'] / params['speed'])
                    expected_stop = sum(metres(a, b) for a, b in zip(target['path'], target['path'][1:])) / params['speed']
                    self.assertAlmostEqual(stages[2]['at_seconds'], expected_action, delta=.01)
                    self.assertAlmostEqual(stages[3]['at_seconds'], expected_stop, delta=.01)
                    self.assertEqual(guide['markers'][0]['point'], target['path'][0])
                    self.assertEqual(guide['markers'][-1]['point'], target['path'][-1])
                    plain = copy.deepcopy(raw)
                    plain.pop('mapGuide')
                    plain.pop('sceneGuide')
                    _, _, ordinary_targets, _ = self.compiled(plain)
                    ordinary_target = next(iter(ordinary_targets.values()))
                    for second in (0, expected_action, expected_stop, int(raw['duration'] * 60) - 1):
                        self.assertEqual(target_sample(target, second), target_sample(ordinary_target, second))

    def test_entry_moves_straight_into_rectangle_then_holds_inside_existing_counter_coverage(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                scene, devices, targets, _ = self.compiled(scenes['enter'])
                target = next(iter(targets.values()))
                shell = [coordinates(p) for p in scene['zones'][0]['points']]
                duration = int(scene['duration'] * 60)
                self.assertEqual(duration, max(params['duration_seconds'] + 60,
                                              math.ceil((params['entry_start_distance'] + params['zone_width'] / 2) / params['speed'] + 120)))
                self.assertEqual(len(target['path']), 2)
                self.assertEqual(target.get('silenceWindows', []), [])
                entry_at = params['entry_start_distance'] / params['speed']
                stopped_at = metres(*target['path']) / params['speed']
                previous = None
                for tick in range(duration * 4 + 1):
                    second = tick / 4
                    sample = target_sample(target, second)
                    observed = [sample['longitude'], sample['latitude']]
                    if second < entry_at - .01:
                        self.assertFalse(inside(observed, shell), second)
                    elif second > entry_at + .01:
                        self.assertTrue(inside(observed, shell), second)
                    east, north = local(sample, params)
                    self.assertAlmostEqual(north, 0, delta=.001)
                    self.assertTrue(target_reporting(target, second))
                    point = [(sample['longitude'] - 118.56) / .00012, (37.50 - sample['latitude']) / .00012]
                    if previous is not None:
                        self.assertLessEqual(metres(previous, point), params['speed'] / 4 + .001, second)
                    previous = point
                self.assertGreaterEqual(duration - stopped_at, 120)
                end = target_sample(target, duration)
                self.assertEqual(end['speed'], 0)
                self.assertAlmostEqual(local(end, params)[0], params['zone_width'] / 2, delta=.001)
                radar = devices[target['deviceId']]
                self.assertLess(metres(target['path'][-1], [radar['x'], radar['y']]), 950)

    def test_both_transports_keep_identity_before_entry_inside_and_while_holding(self):
        for params, scenes in self.packages:
            with self.subTest(params=params['identity']):
                scene, devices, targets, _ = self.compiled(scenes['enter'])
                target = next(iter(targets.values()))
                chain, platform, manifest = self.chain(scene, devices, params['identity'] + '-entry')
                chain.prepare()
                for index, second in enumerate([int(params['entry_start_distance'] / params['speed']) - 1,
                                                int(params['entry_start_distance'] / params['speed']) + 10,
                                                int(scene['duration'] * 60) - 1], 1):
                    platform.calls.clear()
                    captured_at = TEST_NOW + second * 1000
                    chain.tick(targets, second, index, observed_at=captured_at)
                    normalized = [body for _, route, body, _ in platform.calls if route.endswith('/target-observations')]
                    self.assertEqual(len(normalized), 1)
                    self.assertEqual(normalized[0]['observed_at'], captured_at)
                    packets = messages(scene, devices, targets, manifest, second, TEST_NOW + second * 1000, {}, index)
                    optical = [body for _, body in packets if body.get('event') == 'HeartBeat']
                    self.assertEqual(len(optical), 1)
                    self.assertTrue(optical[0]['edgeId'].startswith('edge-eo-'))
                    frames = [body for _, body in packets if body.get('objects')]
                    self.assertEqual(len(frames), 1)
                    actual, secondary = normalized[0]['items'][0], frames[0]['objects'][0]
                    self.assertEqual(secondary['time'], captured_at)
                    self.assertEqual(actual['uav_sn'], secondary['extension']['uavSN'])
                    self.assertEqual(actual['uav_sn'], manifest['targets'][target['id']]['uav_sn'])
                    self.assertAlmostEqual(actual['longitude'], secondary['longitude'])
                    self.assertAlmostEqual(actual['latitude'], secondary['latitude'])
                    self.assertEqual(actual['coordinate_system'], 'WGS84')
                    self.assertEqual(secondary['coordinate_system'], 'WGS84')
                    self.assertFalse(any('verifications' in route or '/disposal' in route or '/predictions' in route for _, route, _, _ in platform.calls))

    def test_invalid_geometry_timing_and_identity_fail_without_partial_inputs(self):
        cases = [dict(latitude=89), dict(longitude=float('nan')), dict(speed=0), dict(start_distance=True), dict(entry_start_distance=True),
                 dict(turn_clearance=0), dict(turn_radius=0), dict(zone_width=0), dict(zone_half_height=0),
                 dict(return_distance=0), dict(start_distance=150), dict(duration_seconds=300.5),
                 dict(duration_seconds=1201), dict(identity='../unsafe')]
        for params in cases:
            with self.subTest(params=params), self.assertRaises(ValueError):
                build_scenes(**params)

    def test_removed_silence_and_unknown_variants_are_rejected(self):
        for variant in ['silence', 'entered', 'unknown', '../flow-9-prediction-silence.json']:
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, 'avoid 或 enter'):
                build_scene(variant)


if __name__ == '__main__':
    unittest.main()
