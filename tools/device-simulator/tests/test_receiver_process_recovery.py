"""Kill the real receiver at HTTP commit barriers; replay its actual durable state.

The loopback HTTP peer is a protocol fixture, not the platform or a real recipient.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]


def await_true(predicate, seconds=12):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(.025)
    raise AssertionError('process recovery deadline exceeded')


class ReceiverProcessRecoveryTests(unittest.TestCase):
    def exercise(self, kind, commit_before_kill):
        with tempfile.TemporaryDirectory(prefix='item4-receiver-') as directory:
            folder = Path(directory)
            mid = 'simn-' + uuid.uuid4().hex
            row = dict(message_id=mid, kind=kind, direction='OUT', subject_id=uuid.uuid4().hex,
                       state='SUBMITTED', version=1, created_at=int(time.time()*1000),
                       payload={'text': 'ITEM4 SIMULATED PROCESS TEST'}, result={})
            entered, release = threading.Event(), threading.Event()
            calls, applied, failures, processes, streams = [], [], [], [], []
            lock = threading.RLock()
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args): pass
                def do_POST(self):
                    command = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    path = command['path']
                    if path.endswith('/context'):
                        with lock: result = {'receiver_messages': [copy.deepcopy(row)]}
                    elif path.endswith('/bindings'):
                        result = {'enabled': command['body']['enabled']}
                    else:
                        with lock:
                            first = not calls
                            calls.append(copy.deepcopy(command))
                        if first:
                            saved = json.loads((folder/'state.json').read_text(encoding='utf-8'))
                            pending = saved['messages'][mid]['pending']
                            if pending['body'] != command['body']:
                                failures.append('receipt not persisted before HTTP')
                        if first and not commit_before_kill:
                            entered.set()
                            release.wait(12)
                            return  # Request was received but not committed.
                        with lock:
                            if command['body']['expected_version'] != row['version']:
                                failures.append('unexpected duplicate/version conflict')
                            row.update(state=command['body']['outcome'], version=row['version']+1,
                                       result={'projection_status': 'APPLIED'})
                            applied.append((row['state'], time.monotonic()))
                            result = copy.deepcopy(row)
                        if first:
                            entered.set()
                            release.wait(12)  # Commit completed, response has not reached receiver.
                    raw = json.dumps(result).encode()
                    try:
                        self.send_response(200)
                        self.send_header('Content-Length', str(len(raw)))
                        self.end_headers()
                        self.wfile.write(raw)
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass
            http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            serving = threading.Thread(target=http.serve_forever, daemon=True)
            serving.start()
            def start():
                log = (folder / ('child-%d.log' % len(processes))).open('wb')
                streams.append(log)
                proc = subprocess.Popen([sys.executable, '-u', str(ROOT/'realtime_notification_receiver.py'),
                    '--proxy', 'http://127.0.0.1:%d' % http.server_port,
                    '--data-dir', str(folder), '--play-seconds', '3'], stdout=log, stderr=subprocess.STDOUT,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                processes.append(proc)
                return proc
            try:
                original = start()
                self.assertTrue(entered.wait(12), 'receiver never reached commit barrier')
                original.kill()
                original.wait(5)
                release.set()
                restarted_at = time.monotonic()
                recovered = start()
                final = 'PLAYED' if kind == 'ADVISORY_VOICE' else 'DELIVERED' if kind == 'ADVISORY_SMS' else 'ACKNOWLEDGED'
                await_true(lambda: row['state'] == final)
                (folder/'stop').touch()
                self.assertEqual(recovered.wait(5), 0)
                self.assertEqual(failures, [])
                states = [outcome for outcome, _ in applied]
                expected = ['ANSWERED','PLAYED'] if kind == 'ADVISORY_VOICE' else ['DELIVERED'] if kind == 'ADVISORY_SMS' else ['DELIVERED','ACKNOWLEDGED']
                self.assertEqual(states, expected)
                self.assertEqual(len(calls), len(expected) + (0 if commit_before_kill else 1))
                if not commit_before_kill:
                    self.assertEqual(calls[0]['key'], calls[1]['key'])
                    self.assertEqual(calls[0]['body'], calls[1]['body'])
                if kind == 'ADVISORY_VOICE':
                    self.assertGreaterEqual(applied[-1][1] - restarted_at, 3)
                evidence = os.environ.get('ITEM4_EVIDENCE_DIR')
                if evidence:
                    path = Path(evidence)
                    path.mkdir(parents=True, exist_ok=True)
                    with (path/'receiver-process.jsonl').open('a', encoding='utf-8') as stream:
                        stream.write(json.dumps({'case':mid,'kind':kind,'commit_before_kill':commit_before_kill,
                            'http_attempts':len(calls),'applied':states,'same_persisted_state':True,
                            'recovered_seconds':time.monotonic()-restarted_at,'result':'PASS'})+'\n')
            finally:
                release.set()
                for proc in processes:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait(5)
                http.shutdown()
                http.server_close()
                serving.join(5)
                for stream in streams: stream.close()

    def test_three_repeats_of_precommit_and_lost_response_restart(self):
        for repeat in range(3):
            for kind in ('ADVISORY_SMS','ADVISORY_VOICE','UAV_PUNISHMENT','RISK_NOTICE'):
                for committed in (False, True):
                    with self.subTest(repeat=repeat, kind=kind, committed=committed):
                        self.exercise(kind, committed)


if __name__ == '__main__':
    unittest.main()
