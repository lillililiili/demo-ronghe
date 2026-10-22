"""Persistence survives Windows encoding changes without resuming MQTT."""
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Runtime
from test_engine import scene


class RuntimeRecoveryTests(unittest.TestCase):
    def history(self, root, phase):
        folder = Path(root) / ('sim-' + uuid.uuid4().hex)
        folder.mkdir()
        manifest = {'batch': folder.name, 'phase': phase, 'elapsed': 12, 'sent': 27}
        (folder / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        (folder / 'scene.json').write_text(json.dumps(scene()), encoding='utf-8')
        (folder / 'events.ndjson').write_text(json.dumps({'kind': 'ERROR', 'message': '原始登记失败'}) + '\n', encoding='utf-8')
        return folder, {p.name: p.read_bytes() for p in folder.iterdir()}

    def assert_history_unchanged(self, folder, saved):
        self.assertEqual({p.name: p.read_bytes() for p in folder.iterdir()}, saved)

    def test_failed_history_recovers_as_stopped_and_stays_read_only(self):
        for _ in range(2):
            with self.subTest(batch_variant=_), tempfile.TemporaryDirectory() as root:
                folder, saved = self.history(root, 'FAILED')
                runtime = Runtime(root)
                state = runtime.status()
                self.assertEqual(state['phase'], 'STOPPED')
                self.assertEqual(state['manifest']['phase'], 'FAILED')
                self.assertEqual(state['batch'], folder.name)
                self.assertEqual(state['error'], '上次模拟失败，当前已停止，请查看运行记录后重新开始')
                self.assertEqual(state['logs'][-1]['message'], '原始登记失败')
                self.assertIsNone(runtime.thread)
                self.assertIsNone(runtime.platform)
                self.assertFalse(runtime.mqtt_connected)
                runtime.control('stop')
                runtime.checkpoint()
                runtime.log('STATUS', '当前进程已停止')
                self.assertEqual(runtime.manifest['phase'], 'FAILED')
                self.assert_history_unchanged(folder, saved)

    def test_interrupted_and_finished_history_remains_unchanged(self):
        for phase in ('PREPARING', 'RUNNING', 'PAUSED', 'STOPPING', 'COMPLETED', 'STOPPED'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as root:
                folder, saved = self.history(root, phase)
                runtime = Runtime(root)
                self.assertEqual(runtime.phase, 'COMPLETED' if phase == 'COMPLETED' else 'STOPPED')
                self.assertEqual(runtime.manifest['phase'], phase)
                self.assertIsNone(runtime.thread)
                runtime.control('stop')
                self.assert_history_unchanged(folder, saved)

    def test_new_failure_after_history_is_still_failed_and_persisted(self):
        for _ in range(2):
            with self.subTest(batch_variant=_), tempfile.TemporaryDirectory() as root:
                folder, saved = self.history(root, 'FAILED')
                runtime = Runtime(root)
                platform = SimpleNamespace(base='http://localhost/test',
                    prepare_devices=Mock(side_effect=ValueError('当前设备登记失败')))
                runtime.session.platform = platform
                runtime.broker = {'broker_id': uuid.uuid4().hex, 'name': 'test', 'host': 'localhost', 'port': 1883,
                                  'owner_org_id': uuid.uuid4().hex, 'district_id': uuid.uuid4().hex}
                runtime.start(scene())
                runtime.thread.join(5)
                self.assertFalse(runtime.thread.is_alive())
                self.assertNotEqual(runtime.batch, folder.name)
                self.assertEqual(runtime.status()['phase'], 'FAILED')
                self.assertIn('当前设备登记失败', runtime.error)
                current = Path(root) / runtime.batch
                self.assertEqual(json.loads((current / 'manifest.json').read_text(encoding='utf-8'))['phase'], 'FAILED')
                self.assertIn('ERROR', (current / 'events.ndjson').read_text(encoding='utf-8'))
                runtime.control('stop')
                self.assertEqual(runtime.phase, 'FAILED')
                self.assert_history_unchanged(folder, saved)

    def test_legacy_windows_batch_recovers_as_stopped(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / 'sim-legacy'
            folder.mkdir()
            manifest = {'batch': folder.name, 'phase': 'RUNNING', 'elapsed': 12, 'sent': 27}
            (folder / 'manifest.json').write_text(json.dumps(manifest), encoding='cp936')
            (folder / 'scene.json').write_text(json.dumps(scene(), ensure_ascii=False), encoding='cp936')
            (folder / 'events.ndjson').write_text(json.dumps({'kind': 'START', 'message': '开始发送'}, ensure_ascii=False) + '\n', encoding='cp936')
            runtime = Runtime(root)
            self.assertEqual(runtime.phase, 'STOPPED')
            self.assertEqual(runtime.scene['name'], '隔离验证')
            self.assertEqual(runtime.logs[-1]['message'], '开始发送')
            self.assertEqual((runtime.sent, runtime.elapsed), (27, 12))
            self.assertIn('未自动续发', runtime.error)
            self.assertIsNone(runtime.thread)
            self.assertIsNone(runtime.platform)

    def test_new_scene_and_log_are_utf8_independent_of_process_default(self):
        with tempfile.TemporaryDirectory() as root, patch.object(Runtime, 'run'):
            runtime = Runtime(root)
            runtime.session.platform = SimpleNamespace(base='http://localhost/test')
            runtime.broker = {'broker_id': 'test', 'name': 'test', 'host': 'localhost', 'port': 1883,
                              'owner_org_id': uuid.uuid4().hex, 'district_id': uuid.uuid4().hex}
            runtime.start(scene())
            runtime.thread.join(1)
            runtime.log('TEST', '中文记录')
            folder = Path(root) / runtime.batch
            self.assertEqual(json.loads((folder / 'scene.json').read_text(encoding='utf-8'))['name'], '隔离验证')
            self.assertIn('中文记录', (folder / 'events.ndjson').read_text(encoding='utf-8'))

    def test_pause_checkpoints_progress_before_process_exit(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.batch = 'sim-progress'
            (Path(root) / runtime.batch).mkdir()
            runtime.manifest = {'batch': runtime.batch}
            runtime.phase, runtime.sent, runtime.elapsed = 'RUNNING', 27, 12
            runtime.control('pause')
            saved = json.loads((Path(root) / runtime.batch / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual((saved['phase'], saved['sent'], saved['elapsed']), ('PAUSED', 27, 12))

    def test_session_check_runs_without_notification_targets_and_is_bounded(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            platform = SimpleNamespace(call=Mock(return_value={'account': 'qa'}))
            runtime.session.platform = platform
            runtime.check_session(100)
            runtime.check_session(104.9)
            platform.call.assert_called_once_with('GET', '/local-interface-simulator/session')
            runtime.check_session(105)
            self.assertEqual(platform.call.call_count, 2)

    def test_failed_session_check_does_not_renew_validation_window(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            platform = SimpleNamespace(call=Mock(side_effect=ValueError('会话已失效')))
            runtime.session.platform = platform
            with self.assertRaisesRegex(ValueError, '会话已失效'):
                runtime.check_session(100)
            with self.assertRaisesRegex(ValueError, '会话已失效'):
                runtime.check_session(100.1)
            self.assertEqual(platform.call.call_count, 2)


if __name__ == '__main__':
    unittest.main()
