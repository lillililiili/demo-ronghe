import math
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acceptance_flows import read_acceptance_flows, _cover_paths_with_eo
from eo_observations import PAGE_DEFAULT_CONFIG, EoObservations
from engine import metres

ROOT = Path(__file__).resolve().parents[1]


def inside(coverage, origin, point):
    distance = metres(origin, point)
    if coverage['kind'] == 'circle':
        return distance <= coverage['radiusM']
    bearing = (math.degrees(math.atan2(point[0] - origin[0], origin[1] - point[1])) + 360) % 360
    off = abs((bearing - coverage['azimuthDeg'] + 180) % 360 - 180)
    return distance <= coverage['rangeM'] and off <= coverage['fovDeg'] / 2


class PageDefaultsTest(unittest.TestCase):
    def test_page_flows_report_eo_recognition_with_confidence(self):
        generator = EoObservations(PAGE_DEFAULT_CONFIG, {}, {}, lambda: 0)
        self.assertIs(generator.config['enabled'], True)
        self.assertEqual(generator.config['detectConfidence'], 0.94)

    def test_every_flow_eo_range_contains_its_aircraft_paths(self):
        flows = read_acceptance_flows(ROOT)['flows']
        checked = 0
        for flow in flows:
            for scene in [flow['scene']] + [v['scene'] for v in flow.get('variants', [])]:
                # 民航航班不经光电（由航班接收机送给平台），航线几十公里，不在光电范围内。
                points = [p for t in scene['targets'] if t.get('kind') != 'flight' for p in t['path'] + t.get('departurePath', [])]
                for site in scene['sites']:
                    for device in site['devices']:
                        if device['kind'] != 'eo' or not points: continue
                        checked += 1
                        for point in points:
                            self.assertTrue(inside(device['coverage'], [site['x'], site['y']], point),
                                            (flow['flow'], device['id'], point))
        self.assertGreater(checked, 10)

    def test_written_coverage_is_kept_and_wide_spread_becomes_circle(self):
        written = {'kind': 'sector', 'rangeM': 900, 'azimuthDeg': 10, 'fovDeg': 40}
        scene = {'targets': [{'path': [[100, 0], [-100, 0], [0, 100], [0, -100]]}],
                 'sites': [{'x': 0, 'y': 0, 'devices': [{'kind': 'eo'}, {'kind': 'eo', 'coverage': dict(written)}, {'kind': 'radar'}]}]}
        _cover_paths_with_eo(scene)
        devices = scene['sites'][0]['devices']
        self.assertEqual(devices[0]['coverage']['kind'], 'circle')
        self.assertEqual(devices[1]['coverage'], written)
        self.assertNotIn('coverage', devices[2])


if __name__ == '__main__':
    unittest.main()


class GimbalLockTest(unittest.TestCase):
    def test_captured_target_stays_locked_when_platform_guide_lags(self):
        from eo_pointing import SimulatedGimbal
        b = {'longitude': 118, 'latitude': 37, 'altitude_m': 0, 'altitude_datum': 'AMSL',
             'coverage': {'kind': 'circle', 'radiusM': 3000}}
        def at(lon, lat):
            return {'longitude': lon, 'latitude': lat, 'altitude': 80, 'altitude_datum': 'AMSL', 'coordinate_system': 'WGS84'}
        def guide(point, t):
            return {'source_mode': 'replay', 'latest_state': {'observed_at': t * 1000,
                    'location': {k: point[k] for k in ('longitude', 'latitude', 'coordinate_system')}, 'altitude_amsl_m': 80}}
        g = SimulatedGimbal(b, 0); g.begin(0)
        east = at(118.002, 37)
        for t in range(1, 5): g.update(east, guide(east, t), t)
        self.assertEqual(g.state, 'TRACKING')
        # 近处快速横穿（约 175 米外、每秒约 15°），平台位置晚一秒：锁住后跟画面走，不再跳「转向寻找中」。
        previous = east
        for step in range(1, 8):
            now = at(118.002, 37 + .0004 * step)
            self.assertTrue(g.update(now, guide(previous, 4 + step), 4 + step), step)
            previous = now


class NormalizedSourceLinkTest(unittest.TestCase):
    def setUp(self):
        self.target = {'id': 'u', 'deviceId': 'radar', 'secondaryDeviceId': '5ga', 'kind': 'uav', 'path': [[0, 0], [100, 0]],
                       'speed': 10, 'height': 80, 'transport': 'normalized', 'secondaryTransport': 'normalized', 'altitudeDatum': 'AMSL'}
        self.manifest = {'batch': 'sim-1', 'devices': {}, 'targets': {'u': {'external_id': 'sim-1-t1'}},
                         'normalized_sources': {'radar': {'device_id': 'obs-radar'}, '5ga': {'device_id': 'obs-5ga'}}}
        self.generator = EoObservations(PAGE_DEFAULT_CONFIG, self.manifest, {'u': self.target}, lambda: 5)

    def link(self, **change):
        return dict({'device_id': 'obs-5ga', 'external_target_id': 'sim-1-t1', 'source_mode': 'replay'}, **change)

    def test_batch_external_id_on_this_batch_source_identifies_the_target(self):
        self.assertEqual(self.generator.observation({'source_links': [self.link()]}, {})['className'], 'drone')
        self.assertIsNotNone(self.generator.observation({'source_links': [self.link()]}, {}, acquisition=True))

    def test_other_batch_other_device_or_live_never_match(self):
        for altered in (self.link(external_target_id='sim-2-t1'), self.link(device_id='obs-other'), self.link(source_mode='live')):
            self.assertIsNone(self.generator.observation({'source_links': [altered]}, {}))
        second = dict(self.target, id='v'); self.generator.targets['v'] = second
        self.manifest['targets']['v'] = {'external_id': 'sim-1-t1'}
        self.assertIsNone(self.generator.observation({'source_links': [self.link()]}, {}))


class CoverDuplicateBearingTest(unittest.TestCase):
    def test_repeated_points_do_not_hide_the_far_side(self):
        # 东北、正东（重复两次）、正南：重复的方向不能让最宽缺口算错。
        points = [[100, -173], [100, 0], [100, 0], [0, 200]]
        scene = {'targets': [{'path': points}], 'sites': [{'x': 0, 'y': 0, 'devices': [{'kind': 'eo'}]}]}
        _cover_paths_with_eo(scene)
        coverage = scene['sites'][0]['devices'][0]['coverage']
        for point in points:
            self.assertTrue(inside(coverage, [0, 0], point), (coverage, point))
        single = {'targets': [{'path': [[100, 0]]}], 'sites': [{'x': 0, 'y': 0, 'devices': [{'kind': 'eo'}]}]}
        _cover_paths_with_eo(single)
        self.assertEqual(single['sites'][0]['devices'][0]['coverage']['azimuthDeg'], 90)
