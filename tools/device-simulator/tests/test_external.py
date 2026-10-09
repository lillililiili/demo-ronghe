"""Contract tests for the local external-interface bridge."""
import http.server
import json
import sys
import threading
import types
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as simulator_server
from server import ExternalBridge


class FakePlatform(http.server.BaseHTTPRequestHandler):
    calls = []
    brokers = []
    def log_message(self, *args): pass
    def answer(self, status, value):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)
    def do_GET(self):
        self.calls.append((self.command, self.path, self.headers.get('Authorization'), None))
        if self.path == '/auth/me': return self.answer(200, {'ok': True, 'data': {'account': 'operator', 'role_code': 'ROLE-USER', 'session_id': 'secret'}})
        if self.path == '/local-interface-simulator/context': return self.answer(200, {'ok': True, 'data': {'routes': [], 'messages': []}})
        if self.path == '/mqtt-brokers': return self.answer(200, {'ok': True, 'data': self.brokers})
        return self.answer(404, {'ok': False, 'error': {'message': 'missing'}})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append((self.command, self.path, self.headers.get('Idempotency-Key'), body))
        if self.path == '/auth/login': return self.answer(200, {'ok': True, 'data': {'session_id': 'secret'}})
        if self.path == '/local-interface-simulator/plans': return self.answer(200, {'ok': True, 'data': {'state': 'ACCEPTED', 'result': {'plan_no': 'MOCK-1'}}})
        return self.answer(404, {'ok': False, 'error': {'message': 'missing'}})


class ExternalBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakePlatform)
        cls.thread = threading.Thread(target=cls.backend.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = 'http://127.0.0.1:%s' % cls.backend.server_port
    @classmethod
    def tearDownClass(cls):
        cls.backend.shutdown(); cls.backend.server_close(); cls.thread.join()
    def setUp(self):
        FakePlatform.calls.clear()
        self.bridge = ExternalBridge()
    def test_shared_login_and_sanitized_status(self):
        user = self.bridge.connect({'api': self.url, 'account': 'operator', 'password': 'pass'})
        self.assertEqual(user, {'connected': True, 'user': {'account': 'operator', 'role_code': 'ROLE-USER'}, 'api': self.url, 'session_version': self.bridge.version})
        self.assertEqual(self.bridge.status(), user)
        self.assertNotIn('secret', json.dumps(user))
        self.assertEqual(self.bridge.request({'method': 'GET', 'path': '/local-interface-simulator/context'}), {'routes': [], 'messages': []})
    def test_allowlist_and_idempotency_key(self):
        self.bridge.connect({'api': self.url, 'account': 'operator', 'password': 'pass'})
        before = len(FakePlatform.calls)
        for request in ({'method': 'GET', 'path': '/auth/me'}, {'method': 'POST', 'path': '/local-interface-simulator/context'}, {'method': 'GET', 'path': '/local-interface-simulator/messages/x/receipt'}, {'method': 'GET', 'path': '/local-interface-simulator/context?x=1'}, {'method': 'POST', 'path': '/local-interface-simulator/plans', 'body': [], 'key': 'k'}):
            with self.assertRaises(ValueError): self.bridge.request(request)
        self.assertEqual(len(FakePlatform.calls), before)
        value = self.bridge.request({'method': 'POST', 'path': '/local-interface-simulator/plans', 'body': {'message_id': 'demo-1'}, 'key': 'demo-1'})
        self.assertEqual(value['result']['plan_no'], 'MOCK-1')
        self.assertEqual(FakePlatform.calls[-1][2], 'demo-1')
    def test_connection_scope_defaults_airspace_owner_to_the_simulator_connection(self):
        with self.assertRaises(simulator_server.ExternalAuthenticationRequired):
            self.bridge.connection_scope()
        self.bridge.connect({'api': self.url, 'account': 'operator', 'password': 'pass'})
        FakePlatform.brokers = [
            {'broker_id': 'other', 'name': 'local-risk-video-eo', 'source_mode': 'replay', 'enabled': True, 'owner_org_id': 'org-x', 'district_id': 'district-x'},
            {'broker_id': 'replay', 'name': 'local-lingyun-replay', 'source_mode': 'replay', 'enabled': True, 'owner_org_id': 'org-a', 'district_id': 'district-a'}]
        self.assertEqual(self.bridge.connection_scope(), {'owner_org_id': 'org-a', 'district_id': 'district-a', 'broker_name': 'local-lingyun-replay'})
        # Once a run has chosen its broker, that connection decides, without another broker lookup.
        self.bridge.runtime = types.SimpleNamespace(broker={'name': 'chosen', 'owner_org_id': 'org-b', 'district_id': 'district-b'})
        before = len(FakePlatform.calls)
        self.assertEqual(self.bridge.connection_scope(), {'owner_org_id': 'org-b', 'district_id': 'district-b', 'broker_name': 'chosen'})
        self.assertEqual(len(FakePlatform.calls), before)
        self.bridge.runtime = types.SimpleNamespace(broker=None)
        FakePlatform.brokers = [FakePlatform.brokers[0]]
        missing = self.bridge.connection_scope()
        self.assertEqual((missing['owner_org_id'], missing['district_id']), (None, None))
        self.assertIn('请手动选择', missing['message'])

    def test_device_status_input_has_only_the_exact_post_path(self):
        path = '/local-interface-simulator/device-status'
        self.assertTrue(self.bridge.allowed('POST', path))
        for method in ('GET', 'PUT', 'DELETE'):
            self.assertFalse(self.bridge.allowed(method, path))
        for extra in ('/x', '?device_id=x', '/../devices/x'):
            self.assertFalse(self.bridge.allowed('POST', path + extra))
        self.assertFalse(self.bridge.allowed('POST', '/devices/x/status'))

    def test_punishment_recipients_path_is_exact(self):
        path = '/local-interface-simulator/punishment-recipients'
        for method in ('GET', 'POST'):
            self.assertTrue(self.bridge.allowed(method, path))
        self.assertFalse(self.bridge.allowed('DELETE', path))
        for extra in ('/x', '?org_ids=x', '/../bindings'):
            self.assertFalse(self.bridge.allowed('POST', path + extra))

    def test_receipt_path_is_strict(self):
        self.bridge.connect({'api': self.url, 'account': 'operator', 'password': 'pass'})
        self.assertTrue(self.bridge.allowed('POST', '/local-interface-simulator/messages/demo_1/receipt'))
        for path in ('/local-interface-simulator/messages/../receipt', '/local-interface-simulator/messages/x%2fy/receipt', '/local-interface-simulator/messages/x/receipt/extra'):
            self.assertFalse(self.bridge.allowed('POST', path))

    def test_filing_paths_are_limited_to_read_and_supplement(self):
        self.assertTrue(self.bridge.allowed('GET', '/local-interface-simulator/plan-options'))
        path = '/local-interface-simulator/plans/29f39fa7-088a-425f-9c06-a3557b31b00b/filing'
        for method in ('GET', 'POST'):
            self.assertTrue(self.bridge.allowed(method, path))
        for bad in ('/local-interface-simulator/plans/../filing', path + '?x=1', path + '/extra', '/flight-plans/x'):
            self.assertFalse(self.bridge.allowed('POST', bad))
        self.assertFalse(self.bridge.allowed('DELETE', path))

    def test_cleared_session_returns_http_401_for_context_and_inbox(self):
        local = http.server.ThreadingHTTPServer(('127.0.0.1', 0), simulator_server.Handler)
        thread = threading.Thread(target=local.serve_forever, daemon=True)
        previous = simulator_server.external_bridge
        simulator_server.external_bridge = ExternalBridge()
        thread.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        base = 'http://127.0.0.1:%s' % local.server_port
        try:
            with opener.open(base + '/api/external/status') as response:
                self.assertEqual(json.load(response), {'connected': False, 'api': None, 'session_version': simulator_server.external_bridge.version})
            request = urllib.request.Request(base + '/api/external/request', data=json.dumps({'method': 'GET', 'path': '/local-interface-simulator/context'}).encode(), headers={'Content-Type': 'application/json'}, method='POST')
            for target in (request, base + '/api/external/inbox?kind=risk&page=1', base + '/api/external/connection-scope'):
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    opener.open(target)
                self.assertEqual(caught.exception.code, 401)
                self.assertIn('请先登录', json.load(caught.exception)['error'])
        finally:
            simulator_server.external_bridge = previous
            local.shutdown(); local.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
