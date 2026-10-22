"""「选流程」弹框：只读九个流程、固定预测变式和规则开关。"""
import http.server
import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import acceptance_flows
import server
from engine import compile_scene

ROOT = Path(__file__).resolve().parents[1]
FOLDER = ROOT / 'scenarios' / acceptance_flows.OUTPUT_NAME


class ReadAcceptanceFlowsTest(unittest.TestCase):
    def test_reads_the_nine_repository_flows_in_order_without_any_external_script(self):
        result = acceptance_flows.read_acceptance_flows(ROOT)
        self.assertEqual('READY_FOR_IMPORT', result['status'])
        self.assertEqual(list(range(1, 10)), [item['flow'] for item in result['flows']])
        for item in result['flows']:
            self.assertEqual(acceptance_flows.FLOW_FILES[item['flow']], item['file'])
            guide = item['guide']
            for key in ('shows', 'before', 'sees', 'todo'):
                self.assertTrue(guide[key], f'流程 {item["flow"]} 的说明缺 {key}')
            compile_scene(item['scene'])

    def test_durations_are_the_flow_files_own_minutes(self):
        minutes = {item['flow']: item['minutes'] for item in acceptance_flows.read_acceptance_flows(ROOT)['flows']}
        self.assertEqual({1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 2, 7: 2, 8: 10, 9: 5}, minutes)

    def test_only_flow_four_asks_for_auto_verification_to_be_turned_off(self):
        flows = {item['flow']: item['guide'] for item in acceptance_flows.read_acceptance_flows(ROOT)['flows']}
        self.assertEqual({4}, {flow for flow, guide in flows.items() if guide['auto_verify'] is False})
        self.assertEqual('开始前请先在规则管理关掉自动核实', flows[4]['warning'])
        self.assertEqual({1, 2, 3, 5}, {flow for flow, guide in flows.items() if guide['auto_verify'] is True})
        self.assertEqual({6, 7, 8, 9}, {flow for flow, guide in flows.items() if guide['auto_verify'] is None})
        self.assertEqual({4}, {flow for flow, guide in flows.items() if guide['warning']})

    def test_every_flow_says_what_auto_verify_and_the_counter_button_do(self):
        for item in acceptance_flows.read_acceptance_flows(ROOT)['flows']:
            guide = item['guide']
            text = '\n'.join(guide['before'] + guide['sees'] + guide['todo'])
            self.assertIn('自动核实', text, f'流程 {item["flow"]} 没写自动核实')
            if item['flow'] in (1, 3, 5):
                self.assertIn('反制按钮', text, f'流程 {item["flow"]} 没写反制按钮什么时候亮')
        flow5 = next(item for item in acceptance_flows.read_acceptance_flows(ROOT)['flows'] if item['flow'] == 5)
        self.assertIn('核实', flow5['guide']['before'][0])

    def test_reading_does_not_touch_the_files(self):
        before = {path.name: path.stat().st_mtime_ns for path in FOLDER.iterdir()}
        acceptance_flows.read_acceptance_flows(ROOT)
        self.assertEqual(before, {path.name: path.stat().st_mtime_ns for path in FOLDER.iterdir()})

    def test_reports_plain_errors_for_a_broken_folder(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, '找不到流程 1-9'):
                acceptance_flows.read_acceptance_flows(root)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            (folder / 'manifest.json').unlink()
            with self.assertRaisesRegex(ValueError, 'manifest.json'):
                acceptance_flows.read_acceptance_flows(root)
            (folder / 'manifest.json').write_text('{bad', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '读不出来'):
                acceptance_flows.read_acceptance_flows(root)

    def test_rejects_unknown_files_mismatched_flows_and_missing_flows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
            outsider = json.loads(json.dumps(manifest))
            outsider['flows'][0]['file'] = '../outside.json'
            (folder / 'manifest.json').write_text(json.dumps(outsider), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '不认识的文件'):
                acceptance_flows.read_acceptance_flows(root)
            missing = json.loads(json.dumps(manifest))
            missing['flows'] = missing['flows'][:-1]
            (folder / 'manifest.json').write_text(json.dumps(missing), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '各一条'):
                acceptance_flows.read_acceptance_flows(root)
            (folder / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            swapped = json.loads((folder / 'flow-2-after-sms-departure.json').read_text(encoding='utf-8'))
            swapped['fullchain']['acceptanceFlow'] = 3
            (folder / 'flow-2-after-sms-departure.json').write_text(json.dumps(swapped), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '校验失败'):
                acceptance_flows.read_acceptance_flows(root)

    def test_prediction_variants_share_manual_gates_but_describe_distinct_outcomes(self):
        flows = acceptance_flows.read_acceptance_flows(ROOT)['flows']
        prediction = next(item for item in flows if item['flow'] == 9)
        self.assertEqual('预测入区预警', prediction['title'])
        self.assertEqual('avoid', prediction['default_variant'])
        self.assertEqual(['avoid', 'enter'], [item['id'] for item in prediction['variants']])
        self.assertEqual(prediction['scene'], prediction['variants'][0]['scene'])
        self.assertEqual(prediction['guide'], prediction['variants'][0]['guide'])
        for variant in prediction['variants']:
            with self.subTest(variant=variant['id']):
                self.assertEqual(6 if variant['id'] == 'enter' else 5, variant['minutes'])
                self.assertEqual(9, variant['scene']['fullchain']['acceptanceFlow'])
                self.assertTrue(variant['guide']['prediction_only'])
                self.assertIsNone(variant['guide']['auto_verify'])
                text = '\n'.join(variant['guide']['before'] + variant['guide']['sees'] + variant['guide']['todo'])
                for required in ('专用录音', '不自动核实', '不自动反制', '不自动处罚', '第4分钟', '实际回执', '另一个', '直接反制权限'):
                    self.assertIn(required, text)
                compile_scene(variant['scene'])
        variants = {item['id']: item for item in prediction['variants']}
        self.assertIn('连续新实测', variants['avoid']['guide']['sees'][-1])
        self.assertEqual('6分钟继续入区并反制', variants['enter']['label'])
        entry_todo = '\n'.join(variants['enter']['guide']['todo'])
        for required in ('关联实测告警', '约2分钟', '权限', '有效证据', '人工核实', '申请', '审批', '执行反制', '6分钟结束'):
            self.assertIn(required, entry_todo)
        self.assertIn('短信电话回执在原预测预警中查看', entry_todo)
        self.assertIn('同次风险不重复通知', entry_todo)
        self.assertIn('仍待核实时先人工核实', entry_todo)
        self.assertIn('已失效的预测授权不能复用', entry_todo)
        self.assertNotIn('3分20秒', entry_todo)
        self.assertNotIn('5分钟结束', entry_todo)
        avoid_todo = '\n'.join(variants['avoid']['guide']['todo'])
        self.assertIn('3分20秒', avoid_todo)
        self.assertIn('5分钟结束', avoid_todo)
        common_todo = '\n'.join(acceptance_flows.GUIDE[9]['todo'])
        self.assertNotIn('3分20秒', common_todo)
        self.assertNotIn('5分钟结束', common_todo)
        for existing in flows[:8]:
            self.assertNotIn('variants', existing)
            self.assertNotIn('default_variant', existing)
            self.assertNotIn('prediction_only', existing['guide'])

    def test_manifest_contains_only_the_prediction_default_and_cannot_redirect_variants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            manifest_path = folder / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            prediction = next(item for item in manifest['flows'] if item['flow'] == 9)
            self.assertEqual('flow-9-prediction-warning.json', prediction['file'])
            for filename in ('flow-9-prediction-entry.json',):
                self.assertNotIn(filename, [item['file'] for item in manifest['flows']])
            prediction['variants'] = [{'id': 'enter', 'file': '../../outside.json'}]
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            flow = acceptance_flows.read_acceptance_flows(root)['flows'][-1]
            for variant_id, filename in (('enter', 'flow-9-prediction-entry.json'),):
                with self.subTest(variant=variant_id):
                    expected = json.loads((folder / filename).read_text(encoding='utf-8'))
                    self.assertEqual(expected, next(item['scene'] for item in flow['variants'] if item['id'] == variant_id))
                    prediction['file'] = filename
                    manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                    with self.assertRaisesRegex(ValueError, '不认识的文件'):
                        acceptance_flows.read_acceptance_flows(root)

    def test_rejects_missing_or_invalid_prediction_variant_instead_of_silent_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            for variant in acceptance_flows.FLOW_VARIANTS[9].values():
                variant_path = folder / variant['file']
                original = json.loads(variant_path.read_text(encoding='utf-8'))
                variant_path.unlink()
                with self.assertRaisesRegex(ValueError, '流程文件读不出来：' + variant['file']):
                    acceptance_flows.read_acceptance_flows(root)
                for invalid in ([], {'version': 1, 'fullchain': []},
                                dict(original, fullchain={'acceptanceFlow': 8}),
                                dict(original, fullchain={'acceptanceFlow': True})):
                    with self.subTest(variant=variant['file'], invalid=invalid):
                        variant_path.write_text(json.dumps(invalid), encoding='utf-8')
                        with self.assertRaisesRegex(ValueError, '流程场景校验失败'):
                            acceptance_flows.read_acceptance_flows(root)
                variant_path.write_text(json.dumps(original), encoding='utf-8')

    def test_prediction_variant_identity_must_match_each_fixed_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            for variant_id, variant in acceptance_flows.FLOW_VARIANTS[9].items():
                path = folder / variant['file']
                original = path.read_text(encoding='utf-8')
                wrong_id = 'enter' if variant_id == 'avoid' else 'avoid'
                for identity in (None, '', wrong_id, 'silence', 9, True):
                    with self.subTest(variant=variant_id, identity=identity):
                        scene = json.loads(original)
                        if identity is None:
                            scene['fullchain'].pop('predictionVariant')
                        else:
                            scene['fullchain']['predictionVariant'] = identity
                        path.write_text(json.dumps(scene), encoding='utf-8')
                        with self.assertRaisesRegex(ValueError, '流程预测变式校验失败：' + variant['file']):
                            acceptance_flows.read_acceptance_flows(root)
                path.write_text(original, encoding='utf-8')

    def test_rejects_swapped_prediction_scene_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            avoid = folder / acceptance_flows.FLOW_VARIANTS[9]['avoid']['file']
            enter = folder / acceptance_flows.FLOW_VARIANTS[9]['enter']['file']
            avoid_content = avoid.read_text(encoding='utf-8')
            enter_content = enter.read_text(encoding='utf-8')
            avoid.write_text(enter_content, encoding='utf-8')
            enter.write_text(avoid_content, encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '流程预测变式校验失败'):
                acceptance_flows.read_acceptance_flows(root)

    def test_removed_silence_variant_cannot_be_restored_by_a_leftover_file_or_manifest(self):
        self.assertNotIn('silence', acceptance_flows.FLOW_VARIANTS[9])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            removed_name = 'flow-9-prediction-silence.json'
            legacy_scene = json.loads((folder / acceptance_flows.FLOW_FILES[9]).read_text(encoding='utf-8'))
            legacy_scene['fullchain']['predictionVariant'] = 'silence'
            (folder / removed_name).write_text(json.dumps(legacy_scene), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '流程预测变式校验失败'):
                acceptance_flows._read_scene(folder, removed_name, 9, 'silence')
            manifest_path = folder / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            prediction = next(item for item in manifest['flows'] if item['flow'] == 9)
            prediction['variants'] = [{'id': 'silence', 'file': removed_name}]
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            result = acceptance_flows.read_acceptance_flows(root)['flows'][-1]
            self.assertEqual(['avoid', 'enter'], [item['id'] for item in result['variants']])
            prediction['file'] = removed_name
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '不认识的文件'):
                acceptance_flows.read_acceptance_flows(root)

    def test_prediction_variant_identity_does_not_restrict_existing_flows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            for number, filename in acceptance_flows.FLOW_FILES.items():
                if number == 9:
                    continue
                path = folder / filename
                scene = json.loads(path.read_text(encoding='utf-8'))
                scene['fullchain']['predictionVariant'] = 'unrelated-extension'
                path.write_text(json.dumps(scene), encoding='utf-8')
            flows = acceptance_flows.read_acceptance_flows(root)['flows']
            self.assertEqual(list(range(1, 10)), [flow['flow'] for flow in flows])

    def test_rejects_duplicate_flow_and_non_string_manifest_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / 'scenarios' / acceptance_flows.OUTPUT_NAME
            shutil.copytree(FOLDER, folder)
            manifest_path = folder / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            manifest['flows'].append(dict(manifest['flows'][-1]))
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '各一条'):
                acceptance_flows.read_acceptance_flows(root)
            manifest['flows'][-1]['file'] = ['flow-9-prediction-warning.json']
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '不认识的文件'):
                acceptance_flows.read_acceptance_flows(root)


class FakeRules(http.server.BaseHTTPRequestHandler):
    """Stands in for the platform: verify/counter rule groups, or a 403 for non-backend accounts."""
    forbid = False
    unauthorized = False
    groups = {}

    def log_message(self, *args): pass

    def answer(self, status, value):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == '/auth/me':
            return self.answer(200, {'ok': True, 'data': {'account': 'admin1', 'role_code': 'ROLE-ADMIN'}})
        if self.path.startswith('/automation-rule-groups/'):
            if self.unauthorized:
                return self.answer(401, {'ok': False, 'error': {'message': 'expired'}})
            if self.forbid:
                return self.answer(403, {'ok': False, 'error': {'message': 'forbidden'}})
            category = self.path.rsplit('/', 1)[1]
            return self.answer(200, {'ok': True, 'data': self.groups[category]})
        return self.answer(404, {'ok': False, 'error': {'message': 'missing'}})

    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        if self.path == '/auth/login':
            return self.answer(200, {'ok': True, 'data': {'session_id': 'secret'}})
        return self.answer(404, {'ok': False, 'error': {'message': 'missing'}})


class AutomationRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeRules)
        cls.thread = threading.Thread(target=cls.backend.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:%s' % cls.backend.server_port

    @classmethod
    def tearDownClass(cls):
        cls.backend.shutdown()
        cls.backend.server_close()
        cls.thread.join()

    def setUp(self):
        FakeRules.forbid = False
        FakeRules.unauthorized = False
        FakeRules.groups = {
            'verify': {'execution_status': 'CONNECTED', 'execution_message': '规则引擎运行中',
                       'rules': [{'enabled': True}, {'enabled': False}, {'enabled': True}]},
            'counter': {'execution_status': 'CONNECTED', 'execution_message': '', 'rules': [{'enabled': False}]},
        }
        self.bridge = server.ExternalBridge()

    def login(self):
        self.bridge.connect({'api': self.url, 'account': 'admin1', 'password': 'pass'})

    def test_needs_a_login_first(self):
        with self.assertRaises(server.ExternalAuthenticationRequired):
            self.bridge.automation_rules()

    def test_counts_only_enabled_rules_and_reports_the_engine(self):
        self.login()
        result = self.bridge.automation_rules()
        self.assertEqual({'ok': True, 'total': 3, 'enabled': 2, 'engine': 'CONNECTED', 'engine_message': '规则引擎运行中'}, result['verify'])
        self.assertEqual(0, result['counter']['enabled'])
        self.assertEqual(1, result['counter']['total'])

    def test_a_non_backend_account_gets_a_plain_forbidden_not_a_guess(self):
        self.login()
        FakeRules.forbid = True
        self.assertEqual({'verify': {'ok': False, 'reason': 'FORBIDDEN'}, 'counter': {'ok': False, 'reason': 'FORBIDDEN'}},
                         self.bridge.automation_rules())

    def test_an_expired_login_clears_the_session(self):
        self.login()
        FakeRules.unauthorized = True
        with self.assertRaises(ValueError):
            self.bridge.automation_rules()
        self.assertFalse(self.bridge.status()['connected'])

    def test_the_rules_are_not_reachable_through_the_generic_proxy(self):
        self.assertFalse(self.bridge.allowed('GET', '/automation-rule-groups/verify'))
        self.assertFalse(self.bridge.allowed('POST', '/automation-rule-groups/verify'))


class AcceptanceFlowHttpTest(unittest.TestCase):
    def setUp(self):
        self.local = http.server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.thread = threading.Thread(target=self.local.serve_forever, daemon=True)
        self.previous = server.external_bridge
        server.external_bridge = server.ExternalBridge()
        self.thread.start()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.base = 'http://127.0.0.1:%s' % self.local.server_port

    def tearDown(self):
        server.external_bridge = self.previous
        self.local.shutdown()
        self.local.server_close()
        self.thread.join()

    def test_get_returns_nine_flows_with_prediction_variants_and_post_is_gone(self):
        with self.opener.open(self.base + '/api/acceptance-flows') as response:
            data = json.load(response)
        self.assertEqual(list(range(1, 10)), [item['flow'] for item in data['flows']])
        prediction = data['flows'][-1]
        self.assertEqual('avoid', prediction['default_variant'])
        self.assertEqual(['avoid', 'enter'], [item['id'] for item in prediction['variants']])
        self.assertTrue(prediction['guide']['prediction_only'])
        request = urllib.request.Request(self.base + '/api/acceptance-flows-1-7', data=b'{}',
                                         headers={'Content-Type': 'application/json'}, method='POST')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.opener.open(request)
        self.assertEqual(404, caught.exception.code)

    def test_rules_endpoint_asks_for_login_before_anything_else(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.opener.open(self.base + '/api/external/automation-rules')
        self.assertEqual(401, caught.exception.code)
        self.assertIn('请先登录', json.load(caught.exception)['error'])


if __name__ == '__main__':
    unittest.main()
