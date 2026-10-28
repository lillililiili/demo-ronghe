import json
import math
import unittest
from pathlib import Path

from acceptance_flows import read_acceptance_flows
from adsb_flights import AdsbReceivers, PREFIX, STATION_GUID, background_flights, flight_at, pingstation_traffic
from engine import compile_scene, coordinates, target_sample

ROOT = Path(__file__).resolve().parents[1]
CENTER = tuple(coordinates([450, 300]))  # 流程 1-7 模拟设备组所在点位


def km(row):
    return math.hypot((row['longitude'] - CENTER[0]) * 111.32 * math.cos(math.radians(CENTER[1])),
                      (row['latitude'] - CENTER[1]) * 111.32)


def flow_scene(variant):
    flow = next(item for item in read_acceptance_flows(ROOT)['flows'] if item['flow'] == 10)
    return next(item for item in flow['variants'] if item['id'] == variant)['scene']


def plane(variant, elapsed):
    scene, _, _, _ = compile_scene(flow_scene(variant))
    return flight_at(scene['flights'][0], elapsed, 0)


class FakeApi:
    base = 'http://127.0.0.1:8081/api/v1'

    def __init__(self):
        self.calls = []

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, body))
        if path == PREFIX:
            return {'device_id': 'receiver-' + body['station_guid'][-4:]}
        return {}


def scene_with_receiver(**device):
    return {'version': 1, 'name': '航班', 'duration': 1, 'plans': [], 'zones': [], 'risks': [],
            'sites': [{'id': 's1', 'name': '点位', 'x': 450, 'y': 300, 'devices': [
                {'id': 'd1', 'name': '雷达', 'kind': 'radar', 'health': '正常', 'heartbeat': '持续上报', 'interval': 1},
                dict({'id': 'a1', 'name': '航班接收机 01', 'kind': 'adsb', 'health': '正常', 'heartbeat': '持续上报', 'interval': 1}, **device)]}],
            'targets': [{'id': 'f1', 'kind': 'flight', 'name': '民航航班 1', 'callsign': 'csn6875', 'path': [[450, 300], [650, 300]],
                         'height': 2500, 'speed': 100, 'motionMode': 'once'}]}


class AdsbFlightsTest(unittest.TestCase):
    def test_enter_variant_follows_the_guide(self):
        # 开始时飞得高（不算），约 60 秒降到 3000 米以下、在 20 公里提醒范围，140 秒后转向反制设备飞到 10 公里以内，约 370 秒爬升到 3000 米以上。
        self.assertGreater(plane('enter', 30)['altitude_m'], 3000)
        self.assertLess(plane('enter', 65)['altitude_m'], 3000)
        self.assertAlmostEqual(20, km(plane('enter', 100)), delta=.5)
        self.assertLess(km(plane('enter', 230)), 10)
        self.assertLess(plane('enter', 300)['altitude_m'], 3000)
        self.assertGreater(plane('enter', 375)['altitude_m'], 3000)
        self.assertEqual(('780A1B', 'CES2471', '东方航空'), (plane('enter', 0)['icao24'].upper(), plane('enter', 0)['callsign'], plane('enter', 0)['airline']))

    def test_no_data_variant_keeps_the_flight_far_away_and_cuts_the_receiver_for_four_minutes(self):
        for elapsed in (0, 100, 300, 480):
            self.assertGreater(km(plane('no_data', elapsed)), 40)
            self.assertLess(km(plane('no_data', elapsed)), 52)
        scene, _, _, _ = compile_scene(flow_scene('no_data'))
        outage = next(risk for risk in scene['risks'] if risk['type'] == 'offline')
        self.assertEqual(('acceptance-adsb', 60, 240), (outage['deviceId'], outage['at'], outage['seconds']))
        receivers = AdsbReceivers(FakeApi(), {'owner_org_id': 'org', 'district_id': 'dist'}, scene, sender=lambda _: None)
        receivers.prepare()
        self.assertGreater(receivers.tick(30, 1000), 0)
        self.assertEqual(0, receivers.tick(60, 2000))
        self.assertEqual(0, receivers.tick(299, 3000))
        self.assertTrue(receivers.snapshot()['offline'])
        self.assertGreater(receivers.tick(300, 4000), 0)
        self.assertFalse(receivers.snapshot()['offline'])

    def test_flow_ten_receiver_keeps_its_fixed_number_and_guid(self):
        scene, devices, _, _ = compile_scene(flow_scene('enter'))
        receiver = next(d for site in scene['sites'] for d in site['devices'] if d['kind'] == 'adsb')
        self.assertEqual(('SIM-ADSB-DY01', STATION_GUID, 350, 60), (receiver['deviceNo'], receiver['stationGuid'], receiver['rangeKm'], receiver['backgroundFlights']))
        self.assertNotIn('acceptance-adsb', devices)  # 不是 MQTT 设备
        self.assertEqual(['flow10-flight'], [f['id'] for f in scene['flights']])
        self.assertEqual(['流程 10 偏航无人机'], [t['name'] for t in scene['targets']])

    def test_receiver_registers_at_its_site_pushes_pingstation_udp_every_second_and_releases(self):
        api = FakeApi()
        sent = []
        scene, _, _, _ = compile_scene(scene_with_receiver(backgroundFlights=5, rangeKm=200))
        receivers = AdsbReceivers(api, {'owner_org_id': 'org', 'district_id': 'dist'}, scene, sender=sent.append)
        receivers.prepare()
        method, path, body = api.calls[0]
        self.assertEqual(('POST', PREFIX), (method, path))
        self.assertEqual({'owner_org_id': 'org', 'district_id': 'dist', 'device_no': 'SIM-ADSB-' + body['station_guid'][:8].upper(),
                          'name': '模拟 航班接收机 01', 'longitude': CENTER[0], 'latitude': CENTER[1], 'receive_range_km': 200,
                          'station_guid': body['station_guid']}, body)
        self.assertRegex(body['station_guid'], r'^[0-9a-f]{16}$')
        self.assertEqual(6, receivers.tick(0, 1000))   # 5 架背景航班 + 1 架画的航班
        self.assertEqual(7, len(sent))                   # 一条状态 + 一架一条
        self.assertEqual(body['station_guid'], json.loads(sent[0])['status']['pingStationGuid'])
        drawn = json.loads(sent[-1])['aircraft'][0]
        self.assertEqual(('CSN6875 ', 2500000, '1970-01-01T00:00:01Z', 10000), (drawn['callsign'], drawn['altitudeMM'], drawn['timeStamp'], drawn['horVelocityCMS']))
        self.assertEqual(6, receivers.tick(1, 2000))   # 每秒一遍，30 秒内不再发状态
        self.assertEqual(13, len(sent))
        for message in sent[1:6]:
            self.assertGreaterEqual(json.loads(message)['aircraft'][0]['altitudeMM'], 7000000)  # 背景航班都在高空
        self.assertEqual({'aircraft': 6, 'per_second': 6, 'sent': 13, 'offline': False}, {k: receivers.snapshot()[k] for k in ('aircraft', 'per_second', 'sent', 'offline')})
        receivers.release()
        self.assertEqual(('POST', PREFIX + '/receiver-' + body['station_guid'][-4:] + '/release', {}), api.calls[-1])
        receivers.release()  # 再停一次不会重复请求
        self.assertEqual(1, sum(1 for call in api.calls if call[1].endswith('/release')))

    def test_disconnected_receiver_sends_nothing(self):
        sent = []
        scene, _, _, _ = compile_scene(scene_with_receiver(heartbeat='停止心跳', backgroundFlights=3))
        receivers = AdsbReceivers(FakeApi(), {'owner_org_id': 'org', 'district_id': 'dist'}, scene, sender=sent.append)
        receivers.prepare()
        self.assertEqual(0, receivers.tick(5, 1000))
        self.assertEqual([], sent)
        self.assertTrue(receivers.snapshot()['offline'])

    def test_background_flights_are_the_same_every_start_and_stay_inside_the_range(self):
        first, second = background_flights('a1b2c3d4e5f60001', 60, 350), background_flights('a1b2c3d4e5f60001', 60, 350)
        self.assertEqual(first, second)
        self.assertEqual(60, len({row['icao24'] for row in first}))
        self.assertNotEqual(first[0]['callsign'], background_flights('ffffffffffffffff', 60, 350)[0]['callsign'])
        scene, _, _, _ = compile_scene(scene_with_receiver(backgroundFlights=60))
        receivers = AdsbReceivers(FakeApi(), {'owner_org_id': 'org', 'district_id': 'dist'}, scene, sender=lambda _: None)
        receiver = receivers.receivers[0]
        for elapsed in (0, 600, 3600):
            for row in receiver.aircraft_at(elapsed, 0)[:60]:
                self.assertLessEqual(km(row), 350)

    def test_flight_outside_the_receiver_range_is_not_reported(self):
        scene, _, _, _ = compile_scene(scene_with_receiver(backgroundFlights=0, rangeKm=10))
        scene['flights'][0]['path'] = [[450 + 20000 / 10.6, 300]]  # 约 20 公里外
        receivers = AdsbReceivers(FakeApi(), {'owner_org_id': 'org', 'district_id': 'dist'}, scene, sender=lambda _: None)
        receivers.prepare()
        self.assertEqual(0, receivers.tick(0, 1000))

    def test_traffic_datagram_rounds_units_like_the_receiver(self):
        row = {'icao24': '780a1b', 'callsign': 'CES2471', 'longitude': 118.6, 'latitude': 37.4, 'altitude_m': 1500,
               'ground_speed_mps': 211.43, 'track_deg': 263.3, 'vertical_mps': -5.2, 'observed_at': 1700000000000}
        plane = json.loads(pingstation_traffic(row, STATION_GUID, 7))['aircraft'][0]
        self.assertEqual((1500000, 26330, 21143, -520, 7, '780A1B'), (plane['altitudeMM'], plane['headingDE2'], plane['horVelocityCMS'], plane['verVelocityCMS'], plane['sequenceNumber'], plane['icaoAddress']))

    def test_flow_ten_is_built_from_flow_five_with_both_variants(self):
        flows = read_acceptance_flows(ROOT)['flows']
        flow = next(item for item in flows if item['flow'] == 10)
        self.assertEqual('反制前附近有航班', flow['title'])
        self.assertEqual(['enter', 'no_data'], [item['id'] for item in flow['variants']])
        for variant in flow['variants']:
            self.assertEqual(variant['id'], variant['scene']['fullchain']['adsb']['variant'])
            self.assertEqual(8, variant['minutes'])
            self.assertEqual(['flight'], [t['kind'] for t in variant['scene']['targets'] if t['kind'] == 'flight'])
        five = next(item for item in flows if item['flow'] == 5)
        self.assertFalse(any(d['kind'] == 'adsb' for site in five['scene']['sites'] for d in site['devices']))


class FlightEngineTest(unittest.TestCase):
    def test_flight_is_compiled_apart_from_sensor_targets(self):
        scene, devices, targets, skipped = compile_scene(scene_with_receiver())
        self.assertEqual([], list(targets))
        self.assertEqual([], skipped)
        flight = scene['flights'][0]
        self.assertEqual(('CSN6875', '', 'once', 5000.0), (flight['callsign'], flight['airline'], flight['motionMode'], flight['orbitRadiusM']))
        self.assertRegex(flight['icao24'], r'^78[0-9a-f]{4}$')
        # 已编译的场景再编译一遍（服务重启时会这样）结果一样。
        again, _, _, _ = compile_scene(scene)
        self.assertEqual(scene['flights'], again['flights'])

    def test_flight_needs_a_receiver_and_a_callsign(self):
        raw = scene_with_receiver()
        raw['sites'][0]['devices'].pop()
        with self.assertRaisesRegex(ValueError, '航班接收机'):
            compile_scene(raw)
        raw = scene_with_receiver()
        raw['targets'][0]['callsign'] = 'x'
        with self.assertRaisesRegex(ValueError, '航班号'):
            compile_scene(raw)
        raw = scene_with_receiver(health='故障')
        with self.assertRaisesRegex(ValueError, '没有故障码'):
            compile_scene(raw)
        raw = scene_with_receiver(stationGuid='zz')
        with self.assertRaisesRegex(ValueError, '识别码'):
            compile_scene(raw)

    def test_orbit_mode_circles_the_last_point_to_the_right(self):
        raw = scene_with_receiver()
        raw['targets'][0].update(motionMode='orbit', orbitRadiusM=2000, speed=100)
        scene, _, _, _ = compile_scene(raw)
        flight = scene['flights'][0]
        end = target_sample(flight, 0)
        last = coordinates([650, 300])
        arrival = 200 * 10.6 / 100  # 约 21 秒到最后一个点
        circumference = 2 * math.pi * 2000 / 100
        distances = []
        for step in range(8):
            sample = target_sample(flight, arrival + 1 + step * circumference / 8)
            distances.append(math.hypot((sample['longitude'] - last[0]) * 111320 * math.cos(math.radians(last[1])), (sample['latitude'] - last[1]) * 111320))
            self.assertAlmostEqual(100, sample['speed'], delta=.5)
        self.assertLessEqual(max(distances), 4000 + 50)    # 圈经过最后一个点，直径 4 公里
        self.assertGreater(max(distances), 3000)
        self.assertAlmostEqual(2500, end['altitude'])
        # 到最后一个点时向东飞，右转就是先向南
        sample = target_sample(flight, arrival + 2)
        self.assertLess(sample['latitude'], last[1])

    def test_offline_risk_may_point_at_a_receiver(self):
        raw = scene_with_receiver()
        raw['risks'].append({'id': 'r1', 'name': '接收机断开', 'type': 'offline', 'enabled': True, 'deviceId': 'a1', 'at': 5, 'seconds': 10})
        scene, _, _, _ = compile_scene(raw)
        self.assertEqual(1, len(scene['risks']))
        raw['risks'][0]['type'] = 'fault'
        with self.assertRaises(ValueError):
            compile_scene(raw)


if __name__ == '__main__':
    unittest.main()
