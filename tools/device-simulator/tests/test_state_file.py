"""Snapshots remain complete under transient or permanent Windows locks."""
import ctypes
from ctypes import wintypes
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from state_file import atomic_json, REPLACE_DELAYS


def locked(code):
    error = PermissionError('snapshot locked')
    error.winerror = code
    return error


class StateFileTests(unittest.TestCase):
    def test_transient_windows_errors_preserve_old_file_until_replaced(self):
        replace = os.replace
        for code in (5, 32, 33):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as root:
                path = Path(root) / ('状态-' + str(code) + '.json')
                atomic_json(path, {'generation': 'old'})
                attempts = []

                def replacing(source, dest):
                    attempts.append(Path(source))
                    self.assertEqual(json.loads(path.read_text(encoding='utf-8')), {'generation': 'old'})
                    if len(attempts) <= 2:
                        raise locked(code)
                    return replace(source, dest)

                with patch('state_file.os.replace', side_effect=replacing), patch('state_file.time.sleep') as sleep:
                    atomic_json(path, {'generation': 'new', 'name': '中文记录'})
                self.assertEqual(sleep.call_count, 2)
                self.assertEqual(json.loads(path.read_text(encoding='utf-8'))['generation'], 'new')
                self.assertEqual(list(Path(root).glob('*.tmp')), [])

    def test_permanent_lock_is_bounded_and_does_not_destroy_history(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'progress.json'
            atomic_json(path, {'sent': 123})
            previous = path.read_bytes()
            with patch('state_file.os.replace', side_effect=locked(5)) as replace, patch('state_file.time.sleep') as sleep:
                with self.assertRaises(PermissionError):
                    atomic_json(path, {'sent': 456})
            self.assertEqual(replace.call_count, len(REPLACE_DELAYS) + 1)
            self.assertEqual(sleep.call_count, len(REPLACE_DELAYS))
            self.assertEqual(path.read_bytes(), previous)
            self.assertEqual(list(Path(root).glob('*.tmp')), [])

    def test_other_io_errors_fail_without_retry(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'progress.json'
            atomic_json(path, {'sent': 12})
            with patch('state_file.os.replace', side_effect=OSError('disk failure')), patch('state_file.time.sleep') as sleep:
                with self.assertRaisesRegex(OSError, 'disk failure'):
                    atomic_json(path, {'sent': 23})
            sleep.assert_not_called()
            self.assertEqual(json.loads(path.read_text())['sent'], 12)

    def test_concurrent_writers_use_distinct_files_and_publish_complete_json(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'run.json'
            barrier = threading.Barrier(4)
            replace = os.replace
            sources = []
            seen_lock = threading.Lock()

            def replacing(source, dest):
                with seen_lock:
                    first_attempt = Path(source) not in sources
                    if first_attempt:
                        sources.append(Path(source))
                if first_attempt:
                    barrier.wait(timeout=5)
                return replace(source, dest)

            with patch('state_file.os.replace', side_effect=replacing), ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(lambda value: atomic_json(path, {'value': value, 'payload': str(value) * 1000}), range(4)))
            self.assertEqual(len(set(sources)), 4)
            saved = json.loads(path.read_text())
            self.assertEqual(saved['payload'], str(saved['value']) * 1000)
            self.assertEqual(list(Path(root).glob('*.tmp')), [])

    @unittest.skipUnless(os.name == 'nt', 'Windows sharing handle required')
    def test_actual_windows_reader_lock_released_during_retry(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                      wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / '真实占用.json'
            atomic_json(path, {'value': 'old'})
            handle = kernel.CreateFileW(str(path), 0x80000000, 3, None, 3, 128, None)
            self.assertNotEqual(handle, ctypes.c_void_p(-1).value)
            try:
                probe = Path(root) / 'probe.tmp'
                probe.write_text('{}')
                with self.assertRaises(OSError) as denied:
                    os.replace(probe, path)
                self.assertIn(denied.exception.winerror, (5, 32, 33))
                probe.unlink()
                released = threading.Timer(.12, kernel.CloseHandle, args=(handle,))
                released.start()
                try:
                    atomic_json(path, {'value': 'new'})
                finally:
                    released.join()
                    handle = None
                self.assertEqual(json.loads(path.read_text())['value'], 'new')
            finally:
                if handle is not None:
                    kernel.CloseHandle(handle)


if __name__ == '__main__':
    unittest.main()
