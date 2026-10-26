import math
import unittest

from adsb_flights import AdsbFeed, PREFIX, aircraft_at
from acceptance_flows import read_acceptance_flows
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CENTER = (118.614, 37.464)


def plane(variant, elapsed):
    rows = aircraft_at(variant, elapsed, CENTER, 0)
    return None if rows is None else rows[-1]


def km(row):
    return math.hypot((row['longitude'] - CENTER[0]) * 111.32 * math.cos(math.radians(CENTER[1])),
                      (row['latitude'] - CENTER[1]) * 111.32)


class FakeApi:
    def __init__(self):
        self.calls = []

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, body))
        if method == 'GET':
            return {'items': [{'longitude': 118.7, 'latitude': 37.5}]}
        if path == PREFIX:
            return {'device_id': 'receiver-1'}
        return {}


class AdsbFlightsTest(unittest.TestCase):
    def test_enter_variant_follows_the_guide(self):
        # 开始时飞得高（不算），约 60 秒降到 3000 米以下、在 20 公里提醒范围，140 秒后飞近到 10 公里以内，约 370 秒爬升到 3000 米以上。
        self.assertGreater(plane('enter', 30)['altitude_m'], 3000)
        self.assertLess(plane('enter', 62)['altitude_m'], 3000)
        self.assertAlmostEqual(20, km(plane('enter', 100)), delta=.5)
        self.assertLess(km(plane('enter', 230)), 10)
        self.assertLess(plane('enter', 300)['altitude_m'], 3000)
        self.assertGreater(plane('enter', 375)['altitude_m'], 3000)

    def test_no_data_variant_stops_reporting_for_four_minutes(self):
        self.assertIsNotNone(aircraft_at('no_data', 30, CENTER, 0))
        self.assertIsNone(aircraft_at('no_data', 60, CENTER, 0))
        self.assertIsNone(aircraft_at('no_data', 299, CENTER, 0))
        self.assertIsNotNone(aircraft_at('no_data', 300, CENTER, 0))
        self.assertGreater(km(plane('no_data', 10)), 30)

    def test_feed_registers_around_the_counter_device_reports_and_releases(self):
        api = FakeApi()
        feed = AdsbFeed(api, {'owner_org_id': 'org', 'district_id': 'dist'}, 'enter')
        feed.prepare()
        self.assertEqual((118.7, 37.5), feed.center)
        self.assertEqual(350, api.calls[1][2]['receive_range_km'])
        self.assertEqual(6, feed.tick(0, 1000))
        self.assertEqual(0, feed.tick(1, 2000))  # 每 2 秒送一次
        feed.release()
        self.assertEqual(('POST', PREFIX + '/receiver-1/release', {}), api.calls[-1])

    def test_flow_ten_is_built_from_flow_five_with_both_variants(self):
        flows = read_acceptance_flows(ROOT)['flows']
        flow = next(item for item in flows if item['flow'] == 10)
        self.assertEqual('反制前附近有航班', flow['title'])
        self.assertEqual(['enter', 'no_data'], [item['id'] for item in flow['variants']])
        for variant in flow['variants']:
            self.assertEqual(['adsb'], variant['scene']['fullchain']['categories'])
            self.assertEqual(variant['id'], variant['scene']['fullchain']['adsb']['variant'])
            self.assertEqual(8, variant['minutes'])
        five = next(item for item in flows if item['flow'] == 5)
        self.assertEqual([], five['scene']['fullchain']['categories'])


if __name__ == '__main__':
    unittest.main()
