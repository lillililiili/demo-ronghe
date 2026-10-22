"""Protocol C command receiver and loopback-only QA video publisher."""
import copy
from functools import lru_cache
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlparse, quote, urlunparse
from eo_calibration import detection as calibration_detection, scene_filters as calibration_filters, FPS as CALIBRATION_FPS
from eo_media_clock import HlsCalibrationClock
from eo_recorded import recorded_clip

def default_video_config():
    """Enable local test video by default, with an explicit environment opt-out."""
    enabled = os.environ.get('QA_VIDEO_ENABLED', 'true').strip().lower() in ('1', 'true', 'yes', 'on')
    return {
        'enabled': enabled,
        'ffmpeg': 'ffmpeg',
        'source': '',
        'source_mode': 'recorded',
        'rtsp_base': os.environ.get('QA_VIDEO_RTSP_BASE', 'rtsp://127.0.0.1:8554'),
        'publisher_user': os.environ.get('QA_VIDEO_PUBLISH_USER', 'qa-publisher'),
        'publisher_password': os.environ.get('QA_VIDEO_PUBLISH_PASSWORD', ''),
    }


DEFAULT_VIDEO = default_video_config()
SAFE_ID = re.compile(r'[A-Za-z0-9_-]{1,128}')


def public_video_config(config):
    return {**{key: value for key, value in config.items() if key != 'publisher_password'},
            'publisher_password_set': bool(config.get('publisher_password'))}


def sanitize_video_error(error, config):
    text = str(error)
    password = config.get('publisher_password')
    if password:
        for secret in sorted({password, quote(password, safe='')}, key=len, reverse=True):
            text = text.replace(secret, '[redacted]')
    return re.sub(r'(rtsp://)[^\s/@]+@', r'\1[redacted]@', text)


class OwnedProcessJob:
    """Windows closes this non-inherited handle on simulator exit, killing only our encoder."""
    def __init__(self, process):
        self.handle = None
        if os.name != 'nt' or not hasattr(process, '_handle'): return
        import ctypes
        from ctypes import wintypes
        class Basic(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                ('flags', wintypes.DWORD), ('min_working_set', ctypes.c_size_t),
                ('max_working_set', ctypes.c_size_t), ('active_limit', wintypes.DWORD),
                ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
        class Io(ctypes.Structure):
            _fields_ = [(name, ctypes.c_ulonglong) for name in ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
        class Limits(ctypes.Structure):
            _fields_ = [('basic', Basic), ('io', Io), ('process_memory', ctypes.c_size_t),
                ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self.kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = self.kernel.CreateJobObjectW(None, None)
        if not handle: raise OSError('无法创建 FFmpeg 进程清理句柄')
        limits = Limits(); limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not self.kernel.AssignProcessToJobObject(handle, int(process._handle)):
            self.kernel.CloseHandle(handle)
            raise OSError('无法绑定 FFmpeg 退出清理，测试视频已停止')
        self.handle = handle

    def close(self):
        if self.handle:
            self.kernel.CloseHandle(self.handle); self.handle = None


def video_config(raw):
    value = {**DEFAULT_VIDEO, **(raw or {})}
    if not isinstance(value['enabled'], bool):
        raise ValueError('测试视频启用状态必须为布尔值')
    if value.get('source_mode') not in ('recorded', 'calibration', 'test_pattern'):
        raise ValueError('视频模板必须为 recorded、calibration 或 test_pattern')
    parsed = urlparse(value['rtsp_base'])
    if (parsed.scheme != 'rtsp' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ValueError('测试视频仅允许本机 RTSP 地址')
    try:
        if not parsed.port: raise ValueError()
    except ValueError:
        raise ValueError('RTSP 地址需要有效端口') from None
    value['rtsp_base'] = value['rtsp_base'].rstrip('/')
    for name in ('ffmpeg', 'source'):
        if not isinstance(value[name], str): raise ValueError('视频配置格式无效')
        value[name] = value[name].strip()
    for name in ('publisher_user', 'publisher_password'):
        if not isinstance(value[name], str) or len(value[name]) > 256 or any(ord(c) < 32 for c in value[name]):
            raise ValueError('媒体推流凭据格式无效')
    value['publisher_user'] = value['publisher_user'].strip()
    if value['enabled']:
        if not value['publisher_user'] or not value['publisher_password']:
            raise ValueError('开启测试视频必须填写媒体推流账号和密码')
        executable = shutil.which(value['ffmpeg'])
        if not executable and value['ffmpeg'] == 'ffmpeg' and os.name == 'nt':
            packages = Path(os.environ.get('LOCALAPPDATA', ''))/'Microsoft/WinGet/Packages'
            candidates = sorted(packages.glob('Gyan.FFmpeg_*/ffmpeg-*/bin/ffmpeg.exe'))
            if candidates: executable = str(candidates[-1])
        if not executable or Path(executable).suffix.lower() in ('.bat', '.cmd', '.ps1'):
            raise ValueError('找不到 FFmpeg 可执行程序，请填写本机 ffmpeg.exe 路径')
        value['ffmpeg'] = executable
        if value['source']:
            source = Path(value['source'])
            if not source.is_absolute() or value['source'].startswith(('\\\\', '//')) or not source.is_file():
                raise ValueError('视频源必须是本机已存在文件的绝对路径')
            value['source'] = str(source.resolve())
        elif value['source_mode'] == 'recorded':
            recorded_clip()  # Fail closed if footage no longer matches its labels.
    return value


@lru_cache(maxsize=8)
def filter_file_option(executable):
    """Use the advertised legacy option or FFmpeg's current file-argument syntax."""
    help_result = subprocess.run([executable, '-hide_banner', '-h', 'full'],
                                 capture_output=True, text=True, encoding='utf-8',
                                 errors='replace', check=True, timeout=10)
    return '-filter_script:v' if '-filter_script' in help_result.stdout else '-/filter:v'


def ffmpeg_arguments(config, path, watermark, kind='AI', frame_offset=0):
    if not re.fullmatch(r'qa/[0-9a-fA-F-]{36}', path):
        raise ValueError('系统返回的测试流路径无效')
    # textfile avoids filter/shell injection; the isolated process owns this temporary directory.
    args = [config['ffmpeg'], '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-stats_period', '1', '-progress', 'progress.txt', '-re']
    recorded = not config['source'] and config.get('source_mode') == 'recorded'
    clip = recorded_clip() if recorded else None
    if recorded:
        if frame_offset: args += ['-readrate_initial_burst', str(frame_offset / CALIBRATION_FPS)]
        args += ['-stream_loop', '-1', '-i', str(clip.path)]
    elif config['source']:
        args += ['-stream_loop', '-1', '-i', config['source']]
    elif config.get('source_mode', 'calibration') == 'test_pattern':
        args += ['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=15']
    else:
        args += ['-f', 'lavfi', '-i', 'color=c=0x12263a:size=960x540:rate=15']
    filters = clip.filters(kind, frame_offset) if recorded else 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2'
    if not config['source'] and config.get('source_mode', 'calibration') == 'calibration':
        filters += ',' + calibration_filters()
    font_option = ''
    if watermark:
        fonts = [Path(os.environ.get('WINDIR', 'C:/Windows'))/'Fonts/arial.ttf',
                 Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
                 Path('/System/Library/Fonts/Supplemental/Arial.ttf'), Path('/Library/Fonts/Arial.ttf')]
        font = next((file for file in fonts if file.is_file()), None)
        if font is None: raise ValueError('找不到测试视频水印字体 Arial 或 DejaVu Sans')
        shutil.copyfile(font, Path(watermark).parent/'font.ttf')
        font_option = 'fontfile=font.ttf:'
    filters += ',drawtext=' + font_option + ('textfile=watermark.txt:fontcolor=white:fontsize=13:x=350:y=516' if recorded
        else 'textfile=watermark.txt:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.8:x=16:y=16')
    # A per-frame annotation filter can exceed Windows' command-line limit.
    filter_args = ['-vf', filters]
    if recorded and watermark:
        (Path(watermark).parent / 'video-filter.txt').write_text(filters, encoding='utf-8')
        filter_args = [filter_file_option(config['ffmpeg']), 'video-filter.txt']
    base = urlparse(config['rtsp_base'])
    authority = quote(config['publisher_user'], safe='') + ':' + quote(config['publisher_password'], safe='') + '@' + base.netloc
    destination = urlunparse((base.scheme, authority, '/' + path, '', '', ''))
    args += ['-map', '0:v:0', '-an', *filter_args, '-c:v', 'libx264', '-preset', 'ultrafast',
             '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-r', '15', '-g', '15', '-keyint_min', '15',
             '-sc_threshold', '0', '-b:v', '900k', '-f', 'rtsp', '-rtsp_transport', 'tcp', destination]
    return args


class EoSimulator:
    def __init__(self, platform, manifest, config, publish, log, popen=subprocess.Popen, clock=time.time, is_running=lambda: True, observations=None, publish_final=None):
        self.platform, self.config, self.publish, self.log = platform, copy.deepcopy(config), publish, log
        # “光电跟踪已结束”的回执发在暂停和停止的时候，那时任务已不在运行中，不能走只在运行中才发的 publish。
        self.publish_final = publish_final or publish
        self.popen, self.clock = popen, clock
        self.is_running = is_running
        self.observations = observations
        self.bindings = {d['dispatcher_topic']: d for d in manifest['devices'].values() if d['kind'] == 'eo'}
        self.incoming = queue.Queue(maxsize=100)
        self.active, self.retired, self.states = {}, set(), {}
        self.accept_after = int(clock() * 1000)
        self.accepting = True
        self.unavailable = set()
        self.raw_video = {}
        self.media_clock = HlsCalibrationClock()
        self.recorded = recorded_clip() if not config['source'] and config.get('source_mode') == 'recorded' else None

    def enqueue(self, topic, payload, retained=False):
        if retained or topic not in self.bindings or len(payload) > 1_048_576: return
        try: self.incoming.put_nowait((topic, payload))
        except queue.Full: pass  # no invented protocol error; platform command times out

    def _ai_interval(self):
        config = getattr(self.observations, 'config', {})
        return config.get('intervalSeconds', 2) if config.get('enabled') is True else None

    def snapshot(self):
        return {'enabled': self.config['enabled'], 'devices': copy.deepcopy(list(self.states.values()))}

    def configure_video(self, config):
        """Called only by the MQTT owner thread; tracking survives video changes."""
        if config == self.config: return
        self._stop_raw_video()
        for active in self.active.values():
            self._kill(active)
            self._deregister(active)
            active['next_check'] = self.clock()
        self.config = copy.deepcopy(config)
        self.recorded = recorded_clip() if not config['source'] and config.get('source_mode') == 'recorded' else None
        for state in self.states.values():
            state.update(video='IDLE' if config['enabled'] else 'DISABLED', error='', exit_code=None)

    def _state(self, binding):
        return self.states.setdefault(binding['platform_id'], {'device_id': binding['platform_id'], 'camera_id': binding['external_id'],
            'device': binding['external_id'], 'ai_observation': 'UNAVAILABLE' if self._ai_interval() else 'DISABLED', 'task_id': None, 'tracking': 'IDLE', 'video': 'DISABLED' if not self.config['enabled'] else 'IDLE', 'error': ''})

    def _details(self, binding):
        return self.platform.call('GET', '/devices/' + binding['platform_id'] + '/protocol-status')['details']

    def receipt(self, binding, event, task=None, final=False):
        metadata = {'deviceId': binding['external_id'], 'codeStatus': 200,
                    'workState': 1 if binding['platform_id'] in self.active else 0, 'cameraStatus': {}}
        if task: metadata['taskId'] = task
        (self.publish_final if final else self.publish)(binding['reporting_topic'], {
            'event': event, 'edgeId': binding['edge_id'], 'timestamp': int(self.clock()*1000), 'metadata': metadata})

    def drain(self):
        while True:
            try: topic, raw = self.incoming.get_nowait()
            except queue.Empty: break
            if not self.accepting: continue
            try: self.handle(topic, raw)
            except (ValueError, KeyError, TypeError, UnicodeError) as error:
                self.log('EO_REJECTED', '光电指令未执行：' + sanitize_video_error(error, self.config)[:240])

    def handle(self, topic, raw):
        binding = self.bindings.get(topic)
        if not binding or not self.accepting or not self.is_running(): return
        if binding['platform_id'] in self.unavailable: return
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result: raise ValueError('重复报文字段')
                result[key] = value
            return result
        command = json.loads(raw, object_pairs_hook=unique)
        if not isinstance(command, dict): raise ValueError('光电指令必须为对象')
        metadata = command.get('metadata')
        if not isinstance(metadata, dict) or command.get('edgeId') != binding['edge_id'] or metadata.get('deviceId') != binding['external_id']:
            raise ValueError('设备或边端身份不匹配')
        stamp = command.get('timestamp')
        if type(stamp) is not int or not self.accept_after <= stamp <= int(self.clock()*1000)+5000:
            raise ValueError('指令时间已过期或无效')
        if int(self.clock()*1000)-stamp > 30000: raise ValueError('指令已过期')
        event, device = command.get('event'), binding['platform_id']
        if event not in ('BeginTracking', 'EndTracking', 'CameraStatus'): return
        if event == 'CameraStatus':
            self.receipt(binding, event); return
        task = metadata.get('taskId')
        if not isinstance(task, str) or not SAFE_ID.fullmatch(task): raise ValueError('任务编号无效')
        current = self.active.get(device)
        if event == 'EndTracking':
            if not current and task in self.retired and self._state(binding)['task_id'] == task:
                self.receipt(binding, event, task); return
            if not current:
                # After a simulator restart there is no local activity to stop.
                # Only acknowledge the exact stop the platform is awaiting; never
                # infer that an unrelated/newer task has ended from an idle heartbeat.
                facts = self._details(binding).get('open_task') or {}
                if facts.get('task_id') != task or facts.get('status') != 'ENDING':
                    raise ValueError('结束任务不是系统当前待停止任务')
                self.retired.add(task)
                self._state(binding).update(task_id=task, tracking='STOPPED')
                self.receipt(binding, event, task)
                return
            if not current or current['task'] != task: raise ValueError('结束任务与当前任务不匹配')
            self._stop(device, 'STOPPED')
            self.receipt(binding, event, task)
            return
        if task in self.retired: raise ValueError('已结束任务不能恢复')
        if current and current['task'] != task: raise ValueError('设备已有活动任务')
        facts = self._details(binding).get('open_task') or {}
        if facts.get('task_id') != task or facts.get('status') != 'OPEN': raise ValueError('系统当前任务不匹配')
        if not current:
            self.active[device] = {'task': task, 'binding': binding, 'process': None, 'directory': None,
                'stderr': None, 'job': None, 'stream_id': None, 'registered': False,
                'next_check': 0, 'next_report': self.clock()+5,
                'next_ai': self.clock() + (self._ai_interval() or 5),
                'echo': {key: copy.deepcopy(metadata[key]) for key in ('objectData', 'extention') if key in metadata}}
            self._state(binding).update(task_id=task, tracking='TRACKING', error='')
        self.receipt(binding, event, task)
        if not current: self._refresh(self.active[device])

    def _refresh(self, active):
        binding, task = active['binding'], active['task']
        state = self._state(binding)
        active['next_check'] = self.clock()+15
        try:
            if not self.config['enabled']:
                self._deregister(active)
                return
            # A replacement encoder has a new PTS origin. Preserve the old lease
            # during interruption, then retire it at restart so frame/session IDs
            # can never splice two independent media clocks.
            if active['process'] is None and active.get('stream_id') and active['registered']:
                self._deregister(active)
                if active['registered']: raise ValueError('旧视频登记尚未注销，等待下次重试')
                active['stream_id'] = None
            registration = self.platform.call('PUT', '/local-interface-simulator/video-streams/' + task,
                                              {'device_id': binding['platform_id']})
            active['registered'] = True
            if registration.get('task_id') != task or registration.get('device_id') != binding['platform_id']:
                raise ValueError('系统测试流关联不匹配')
            if not self.is_running(): raise ValueError('模拟任务已暂停或停止')
            if active['process'] is not None and registration['stream_id'] == active['stream_id']: return
            self._kill(active)
            directory = tempfile.TemporaryDirectory(prefix='eo-test-video-')
            active['directory'] = directory
            watermark = Path(directory.name)/'watermark.txt'
            scene = 'SIMULATED CALIBRATION' if not self.config['source'] and self.config.get('source_mode') == 'calibration' else 'SIMULATED SOURCE'
            watermark.write_text('TEST VIDEO - ' + scene + '\nDEVICE ' + binding['external_id'] + '\nTASK ' + task
                + '\nPTS %{pts} FRAME %{n}', encoding='utf-8')
            active['frame_offset'] = 0
            if self.recorded:
                watermark.write_text('TEST VIDEO - RECORDED REPLAY | AI | CC0', encoding='utf-8')
                raw = self.raw_video.get(binding['platform_id'])
                if raw and raw.get('process'):
                    self._output_stalled(raw)
                    if raw.get('progress_key'):
                        active['frame_offset'] = raw['progress_key'][0] % self.recorded.frame_count
            args = ffmpeg_arguments(self.config, registration['stream_path'], watermark, 'AI', active['frame_offset'])
            active['process'] = self.popen(args, cwd=directory.name, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            active['job'] = OwnedProcessJob(active['process'])
            active['stream_id'] = registration['stream_id']
            active['progress_key'] = None
            active['progress_at'] = self.clock()
            active['started_at'] = self.clock()
            active['last_frame_pts'] = None
            active['last_frame_number'] = None
            active['next_frame'] = self.clock()
            state.update(video='PUBLISHING', error='', exit_code=None)
        except Exception as error:
            self._kill(active)
            if not self.is_running(): self._deregister(active)
            state.update(video='FAILED', error=sanitize_video_error(error, self.config)[:240])
            # Preserve the active task's lease so the platform can report an interruption.
            # Retry only at the next 15-second check, after revalidating the same open task.

    def _output_stalled(self, active):
        # Process liveness is not output liveness: RTSP can hang across a broker restart.
        # FFmpeg owns this temporary file; read a bounded tail and never expose its URL.
        try:
            path = Path(active['directory'].name) / 'progress.txt'
            with path.open('rb') as stream:
                stream.seek(0, 2)
                stream.seek(max(0, stream.tell() - 4096))
                text = stream.read(4096).decode('ascii', errors='ignore')
            blocks = text.split('progress=')
            completed = blocks[-2] if len(blocks) > 1 else ''
            values = dict(line.split('=', 1) for line in completed.splitlines() if '=' in line)
            frame, position = values.get('frame', '').strip(), values.get('out_time_us', '').strip()
            if frame.isdigit() and position.isdigit() and int(frame) > 0:
                key = (int(frame), int(position))
                if active['progress_key'] is None or key > active['progress_key']:
                    active['progress_key'], active['progress_at'] = key, self.clock()
        except (OSError, AttributeError):
            pass  # No file / no complete progress is not proof of working output.
        return self.clock() - active['progress_at'] >= 30

    def tick(self):
        self.drain()
        self._tick_raw_video()
        for device, active in list(self.active.items()):
            process = active['process']
            if process is not None and process.poll() is not None:
                code = process.returncode
                self._kill(active)
                active['next_check'] = self.clock()+15
                self._state(active['binding']).update(video='FAILED', exit_code=code, error='FFmpeg 已退出；跟踪仍有效时15秒后重试视频')
            elif process is not None and self._output_stalled(active):
                self._kill(active)
                active['next_check'] = self.clock()+15
                self._state(active['binding']).update(video='FAILED', exit_code=None,
                    error='FFmpeg 输出已停滞；跟踪仍有效时15秒后重试视频')
            now = self.clock()
            refresh_due = now >= active['next_check']
            ai_interval = self._ai_interval()
            ai_due = ai_interval is not None and now >= active['next_ai']
            status_due = now >= active['next_report']
            if refresh_due or status_due or ai_due:
                try:
                    facts = self._details(active['binding']).get('open_task') or {}
                    if facts.get('task_id') != active['task'] or facts.get('status') != 'OPEN':
                        self._stop(device, 'STOPPED'); continue
                    self._tracking_report(active, facts, include_ai=ai_due or ai_interval is None)
                    if device not in self.active: continue
                    # Tracking liveness must not sit on the backend's 15-second
                    # freshness boundary or depend on video lease/retry timing.
                    if status_due or refresh_due: active['next_report'] = self.clock()+5
                    if ai_due: active['next_ai'] = self.clock()+ai_interval
                    if refresh_due: self._refresh(active)
                except Exception as error:
                    self._stop(device, 'FAILED')
                    self._state(active['binding'])['error'] = sanitize_video_error(error, self.config)[:240]
            if device in self.active:
                self._report_video_frame(active)

    def _tracking_report(self, active, facts, include_ai=True):
        if self.observations is None:
            self.receipt(active['binding'], 'BeginTracking', active['task'])
            return
        binding = active['binding']
        metadata = {'deviceId': binding['external_id'], 'taskId': active['task'],
                    'codeStatus': 200, 'workState': 1, 'cameraStatus': {}, **active.get('echo', {})}
        target_id = facts.get('target_id')
        ai_disabled = getattr(self.observations, 'config', {}).get('enabled') is not True if hasattr(self.observations, 'config') else False
        if ai_disabled: self._state(binding)['ai_observation'] = 'DISABLED'
        if target_id and include_ai and not ai_disabled:
            try:
                detail = self.platform.call('GET', '/targets/' + str(target_id))
                # Recheck after the target read: a switched/stopping task cannot emit an AI frame.
                latest = self._details(binding).get('open_task') or {}
                if latest.get('task_id') != active['task'] or latest.get('status') != 'OPEN' or latest.get('target_id') != target_id:
                    self._stop(binding['platform_id'], 'STOPPED')
                    return
                ai = self.observations.observation(detail, binding)
                self._state(binding)['ai_observation'] = 'ACTIVE' if ai is not None else 'UNAVAILABLE'
                if ai is not None: metadata['aiStatus'] = ai
            except Exception as error:
                self._state(binding)['ai_observation'] = 'UNAVAILABLE'
                self.log('EO_AI_UNAVAILABLE', '模拟光电观测未发送：' + sanitize_video_error(error, self.config)[:180])
        self.publish(binding['reporting_topic'], {'event':'BeginTracking', 'edgeId':binding['edge_id'],
                     'timestamp':int(self.clock()*1000), 'metadata':metadata})

    def _kill(self, active):
        process = active.get('process')
        if process is not None:
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=3)
            active['process'] = None
        if active.get('job'):
            active['job'].close(); active['job'] = None
        if active.get('stderr'):
            active['stderr'].close(); active['stderr'] = None
        if active.get('directory'):
            active['directory'].cleanup(); active['directory'] = None

    def _deregister(self, active):
        if active['registered']:
            try:
                self.platform.call('DELETE', '/local-interface-simulator/video-streams/' + active['task'])
                active['registered'] = False
            except Exception as error:
                self.log('VIDEO_CLEANUP', '测试流注销失败，等待服务端租约过期：' + sanitize_video_error(error, self.config)[:180])

    def _stop(self, device, video):
        active = self.active.pop(device)
        self.retired.add(active['task'])
        self._kill(active)
        self._deregister(active)
        self._state(active['binding']).update(tracking='STOPPED', video=video, ai_observation='STOPPED')

    def suspend(self):
        """暂停或停止：本地结束跟踪，并告诉平台“光电跟踪已结束”，平台上的任务才不会一直挂着。"""
        self.accepting = False
        self._stop_raw_video()
        for device in list(self.active):
            binding, task = self.active[device]['binding'], self.active[device]['task']
            self._stop(device, 'STOPPED')
            self._tell_platform_ended(binding, task)
        self.drain()

    def settle_leftovers(self):
        """开始发送前，把平台上这台模拟光电设备以前留下的“进行中/正在结束”任务回执为已结束。

        旧版本在暂停、停止时没有告诉平台，任务会一直挂着并占着这台设备（清单第 5 条）。这一步发生在本次开始发送之前，
        本次还没有产生任何任务，所以平台上此刻存在的都是以前留下的。"""
        for binding in self.bindings.values():
            try:
                facts = self._details(binding).get('open_task') or {}
            except Exception as error:
                self.log('EO_LEFTOVER', '读取光电设备上一次留下的任务失败：' + sanitize_video_error(error, self.config)[:160])
                continue
            task = facts.get('task_id')
            if not task or facts.get('status') not in ('OPEN', 'ENDING') or not SAFE_ID.fullmatch(str(task)):
                continue
            self.retired.add(task)
            self._state(binding).update(task_id=task, tracking='STOPPED')
            self.log('EO_LEFTOVER', '平台上有一条以前留下的光电跟踪任务，已回执为结束：' + str(task)[:8])
            self._tell_platform_ended(binding, task)

    def _tell_platform_ended(self, binding, task):
        try:
            self.receipt(binding, 'EndTracking', task, final=True)
        except Exception as error:
            # 发不出去也不能挡住暂停或停止；平台上的任务会继续挂着，如实写进运行记录。
            self.log('EO_END_RECEIPT', '光电跟踪结束回执没有发出去，平台上的任务可能仍显示进行中：'
                     + sanitize_video_error(error, self.config)[:180])

    def resume(self):
        self.accept_after = int(self.clock()*1000)
        self.accepting = True

    def availability(self, unavailable):
        self.unavailable = set(unavailable)
        for device in list(self.raw_video):
            if device in self.unavailable: self._stop_raw_video(device)
        for device in list(self.active):
            if device in self.unavailable: self._stop(device, 'STOPPED')

    def heartbeat(self, payload):
        external = payload['metadata']['deviceId']
        payload['metadata']['workState'] = int(any(a['binding']['external_id'] == external for a in self.active.values()))

    def _raw_endpoint(self, binding):
        return '/local-interface-simulator/device-video-streams/' + binding['platform_id']

    def _stop_raw_video(self, device=None):
        for identity in [device] if device is not None else list(self.raw_video):
            active = self.raw_video.pop(identity, None)
            if active is None: continue
            self._kill(active)
            if active.get('registered'):
                try: self.platform.call('DELETE', self._raw_endpoint(active['binding']))
                except Exception as error:
                    self.log('VIDEO_CLEANUP', '原始测试流注销失败，等待租约过期：' + sanitize_video_error(error, self.config)[:160])
            self._state(active['binding'])['raw_video'] = 'STOPPED'

    def _tick_raw_video(self):
        if not self.config['enabled'] or not self.accepting or not self.is_running():
            self._stop_raw_video()
            return
        for binding in self.bindings.values():
            device, now = binding['platform_id'], self.clock()
            if device in self.unavailable: continue
            active = self.raw_video.setdefault(device, {'binding': binding, 'process': None, 'next_check': 0,
                'registered': False, 'stream_id': None, 'job': None, 'directory': None})
            state = self._state(binding)
            process = active['process']
            if process is not None and (process.poll() is not None or self._output_stalled(active)):
                self._kill(active)
                active['next_check'] = now + 15
                state.update(raw_video='FAILED', raw_error='原始测试流中断，15秒后重试')
            if now < active['next_check']: continue
            active['next_check'] = now + 15
            try:
                if active['process'] is None and active.get('stream_id') and active['registered']:
                    self.platform.call('DELETE', self._raw_endpoint(binding))
                    active.update(registered=False, stream_id=None)
                registration = self.platform.call('PUT', self._raw_endpoint(binding), {})
                if registration.get('device_id') != device or registration.get('stream_kind') != 'RAW':
                    raise ValueError('原始测试流设备关联或类型不匹配')
                active['registered'] = True
                if not self.is_running() or not self.accepting: raise ValueError('模拟已暂停或停止')
                if process is not None and active['stream_id'] == registration['stream_id']: continue
                self._kill(active)
                directory = tempfile.TemporaryDirectory(prefix='eo-raw-video-')
                active['directory'] = directory
                watermark = Path(directory.name) / 'watermark.txt'
                watermark.write_text('TEST VIDEO - SIMULATED CALIBRATION' if not self.config['source'] and self.config.get('source_mode') == 'calibration'
                    else 'TEST VIDEO - SIMULATED SOURCE', encoding='utf-8')
                with watermark.open('a', encoding='utf-8') as output:
                    output.write('\nDEVICE ' + binding['external_id'] + '\nRAW CAMERA\nPTS %{pts} FRAME %{n}')
                if self.recorded:
                    watermark.write_text('TEST VIDEO - RECORDED REPLAY | RAW | CC0', encoding='utf-8')
                active['process'] = self.popen(ffmpeg_arguments(self.config, registration['stream_path'], watermark, 'RAW'),
                    cwd=directory.name, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                active['job'] = OwnedProcessJob(active['process'])
                active.update(stream_id=registration['stream_id'], progress_key=None, progress_at=now)
                state.update(raw_video='PUBLISHING', raw_error='')
            except Exception as error:
                self._kill(active)
                if not self.is_running() or not self.accepting:
                    self._stop_raw_video(device)
                state.update(raw_video='FAILED', raw_error=sanitize_video_error(error, self.config)[:240])

    def _report_video_frame(self, active):
        # Only the controlled renderer/verified recorded annotation owns its pixels.
        # Arbitrary operator files never inherit this fixture's detections.
        if (self.config['source'] or self.config.get('source_mode', 'calibration') not in ('calibration', 'recorded')
                or active.get('process') is None or self.clock() < active.get('next_frame', 0)):
            return
        active['next_frame'] = self.clock() + 1
        key = active.get('progress_key')
        if key is None or key[1] == active.get('last_frame_pts'): return
        if not 0 < key[0] <= 1 << 24:
            self._state(active['binding'])['video_metadata'] = 'UNAVAILABLE'
            return  # The calibration barcode must never wrap into an invented clock.
        binding = active['binding']
        try:
            # This read cannot schedule tracking. A stopped/switched task cannot
            # inherit the old pixels, observation id or media clock.
            facts = self._details(binding).get('open_task') or {}
            if facts.get('task_id') != active['task'] or facts.get('status') != 'OPEN' or not facts.get('target_id'): return
            origin = self.media_clock.anchor('qa/' + active['stream_id'], self.config['ffmpeg'])
            if origin is None:
                self._state(binding)['video_metadata'] = 'AWAITING_MEDIA_CLOCK'
                return
            # Progress out_time includes the last sample's duration. The barcode
            # uses zero-based n, so the last encoded sample is frame_count - 1.
            media_time = (key[0] - 1) * 1000 / CALIBRATION_FPS
            timestamp = int(origin + media_time)
            if not 0 <= self.clock() * 1000 - timestamp <= 5000: return
            association = None
            if self.observations is not None and facts.get('target_id'):
                detail = self.platform.call('GET', '/targets/' + str(facts['target_id']))
                sample = self.observations.observation(detail, binding)
                # The regular observation producer verifies this exact scene target's
                # replay source/device mapping. Readback then verifies persisted ID.
                if sample is not None and sample.get('className') == 'drone':
                    result = self.platform.call('GET', self._raw_endpoint(binding)
                        + '/observation-associations?task_id=' + quote(active['task'], safe=''))
                    matches = [item for item in result.get('items', [])
                        if item.get('target_id') == facts['target_id'] and item.get('class_code', '').lower() in ('drone', 'uav')
                        and isinstance(item.get('observation_id'), str)
                        and type(item.get('observed_at')) in (int, float)
                        and 0 <= self.clock() * 1000 - item['observed_at'] <= 5000]
                    association = max(matches, key=lambda item: item['observed_at']) if matches else None
            last = key[0] - 1
            # Send every actually encoded frame since the last report. A single
            # box per second cannot follow moving recorded pixels accurately.
            previous = active.get('last_frame_number')
            first = max(0, last - 29, previous + 1 if previous is not None else 0) if self.recorded else last
            for number in range(first, last + 1):
                media_time = number * 1000 / CALIBRATION_FPS
                timestamp = int(origin + media_time)
                if timestamp > self.clock() * 1000 or timestamp < self.clock() * 1000 - 5000: continue
                detection = (self.recorded.detection(active['stream_id'], number, association, active.get('frame_offset', 0))
                    if self.recorded else calibration_detection(active['stream_id'], association))
                payload = {'stream_id': active['stream_id'], 'task_id': active['task'],
                    'frame_timestamp': timestamp, 'media_time_ms': int(media_time),
                    'detections': [detection] if detection else []}
                self.platform.call('PUT', self._raw_endpoint(binding) + '/frames', payload)
                active['last_frame_number'] = number
            active['last_frame_pts'] = key[1]
            self._state(binding)['video_metadata'] = 'LINKED' if association else 'UNLINKED'
            self._state(binding)['video_metadata_error'] = ''
        except Exception as error:
            state = self._state(binding)
            message = sanitize_video_error(error, self.config)[:160]
            if message != state.get('video_metadata_error'):
                self.log('VIDEO_METADATA', '模拟视频帧信息未上报：' + message)
            state.update(video_metadata='UNAVAILABLE', video_metadata_error=message)
            active['next_frame'] = self.clock() + 5
