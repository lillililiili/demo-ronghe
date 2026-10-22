"""Measure generated-frame UTC from actual HLS PDT and a decoded frame barcode.

Never estimate from process start or download arrival. This reader cannot change
the media service and reads only the private loopback QA path with read credentials.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from eo_calibration import decoded_frame_number, FPS

UUID_PATTERN = r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None


class HlsCalibrationClock:
    def __init__(self, reader=None, clock=time.monotonic):
        self.reader, self.clock = reader or self._read_local, clock
        self.cache = {}
        self.cache_lock = threading.Lock()
        self.pending = {}
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix='eo-media-clock')
        self.last_decoded_frame = self.last_segment_epoch_ms = None

    @staticmethod
    def _read_local(path):
        match = re.fullmatch(r'qa/(' + UUID_PATTERN + r')/(.+)', path)
        if not match:
            raise ValueError('媒体时钟读取路径无效')
        resource = HlsCalibrationClock._resource(match[2])
        # MediaMTX bootstrap otherwise redirects to establish a browser cookie.
        # Keep redirects disabled; use its explicit read-only session protocol.
        if resource == 'index.m3u8': path += '?cookieCheck=1'
        from qa_media import credentials_file
        # Reading must not create or overwrite any credentials file.
        credentials = json.loads(Path(credentials_file()).read_text(encoding='utf-8-sig'))
        password = credentials.get('read')
        if not isinstance(password, str) or not re.fullmatch(r'[A-Za-z0-9_-]{24,128}', password):
            raise ValueError('媒体只读凭据无效')
        port = int(os.environ.get('QA_VIDEO_HLS_PORT', '8888'))
        if not 1 <= port <= 65535: raise ValueError('媒体端口无效')
        token = base64.b64encode(('qa-platform:' + password).encode()).decode()
        request = Request(f'http://127.0.0.1:{port}/' + path, headers={'Authorization': 'Basic ' + token})
        opener = build_opener(ProxyHandler({}), NoRedirect())
        with opener.open(request, timeout=1.5) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024: raise ValueError('媒体分片超过时钟校准读取限制')
        return data

    @staticmethod
    def _resource(name):
        if not re.fullmatch(r'[A-Za-z0-9_.-]{1,150}(?:\?session=' + UUID_PATTERN + r')?', name) or name.split('?', 1)[0] in ('.', '..'):
            raise ValueError('媒体播放列表资源路径无效')
        return name

    def anchor(self, stream_path, ffmpeg):
        """Nonblocking owner-thread API; media reads never delay tracking reports."""
        with self.cache_lock: previous = self.cache.get(stream_path)
        usable = previous is not None and self.clock() - previous['measured_at'] <= 30
        future = self.pending.get(stream_path)
        if future is not None:
            if not future.done(): return previous['origin'] if usable else None
            self.pending.pop(stream_path, None)
            return future.result()  # done already; propagates a sanitized read/decode error
        if usable and self.clock() < previous['next_check']: return previous['origin']
        # Bound concurrent reads/decoders and avoid accumulating a task per camera.
        if sum(not item.done() for item in self.pending.values()) < 2:
            self.pending[stream_path] = self.executor.submit(self.measure, stream_path, ffmpeg)
        return previous['origin'] if usable else None

    def measure(self, stream_path, ffmpeg):
        if not re.fullmatch(r'qa/[a-fA-F0-9-]{36}', stream_path): raise ValueError('媒体流路径无效')
        with self.cache_lock: previous = self.cache.get(stream_path)
        # Keep measuring regularly. If the media origin changes, never silently
        # stretch the viewer tolerance or reanimate a stale association.
        if previous and self.clock() < previous['next_check']: return previous['origin']
        playlist = self.reader(stream_path + '/index.m3u8').decode('utf-8-sig')
        if '#EXTINF:' not in playlist:
            variants = [line.strip() for line in playlist.splitlines() if line.strip() and not line.startswith('#')]
            if not variants: return None
            playlist = self.reader(stream_path + '/' + self._resource(variants[0])).decode('utf-8-sig')
        initialization, stamp, duration, segments = None, None, None, []
        for raw in playlist.splitlines():
            line = raw.strip()
            if line.startswith('#EXT-X-MAP:'):
                match = re.search(r'URI="([^"]+)"', line)
                if match: initialization = self._resource(match[1])
            elif line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
                stamp = dt.datetime.fromisoformat(line.split(':', 1)[1].replace('Z', '+00:00')).timestamp() * 1000
            elif line.startswith('#EXTINF:'):
                duration = float(line.split(':', 1)[1].split(',', 1)[0])
            elif line and not line.startswith('#') and duration is not None:
                if stamp is not None: segments.append((self._resource(line), stamp))
                if stamp is not None: stamp += duration * 1000
                duration = None
        if not segments: return None
        segment, segment_epoch = segments[-1]
        if previous and segment == previous['segment']:
            if self.clock() - previous['measured_at'] > 30: return None
            with self.cache_lock: previous['next_check'] = self.clock() + 2
            return previous['origin']
        content = (self.reader(stream_path + '/' + initialization) if initialization else b'') + self.reader(stream_path + '/' + segment)
        # A whole independent fragment starts at an IDR. Decode actual pixels;
        # HLS/container PTS may have been rebased, but our rendered n cannot be.
        result = subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', 'pipe:0',
            '-map', '0:v:0', '-frames:v', '1', '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'],
            input=content, capture_output=True, timeout=4, check=True,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        number = decoded_frame_number(result.stdout)
        origin = segment_epoch - number * 1000 / FPS
        self.last_decoded_frame, self.last_segment_epoch_ms = number, segment_epoch
        if previous and abs(previous['origin'] - origin) > 100:
            with self.cache_lock: self.cache.pop(stream_path, None)
            raise ValueError('媒体分片时钟关联发生变化，暂停识别框等待新锚点')
        with self.cache_lock:
            self.cache[stream_path] = {'origin': origin, 'segment': segment,
                'next_check': self.clock() + 5, 'measured_at': self.clock()}
            # Bound old per-session anchors, which never own any service or process.
            if len(self.cache) > 32: self.cache.pop(next(iter(self.cache)))
        return origin
