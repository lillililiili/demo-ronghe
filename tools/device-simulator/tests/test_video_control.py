import copy
import json
from pathlib import Path
import sys
import tempfile
import threading
import urllib.request
import urllib.error
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Runtime
import server as simulator_server


class VideoControlTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.runtime = Runtime(self.directory.name)
        self.runtime.video_config['enabled'] = False
        self.runtime.session.platform = SimpleNamespace(base='http://localhost:8081/api/v1', call=Mock(return_value={}))
        self.runtime.video_config['publisher_password'] = 'test-secret-only'
        self.runtime.video_media.ensure = Mock(return_value='test-secret-only')
        self.runtime.phase = 'RUNNING'
        self.runtime.elapsed, self.runtime.sent = 42, 19

    def control(self, body):
        self.assertTrue(callable(getattr(self.runtime, 'video_control', None)), 'video control endpoint is missing')
        with patch('eo_video.shutil.which', return_value='C:/ffmpeg.exe'):
            return self.runtime.video_control(body)

    def test_running_toggle_preserves_observations_and_applies_on_owner_thread(self):
        eo = Mock()
        eo.snapshot.return_value = {'enabled': True, 'devices': []}
        self.runtime.eo = eo
        result = self.control({'enabled': True})
        eo.configure_video.assert_not_called()
        self.assertTrue(result['video_config']['enabled'])
        self.runtime.sync_video()
        eo.configure_video.assert_called_once()
        self.assertEqual((self.runtime.phase, self.runtime.elapsed, self.runtime.sent), ('RUNNING', 42, 19))
        self.assertFalse(self.runtime.cancel.is_set())
        self.assertNotIn('test-secret-only', json.dumps(result))

    def test_disable_remains_available_after_login_expiry(self):
        self.runtime.video_config['enabled'] = True
        self.runtime.session.platform = None
        self.assertFalse(self.control({'enabled': False})['video_config']['enabled'])

    def test_enable_requires_valid_session_and_keeps_config_on_failure(self):
        for platform in (None, SimpleNamespace(call=Mock(side_effect=ValueError('expired')))):
            self.runtime.session.platform = platform
            before = copy.deepcopy(self.runtime.video_config)
            with self.assertRaises(ValueError): self.control({'enabled': True})
            self.assertEqual(self.runtime.video_config, before)

    def test_first_enable_provisions_missing_password_without_opening_settings(self):
        self.runtime.video_config['publisher_password'] = ''
        with patch('server.load_or_create_credentials', return_value={'publish': 'generated-secret-only'}):
            result = self.control({'enabled': True})
        self.assertTrue(result['video_config']['enabled'])
        self.assertTrue(result['video_config']['publisher_password_set'])
        self.runtime.video_media.ensure.assert_called_once()
        self.assertNotIn('generated-secret-only', json.dumps(result))

    def test_default_enabled_connect_prepares_media_without_manual_toggle(self):
        self.runtime.phase = 'STOPPED'
        self.runtime.video_config.update(enabled=True, publisher_password='')
        self.runtime.session.platform.brokers = Mock(return_value=[{
            'broker_id': 'local-test', 'name': 'local-lingyun-replay',
            'host': '127.0.0.1', 'port': 1883}])
        with patch('server.load_or_create_credentials', return_value={'publish': 'generated-secret-only'}), \
                patch('eo_video.shutil.which', return_value='/test/ffmpeg'):
            self.runtime.connect({})
        self.runtime.video_media.ensure.assert_called_once()
        self.assertTrue(self.runtime.video_config['enabled'])
        self.assertEqual(self.runtime.video_config['ffmpeg'], '/test/ffmpeg')
        self.assertNotIn('generated-secret-only', json.dumps(self.runtime.status()))

    def test_default_enabled_first_toggle_can_provision_credentials(self):
        self.runtime.video_config.update(enabled=True, publisher_password='')
        with patch('server.load_or_create_credentials', return_value={'publish': 'generated-secret-only'}):
            self.assertTrue(self.control({'enabled': True})['video_config']['publisher_password_set'])

    def test_invalid_input_or_transition_never_changes_configuration(self):
        for body in ({'enabled': 'true'}, {'enabled': 1}, {'enabled': True, 'shell': 'bad'},
                     {'enabled': False, 'config': {'other': 1}}, {'enabled': False, 'config': []}):
            with self.subTest(body=body), self.assertRaises(ValueError): self.control(body)
        for phase in ('PREPARING', 'STOPPING'):
            self.runtime.phase = phase
            with self.assertRaises(ValueError): self.control({'enabled': True})
        self.assertFalse(self.runtime.video_config['enabled'])

    def test_config_changes_require_video_off_and_never_export_secret(self):
        self.runtime.video_config['enabled'] = True
        with self.assertRaises(ValueError):
            self.control({'enabled': True, 'config': {'source': 'C:/different.mp4'}})
        self.control({'enabled': False})
        result = self.control({'enabled': False, 'config': {'rtsp_base': 'rtsp://127.0.0.1:18554'}})
        self.assertTrue(result['video_config']['publisher_password_set'])
        self.assertNotIn('test-secret-only', json.dumps(result))
        self.assertEqual(result['video_config']['rtsp_base'], 'rtsp://127.0.0.1:18554')

    def test_same_origin_http_endpoint_validates_payload_and_masks_secrets(self):
        local = simulator_server.ThreadingHTTPServer(('127.0.0.1', 0), simulator_server.Handler)
        thread = threading.Thread(target=lambda: local.serve_forever(poll_interval=.05), daemon=True)
        thread.start()
        base = 'http://127.0.0.1:' + str(local.server_port)
        try:
            with patch.object(simulator_server, 'runtime', self.runtime, create=True):
                for origin, body, code in ((base, {'enabled': False}, 200),
                        ('http://untrusted.invalid', {'enabled': False}, 403),
                        (base, {'enabled': 'true'}, 400)):
                    request = urllib.request.Request(base+'/api/video', json.dumps(body).encode(),
                        {'Content-Type':'application/json', 'Origin':origin})
                    try: response = urllib.request.urlopen(request, timeout=3)
                    except urllib.error.HTTPError as error: response = error
                    with response:
                        self.assertEqual(response.status, code)
                        self.assertNotIn('test-secret-only', response.read().decode())
        finally:
            local.shutdown(); local.server_close(); thread.join(2)


if __name__ == '__main__': unittest.main()
