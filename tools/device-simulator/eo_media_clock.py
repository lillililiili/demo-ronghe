"""Measure generated-frame UTC from actual HLS PDT and a decoded frame barcode.

Never estimate from process start or download arrival. This reader cannot change
the media service and reads only the private loopback QA path with read credentials.
"""
import base64
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import json
import math
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

    def segment(self, stream_path, ffmpeg):
        """Return only actual decoded HLS segment frames; never extrapolate progress."""
        with self.cache_lock: previous = self.cache.get(stream_path)
        usable = previous is not None and self.clock()-previous['measured_at'] <= 10
        future = self.pending.get(stream_path)
        if future is not None:
            if not future.done(): return previous if usable else None
            self.pending.pop(stream_path, None)
            return future.result()
        if usable and self.clock() < previous['next_check']: return previous
        if sum(not item.done() for item in self.pending.values()) < 2:
            self.pending[stream_path] = self.executor.submit(self.measure_segment, stream_path, ffmpeg)
        return previous if usable else None

    def anchor(self, stream_path, ffmpeg):
        # Compatibility view for existing clock diagnostics. Producers must use
        # segment.frames: this origin has no validity outside the proved segment.
        measured = self.segment(stream_path, ffmpeg)
        return measured.get('origin') if measured else None

    def measure(self, stream_path, ffmpeg):
        measured = self.measure_segment(stream_path, ffmpeg)
        return measured.get('origin') if measured else None

    def measure_segment(self, stream_path, ffmpeg):
        if not re.fullmatch(r'qa/[a-fA-F0-9-]{36}', stream_path):
            raise ValueError('媒体流路径无效')
        with self.cache_lock: previous = self.cache.get(stream_path)
        playlist = self.reader(stream_path+'/index.m3u8').decode('utf-8-sig')
        if '#EXTINF:' not in playlist:
            variants=[line.strip() for line in playlist.splitlines() if line.strip() and not line.startswith('#')]
            if not variants: return None
            playlist=self.reader(stream_path+'/'+self._resource(variants[0])).decode('utf-8-sig')
        initialization, stamp, duration, candidates = None, None, None, []
        for raw in playlist.splitlines():
            line=raw.strip()
            if line.startswith('#EXT-X-MAP:'):
                match=re.search(r'URI="([^"]+)"',line)
                if match: initialization=self._resource(match[1])
            elif line=='#EXT-X-DISCONTINUITY':
                stamp=None
            elif line.startswith('#EXT-X-PROGRAM-DATE-TIME:'):
                stamp=dt.datetime.fromisoformat(line.split(':',1)[1].replace('Z','+00:00')).timestamp()*1000
            elif line.startswith('#EXTINF:'):
                duration=float(line.split(':',1)[1].split(',',1)[0])
            elif line and not line.startswith('#') and duration is not None:
                if stamp is not None:
                    count=round(duration*FPS)
                    if 1 <= count <= 30 and abs(duration*FPS-count)<.01:
                        candidates.append((self._resource(line),stamp,duration,count))
                    stamp+=duration*1000
                duration=None
        selected=[];total=0
        for candidate in reversed(candidates):
            if total+candidate[3]>30: break
            selected.append(candidate);total+=candidate[3]
        selected.reverse()
        if not selected: return None
        old={item['segment_id']:item for item in (previous or {}).get('segments',[])}
        decoded=[];rejected=[]
        init_content=None
        for resource,epoch,duration,count in selected:
            name=resource.split('?',1)[0]
            cached=old.get(name)
            if cached is not None and cached['program_date_time_ms']==epoch:
                decoded.append(cached)
                continue
            try:
                if init_content is None:
                    init_content=self.reader(stream_path+'/'+initialization) if initialization else b''
                content=init_content+self.reader(stream_path+'/'+resource)
                probe=str(Path(ffmpeg).with_name('ffprobe.exe' if os.name=='nt' else 'ffprobe'))
                times=subprocess.run([probe,'-v','error','-i','pipe:0','-select_streams','v',
                    '-show_entries','frame=best_effort_timestamp_time','-of','json'],input=content,
                    capture_output=True,timeout=4,check=True,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                pts=[float(frame['best_effort_timestamp_time']) for frame in json.loads(times.stdout)['frames']]
                if (len(pts)!=count or not all(math.isfinite(value) for value in pts)
                        or any(abs((b-a)-1/FPS)>.001 for a,b in zip(pts,pts[1:]))):
                    raise ValueError('SEGMENT_TIMESTAMPS_NOT_CONTROLLED_15FPS')
                # Decode the entire complete fragment, capped at 31 frames so an
                # unexpected oversized segment cannot allocate unbounded pixels.
                result=subprocess.run([ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-i','pipe:0',
                    '-map','0:v:0','-frames:v','31','-an','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],
                    input=content,capture_output=True,timeout=4,check=True,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                size=960*540*3
                if len(result.stdout)!=count*size: raise ValueError('SEGMENT_FRAME_COUNT_MISMATCH')
                numbers=[decoded_frame_number(result.stdout[i*size:(i+1)*size]) for i in range(count)]
                if numbers!=list(range(numbers[0],numbers[0]+count)):
                    raise ValueError('SEGMENT_BARCODE_DISCONTINUITY')
                frames=[{'number':number,'frame_timestamp':int(epoch+(pts[i]-pts[0])*1000),
                         'media_time_ms':int(number*1000/FPS),'segment_id':name}
                        for i,number in enumerate(numbers)]
                decoded.append({'segment_id':name,'program_date_time_ms':epoch,'duration_seconds':duration,
                    'first_frame':numbers[0],'last_frame':numbers[-1],'packet_pts_ms':[round(value*1000,3) for value in pts],'frames':frames})
            except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
                rejected.append({'segment_id':name,'reason':'SEGMENT_NOT_PROVED'})
        frames=[frame for item in decoded for frame in item['frames']]
        latest=decoded[-1] if decoded else None
        measured={'segments':decoded,'frames':frames,'rejected_segments':rejected,
                  'origin':latest['program_date_time_ms']-latest['first_frame']*1000/FPS if latest else None,
                  'measured_at':self.clock(),'next_check':self.clock()+.25}
        if latest:
            self.last_decoded_frame=latest['first_frame']
            self.last_segment_epoch_ms=latest['program_date_time_ms']
        with self.cache_lock:
            self.cache[stream_path]=measured
            if len(self.cache)>32:self.cache.pop(next(iter(self.cache)))
        return measured
