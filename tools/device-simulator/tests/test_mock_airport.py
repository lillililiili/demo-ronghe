import copy
import json
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mock_airport
from engine import coordinates
from full_scenario import full_scene

SCOPE = {'owner_org_id': 'org-1', 'district_id': 'district-1'}


class AirportPlatform:
    """Append-only airport API, as the platform has it: no edit, no delete."""

    def __init__(self, airports=None):
        self.calls, self.airports = [], copy.deepcopy(airports or {})

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, copy.deepcopy(body), key))
        if method == 'GET' and path.startswith('/airports?'):
            items = [a['airport'] for a in self.airports.values()]
            return {'items': items, 'page': 1, 'size': 100, 'total': len(items)}
        if method == 'GET' and path.startswith('/airports/'):
            return copy.deepcopy(self.airports[path.split('/')[2]])
        if method == 'POST' and path == '/airports':
            airport = {'airport_id': 'a1', 'icao_code': body['icao_code'], 'name': body['name'],
                       'owner_org_id': body['owner_org_id'], 'district_id': body['district_id']}
            self.airports['a1'] = {'airport': airport, 'procedure_routes': [], 'protected_targets': []}
            return airport
        if method == 'POST' and path.endswith('/procedure-routes'):
            self.airports[path.split('/')[2]]['procedure_routes'].append({'name': body['name']})
            return {'route_id': 'r1'}
        if method == 'POST' and path.endswith('/protected-targets'):
            self.airports[path.split('/')[2]]['protected_targets'].append({'name': body['name']})
            return {'protected_target_id': 't1'}
        raise AssertionError((method, path))

    def posts(self):
        return [(path, body) for method, path, body, _ in self.calls if method == 'POST']


def metres(a, b):
    """Local flat-earth distance in metres between two lon/lat points (fine at a few kilometres)."""
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot((a[0] - b[0]) * 111320 * math.cos(lat), (a[1] - b[1]) * 111320)


def to_segment(point, a, b):
    lat = math.radians(point[1])
    def xy(p): return ((p[0] - point[0]) * 111320 * math.cos(lat), (p[1] - point[1]) * 111320)
    (ax, ay), (bx, by) = xy(a), xy(b)
    dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx, ay + t * dy)


class MockAirportTest(unittest.TestCase):
    def test_first_entry_creates_one_airport_route_and_target_in_the_connection_scope(self):
        platform = AirportPlatform()
        result = mock_airport.ensure(platform, SCOPE)
        posts = platform.posts()
        self.assertEqual([p for p, _ in posts], ['/airports', '/airports/a1/procedure-routes', '/airports/a1/protected-targets'])
        airport, route, target = (b for _, b in posts)
        self.assertEqual((airport['owner_org_id'], airport['district_id']), ('org-1', 'district-1'))
        self.assertEqual(airport['icao_code'], 'ZZMOCK')
        self.assertIn('模拟', airport['name'])
        self.assertTrue(route['centerline'].startswith('SRID=4326;LINESTRING('))
        self.assertEqual(route['kind'], 'APPROACH')
        self.assertEqual(target['kind'], 'TOWER')
        self.assertTrue(result['exists'] and result['complete'])
        self.assertEqual(result['message'], '已录入模拟机场、进近航线和保护目标')
        # 每次写入各用一个新的幂等键：平台对重放的同一键返回 409，不能复用。
        self.assertEqual(len({key for method, _, _, key in platform.calls if method == 'POST'}), 3)

    def test_second_entry_changes_nothing(self):
        platform = AirportPlatform()
        mock_airport.ensure(platform, SCOPE)
        platform.calls.clear()
        result = mock_airport.ensure(platform, SCOPE)
        self.assertEqual(platform.posts(), [])
        self.assertEqual(result['message'], '模拟机场资料已在系统里，没有重复录入')

    def test_a_half_entered_airport_only_gets_what_is_missing(self):
        platform = AirportPlatform({'a1': {'airport': {'airport_id': 'a1', 'icao_code': 'ZZMOCK', **SCOPE},
                                           'procedure_routes': [{'name': mock_airport.APPROACH_NAME}], 'protected_targets': []}})
        result = mock_airport.ensure(platform, SCOPE)
        self.assertEqual([p for p, _ in platform.posts()], ['/airports/a1/protected-targets'])
        self.assertEqual(result['message'], '已补录保护目标')
        self.assertTrue(result['complete'])

    def test_an_airport_in_another_scope_is_reported_not_duplicated(self):
        platform = AirportPlatform({'a1': {'airport': {'airport_id': 'a1', 'icao_code': 'ZZMOCK',
                                                       'owner_org_id': 'other', 'district_id': 'district-1'},
                                           'procedure_routes': [], 'protected_targets': []}})
        with self.assertRaisesRegex(ValueError, '单位或区域和模拟器连接不一致'):
            mock_airport.ensure(platform, SCOPE)
        self.assertEqual(platform.posts(), [])

    def test_missing_connection_scope_is_explained(self):
        with self.assertRaisesRegex(ValueError, '未找到启用的回放'):
            mock_airport.ensure(AirportPlatform(), {'owner_org_id': None, 'district_id': None,
                                                    'message': '未找到启用的回放 MQTT 连接 local-lingyun-replay，请手动选择归属单位与区县'})

    def test_status_reads_without_writing(self):
        platform = AirportPlatform()
        self.assertFalse(mock_airport.status(platform)['exists'])
        mock_airport.ensure(platform, SCOPE)
        platform.calls.clear()
        state = mock_airport.status(platform)
        self.assertTrue(state['exists'] and state['complete'])
        self.assertEqual(platform.posts(), [])

    def test_test_points_sit_300_m_and_1_km_from_the_approach_and_far_from_the_tower(self):
        shape = mock_airport.layout()
        a, b = shape['approach']
        near, far = shape['test_points']
        self.assertAlmostEqual(to_segment((near['longitude'], near['latitude']), a, b), 300, delta=5)
        self.assertAlmostEqual(to_segment((far['longitude'], far['latitude']), a, b), 1000, delta=10)
        for point in (near, far):
            # 保护目标周边 200 米也算机场附近：试放点必须离它远，结果才只取决于到进近航线的距离。
            self.assertGreater(metres((point['longitude'], point['latitude']), shape['protected']), 1000)
            # 地图上画的位置和录进系统的经纬度是同一个点。
            self.assertLess(metres(coordinates(point['grid']), (point['longitude'], point['latitude'])), 2)

    def test_test_points_are_far_from_every_demo_task_route(self):
        # 气球靠近任务航线会另出“气球邻近航线”风险；试放点离所有演示任务都超过 1 公里，结果只看机场。
        demo = json.loads((Path(__file__).resolve().parents[1] / 'web' / 'demo-samples.json').read_text(encoding='utf-8'))
        routes = [p['points'] for p in full_scene()['plans'] + demo['plans']]
        routes.append([[260, 470], [361, 429], [475, 419], [611, 402], [729, 368], [825, 318]])  # 地图默认场景的巡检任务
        for point in mock_airport.layout()['test_points']:
            here = (point['longitude'], point['latitude'])
            nearest = min(to_segment(here, coordinates(a), coordinates(b)) for route in routes for a, b in zip(route, route[1:]))
            self.assertGreater(nearest, 1000, point)


if __name__ == '__main__':
    unittest.main()
