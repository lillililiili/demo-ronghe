"""常见报错说人话：哪个对象出了什么问题、怎么办；原来的技术文字留作“技术详情”。"""
import http.server
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import friendly_errors
import server
from friendly_errors import explain, explain_exception, subject_of

# 页面和报错里不能再出现的说法：指向已经不存在的后台页面，或者让人去做做不了的事。
STALE_WORDS = ('接口配置', '请在后台配置', 'local-lingyun-replay', '先在管理端')


class SubjectTest(unittest.TestCase):
    def test_platform_paths_become_the_object_a_person_knows(self):
        for path, expected in [('/local-interface-simulator/plans', '飞行任务'),
                               ('/local-interface-simulator/airspaces/context', '空域'),
                               ('/local-interface-simulator/weather-risks', '天气风险'),
                               ('/local-interface-simulator/weather', '天气预报'),
                               ('/local-interface-simulator/countermeasure-device', '模拟反制设备'),
                               ('/devices/onboard', '设备登记'),
                               ('/devices/abc?x=1', '设备'),
                               ('/flight-plans/p1', '飞行任务'),
                               ('/mqtt-brokers', '设备数据连接'),
                               ('/automation-rule-groups/verify', '自动规则'),
                               ('/something-new', '平台接口'),
                               (None, '平台接口')]:
            self.assertEqual(expected, subject_of(path), path)

    def test_longer_prefixes_win_over_shorter_ones(self):
        self.assertEqual('天气风险', subject_of('/local-interface-simulator/weather-risks/x'))
        self.assertEqual('通知接收端', subject_of('/local-interface-simulator/receiver-context'))
        self.assertEqual('模拟器配套接口', subject_of('/local-interface-simulator/unheard-of'))


class HttpErrorTest(unittest.TestCase):
    def say(self, code, text, path='/local-interface-simulator/plans'):
        raw = f'系统接口 {path} 返回 {code}：{text}'
        friendly, detail = explain(raw)
        self.assertEqual(raw, detail, '技术原文必须原样留作详情')
        self.assertNotIn('系统接口', friendly)
        return friendly

    def test_every_status_names_the_object_and_what_to_do_next(self):
        self.assertIn('登录已经失效', self.say(401, 'x'))
        forbidden = self.say(403, '没有权限', '/local-interface-simulator/airspaces')
        self.assertIn('空域被拒绝', forbidden)
        self.assertIn('换一个有权限的账号', forbidden)
        self.assertIn('没有权限', forbidden)
        self.assertIn('找不到飞行任务', self.say(404, 'gone'))
        conflict = self.say(409, 'VERSION_OVERLAP', '/local-interface-simulator/airspaces')
        self.assertIn('空域和平台里已有的记录冲突', conflict)
        self.assertIn('先点“停止”', conflict)
        self.assertIn('VERSION_OVERLAP', conflict)
        self.assertIn('请等十几秒再试', self.say(429, ''))
        self.assertIn('飞行任务平台没有接受', self.say(422, '字段不对'))
        self.assertIn('错误码 503', self.say(503, 'down'))
        self.assertIn('错误码 418', self.say(418, 'teapot'))

    def test_a_retired_device_type_tells_the_person_to_remove_it_not_to_visit_a_page(self):
        text = self.say(400, '设备类型已停用：dcd', '/devices/onboard')
        self.assertIn('平台已经停用这类设备', text)
        self.assertIn('删掉', text)
        self.assertIn('雷达、TDOA、5G-A、光电', text)

    def test_no_message_points_at_pages_that_no_longer_exist(self):
        for code in (400, 401, 403, 404, 409, 422, 429, 500):
            self.assertFalse([word for word in STALE_WORDS if word in self.say(code, '设备类型已停用' if code == 400 else 'x')])


class OtherErrorTest(unittest.TestCase):
    def test_connection_timeout_and_garbage_replies(self):
        for raw, expected in [('系统接口 /devices 连接失败：refused', '连不上平台后台'),
                              ('系统接口 /devices 连接中断', '连不上平台后台'),
                              ('系统接口 /flight-plans 请求超时', '响应太慢'),
                              ('系统接口 /flight-plans 返回无效 JSON', '返回的内容不对')]:
            friendly, detail = explain(raw)
            self.assertIn(expected, friendly, raw)
            self.assertEqual(raw, detail)
        self.assertIn('“设备”', explain('系统接口 /devices 连接失败')[0])
        self.assertIn('默认 8081', explain('系统接口 /devices 连接失败')[0])

    def test_readback_mismatches_say_which_object_and_field(self):
        friendly, detail = explain('任务回读不一致：plan-9 / uav_sn')
        self.assertIn('平台里的“无人机序列号”和刚提交的不一样（任务 plan-9）', friendly)
        self.assertEqual('任务回读不一致：plan-9 / uav_sn', detail)
        self.assertIn('平台里记的单位或区县', explain('任务回读范围不一致：plan-9')[0])
        route, _ = explain('航线回读不一致：r1 / min')
        self.assertIn('航线 r1，“最低高度”不一致', route)
        self.assertIn('任务航线提交后核对不上（航线 r2）', explain('航线回读缺少版本编号：r2')[0])
        device, _ = explain('设备回读绑定不一致：map-sim-radar-x / broker_id')
        self.assertIn('map-sim-radar-x', device)
        self.assertIn('“设备数据连接”', device)

    def test_mqtt_waiting_and_credentials(self):
        self.assertIn('30 秒内没有确认收到', explain('后台 MQTT 订阅等待超时，未开始发送')[0])
        bound, detail = explain('后台 MQTT 设备绑定不一致，未开始发送：map-sim-radar-1 / x')
        self.assertIn('map-sim-radar-1', bound)
        self.assertTrue(detail.startswith('后台 MQTT'))
        self.assertIn('账号密码不对', explain('MQTT 连接或认证失败')[0])

    def test_unrecognised_text_is_already_for_people_and_passes_through_untouched(self):
        for text in ('请先登录系统', '已有任务运行中，请先停止它，再开始新的', '', None):
            self.assertEqual((str(text or ''), ''), explain(text))


class ExceptionTest(unittest.TestCase):
    def test_a_missing_field_says_which_one_in_plain_words(self):
        friendly, detail = explain_exception(KeyError('max'))
        self.assertEqual('场景或提交的内容里缺少“高度上限”这一项，请检查后再试。', friendly)
        self.assertEqual("缺少字段 'max'", detail)
        self.assertIn('“名称”', explain_exception(KeyError('name'))[0])
        self.assertIn('“weird_field”', explain_exception(KeyError('weird_field'))[0])

    def test_wrong_shape_hides_the_python_error_in_the_detail(self):
        friendly, detail = explain_exception(TypeError("'NoneType' object is not subscriptable"))
        self.assertIn('格式不对', friendly)
        self.assertNotIn('NoneType', friendly)
        self.assertIn('NoneType', detail)

    def test_value_errors_go_through_the_text_rules(self):
        friendly, detail = explain_exception(ValueError('系统接口 /airspaces 返回 403：no'))
        self.assertIn('空域被拒绝', friendly)
        self.assertIn('返回 403', detail)
        self.assertEqual(('请先登录系统', ''), explain_exception(ValueError('请先登录系统')))


class RuntimeAndHttpTest(unittest.TestCase):
    def test_runtime_describe_failure_hides_the_video_password_in_both_texts(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = server.Runtime(root)
            runtime.video_config = {**runtime.video_config, 'publisher_password': 'secret-qa-only'}
            friendly, detail = runtime.describe_failure(
                ValueError('系统接口 /local-interface-simulator/video-streams 返回 500：boom secret-qa-only'))
            self.assertNotIn('secret-qa-only', friendly + detail)
            self.assertIn('光电视频', friendly)
            self.assertIn('返回 500', detail)
            friendly, detail = runtime.describe_failure(KeyError('name'))
            self.assertIn('“名称”', friendly)
            self.assertEqual("缺少字段 'name'", detail)

    def test_status_carries_both_texts_and_start_clears_the_old_detail(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = server.Runtime(root)
            self.assertEqual(('', ''), (runtime.status()['error'], runtime.status()['error_detail']))
            runtime.error, runtime.error_detail = '飞行任务被拒绝', '系统接口 /x 返回 403：no'
            status = runtime.status()
            self.assertEqual(('飞行任务被拒绝', '系统接口 /x 返回 403：no'), (status['error'], status['error_detail']))


class FailResponseTest(unittest.TestCase):
    def setUp(self):
        self.local = http.server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.local.serve_forever, daemon=True)
        self.thread.start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.base = 'http://127.0.0.1:%s' % self.local.server_port

    def tearDown(self):
        self.local.shutdown()
        self.local.server_close()
        self.thread.join()

    def test_a_translated_error_carries_the_original_as_detail_and_a_plain_one_does_not(self):
        previous = server.external_bridge
        server.external_bridge = server.ExternalBridge()
        try:
            request = urllib.request.Request(
                self.base + '/api/external/request',
                data=b'{"method":"GET","path":"/local-interface-simulator/airspaces/context"}',
                headers={'Content-Type': 'application/json'}, method='POST')
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.opener.open(request)
            body = json.load(caught.exception)
            self.assertEqual(401, caught.exception.code)
            self.assertIn('请先登录', body['error'])
            self.assertNotIn('detail', body)
        finally:
            server.external_bridge = previous

    def test_handler_fail_splits_friendly_text_and_technical_detail(self):
        sent = {}

        class Stub:
            def respond(self, value, status=200):
                sent.update(value=value, status=status)

        server.Handler.fail(Stub(), ValueError('系统接口 /devices/onboard 返回 409：duplicate'), 400)
        self.assertEqual(400, sent['status'])
        self.assertIn('设备登记和平台里已有的记录冲突', sent['value']['error'])
        self.assertEqual('系统接口 /devices/onboard 返回 409：duplicate', sent['value']['detail'])
        server.Handler.fail(Stub(), ValueError('请先停止全部收发'), 409)
        self.assertEqual({'error': '请先停止全部收发'}, sent['value'])


if __name__ == '__main__':
    unittest.main()
