"""Polygon-hole input validation and API/WKT preservation, entirely in memory."""
import copy
import datetime as dt
import math
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import compile_scene, coordinates, zone_polygon_rings
from fullchain import FullChain, PREFIX, SHANGHAI
from platform_client import Prerequisites


NOW = int(dt.datetime(2026, 11, 2, 12, tzinfo=SHANGHAI).timestamp() * 1000)
OUTER = [[100, 100], [300, 100], [300, 300], [100, 300]]
HOLE = [[140, 140], [180, 140], [180, 180], [140, 180]]
SECOND = [[220, 220], [260, 220], [260, 260], [220, 260]]


def zone(**values):
    return dict(id='area-unit', name='含孔测试区域', points=copy.deepcopy(OUTER),
                holes=[copy.deepcopy(HOLE)], max=300, start='00:00', end='23:59',
                kindCode='PROHIBITED', **values)


def scene(boundary):
    return {'version': 1, 'duration': 1, 'name': '区域几何验证',
            'sites': [{'id': 'site-unit', 'name': '测试组', 'x': 160, 'y': 160,
                       'devices': [{'id': 'radar-unit', 'name': '测试雷达', 'kind': 'radar',
                                    'health': '正常', 'heartbeat': '持续上报', 'interval': 1}]}],
            'zones': [copy.deepcopy(boundary)], 'plans': [], 'risks': [],
            'targets': [{'id': 'target-unit', 'name': '孔内目标', 'kind': 'uav',
                         'deviceId': 'radar-unit', 'path': [[150, 150], [170, 150]],
                         'height': 100, 'speed': 5, 'transport': 'mqtt', 'planId': ''}]}


class Platform:
    def __init__(self, previous=None):
        self.previous = copy.deepcopy(previous)
        self.calls = []

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, copy.deepcopy(body)))
        if path.endswith('/plan-options'):
            return {'pilots': [], 'organizations': [], 'source_bindings': []}
        if path.endswith('/airspaces/context'):
            return {'items': [self.previous] if self.previous else []}
        if path.endswith('/context'):
            return {'routes': [], 'messages': []}
        if method == 'POST' and path.endswith('/airspaces'):
            self.previous = {'airspace_id': 'area-result', 'airspace_version_id': 'version-result',
                             'airspace_no': body['airspace_no'], 'revision': body['revision'],
                             'state': 'ACCEPTED', 'action': body['action'], 'payload': copy.deepcopy(body)}
            return {key: value for key, value in self.previous.items() if key != 'payload'}
        raise AssertionError((method, path))

    def posts(self):
        return [body for method, path, body in self.calls if method == 'POST']


def chain(platform, boundary, batch='batch-unit'):
    return FullChain(platform, scene(boundary),
                     {'batch': batch, 'created_at': NOW, 'devices': {}, 'zones': {}, 'plans': {}, 'targets': {}},
                     {'owner_org_id': 'owner-unit', 'district_id': 'district-unit'}, lambda: None,
                     clock=lambda: NOW + 1000)


class ZoneHoleValidationTest(unittest.TestCase):
    def test_open_and_closed_multiple_rings_preserve_input_and_compile(self):
        for closed in (False, True):
            for reverse in (False, True):
                with self.subTest(closed=closed, reverse=reverse):
                    boundary = zone()
                    boundary['holes'].append(copy.deepcopy(SECOND))
                    for ring in [boundary['points']] + boundary['holes']:
                        if reverse:
                            ring.reverse()
                        if closed:
                            ring.append(ring[0][:])
                    original = copy.deepcopy(boundary)
                    rings = zone_polygon_rings(boundary)
                    self.assertEqual(3, len(rings))
                    self.assertTrue(all(len(ring) == 5 and ring[0] == ring[-1] for ring in rings))
                    compiled, *_ = compile_scene(scene(boundary))
                    self.assertEqual(original, boundary)
                    self.assertEqual(boundary['holes'], compiled['zones'][0]['holes'])
                    self.assertEqual([[150, 150], [170, 150]], compiled['targets'][0]['path'])

    def test_missing_or_empty_holes_uses_the_same_original_outer_boundary(self):
        missing = zone()
        missing.pop('holes')
        empty = dict(missing, holes=[])
        self.assertEqual(zone_polygon_rings(missing), zone_polygon_rings(empty))
        first, second = Platform(), Platform()
        chain(first, missing).prepare()
        chain(second, empty).prepare()
        self.assertEqual(first.posts()[0]['boundary'], second.posts()[0]['boundary'])
        self.assertEqual(1, len(first.posts()[0]['boundary']['coordinates']))

    def test_coordinate_pairs_must_be_finite_numbers(self):
        for point in ([100], [100, 100, 1], [True, 100], ['100', 100], [None, 100],
                      [math.inf, 100], [math.nan, 100], 'not-a-point'):
            for target in ('outer', 'hole'):
                with self.subTest(point=point, target=target):
                    boundary = zone()
                    (boundary['points'] if target == 'outer' else boundary['holes'][0])[0] = point
                    with self.assertRaises(ValueError):
                        compile_scene(scene(boundary))

    def test_invalid_hole_collections_are_not_silently_dropped(self):
        for holes in (None, {}, 'ignored', [None], [[]], [HOLE] * 101):
            with self.subTest(holes=holes):
                boundary = zone()
                boundary['holes'] = holes
                with self.assertRaises(ValueError):
                    zone_polygon_rings(boundary)

    def test_degenerate_duplicate_self_crossing_and_backtracking_rings_rejected(self):
        invalid = (
            [[140, 140], [180, 140]],
            [[140, 140], [180, 140], [140, 140]],
            [[140, 140], [160, 140], [180, 140]],
            [[140, 140], [180, 140], [180, 180], [140, 140], [140, 180]],
            [[140, 140], [190, 180], [140, 180], [180, 140]],
            [[140, 140], [180, 140], [160, 140], [180, 180], [140, 180]],
        )
        for ring in invalid:
            for target in ('outer', 'hole'):
                with self.subTest(ring=ring, target=target):
                    boundary = zone()
                    if target == 'outer':
                        boundary.update(points=ring, holes=[])
                    else:
                        boundary['holes'] = [ring]
                    with self.assertRaises(ValueError):
                        zone_polygon_rings(boundary)

    def test_hole_outside_crossing_or_touching_outer_rejected(self):
        for ring in (
            [[310, 110], [320, 110], [320, 120], [310, 120]],
            [[90, 150], [150, 150], [150, 180], [90, 180]],
            [[100, 140], [150, 140], [150, 180], [100, 180]],
            [[100, 100], [150, 120], [120, 150]],
            [[90, 90], [310, 90], [310, 310], [90, 310]],
        ):
            with self.subTest(ring=ring):
                boundary = zone()
                boundary['holes'] = [ring]
                with self.assertRaises(ValueError):
                    zone_polygon_rings(boundary)

    def test_holes_cannot_overlap_touch_or_nest_in_either_order(self):
        for other in (
            [[170, 170], [200, 170], [200, 200], [170, 200]],
            [[180, 140], [200, 140], [200, 160], [180, 160]],
            [[180, 180], [200, 180], [200, 200], [180, 200]],
            [[150, 150], [170, 150], [170, 170], [150, 170]],
            HOLE,
        ):
            for reverse in (False, True):
                with self.subTest(other=other, reverse=reverse):
                    boundary = zone()
                    boundary['holes'] = [other, HOLE] if reverse else [HOLE, other]
                    with self.assertRaises(ValueError):
                        zone_polygon_rings(boundary)

    def test_concave_outer_does_not_accept_a_hole_bridge_across_exterior(self):
        boundary = zone()
        boundary['points'] = [[100, 100], [300, 100], [300, 300], [230, 300],
                              [230, 180], [170, 180], [170, 300], [100, 300]]
        boundary['holes'] = [[[140, 220], [260, 220], [260, 260], [140, 260]]]
        with self.assertRaises(ValueError):
            zone_polygon_rings(boundary)
        boundary['holes'] = [[[120, 120], [140, 120], [140, 260], [120, 260]]]
        self.assertEqual(2, len(zone_polygon_rings(boundary)))

    def test_translated_scaled_geometry_keeps_the_same_rules(self):
        for scale, dx, dy in ((.1, -400, 700), (3, 1200, -800)):
            boundary = zone()
            boundary['id'] = 'another-area'
            boundary['holes'].append(copy.deepcopy(SECOND))
            for ring in [boundary['points']] + boundary['holes']:
                for point in ring:
                    point[:] = [point[0] * scale + dx, point[1] * scale + dy]
            self.assertEqual(3, len(zone_polygon_rings(boundary)))
            boundary['holes'][0][0] = boundary['points'][0][:]
            with self.assertRaises(ValueError):
                zone_polygon_rings(boundary)


class ZoneHolePublicationTest(unittest.TestCase):
    def test_polygon_keeps_all_closed_rings_in_wgs84_and_reuses_definition(self):
        boundary = zone()
        boundary['holes'].append(copy.deepcopy(SECOND))
        platform = Platform()
        chain(platform, boundary).prepare()
        expected = [[coordinates(point) for point in ring] for ring in zone_polygon_rings(boundary)]
        self.assertEqual({'type': 'Polygon', 'coordinates': expected}, platform.posts()[0]['boundary'])
        again = Platform(platform.previous)
        reused = chain(again, boundary, 'second-batch')
        reused.prepare()
        self.assertEqual([], again.posts())
        self.assertTrue(reused.state['requests']['zone-area-unit']['reused_by_readback'])

    def test_changing_adding_or_removing_holes_creates_a_new_revision(self):
        for change in ('move', 'add', 'remove'):
            with self.subTest(change=change):
                first = Platform()
                chain(first, zone()).prepare()
                boundary = zone()
                if change == 'move':
                    boundary['holes'] = [[[x + 10, y] for x, y in HOLE]]
                elif change == 'add':
                    boundary['holes'].append(copy.deepcopy(SECOND))
                else:
                    boundary.pop('holes')
                following = Platform(first.previous)
                chain(following, boundary, 'changed-batch').prepare()
                self.assertEqual(1, len(following.posts()))
                self.assertEqual(2, following.posts()[0]['revision'])
                self.assertNotEqual(first.posts()[0]['boundary'], following.posts()[0]['boundary'])
                self.assertGreater(following.posts()[0]['valid_from'], first.posts()[0]['valid_from'])

    def test_invalid_geometry_is_rejected_before_any_prepare_call(self):
        boundary = zone()
        boundary['holes'][0][0] = boundary['points'][0][:]
        platform = Platform()
        with self.assertRaises(ValueError):
            chain(platform, boundary).prepare()
        self.assertEqual([], platform.calls)

    def test_withdrawal_uses_existing_identity_and_leaves_boundary_history_intact(self):
        platform = Platform()
        run = chain(platform, zone())
        run.prepare()
        first = copy.deepcopy(platform.posts()[0])
        results = run.withdraw_zones()
        self.assertTrue(results[0]['ok'])
        stop = platform.posts()[1]
        self.assertEqual(('WITHDRAW', first['airspace_no'], 2),
                         (stop['action'], stop['airspace_no'], stop['revision']))
        self.assertNotIn('boundary', stop)
        self.assertEqual(first, platform.posts()[0])
        self.assertEqual(PREFIX + '/airspaces', platform.calls[-1][1])

    def test_legacy_isolated_wkt_keeps_every_ring_without_database_calls(self):
        boundary = zone()
        boundary['holes'].append(copy.deepcopy(SECOND))
        raw = scene(boundary)
        raw['risks'] = [{'id': 'risk-unit', 'name': '区域观测', 'type': 'zone',
                         'enabled': True, 'zoneId': boundary['id']}]
        calls = []
        seed = Prerequisites('isolated_unit_test')
        seed.query = lambda statement: calls.append(statement) or ('1' if statement.startswith('SELECT') else '')
        seed.create(raw, {}, {'broker_id': 'broker-unit', 'owner_org_id': 'owner-unit', 'district_id': 'district-unit'},
                    {'batch': 'wkt-batch', 'plans': {}, 'zones': {}, 'targets': {}}, NOW)
        wkt = re.search(r"ST_GeomFromText\('([^']+)'", calls[-1]).group(1)
        expected = 'MULTIPOLYGON((' + ','.join('(' + ','.join(f'{x} {y}' for x, y in map(coordinates, ring)) + ')'
                                              for ring in zone_polygon_rings(boundary)) + '))'
        self.assertEqual(expected, wkt)
        self.assertEqual(3, wkt.count('),(') + 1)

    def test_legacy_rejects_bad_hole_before_its_broker_query(self):
        boundary = zone()
        boundary['holes'][0][0] = boundary['points'][0][:]
        raw = scene(boundary)
        raw['risks'] = [{'type': 'zone', 'enabled': True, 'zoneId': boundary['id']}]
        calls = []
        seed = Prerequisites('isolated_unit_test')
        seed.query = lambda statement: calls.append(statement) or '1'
        with self.assertRaises(ValueError):
            seed.create(raw, {}, {'broker_id': 'broker-unit'},
                        {'batch': 'wkt-batch', 'plans': {}, 'zones': {}, 'targets': {}}, NOW)
        self.assertEqual([], calls)


if __name__ == '__main__':
    unittest.main()
