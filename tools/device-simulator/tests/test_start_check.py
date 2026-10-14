"""开始模拟之前的检查：停用设备点名挡住且什么都不发，正常模式提示不生效的设置，任务时段不含现在时提醒。"""
import datetime as dt
import http.server
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
import start_check
from engine import LABELS
from fullchain import SHANGHAI
from test_engine import scene

NOW = dt.datetime(2026, 10, 13, 12, 30, tzinfo=SHANGHAI)
NOW_MS = int(NOW.timestamp() * 1000)


def with_device(raw, **device):
    raw['sites'][0]['devices'].append({'id': 'dx', 'name': '协议破解 01', 'kind': 'dcd', 'health': '正常',
                                       'heartbeat': '持续上报', 'interval': 5, **device})
    return raw


class RetiredDeviceTest(unittest.TestCase):
    def test_the_six_retired_kinds_are_exactly_the_ones_the_page_no_longer_offers(self):
        self.assertEqual({'aoa', 'bsc', 'dcd', 'dec', 'ifr', 'rid'}, set(start_check.RETIRED_KINDS))
        self.assertEqual(set(), set(start_check.RETIRED_KINDS) & set(start_check.CURRENT_KINDS))
        for kind in start_check.RETIRED_KINDS + start_check.CURRENT_KINDS:
            self.assertIn(kind, LABELS)

    def test_names_every_retired_device_with_its_group_and_type(self):
        raw = with_device(scene())
        raw['sites'][0]['devices'].append({'id': 'dy', 'name': '干扰 01', 'kind': 'ifr'})
        found = start_check.retired_devices(raw)
        self.assertEqual([('验证组', '协议破解 01', 'dcd'), ('验证组', '干扰 01', 'ifr')],
                         [(item['site'], item['device'], item['kind']) for item in found])
        text = start_check.retired_message(found)
        self.assertIn('“协议破解 01”（验证组，类型 协议破解）', text)
        self.assertIn('“干扰 01”（验证组，类型 干扰）', text)
        self.assertIn('什么都没有发出去', text)
        self.assertIn('删掉', text)

    def test_current_devices_and_devices_that_send_nothing_are_not_blocked(self):
        raw = scene()
        for index, kind in enumerate(start_check.CURRENT_KINDS):
            raw['sites'][0]['devices'].append({'id': f'c{index}', 'name': kind, 'kind': kind})
        self.assertEqual([], start_check.retired_devices(raw))
        self.assertEqual([], start_check.retired_devices(with_device(scene(), send=False)))

    def test_broken_scenes_never_crash_the_check(self):
        for value in (None, [], 'x', 7, {}, {'sites': None}, {'sites': 'x'}, {'sites': [None, 3, {'devices': 'x'}, {'devices': [None, 5]}]}):
            self.assertEqual([], start_check.retired_devices(value))
            self.assertEqual([], start_check.normal_mode_ignored(value, {'mode': 'normal'}))
            self.assertEqual([], start_check.plan_window_notes(value, NOW_MS))
            result = start_check.check(value, {'mode': 'normal'}, NOW_MS)
            self.assertEqual(([], []), (result['blocking'], result['notices']))


class NormalModeTest(unittest.TestCase):
    def scene_with_every_ignored_setting(self):
        raw = scene()
        raw['sites'][0]['devices'][0].update(health='故障', heartbeat='停止心跳')
        raw['risks'] += [{'id': 'r2', 'type': 'offline', 'name': '设备离线', 'enabled': True},
                         {'id': 'r3', 'type': 'fault', 'enabled': True},
                         {'id': 'r4', 'type': 'fault', 'enabled': False}]
        raw['targets'][0]['notificationBehavior'] = 'drop_sms'
        return raw

    def test_lists_each_setting_that_normal_mode_will_put_back(self):
        items = start_check.normal_mode_ignored(self.scene_with_every_ignored_setting(), {'mode': 'normal'})
        self.assertEqual(5, len(items))
        joined = '\n'.join(items)
        for expected in ('设备“雷达”（验证组）的工作状态设成了“故障”', '的心跳设成了“停止心跳”', '“设备离线”已经勾选',
                         '“设备故障”已经勾选', '“验证目标”设成了“短信送达后停止目标上报”'):
            self.assertIn(expected, joined)

    def test_abnormal_and_mixed_modes_keep_those_settings_so_nothing_is_listed(self):
        raw = self.scene_with_every_ignored_setting()
        for mode in ('abnormal', 'mixed'):
            self.assertEqual([], start_check.normal_mode_ignored(raw, {'mode': mode}))

    def test_full_scenes_are_not_rewritten_so_nothing_is_listed(self):
        raw = self.scene_with_every_ignored_setting()
        raw['fullchain'] = {'enabled': True}
        self.assertEqual([], start_check.normal_mode_ignored(raw, {'mode': 'normal'}))
        raw['fullchain'] = None
        self.assertEqual(5, len(start_check.normal_mode_ignored(raw, {'mode': 'normal'})))

    def test_matches_what_prepare_scene_really_overrides(self):
        """提示的和开始时真正改回去的是同一批，不能各说各的。"""
        from realtime_control import DEFAULT_CONFIG, prepare_scene
        raw = self.scene_with_every_ignored_setting()
        config = {**DEFAULT_CONFIG, 'mode': 'normal'}
        prepared = prepare_scene(raw, config)
        self.assertEqual('正常', prepared['sites'][0]['devices'][0]['health'])
        self.assertEqual('持续上报', prepared['sites'][0]['devices'][0]['heartbeat'])
        self.assertEqual('none', prepared['targets'][0]['notificationBehavior'])
        self.assertTrue(all(not risk['enabled'] for risk in prepared['risks'] if risk['type'] in ('offline', 'fault')))
        self.assertTrue(start_check.normal_mode_ignored(raw, config))
        self.assertEqual([], start_check.normal_mode_ignored(prepared, config))


class PlanWindowTest(unittest.TestCase):
    def plan_scene(self, start, end, **target):
        raw = scene()
        raw['plans'] = [{'id': 'p1', 'name': '巡检任务 01', 'points': [[1, 1], [2, 2]], 'min': 20, 'max': 120, 'width': 100,
                         'start': start, 'end': end}]
        raw['targets'][0].update(planId='p1', **target)
        return raw

    def test_window_text_says_the_day_and_that_the_clock_is_beijing_time(self):
        start = int(dt.datetime(2026, 10, 13, 9, 0, tzinfo=SHANGHAI).timestamp() * 1000)
        end = int(dt.datetime(2026, 10, 13, 9, 30, tzinfo=SHANGHAI).timestamp() * 1000)
        self.assertEqual('今天 09:00–09:30（北京时间）', start_check.window_text(start, end, NOW_MS))
        night_end = int(dt.datetime(2026, 10, 14, 2, 0, tzinfo=SHANGHAI).timestamp() * 1000)
        night_start = int(dt.datetime(2026, 10, 13, 22, 0, tzinfo=SHANGHAI).timestamp() * 1000)
        self.assertEqual('今天 22:00 到 明天 02:00（北京时间）', start_check.window_text(night_start, night_end, NOW_MS))
        yesterday = int(dt.datetime(2026, 10, 12, 22, 0, tzinfo=SHANGHAI).timestamp() * 1000)
        self.assertEqual('昨天 22:00 到 今天 02:00（北京时间）', start_check.window_text(yesterday, int(dt.datetime(2026, 10, 13, 2, 0, tzinfo=SHANGHAI).timestamp() * 1000), NOW_MS))

    def test_a_task_in_use_whose_window_misses_now_is_reported_with_its_window(self):
        notes = start_check.plan_window_notes(self.plan_scene('09:00', '09:30'), NOW_MS)
        self.assertEqual([('p1', '巡检任务 01', '今天 09:00–09:30（北京时间）')], [(n['plan_id'], n['plan'], n['window']) for n in notes])

    def test_a_window_that_contains_now_is_fine_including_overnight_ones(self):
        self.assertEqual([], start_check.plan_window_notes(self.plan_scene('12:00', '13:00'), NOW_MS))
        self.assertEqual([], start_check.plan_window_notes(self.plan_scene('22:00', '14:00'), NOW_MS))
        after_midnight = int(dt.datetime(2026, 10, 14, 1, 0, tzinfo=SHANGHAI).timestamp() * 1000)
        self.assertEqual([], start_check.plan_window_notes(self.plan_scene('22:00', '02:00'), after_midnight))
        self.assertTrue(start_check.plan_window_notes(self.plan_scene('22:00', '02:00'), NOW_MS))

    def test_unused_tasks_past_tasks_and_deliberately_late_targets_are_not_reported(self):
        unused = self.plan_scene('09:00', '09:30')
        unused['targets'][0]['planId'] = ''
        self.assertEqual([], start_check.plan_window_notes(unused, NOW_MS))
        past = self.plan_scene('09:00', '09:30')
        past['plans'][0]['timeMode'] = 'past'
        self.assertEqual([], start_check.plan_window_notes(past, NOW_MS))
        late = self.plan_scene('09:00', '09:30')
        late['risks'] = [{'id': 'r9', 'type': 'time', 'enabled': True, 'targetId': 't1', 'planId': 'p1'}]
        self.assertEqual([], start_check.plan_window_notes(late, NOW_MS))

    def test_bad_times_are_left_for_the_normal_validation(self):
        broken = self.plan_scene('9点', '10点')
        self.assertEqual([], start_check.plan_window_notes(broken, NOW_MS))
        del broken['plans'][0]['end']
        self.assertEqual([], start_check.plan_window_notes(broken, NOW_MS))


class CheckTest(unittest.TestCase):
    def test_only_retired_devices_block_everything_else_is_a_notice(self):
        raw = with_device(scene())
        raw['sites'][0]['devices'][0]['health'] = '故障'
        raw['plans'] = [{'id': 'p1', 'name': '巡检任务 01', 'points': [[1, 1], [2, 2]], 'start': '09:00', 'end': '09:30'}]
        raw['targets'][0]['planId'] = 'p1'
        result = start_check.check(raw, {'mode': 'normal'}, NOW_MS)
        self.assertEqual(['RETIRED_DEVICE'], [item['code'] for item in result['blocking']])
        self.assertEqual(['NORMAL_MODE_IGNORES', 'PLAN_OUTSIDE_WINDOW'], [item['code'] for item in result['notices']])
        self.assertIn('“协议破解 01”（验证组，类型 协议破解）', result['blocking'][0]['items'])
        self.assertNotIn('协议破解 01', result['blocking'][0]['message'], 'the dialog lists the devices once, under the sentence')
        self.assertEqual([{'site_id': 's1', 'device_id': 'dx'}], result['blocking'][0]['devices'])
        self.assertIn('现在是北京时间 12:30', result['notices'][1]['title'])
        self.assertEqual(['p1'], result['notices'][1]['plans'])
        self.assertEqual(NOW_MS, result['checked_at'])

    def test_the_mode_notice_says_when_the_mode_cannot_be_switched_right_now(self):
        raw = scene()
        raw['sites'][0]['devices'][0]['health'] = '故障'
        free = start_check.check(raw, {'mode': 'normal'}, NOW_MS)['notices'][0]
        self.assertEqual(('NORMAL_MODE_IGNORES', True), (free['code'], free['can_fix']))
        self.assertNotIn('停止全部收发', free['message'])
        stuck = start_check.check(raw, {'mode': 'normal'}, NOW_MS, can_switch_mode=False)['notices'][0]
        self.assertEqual(('NORMAL_MODE_IGNORES', False), (stuck['code'], stuck['can_fix']))
        self.assertIn('停止全部收发', stuck['message'])
        self.assertEqual(free['items'], stuck['items'])

    def test_a_clean_scene_has_nothing_to_say(self):
        result = start_check.check(scene(), {'mode': 'normal'}, NOW_MS)
        self.assertEqual({'blocking': [], 'notices': [], 'checked_at': NOW_MS}, result)


class RuntimeStartTest(unittest.TestCase):
    def test_a_retired_device_is_refused_before_anything_reaches_the_platform(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = server.Runtime(root)
            runtime.session.platform = Mock()
            with self.assertRaisesRegex(ValueError, '什么都没有发出去：“协议破解 01”（验证组，类型 协议破解）'):
                runtime.start(with_device(scene()))
            self.assertEqual([], runtime.session.platform.mock_calls)
            self.assertEqual('IDLE', runtime.phase)
            self.assertIsNone(runtime.batch)
            self.assertEqual([], list(Path(root).glob('sim-*')))

    def test_a_retired_device_is_refused_even_with_realtime_on_and_before_the_rest_of_the_scene_is_prepared(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = server.Runtime(root)
            runtime.realtime = MagicMock()
            runtime.session.platform = Mock()
            with self.assertRaisesRegex(ValueError, '协议破解 01'):
                runtime.start(with_device(scene()))
            runtime.realtime.start.assert_not_called()
            self.assertEqual([], runtime.session.platform.mock_calls)

    def test_runtime_start_check_reads_the_receive_mode_and_sends_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = server.Runtime(root)
            runtime.session.platform = Mock()
            runtime.realtime = Mock(config={'mode': 'abnormal'})
            result = runtime.start_check(with_device(scene()))
            self.assertEqual('abnormal', result['mode'])
            self.assertEqual(['RETIRED_DEVICE'], [item['code'] for item in result['blocking']])
            runtime.realtime.config = {'mode': 'normal'}
            raw = scene()
            raw['sites'][0]['devices'][0]['health'] = '故障'
            self.assertEqual(['NORMAL_MODE_IGNORES'], [item['code'] for item in runtime.start_check(raw)['notices']])
            with self.assertRaisesRegex(ValueError, '场景格式错误'):
                runtime.start_check([])
            # 没有实时收发（隔离测试场景模式）时设置照原样生效，不提示“正常模式不生效”。
            runtime.realtime = None
            self.assertEqual([], runtime.start_check(raw)['notices'])
            self.assertEqual([], runtime.session.platform.mock_calls)


class StartCheckHttpTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        # 服务脚本里的 runtime 只在直接运行时才创建；测试里临时挂一个，用完拿掉。
        self.had_runtime, self.previous = hasattr(server, 'runtime'), getattr(server, 'runtime', None)
        server.runtime = server.Runtime(self.folder.name)
        server.runtime.realtime = Mock(config={'mode': 'normal'})
        self.local = http.server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.local.serve_forever, daemon=True)
        self.thread.start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.base = 'http://127.0.0.1:%s' % self.local.server_port

    def tearDown(self):
        if self.had_runtime:
            server.runtime = self.previous
        else:
            del server.runtime
        self.local.shutdown()
        self.local.server_close()
        self.thread.join()
        self.folder.cleanup()

    def post(self, body):
        request = urllib.request.Request(self.base + '/api/start-check', data=json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json'}, method='POST')
        return self.opener.open(request)

    def test_returns_blocking_and_notices_for_the_posted_scene(self):
        with self.post(with_device(scene())) as response:
            data = json.load(response)
        self.assertEqual(['RETIRED_DEVICE'], [item['code'] for item in data['blocking']])
        self.assertEqual('normal', data['mode'])

    def test_a_scene_that_is_not_an_object_gets_a_plain_error(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post([1, 2])
        self.assertEqual(400, caught.exception.code)
        self.assertIn('场景格式错误', json.load(caught.exception)['error'])

    def test_get_is_not_allowed(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.opener.open(self.base + '/api/start-check')
        self.assertEqual(404, caught.exception.code)


if __name__ == '__main__':
    unittest.main()
