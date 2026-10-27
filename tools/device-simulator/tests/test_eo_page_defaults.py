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
                points = [p for t in scene['targets'] for p in t['path'] + t.get('departurePath', [])]
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
