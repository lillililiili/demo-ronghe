import json
import os
from pathlib import Path
import sys
import tempfile
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

    def test_invalid_file_is_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'c.json'
            for content in ('not json', json.dumps({'publish': 'short', 'read': 'short'}),
                            json.dumps({'publish': 'a' * 32, 'read': 'a' * 32})):
                path.write_text(content, encoding='utf-8')
                created = qa_media.load_or_create_credentials(path)
                self.assertNotEqual(created['publish'], created['read'])


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

    def test_foreign_service_on_the_ports_is_not_replaced(self):
        for statuses, ports in (([401], False), ([None], True)):
            service, popen, run = self.service(statuses, ports)
            with self.assertRaisesRegex(ValueError, '端口已被其他视频服务占用'): service.ensure(self.credentials)
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

    def test_media_failure_keeps_video_off(self):
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
