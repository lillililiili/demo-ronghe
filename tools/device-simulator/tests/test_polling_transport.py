import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from platform_client import Platform
from realtime_control import RealtimeController
from server import ExternalBridge, Runtime


class PollingTransportTests(unittest.TestCase):
    def test_runtime_rechecks_original_interface_guard_with_light_session_endpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Runtime(directory)
            runtime.session.platform = Mock()
            runtime.check_session(100)
            runtime.session.platform.call.assert_called_once_with('GET', '/local-interface-simulator/session')
            runtime.check_session(101)
            self.assertEqual(1, runtime.session.platform.call.call_count)

    def test_bridge_allowlist_accepts_only_exact_light_get_paths(self):
        for path in ('/local-interface-simulator/session', '/local-interface-simulator/receiver-context'):
            self.assertTrue(ExternalBridge.allowed('GET', path))
            self.assertFalse(ExternalBridge.allowed('POST', path))
            self.assertFalse(ExternalBridge.allowed('GET', path + '?unscoped=true'))
        self.assertFalse(ExternalBridge.allowed('GET', '/auth/me'))

    def test_realtime_polling_uses_light_session_and_failures_stop_with_same_reason(self):
        for error in (None, ValueError('系统接口 /local-interface-simulator/session 请求超时（12秒）'),
                      ValueError('系统接口 /local-interface-simulator/session 返回 403：没有权限')):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                logs = Mock()
                runtime = SimpleNamespace(data_dir=Path(directory), lock=threading.RLock(), phase='RUNNING',
                                          cancel=threading.Event(), error='', log=logs)
                controller = RealtimeController(runtime, port=19721)
                controller.cancel = Mock()
                controller.cancel.wait.side_effect = [False, True]
                client = Mock()
                client.call.side_effect = error
                with patch('realtime_control.time.monotonic', side_effect=[0, 6, 7]), patch.object(controller, 'cleanup'):
                    controller.run(client)
                client.call.assert_called_once_with('GET', '/local-interface-simulator/session')
                self.assertEqual(bool(error), runtime.cancel.is_set())
                if error:
                    self.assertEqual('FAILED', controller.state)
                    self.assertIn(str(error), runtime.error)
                    self.assertEqual('STOPPING', runtime.phase)
                    logs.assert_called_once_with('REALTIME_FAILURE', runtime.error)
                else:
                    self.assertEqual('', runtime.error)
                    logs.assert_not_called()

    def test_platform_preserves_safe_failure_category_without_raw_error_secrets(self):
        for failure, expected in (
            (TimeoutError('private-token'), '请求超时'),
            (urllib.error.URLError(TimeoutError('private-token')), '请求超时'),
            (urllib.error.URLError(ConnectionRefusedError('private-token')), '连接失败'),
            (ConnectionResetError('private-token'), '连接中断'),
            (ValueError('private-token'), '无效 JSON'),
        ):
            with self.subTest(category=expected):
                platform = Platform('http://127.0.0.1:8081/api/v1')
                platform.http = Mock()
                platform.http.open.side_effect = failure
                with self.assertRaises(ValueError) as caught:
                    platform.call('GET', '/local-interface-simulator/session')
                self.assertIn(expected, str(caught.exception))
                self.assertIn('/local-interface-simulator/session', str(caught.exception))
                self.assertNotIn('private-token', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
