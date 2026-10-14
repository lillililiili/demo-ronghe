"""「选流程」弹框的服务端：直接读仓库里现成的 7 份流程文件，并只读地查规则开关。"""
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
    def test_reads_the_seven_repository_files_in_order_without_any_external_script(self):
        result = acceptance_flows.read_acceptance_flows(ROOT)
        self.assertEqual('READY_FOR_IMPORT', result['status'])
        self.assertEqual([1, 2, 3, 4, 5, 6, 7], [item['flow'] for item in result['flows']])
        for item in result['flows']:
            self.assertEqual(acceptance_flows.FLOW_FILES[item['flow']], item['file'])
            guide = item['guide']
            for key in ('shows', 'before', 'sees', 'todo'):
                self.assertTrue(guide[key], f'流程 {item["flow"]} 的说明缺 {key}')
            compile_scene(item['scene'])

    def test_durations_are_the_flow_files_own_minutes(self):
        minutes = {item['flow']: item['minutes'] for item in acceptance_flows.read_acceptance_flows(ROOT)['flows']}
        self.assertEqual({1: 5, 2: 5, 3: 5, 4: 5, 5: 5, 6: 2, 7: 2}, minutes)

    def test_only_flow_four_asks_for_auto_verification_to_be_turned_off(self):
        flows = {item['flow']: item['guide'] for item in acceptance_flows.read_acceptance_flows(ROOT)['flows']}
        self.assertEqual({4}, {flow for flow, guide in flows.items() if guide['auto_verify'] is False})
        self.assertEqual('开始前请先在规则管理关掉自动核实', flows[4]['warning'])
        self.assertEqual({1, 2, 3, 5}, {flow for flow, guide in flows.items() if guide['auto_verify'] is True})
        self.assertEqual({6, 7}, {flow for flow, guide in flows.items() if guide['auto_verify'] is None})
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
            with self.assertRaisesRegex(ValueError, '找不到流程 1-7'):
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

    def test_get_returns_the_seven_flows_and_post_is_gone(self):
        with self.opener.open(self.base + '/api/acceptance-flows-1-7') as response:
            data = json.load(response)
        self.assertEqual([1, 2, 3, 4, 5, 6, 7], [item['flow'] for item in data['flows']])
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
