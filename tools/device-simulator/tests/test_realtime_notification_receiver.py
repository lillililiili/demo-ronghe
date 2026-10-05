import copy
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
MODULE = Path(__file__).resolve().parents[1] / 'realtime_notification_receiver.py'


def message(kind='ADVISORY_SMS', state='SUBMITTED', version=1):
    return dict(message_id='simn-message-1', kind=kind, direction='OUT', subject_id='subject-1',
                state=state, version=version, created_at=int(time.time() * 1000),
                payload={'text': '原样保留通知正文', 'recipient': 'receiver'}, result={})


class FakeProxy:
    def __init__(self, row):
        self.row = row
        self.calls = []
        self.fail = None
        self.projection_status = 'APPLIED'
        self.before_receipt = lambda: None

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, copy.deepcopy(body), key))
        if self.fail:
            raise self.fail
        if path.endswith('/context'):
            return {'receiver_messages': [copy.deepcopy(self.row)]}
        if path.endswith('/bindings'):
            return {'enabled': body['enabled']}
        self.before_receipt()
        if body['expected_version'] != self.row['version']:
            raise RuntimeError('version conflict')
        self.row = {**self.row, 'state': body['outcome'], 'version': self.row['version'] + 1,
                    'result': {'projection_status': self.projection_status}}
        return copy.deepcopy(self.row)

    def outcomes(self):
        return [body['outcome'] for _, path, body, _ in self.calls if path.endswith('/receipt')]


class ReceiverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if MODULE.exists():
            import realtime_notification_receiver
            cls.module = realtime_notification_receiver

    def setUp(self):
        self.assertTrue(MODULE.exists(), 'independent receiver implementation is required')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.proxy = FakeProxy(message())

    def receiver(self, **kwargs):
        return self.module.Receiver(self.proxy, self.root, **kwargs)

    def test_original_request_is_durably_saved_before_receipt(self):
        original = copy.deepcopy(self.proxy.row)
        def check():
            state = json.loads((self.root / 'state.json').read_text(encoding='utf-8'))
            self.assertEqual(original, state['messages']['simn-message-1']['original'])
            events = [json.loads(line) for line in (self.root / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
            self.assertTrue(any(e['event'] == 'received' and e['message'] == original for e in events))
            self.assertEqual('DELIVERED', state['messages']['simn-message-1']['pending']['body']['outcome'])
        self.proxy.before_receipt = check
        self.receiver().step()
        self.assertEqual(['DELIVERED'], self.proxy.outcomes())

    def test_unapplied_projection_is_recorded_as_external_fact_without_retry(self):
        self.proxy.projection_status = 'IGNORED_STALE_ATTEMPT'
        receiver = self.receiver()
        with self.assertLogs(self.module.LOG, level='WARNING') as captured:
            self.assertTrue(receiver.step())
        self.assertTrue(any('业务未采纳' in line for line in captured.output))
        events = [json.loads(line) for line in (self.root / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual('receipt_recorded_unapplied', events[-1]['event'])
        self.assertEqual('IGNORED_STALE_ATTEMPT', events[-1]['message']['result']['projection_status'])
        state = json.loads((self.root / 'state.json').read_text(encoding='utf-8'))
        self.assertIsNone(state['messages']['simn-message-1']['pending'])
        self.receiver().step()
        self.assertEqual(['DELIVERED'], self.proxy.outcomes())

    def test_applied_projection_is_the_only_confirmed_business_receipt(self):
        with self.assertLogs(self.module.LOG, level='INFO') as captured:
            self.receiver().step()
        self.assertTrue(any('业务已采纳' in line for line in captured.output))
        events = [json.loads(line) for line in (self.root / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
        self.assertEqual('receipt_confirmed', events[-1]['event'])

    def test_unknown_projection_is_not_reported_as_business_success(self):
        for status in (None, 'PENDING', 'NEW_UNKNOWN_STATE'):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                proxy = FakeProxy(message())
                proxy.projection_status = status
                receiver = self.module.Receiver(proxy, Path(directory))
                with self.assertLogs(self.module.LOG, level='WARNING') as captured:
                    self.assertTrue(receiver.step())
                self.assertTrue(any('业务采纳状态未确认' in line for line in captured.output))
                events = [json.loads(line) for line in (Path(directory) / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
                self.assertEqual('receipt_recorded_projection_unknown', events[-1]['event'])
                receiver.step()
                self.assertEqual(['DELIVERED'], proxy.outcomes())

    def test_no_receipt_keeps_original_and_does_not_write_platform_success(self):
        config = self.root / 'outcomes.json'
        config.write_text('{"ADVISORY_SMS":"no_receipt"}', encoding='utf-8')
        receiver = self.receiver(outcome_file=config)
        receiver.step()
        receiver.step()
        self.assertEqual([], self.proxy.outcomes())
        self.assertEqual('SUBMITTED', self.proxy.row['state'])
        self.assertTrue((self.root / 'state.json').exists())

    def test_voice_plays_after_real_elapsed_time_and_restart(self):
        self.proxy.row = message('ADVISORY_VOICE')
        first = self.receiver(play_seconds=0.12)
        start = time.time()
        first.step()
        self.assertEqual(['ANSWERED'], self.proxy.outcomes())
        second = self.receiver(play_seconds=0.12)
        second.step()
        self.assertEqual(['ANSWERED'], self.proxy.outcomes())
        time.sleep(0.14)
        second.step()
        self.assertGreaterEqual(time.time() - start, 0.12)
        self.assertEqual(['ANSWERED', 'PLAYED'], self.proxy.outcomes())
        second.step()
        self.assertEqual(['ANSWERED', 'PLAYED'], self.proxy.outcomes())

    def test_non_voice_delivery_then_acknowledgement(self):
        for kind in ('RISK_NOTICE', 'UAV_PUNISHMENT', 'PLAN_FEEDBACK', 'DEVICE_MAINTENANCE'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                proxy = FakeProxy(message(kind))
                receiver = self.module.Receiver(proxy, Path(directory))
                receiver.step()
                self.assertEqual(['DELIVERED'], proxy.outcomes())
                receiver.step()
                self.assertEqual(['DELIVERED', 'ACKNOWLEDGED'], proxy.outcomes())

    def test_failure_timeout_and_answered_only_configuration(self):
        for mode, kind, expected in [('failed', 'ADVISORY_SMS', ['FAILED']),
                                     ('timeout', 'ADVISORY_SMS', ['TIMEOUT']),
                                     ('no_answer', 'ADVISORY_VOICE', ['FAILED']),
                                     ('answered_only', 'ADVISORY_VOICE', ['ANSWERED'])]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = root / 'outcomes.json'
                config.write_text(json.dumps({kind: mode}))
                proxy = FakeProxy(message(kind))
                receiver = self.module.Receiver(proxy, root, outcome_file=config, play_seconds=0.01)
                receiver.step()
                time.sleep(0.02)
                receiver.step()
                self.assertEqual(expected, proxy.outcomes())

    def test_context_error_stops_heartbeat_and_recovers(self):
        receiver = self.receiver()
        self.proxy.fail = self.module.ReceiverError('authentication failed', status=401)
        with self.assertLogs(self.module.LOG, level='ERROR'):
            self.assertFalse(receiver.step())
        self.assertFalse(any(path.endswith('/bindings') for _, path, _, _ in self.proxy.calls))
        self.assertIn('authentication failed', receiver.last_error)
        self.proxy.fail = None
        self.assertTrue(receiver.step())
        self.assertEqual(['DELIVERED'], self.proxy.outcomes())
        self.assertIsNone(receiver.last_error)

    def test_lost_receipt_response_recovers_from_platform_without_duplicate(self):
        receiver = self.receiver()
        original_call = self.proxy.call
        def lost_response(method, path, body=None, key=None):
            result = original_call(method, path, body, key)
            if path.endswith('/receipt'):
                raise self.module.ReceiverError('connection lost')
            return result
        self.proxy.call = lost_response
        with self.assertLogs(self.module.LOG, level='ERROR'):
            self.assertFalse(receiver.step())
        self.proxy.call = original_call
        self.assertTrue(self.receiver().step())
        self.assertEqual(['DELIVERED'], self.proxy.outcomes())

    def test_lease_renews_only_every_five_seconds(self):
        now = [time.time()]
        receiver = self.receiver(clock=lambda: now[0])
        receiver.step()
        now[0] += 4.9
        receiver.step()
        bindings = lambda: [body for _, path, body, _ in self.proxy.calls if path.endswith('/bindings')]
        self.assertEqual(1, len(bindings()))
        now[0] += 0.1
        receiver.step()
        self.assertEqual(2, len(bindings()))
        self.assertEqual({'source_kind': 'NOTIFICATION_CHANNEL', 'source_id': 'receiver', 'enabled': True}, bindings()[0])

    def test_lock_rejects_second_instance_and_releases(self):
        path = self.root / 'receiver.lock'
        with self.module.InstanceLock(path):
            with self.assertRaises(self.module.ReceiverError):
                with self.module.InstanceLock(path):
                    pass
        with self.module.InstanceLock(path):
            pass

    def test_stop_file_prevents_network_and_graceful_stop_disables_lease(self):
        receiver = self.receiver()
        stop = self.root / 'stop'
        stop.touch()
        receiver.run(stop)
        self.assertEqual([], self.proxy.calls)
        stop.unlink()
        receiver.step()
        receiver.close()
        self.assertEqual(False, self.proxy.calls[-1][2]['enabled'])

    def test_corrupt_state_fails_closed(self):
        (self.root / 'state.json').write_text('{broken')
        with self.assertRaises(self.module.ReceiverError):
            self.receiver()
        self.assertEqual([], self.proxy.calls)

    def test_failed_disk_write_prevents_any_receipt(self):
        receiver = self.receiver()
        with patch.object(receiver, 'save', side_effect=OSError('disk full')):
            with self.assertLogs(self.module.LOG, level='ERROR'):
                self.assertFalse(receiver.step())
        self.assertEqual([], self.proxy.outcomes())
        self.assertEqual('SUBMITTED', self.proxy.row['state'])

    def test_lost_voice_answer_response_waits_full_playback_after_recovery(self):
        self.proxy.row = message('ADVISORY_VOICE')
        now = [time.time()]
        receiver = self.receiver(clock=lambda: now[0], play_seconds=3)
        original_call = self.proxy.call
        def lost_response(method, path, body=None, key=None):
            result = original_call(method, path, body, key)
            if path.endswith('/receipt'):
                raise self.module.ReceiverError('connection lost')
            return result
        self.proxy.call = lost_response
        with self.assertLogs(self.module.LOG, level='ERROR'):
            receiver.step()
        now[0] += 10
        self.proxy.call = original_call
        receiver = self.receiver(clock=lambda: now[0], play_seconds=3)
        receiver.step()
        self.assertEqual(['ANSWERED'], self.proxy.outcomes())
        now[0] += 3
        receiver.step()
        self.assertEqual(['ANSWERED', 'PLAYED'], self.proxy.outcomes())

    def test_retry_keeps_idempotency_key_after_restart(self):
        receiver = self.receiver()
        original_call = self.proxy.call
        attempts = []
        def unavailable(method, path, body=None, key=None):
            if path.endswith('/receipt'):
                attempts.append((copy.deepcopy(body), key))
                raise self.module.ReceiverError('unavailable')
            return original_call(method, path, body, key)
        self.proxy.call = unavailable
        with self.assertLogs(self.module.LOG, level='ERROR'):
            receiver.step()
            self.receiver().step()
        self.assertEqual(2, len(attempts))
        self.assertEqual(attempts[0], attempts[1])
        self.proxy.call = original_call
        self.receiver().step()
        self.assertEqual('DELIVERED', self.proxy.row['state'])

    def test_expired_submitted_and_answered_only_report_timeout(self):
        for kind, state in [('ADVISORY_SMS', 'SUBMITTED'), ('ADVISORY_VOICE', 'ANSWERED')]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                row = message(kind, state)
                row['created_at'] = int((time.time() - 61) * 1000)
                proxy = FakeProxy(row)
                receiver = self.module.Receiver(proxy, Path(directory))
                receiver.step()
                self.assertEqual(['TIMEOUT'], proxy.outcomes())

    def test_expired_delivered_notice_can_acknowledge_without_redelivery(self):
        self.proxy.row = message('RISK_NOTICE', 'DELIVERED')
        self.proxy.row['created_at'] = int((time.time() - 3600) * 1000)
        self.receiver().step()
        self.assertEqual(['ACKNOWLEDGED'], self.proxy.outcomes())

    def test_untrusted_message_id_and_invalid_created_at_cannot_receive_success(self):
        for field, value in [('message_id', 'other-queue'), ('created_at', 'broken')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                row = message()
                row[field] = value
                proxy = FakeProxy(row)
                receiver = self.module.Receiver(proxy, Path(directory))
                with self.assertLogs(self.module.LOG, level='ERROR'):
                    self.assertFalse(receiver.step())
                self.assertEqual([], proxy.outcomes())

    def test_real_http_proxy_get_and_post_contract_and_auth_failure(self):
        requests = []
        status = [200]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_POST(self):
                command = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append((self.path, command, self.headers.get('Authorization')))
                raw = json.dumps({'receiver_messages': []}).encode()
                self.send_response(status[0])
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            proxy = self.module.ProxyClient(f'http://127.0.0.1:{server.server_port}')
            self.assertEqual({'receiver_messages': []}, proxy.call('GET', '/local-interface-simulator/context'))
            self.assertEqual(('/api/external/request', {'method': 'GET', 'path': '/local-interface-simulator/context'}, None), requests[0])
            proxy.call('POST', '/local-interface-simulator/bindings', {'enabled': True}, 'stable-key')
            self.assertEqual({'method': 'POST', 'path': '/local-interface-simulator/bindings',
                              'body': {'enabled': True}, 'key': 'stable-key'}, requests[1][1])
            status[0] = 401
            with self.assertRaises(self.module.ReceiverError) as caught:
                proxy.call('GET', '/local-interface-simulator/context')
            self.assertEqual(401, caught.exception.status)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
