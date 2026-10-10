import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qa_media
from server import Runtime


class CredentialsTests(unittest.TestCase):
    def test_creates_owner_only_distinct_secrets_and_reuses_them(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'nested' / 'c.json'
            first = qa_media.load_or_create_credentials(path)
            self.assertNotEqual(first['publish'], first['read'])
            self.assertTrue(all(qa_media.SECRET.fullmatch(first[k]) for k in ('publish', 'read')))
            if os.name != 'nt': self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(qa_media.load_or_create_credentials(path), first)

    def test_existing_utf8_and_bom_credentials_are_reused_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            for encoding in ('utf-8', 'utf-8-sig'):
                with self.subTest(encoding=encoding):
                    path = Path(directory) / (encoding + '.json')
                    credentials = {key: qa_media.secrets.token_urlsafe(32) for key in ('publish', 'read')}
                    original = json.dumps(credentials).encode(encoding)
                    path.write_bytes(original)
                    with patch('qa_media.secrets.token_urlsafe') as generate, patch('qa_media.os.open') as create:
                        self.assertEqual(qa_media.load_or_create_credentials(path), credentials)
                    generate.assert_not_called(); create.assert_not_called()
                    self.assertEqual(path.read_bytes(), original)

    def test_invalid_file_is_rejected_without_replacing_credentials(self):
        secret = qa_media.secrets.token_urlsafe(32)
        contents = (
            b'not json', b'\xff', b'[]', b'null', b'42', b'{}',
            json.dumps({'publish': 'short', 'read': 'short'}).encode(),
            json.dumps({'publish': secret, 'read': secret}).encode(),
            json.dumps({'publish': secret, 'read': False}).encode(),
            json.dumps({'publish': secret}).encode(),
        )
        with tempfile.TemporaryDirectory() as directory:
            for index, original in enumerate(contents):
                with self.subTest(case=index):
                    path = Path(directory) / f'c-{index}.json'
                    path.write_bytes(original)
                    with patch('qa_media.secrets.token_urlsafe') as generate, patch('qa_media.os.open') as create:
                        with self.assertRaisesRegex(ValueError, '格式无效'):
                            qa_media.load_or_create_credentials(path)
                    generate.assert_not_called(); create.assert_not_called()
                    self.assertEqual(path.read_bytes(), original)

    def test_unreadable_existing_file_is_rejected_without_replacing_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'c.json'
            original = json.dumps({key: qa_media.secrets.token_urlsafe(32) for key in ('publish', 'read')}).encode()
            path.write_bytes(original)
            for error in (PermissionError('denied'), OSError('read failed')):
                with self.subTest(error=type(error).__name__):
                    with patch.object(Path, 'read_text', side_effect=error), \
                            patch('qa_media.secrets.token_urlsafe') as generate, patch('qa_media.os.open') as create:
                        with self.assertRaisesRegex(ValueError, '无法读取'):
                            qa_media.load_or_create_credentials(path)
                    generate.assert_not_called(); create.assert_not_called()
                    self.assertEqual(path.read_bytes(), original)


class MediaApiProxyTests(unittest.TestCase):
    def test_loopback_probe_ignores_proxy_and_preserves_media_status(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.server.requests.append(self.path)
                self.send_response(self.server.status)
                self.end_headers()

            def log_message(self, *args): pass

        media = HTTPServer(('127.0.0.1', 0), Handler)
        proxy = HTTPServer(('127.0.0.1', 0), Handler)
        for server in (media, proxy):
            server.requests = []
            server.status = 503
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        credentials = {'read': 'test-only-read-password'}
        with patch.object(qa_media, 'API_PORT', media.server_port), \
                patch('urllib.request.getproxies', return_value={'http': f'http://127.0.0.1:{proxy.server_port}'}), \
                patch('urllib.request.proxy_bypass', return_value=False), \
                patch('urllib.request._opener', None):
            for status in (200, 401, 503):
                with self.subTest(status=status):
                    media.status = status
                    self.assertEqual(qa_media.api_status(credentials), status)
            media.shutdown()
            media.server_close()
            self.assertIsNone(qa_media.api_status(credentials))
        self.assertEqual(proxy.requests, [])
        self.assertEqual(media.requests, ['/v3/paths/list'] * 3)


class MediaServiceTests(unittest.TestCase):
    credentials = {'publish': 'p' * 32, 'read': 'r' * 32}

    def service(self, statuses, ports=False, which=None):
        states = iter(statuses)
        process = Mock(); process.poll.return_value = None
        popen, run = Mock(return_value=process), Mock(return_value=SimpleNamespace(returncode=0))
        clock = iter(range(1000))
        return qa_media.MediaService(popen=popen, run=run, which=which or (lambda name: None),
            status=lambda c: next(states), is_port_open=lambda port: ports, sleep=lambda s: None,
            clock=lambda: next(clock)), popen, run

    def test_running_service_with_same_credentials_is_reused(self):
        service, popen, run = self.service([200])
        service.ensure(self.credentials)
        popen.assert_not_called(); run.assert_not_called()

    def test_existing_service_errors_are_distinguished_without_replacing_it(self):
        cases = ((401, False, '拒绝读取账号'), (403, False, '拒绝读取账号'),
                 (404, False, 'API 响应异常'), (503, False, 'API 响应异常'),
                 (None, True, '端口已被占用，但视频服务 API 无法访问'))
        for status, ports, message in cases:
            with self.subTest(status=status, ports=ports):
                service, popen, run = self.service([status], ports)
                with self.assertRaisesRegex(ValueError, message): service.ensure(self.credentials)
                popen.assert_not_called(); run.assert_not_called()

    def test_local_binary_gets_credentials_only_through_environment(self):
        service, popen, run = self.service([None, None, 200], which=lambda name: '/opt/mediamtx' if name == 'mediamtx' else None)
        with patch.dict(os.environ, {'QA_MEDIAMTX_PATH': ''}):
            service.ensure(self.credentials)
        args, kwargs = popen.call_args
        self.assertEqual(args[0], ['/opt/mediamtx', str(qa_media.CONFIG)])
        self.assertNotIn(self.credentials['publish'], ' '.join(args[0]))
        self.assertEqual(kwargs['env']['MTX_AUTHINTERNALUSERS_0_PASS'], self.credentials['publish'])
        self.assertEqual(kwargs['env']['MTX_AUTHINTERNALUSERS_1_PASS'], self.credentials['read'])

    def test_docker_fallback_keeps_secrets_off_the_command_line_and_loopback_only(self):
        service, popen, run = self.service([None, 200], which=lambda name: '/usr/bin/docker' if name == 'docker' else None)
        with patch.dict(os.environ, {'QA_MEDIAMTX_PATH': ''}):
            service.ensure(self.credentials)
        popen.assert_not_called()
        args, kwargs = run.call_args
        command = ' '.join(args[0])
        self.assertNotIn(self.credentials['publish'], command); self.assertNotIn(self.credentials['read'], command)
        self.assertIn('127.0.0.1:8554:8554', command); self.assertIn(qa_media.MEDIAMTX_IMAGE, command)
        self.assertEqual(kwargs['env']['MTX_AUTHINTERNALUSERS_1_PASS'], self.credentials['read'])

    def test_missing_program_explains_in_chinese(self):
        service, _, _ = self.service([None])
        with patch.dict(os.environ, {'QA_MEDIAMTX_PATH': ''}), self.assertRaisesRegex(ValueError, '还没有视频服务程序'):
            service.ensure(self.credentials)


class OneClickVideoControlTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.file = Path(directory.name) / 'c.json'
        self.runtime = Runtime(directory.name)
        self.runtime.session.platform = SimpleNamespace(base='http://localhost:8081/api/v1', call=Mock(return_value={}))
        self.runtime.video_config['publisher_password'] = ''
        self.runtime.media = Mock()

    def control(self, body):
        with patch.dict(os.environ, {'QA_VIDEO_CREDENTIALS_FILE': str(self.file)}), \
                patch('eo_video.shutil.which', return_value='/usr/bin/ffmpeg'):
            return self.runtime.video_control(body)

    def test_enable_without_password_starts_media_and_fills_publisher_account(self):
        result = self.control({'enabled': True})
        credentials = json.loads(self.file.read_text(encoding='utf-8'))
        self.runtime.media.ensure.assert_called_once_with(credentials)
        self.assertTrue(result['video_config']['enabled'] and result['video_config']['publisher_password_set'])
        self.assertEqual(self.runtime.video_config['publisher_user'], 'qa-publisher')
        self.assertEqual(self.runtime.video_config['publisher_password'], credentials['publish'])
        self.assertNotIn(credentials['publish'], json.dumps(result)); self.assertNotIn(credentials['read'], json.dumps(result))

    def test_invalid_credentials_keep_video_off_without_starting_media(self):
        original = b'[]'
        self.file.write_bytes(original)
        with self.assertRaisesRegex(ValueError, '格式无效'): self.control({'enabled': True})
        self.assertFalse(self.runtime.video_config['enabled'])
        self.runtime.media.ensure.assert_not_called()
        self.assertEqual(self.file.read_bytes(), original)

    def test_media_failure_keeps_video_off(self):
        self.runtime.video_config['enabled'] = False
        self.runtime.media.ensure.side_effect = ValueError('本机还没有视频服务程序（MediaMTX 或 Docker），需要先装一次')
        with self.assertRaisesRegex(ValueError, '视频服务程序'): self.control({'enabled': True})
        self.assertFalse(self.runtime.video_config['enabled'])

    def test_manual_password_skips_one_click_and_login_is_still_required(self):
        self.runtime.video_config['publisher_password'] = 'manual-secret-only'
        self.control({'enabled': True})
        self.runtime.media.ensure.assert_not_called()
        self.assertFalse(self.file.exists())
        self.runtime.video_config.update(enabled=False, publisher_password='')
        self.runtime.session.platform = None
        with self.assertRaises(ValueError): self.control({'enabled': True})
        self.runtime.media.ensure.assert_not_called()


if __name__ == '__main__': unittest.main()
