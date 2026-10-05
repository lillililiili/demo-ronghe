import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from test_engine import scene


class IsolatedQaSceneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.schema = 'monitor_events_' + 'a' * 32
        self.argv = ['--isolated-qa-scene', '--database', 'stage456_verify_unit', '--schema', self.schema,
                     '--data-dir', self.temp.name, '--port', '18767']

    def runtime(self):
        runtime = server.create_runtime(server.parse_args(self.argv))
        runtime.session.platform = SimpleNamespace(base='http://127.0.0.1:8081/api/v1', me={'role_code': 'ROLE-ADMIN'})
        runtime.broker = dict(broker_id='qa-broker', name='qa', host='127.0.0.1', port=1883, enabled=True, source_mode='replay')
        runtime.seed.query = Mock(return_value='1')
        return runtime

    def test_cli_requires_explicit_qa_database_schema_directory_and_port(self):
        self.assertTrue(server.parse_args(self.argv).isolated_qa_scene)
        invalid = [[], ['--database', 'stage456_verify_unit'], ['--schema', self.schema],
                   ['--database', 'production', '--schema', self.schema],
                   ['--database', 'stage456_verify_unit', '--schema', 'public'],
                   ['--database', 'stage456_verify_unit', '--schema', self.schema]]
        for options in invalid:
            with self.subTest(options=options), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                server.parse_args(['--isolated-qa-scene'] + options)
        for replacement, value in (('--database', 'production'), ('--schema', 'public'),
                                   ('--data-dir', str(server.ROOT / '.data' / 'nested')), ('--port', '8766')):
            argv = self.argv[:]; argv[argv.index(replacement) + 1] = value
            with self.subTest(value=value), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                server.parse_args(argv)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            server.parse_args(['--database', 'stage456_verify_unit', '--schema', self.schema])

    def test_default_still_creates_realtime_controller_and_rejects_seed(self):
        args = server.parse_args(['--data-dir', self.temp.name])
        runtime = server.create_runtime(args)
        self.assertFalse(runtime.isolated_qa_scene)
        self.assertIsInstance(runtime.realtime, server.RealtimeController)
        runtime.seed.database = 'test_only'
        with self.assertRaisesRegex(ValueError, '实时收发不使用数据库配套'):
            runtime.start(scene())
        self.assertFalse(runtime.realtime.active())

    def test_qa_uses_original_scene_and_checks_broker_before_thread_start(self):
        runtime = self.runtime()
        raw = scene(); raw['targets'][0]['notificationBehavior'] = 'drop_sms'
        raw['risks'].append(dict(id='r2', name='fault', type='fault', enabled=True, deviceId='d1', at=0, seconds=5))
        original = copy.deepcopy(raw)
        with patch('server.prepare_scene', side_effect=AssertionError('must preserve scene')), patch('server.threading.Thread') as thread:
            state = runtime.start(raw)
        self.assertIsNone(runtime.realtime)
        self.assertEqual(raw, original)
        self.assertEqual(runtime.scene['duration'], original['duration'])
        self.assertEqual(runtime.scene['targets'][0]['notificationBehavior'], 'drop_sms')
        self.assertTrue(runtime.scene['risks'][-1]['enabled'])
        self.assertEqual(state['scene_mode'], 'isolated_qa')
        runtime.seed.query.assert_called_once()
        self.assertIn("broker_id='qa-broker'", runtime.seed.query.call_args.args[0])
        thread.return_value.start.assert_called_once()
        self.assertEqual(runtime.stop_all()['phase'], 'STOPPING')

    def test_qa_rejects_remote_or_mismatched_broker_before_batch_or_thread(self):
        for host, count in (('192.0.2.1', '1'), ('127.0.0.1', '0')):
            runtime = self.runtime(); runtime.broker['host'] = host; runtime.seed.query.return_value = count
            with self.subTest(host=host, count=count), patch('server.threading.Thread') as thread:
                with self.assertRaises(ValueError): runtime.start(scene())
                thread.assert_not_called()
                self.assertIsNone(runtime.batch)

    def test_constructor_cannot_bypass_qa_constraints(self):
        with self.assertRaisesRegex(ValueError, '隔离'):
            server.Runtime(self.temp.name, 'production', schema='public', isolated_qa_scene=True)

    def test_realtime_routes_fail_explicitly_without_controller(self):
        runtime = self.runtime()
        for path in ('/api/realtime/status', '/api/realtime/config'):
            handler = server.Handler.__new__(server.Handler)
            handler.path, handler.safe, handler.respond = path, lambda: True, Mock()
            with patch.object(server, 'runtime', runtime, create=True): handler.do_GET()
            self.assertEqual(handler.respond.call_args.args[1], 409)
            self.assertIn('隔离', handler.respond.call_args.args[0]['error'])
        for path, body in (('/api/realtime/control', {'action':'start'}), ('/api/realtime/config', {})):
            handler = server.Handler.__new__(server.Handler)
            payload = json.dumps(body).encode()
            handler.path, handler.safe, handler.respond = path, lambda: True, Mock()
            handler.headers = {'Content-Type':'application/json', 'Content-Length':str(len(payload))}
            handler.rfile = io.BytesIO(payload)
            with patch.object(server, 'runtime', runtime, create=True): handler.do_POST()
            self.assertEqual(handler.respond.call_args.args[1], 400)
            self.assertIn('隔离', handler.respond.call_args.args[0]['error'])


if __name__ == '__main__':
    unittest.main()
