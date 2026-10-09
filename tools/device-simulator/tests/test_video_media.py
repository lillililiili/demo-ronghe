import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from video_media import load_or_create_credentials


class VideoCredentialTests(unittest.TestCase):
    def test_missing_file_is_created_with_two_distinct_private_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'qa-video-credentials.json'
            with patch.dict('os.environ', {}, clear=True):
                with patch('video_media.credentials_path', return_value=path):
                    credentials = load_or_create_credentials()
            self.assertNotEqual(credentials['publish'], credentials['read'])
            self.assertGreaterEqual(len(credentials['publish']), 24)
            self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['read'], credentials['read'])
            if os.name != 'nt' and hasattr(stat, 'S_IRWXG'):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)

    def test_existing_file_is_reused_without_replacing_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'qa-video-credentials.json'
            old = {'publish': 'p' * 32, 'read': 'r' * 32}
            path.write_text(json.dumps(old), encoding='utf-8')
            with patch('video_media.credentials_path', return_value=path):
                self.assertEqual(load_or_create_credentials(), old)
                self.assertEqual(json.loads(path.read_text(encoding='utf-8')), old)


if __name__ == '__main__':
    unittest.main()
