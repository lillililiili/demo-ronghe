import contextlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from platform_client import Prerequisites


class PrerequisiteSchemaTests(unittest.TestCase):
    def test_default_query_preserves_existing_database_command(self):
        seed = Prerequisites('test_only', 'qa-db')
        with patch('platform_client.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='1\n')) as run:
            self.assertEqual(seed.query('SELECT 1;'), '1')
        run.assert_called_once_with(
            ['docker', 'exec', '-i', 'qa-db', 'psql', '-U', 'uav', '-d', 'test_only', '-qAt', '-v', 'ON_ERROR_STOP=1'],
            input='SELECT 1;', text=True, capture_output=True, timeout=20)

    def test_schema_applies_to_every_psql_process_without_public_fallback(self):
        schema = 'monitor_events_' + 'a' * 32
        seed = Prerequisites('test_only', 'qa-db', schema=schema)
        with patch('platform_client.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='1\n')) as run:
            seed.query('SELECT count(*) FROM mqtt_broker;')
            seed.query('BEGIN; SELECT 1; COMMIT;')
        for call in run.call_args_list:
            command = call.args[0]
            self.assertEqual(command[:6], ['docker', 'exec', '-i', '-e', 'PGOPTIONS=-c search_path=' + schema, 'qa-db'])
            self.assertIn('-X', command)
            self.assertEqual(command[command.index('-d') + 1], 'test_only')
            self.assertNotIn('public', command[4])
        self.assertEqual(run.call_args_list[1].kwargs['input'], 'BEGIN; SELECT 1; COMMIT;')

    def test_schema_accepts_only_bounded_lowercase_identifiers(self):
        for schema in ('public', '_qa', 'qa_123', 'a' * 63):
            self.assertEqual(Prerequisites('test_only', schema=schema).schema, schema)
        for schema in ('', 'A', '1qa', 'a' * 64, 'qa-public', 'qa,public', 'qa public', 'qa\n', 'qa"', 'qa; DROP SCHEMA public;', '$user', '测试', 123):
            with self.subTest(schema=schema), self.assertRaisesRegex(ValueError, 'schema'):
                Prerequisites('test_only', schema=schema)

    def test_schema_requires_explicit_database(self):
        with self.assertRaisesRegex(ValueError, '--database'):
            Prerequisites(None, schema='qa')

    def test_runtime_propagates_schema_without_changing_session_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            session = server.ExternalBridge()
            runtime = server.Runtime(directory, 'test_only', 'qa-db', session, schema='qa')
            self.assertEqual(runtime.seed.schema, 'qa')
            self.assertIs(runtime.session, session)

    def test_cli_validates_schema_before_startup(self):
        schema = 'monitor_events_' + 'a' * 32
        with tempfile.TemporaryDirectory() as directory:
            args = server.parse_args(['--isolated-qa-scene', '--database', 'stage456_verify_unit', '--schema', schema,
                                      '--data-dir', directory, '--port', '18767'])
        self.assertEqual((args.database, args.schema, args.port), ('stage456_verify_unit', schema, 18767))
        self.assertIsNone(server.parse_args([]).schema)
        for argv in (['--schema', 'qa'], ['--database', 'test_only', '--schema', 'qa,public']):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                server.parse_args(argv)
            self.assertEqual(error.exception.code, 2)

    def test_schema_seed_uses_public_postgis_function_and_checks_broker_first(self):
        seed = Prerequisites('test_only', schema='qa')
        scene = dict(risks=[dict(type='zone', zoneId='z1', enabled=True), dict(type='route', planId='p1', enabled=True)],
            plans=[dict(id='p1', name='plan', points=[[100, 100], [200, 100]], width=50, min=0, max=100, start='08:00', end='18:00')], zones=[
            dict(id='z1', name='zone', points=[[100, 100], [200, 100], [200, 200]],
                 max=100, start='08:00', end='18:00', kindCode='PROHIBITED')])
        manifest = dict(batch='schema-test', zones={}, plans={}, targets={})
        with patch('platform_client.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='1\n')) as run:
            seed.create(scene, {}, dict(broker_id='b', owner_org_id='o', district_id='d'), manifest, 1790467200000)
        self.assertEqual(len(run.call_args_list), 2)
        self.assertIn('FROM mqtt_broker', run.call_args_list[0].kwargs['input'])
        self.assertEqual(run.call_args_list[1].kwargs['input'].count('public.ST_GeomFromText('), 2)
        with patch('platform_client.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='0\n')) as run:
            with self.assertRaisesRegex(ValueError, '不一致'):
                seed.create(scene, {}, dict(broker_id='other'), manifest, 1790467200000)
            self.assertEqual(run.call_count, 1)

    def test_missing_schema_table_stops_before_any_seed_write(self):
        seed = Prerequisites('test_only', schema='missing_qa')
        with patch('platform_client.subprocess.run', return_value=SimpleNamespace(
                returncode=1, stdout='', stderr='relation "mqtt_broker" does not exist')) as run:
            with self.assertRaisesRegex(ValueError, '测试库配套失败'):
                seed.query('SELECT count(*) FROM mqtt_broker;')
        self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
