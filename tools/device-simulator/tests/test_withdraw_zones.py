"""停止、完成、失败时撤回本批次下发的模拟空域（清单第 4 条），以及跨夜任务时段（第 8 条）。"""
import copy
import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from fullchain import FullChain, PREFIX, SHANGHAI, plan_window, stable_airspace_no

NOW = int(dt.datetime(2026, 10, 13, 12, 30, tzinfo=SHANGHAI).timestamp() * 1000)
END_OF_DAY = int(dt.datetime(2026, 10, 13, 23, 59, tzinfo=SHANGHAI).timestamp() * 1000)


def delivered(zone_id, revision=1, valid_from=None, valid_to=END_OF_DAY, state='ACCEPTED', action='UPSERT'):
    payload = {'valid_from': valid_from if valid_from is not None else NOW - 3600000, 'valid_to': valid_to}
    if action == 'WITHDRAW':
        payload = {'effective_at': NOW - 600000}
    return {'airspace_no': stable_airspace_no(zone_id), 'state': state, 'action': action, 'revision': revision,
            'payload': payload}


class Platform:
    def __init__(self, items, fail_for=()):
        self.items, self.fail_for, self.calls = items, set(fail_for), []

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, copy.deepcopy(body), key))
        if method == 'GET' and path.endswith('/airspaces/context'):
            return {'items': copy.deepcopy(self.items)}
        if method == 'POST' and path.endswith('/airspaces'):
            if body['airspace_no'] in self.fail_for:
                raise ValueError('系统接口 /local-interface-simulator/airspaces 返回 500：boom')
            return {'revision': body['revision'], 'airspace_id': 'a-' + body['airspace_no']}
        return {}

    def withdrawals(self):
        return [body for method, path, body, _ in self.calls if method == 'POST' and path.endswith('/airspaces')]


def chain_for(platform, zones, cancelled=None):
    scene = {'zones': zones}
    manifest = {'batch': 'sim-unit', 'created_at': NOW, 'devices': {}, 'plans': {}, 'zones': {}}
    return FullChain(platform, scene, manifest, {'owner_org_id': 'o', 'district_id': 'd'}, lambda: None,
                     clock=lambda: NOW, cancelled=cancelled)


ZONES = [{'id': 'z1', 'name': '限飞区域 A'}, {'id': 'z2', 'name': '限飞区域 B'}]


class WithdrawZonesTest(unittest.TestCase):
    def test_every_zone_the_platform_holds_as_valid_is_withdrawn_with_the_next_revision(self):
        platform = Platform([delivered('z1', 3), delivered('z2', 1)])
        results = chain_for(platform, ZONES).withdraw_zones()
        self.assertEqual([('限飞区域 A', True, 4), ('限飞区域 B', True, 2)],
                         [(r['zone'], r['ok'], r['revision']) for r in results])
        first, second = platform.withdrawals()
        self.assertEqual(('WITHDRAW', stable_airspace_no('z1'), 4, NOW), (first['action'], first['airspace_no'], first['revision'], first['effective_at']))
        self.assertEqual((stable_airspace_no('z2'), 2), (second['airspace_no'], second['revision']))
        self.assertNotEqual(first['message_id'], second['message_id'])
        self.assertIn('撤回', first['change_reason'])

    def test_the_withdrawal_takes_effect_strictly_after_the_delivery_it_cancels(self):
        # 刚下发过（生效时间离现在不到一秒）时，撤销时间要比它晚，否则平台按 409 拒收。
        platform = Platform([delivered('z1', 1, valid_from=NOW - 100)])
        chain_for(platform, ZONES[:1]).withdraw_zones()
        self.assertEqual(NOW - 100 + 1000, platform.withdrawals()[0]['effective_at'])
        platform = Platform([delivered('z1', 1, valid_from=NOW + 5000)])
        chain_for(platform, ZONES[:1]).withdraw_zones()
        self.assertEqual(NOW + 6000, platform.withdrawals()[0]['effective_at'])

    def test_withdrawn_unaccepted_unknown_and_expired_ones_are_left_alone(self):
        platform = Platform([delivered('z1', 2, action='WITHDRAW'), delivered('z2', 1, state='REJECTED'),
                             delivered('z3', 1, valid_to=NOW - 1000)])
        zones = ZONES + [{'id': 'z3', 'name': '已过期区域'}, {'id': 'z4', 'name': '从没下发过'}]
        self.assertEqual([], chain_for(platform, zones).withdraw_zones())
        self.assertEqual([], platform.withdrawals())

    def test_airspaces_delivered_by_hand_under_other_numbers_are_never_touched(self):
        platform = Platform([delivered('z1', 1), {'airspace_no': 'hand-made-1', 'state': 'ACCEPTED', 'action': 'UPSERT',
                                                  'revision': 1, 'payload': {'valid_from': NOW - 1000, 'valid_to': END_OF_DAY}}])
        chain_for(platform, ZONES[:1]).withdraw_zones()
        self.assertEqual([stable_airspace_no('z1')], [body['airspace_no'] for body in platform.withdrawals()])

    def test_one_zone_failing_does_not_stop_the_others_and_the_error_is_reported(self):
        platform = Platform([delivered('z1', 1), delivered('z2', 1)], fail_for={stable_airspace_no('z1')})
        results = chain_for(platform, ZONES).withdraw_zones()
        self.assertEqual([('限飞区域 A', False), ('限飞区域 B', True)], [(r['zone'], r['ok']) for r in results])
        self.assertIn('返回 500', results[0]['error'])

    def test_it_still_goes_through_after_stop_was_requested(self):
        platform = Platform([delivered('z1', 1)])
        results = chain_for(platform, ZONES[:1], cancelled=lambda: True).withdraw_zones()
        self.assertEqual([True], [r['ok'] for r in results])

    def test_a_scene_without_zones_makes_no_call_at_all(self):
        platform = Platform([delivered('z1', 1)])
        self.assertEqual([], chain_for(platform, []).withdraw_zones())
        self.assertEqual([], platform.calls)

    def test_it_reads_the_platform_again_instead_of_trusting_what_was_cached_at_the_start(self):
        platform = Platform([delivered('z1', 1)])
        chain = chain_for(platform, ZONES[:1])
        chain._airspaces = {}  # 开始时读到的“还没有任何空域”
        self.assertEqual([True], [r['ok'] for r in chain.withdraw_zones()])
        self.assertEqual(1, len([call for call in platform.calls if call[0] == 'GET']))
        self.assertTrue(all(call[1].startswith(PREFIX) for call in platform.calls))


class RuntimeWithdrawTest(unittest.TestCase):
    def runtime(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        return server.Runtime(folder.name)

    def test_logs_what_was_withdrawn_and_warns_about_what_was_not(self):
        runtime = self.runtime()
        runtime.fullchain = Mock()
        runtime.fullchain.withdraw_zones.return_value = [{'zone': '限飞区域 A', 'ok': True, 'revision': 2},
                                                         {'zone': '限飞区域 B', 'ok': False, 'error': 'boom'}]
        runtime.withdraw_run_airspaces()
        kinds = {record['kind']: record['message'] for record in runtime.logs}
        self.assertIn('限飞区域 A', kinds['AIRSPACE_WITHDRAWN'])
        self.assertIn('限飞区域 B', kinds['AIRSPACE_WITHDRAW_FAILED'])
        self.assertIn('平台上它可能仍然有效', kinds['AIRSPACE_WITHDRAW_FAILED'])
        runtime.fullchain.warn.assert_called_once()
        self.assertIn('boom', runtime.fullchain.warn.call_args.args[0])

    def test_a_crash_while_withdrawing_never_escapes_into_the_stop_path(self):
        runtime = self.runtime()
        runtime.fullchain = Mock()
        runtime.fullchain.withdraw_zones.side_effect = ValueError('读空域失败')
        runtime.withdraw_run_airspaces()
        self.assertEqual(['AIRSPACE_WITHDRAW_FAILED'], [record['kind'] for record in runtime.logs])
        self.assertIn('读空域失败', runtime.logs[0]['message'])

    def test_nothing_to_do_without_a_full_chain(self):
        runtime = self.runtime()
        runtime.fullchain = None
        runtime.withdraw_run_airspaces()
        self.assertEqual([], runtime.logs)


class OvernightPlanWindowTest(unittest.TestCase):
    PLAN = {'start': '22:00', 'end': '02:00'}

    def at(self, hour, minute=0, day=13):
        return int(dt.datetime(2026, 10, day, hour, minute, tzinfo=SHANGHAI).timestamp() * 1000)

    def test_in_the_evening_the_window_runs_into_tomorrow(self):
        start, end = plan_window(self.PLAN, self.at(23))
        self.assertEqual((self.at(22), self.at(2, day=14)), (start, end))

    def test_after_midnight_it_is_still_the_window_that_started_yesterday(self):
        start, end = plan_window(self.PLAN, self.at(1, 30, day=14))
        self.assertEqual((self.at(22), self.at(2, day=14)), (start, end))
        self.assertTrue(start <= self.at(1, 30, day=14) < end)

    def test_in_the_daytime_the_next_window_is_tonight_so_now_is_outside_it(self):
        start, end = plan_window(self.PLAN, self.at(12, 30))
        self.assertEqual((self.at(22), self.at(2, day=14)), (start, end))
        self.assertFalse(start <= self.at(12, 30) < end)

    def test_a_same_day_window_is_unchanged(self):
        self.assertEqual((self.at(9), self.at(9, 30)), plan_window({'start': '09:00', 'end': '09:30'}, self.at(12, 30)))


if __name__ == '__main__':
    unittest.main()
