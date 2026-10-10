"""Forecast coverage follows accepted simulation plans, not a primary plan or list order."""
import copy
import datetime as dt
import sys
import unittest
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from plan_weather import batch_forecasts, plan_forecast


class PlanWeatherTests(unittest.TestCase):
    def setUp(self):
        self.now = int(dt.datetime(2027, 2, 18, 15, tzinfo=dt.timezone.utc).timestamp() * 1000)
        self.weather = {'area_name': '场景气象范围', 'summary': '模拟多云', 'wind_speed_ms': 3, 'gust_ms': 5}
        self.scene = {'fullchain': {'categories': ['weather'], 'weather': self.weather}}

    def test_all_plans_and_extra_task_have_full_coverage_across_dates_sources_and_order(self):
        for shift in (0, 45 * 86400000):
            with self.subTest(shift=shift):
                now = self.now + shift
                plans = {str(uuid4()): {'start_at': now + begin, 'end_at': now + end, 'source_mode': mode}
                         for begin, end, mode in [(-86400000, -60000, 'replay'),
                                                 (-3600000, 3600000, 'replay'),
                                                 (60000, 86400000, 'mock')]}
                extra_id = str(uuid4())
                extra = {extra_id: {'start_at': now, 'end_at': now + 40 * 60000, 'source_mode': 'mock'}}
                manifest = {'batch': str(uuid4()), 'created_at': now, 'plan_expectations': plans,
                            'plans': {'route': {'ids': list(reversed(plans))}}}
                bodies = batch_forecasts(self.scene, manifest, extra)
                self.assertEqual({row['plan_id'] for row in bodies}, set(plans) | set(extra))
                for body in bodies:
                    expected = {**plans, **extra}[body['plan_id']]
                    self.assertEqual((body['periods'][0]['from'], body['periods'][0]['to']),
                                     (expected['start_at'], expected['end_at']))
                    self.assertLessEqual(body['published_at'], body['periods'][0]['from'])
                    self.assertLessEqual(body['published_at'], now)
                    self.assertEqual(body['periods'][0]['wind_speed_ms'], 3)
                    self.assertRegex(body['message_id'], r'^[A-Za-z0-9_-]{1,64}$')
                self.assertEqual(bodies, batch_forecasts(self.scene, manifest, extra))

    def test_changed_weather_or_batch_gets_new_message_but_does_not_mutate_inputs(self):
        plan = {'start_at': self.now, 'end_at': self.now + 60000, 'source_mode': 'mock'}
        original = copy.deepcopy(self.weather)
        a = plan_forecast('a', 'p', plan, self.weather, self.now)
        b = plan_forecast('b', 'p', plan, self.weather, self.now)
        c = plan_forecast('a', 'p', plan, dict(self.weather, wind_speed_ms=8), self.now)
        self.assertEqual(len({r['message_id'] for r in (a, b, c)}), 3)
        self.assertEqual(self.weather, original)
        decimals = plan_forecast('a', 'p', plan, dict(self.weather, wind_from_degrees=91.5, humidity_percent=67.5), self.now)
        self.assertEqual(decimals['periods'][0]['wind_direction_deg'], 91)
        self.assertEqual(decimals['periods'][0]['humidity_pct'], 67)

    def test_explicit_periods_preserved_but_gap_or_nonoverlap_rejected(self):
        plan = {'start_at': self.now, 'end_at': self.now + 120000, 'source_mode': 'replay'}
        periods = [{'from': self.now, 'to': self.now + 60000, 'summary': '模拟晴'},
                   {'from': self.now + 60000, 'to': self.now + 120000, 'summary': '模拟多云'}]
        self.assertEqual(plan_forecast('b', 'p', plan, {'periods': periods}, self.now)['periods'], periods)
        for bad in ([dict(periods[0], to=self.now + 30000), periods[1]],
                    [dict(periods[0], **{'from': self.now + 1000})], list(reversed(periods))):
            with self.subTest(periods=bad), self.assertRaises(ValueError):
                plan_forecast('b', 'p', plan, {'periods': bad}, self.now)

    def test_live_missing_windows_and_partial_batch_never_get_simulated_success(self):
        plan = {'start_at': self.now, 'end_at': self.now + 60000, 'source_mode': 'mock'}
        for bad in (dict(plan, source_mode='live'), dict(plan, start_at=None), dict(plan, end_at=self.now)):
            with self.subTest(plan=bad), self.assertRaises(ValueError):
                plan_forecast('b', 'p', bad, self.weather, self.now)
        with self.assertRaises(ValueError):
            batch_forecasts(self.scene, {'plans': {'r': {'ids': ['missing']}}, 'plan_expectations': {}})
        self.assertEqual(batch_forecasts({'fullchain': {'categories': ['uav']}}, {}), [])


if __name__ == '__main__':
    unittest.main()
