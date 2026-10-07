"""Protocol C command receiver and explicitly enabled, loopback-only QA video publisher."""
import copy
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

def default_video_config():
    """Build opt-in defaults from the launch environment without persisting credentials."""
    enabled = os.environ.get('QA_VIDEO_ENABLED', '').strip().lower() in ('1', 'true', 'yes', 'on')
    return {
        'enabled': enabled,
        'ffmpeg': 'ffmpeg',
        'source': '',
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
    return value


def ffmpeg_arguments(config, path, watermark):
    if not re.fullmatch(r'qa/[0-9a-fA-F-]{36}', path):
        raise ValueError('系统返回的测试流路径无效')
    # textfile avoids filter/shell injection; the isolated process owns this temporary directory.
    args = [config['ffmpeg'], '-hide_banner', '-loglevel', 'error', '-nostdin', '-re']
    if config['source']:
        args += ['-stream_loop', '-1', '-i', config['source']]
    else:
        args += ['-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=15']
    filters = 'scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2'
    font_option = ''
    if watermark:
        fonts = [Path(os.environ.get('WINDIR', 'C:/Windows'))/'Fonts/arial.ttf',
                 Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
        font = next((file for file in fonts if file.is_file()), None)
        if font is None: raise ValueError('找不到测试视频水印字体 Arial 或 DejaVu Sans')
        shutil.copyfile(font, Path(watermark).parent/'font.ttf')
        font_option = 'fontfile=font.ttf:'
    filters += ',drawtext=' + font_option + 'textfile=watermark.txt:fontcolor=white:fontsize=22:box=1:boxcolor=black@0.8:x=16:y=16'
    base = urlparse(config['rtsp_base'])
    authority = quote(config['publisher_user'], safe='') + ':' + quote(config['publisher_password'], safe='') + '@' + base.netloc
    destination = urlunparse((base.scheme, authority, '/' + path, '', '', ''))
    args += ['-map', '0:v:0', '-an', '-vf', filters, '-c:v', 'libx264', '-preset', 'ultrafast',
             '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-r', '15', '-g', '15', '-keyint_min', '15',
             '-sc_threshold', '0', '-b:v', '900k', '-f', 'rtsp', '-rtsp_transport', 'tcp', destination]
    return args


class EoSimulator:
    def __init__(self, platform, manifest, config, publish, log, popen=subprocess.Popen, clock=time.time, is_running=lambda: True):
        self.platform, self.config, self.publish, self.log = platform, copy.deepcopy(config), publish, log
        self.popen, self.clock = popen, clock
        self.is_running = is_running
        self.bindings = {d['dispatcher_topic']: d for d in manifest['devices'].values() if d['kind'] == 'eo'}
        self.incoming = queue.Queue(maxsize=100)
        self.active, self.retired, self.states = {}, set(), {}
        self.accept_after = int(clock() * 1000)
        self.accepting = True
        self.unavailable = set()

    def enqueue(self, topic, payload, retained=False):
        if retained or topic not in self.bindings or len(payload) > 1_048_576: return
        try: self.incoming.put_nowait((topic, payload))
        except queue.Full: pass  # no invented protocol error; platform command times out

    def snapshot(self):
        return {'enabled': self.config['enabled'], 'devices': copy.deepcopy(list(self.states.values()))}

    def configure_video(self, config):
        """Called only by the MQTT owner thread; tracking survives video changes."""
        if config == self.config: return
        for active in self.active.values():
            self._kill(active)
            self._deregister(active)
            active['next_check'] = self.clock()
        self.config = copy.deepcopy(config)
        for state in self.states.values():
            state.update(video='IDLE' if config['enabled'] else 'DISABLED', error='', exit_code=None)

    def _state(self, binding):
        return self.states.setdefault(binding['platform_id'], {'device_id': binding['platform_id'],
            'device': binding['external_id'], 'task_id': None, 'tracking': 'IDLE', 'video': 'DISABLED' if not self.config['enabled'] else 'IDLE', 'error': ''})

    def _details(self, binding):
        return self.platform.call('GET', '/devices/' + binding['platform_id'] + '/protocol-status')['details']

    def receipt(self, binding, event, task=None):
        metadata = {'deviceId': binding['external_id'], 'codeStatus': 200,
                    'workState': 1 if binding['platform_id'] in self.active else 0, 'cameraStatus': {}}
        if task: metadata['taskId'] = task
        self.publish(binding['reporting_topic'], {'event': event, 'edgeId': binding['edge_id'],
                                                'timestamp': int(self.clock()*1000), 'metadata': metadata})

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
                'next_check': 0, 'next_report': self.clock()+5}
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
            watermark.write_text('TEST VIDEO\nDEVICE ' + binding['external_id'] + '\nTASK ' + task, encoding='utf-8')
            args = ffmpeg_arguments(self.config, registration['stream_path'], watermark)
            active['process'] = self.popen(args, cwd=directory.name, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            active['job'] = OwnedProcessJob(active['process'])
            active['stream_id'] = registration['stream_id']
            state.update(video='PUBLISHING', error='', exit_code=None)
        except Exception as error:
            self._kill(active)
            if not self.is_running(): self._deregister(active)
            state.update(video='FAILED', error=sanitize_video_error(error, self.config)[:240])
            # Preserve the active task's lease so the platform can report an interruption.
            # Retry only at the next 15-second check, after revalidating the same open task.

    def tick(self):
        self.drain()
        for device, active in list(self.active.items()):
            process = active['process']
            if process is not None and process.poll() is not None:
                code = process.returncode
                self._kill(active)
                active['next_check'] = self.clock()+15
                self._state(active['binding']).update(video='FAILED', exit_code=code, error='FFmpeg 已退出；跟踪仍有效时15秒后重试视频')
            now = self.clock()
            refresh_due = now >= active['next_check']
            if refresh_due or now >= active['next_report']:
                try:
                    facts = self._details(active['binding']).get('open_task') or {}
                    if facts.get('task_id') != active['task'] or facts.get('status') != 'OPEN':
                        self._stop(device, 'STOPPED'); continue
                    self.receipt(active['binding'], 'BeginTracking', active['task'])
                    # Tracking liveness must not sit on the backend's 15-second
                    # freshness boundary or depend on video lease/retry timing.
                    active['next_report'] = self.clock()+5
                    if refresh_due: self._refresh(active)
                except Exception as error:
                    self._stop(device, 'FAILED')
                    self._state(active['binding'])['error'] = sanitize_video_error(error, self.config)[:240]

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
        self._state(active['binding']).update(tracking='STOPPED', video=video)

    def suspend(self):
        self.accepting = False
        for device in list(self.active): self._stop(device, 'STOPPED')
        self.drain()

    def resume(self):
        self.accept_after = int(self.clock()*1000)
        self.accepting = True

    def availability(self, unavailable):
        self.unavailable = set(unavailable)
        for device in list(self.active):
            if device in self.unavailable: self._stop(device, 'STOPPED')

    def heartbeat(self, payload):
        external = payload['metadata']['deviceId']
        payload['metadata']['workState'] = int(any(a['binding']['external_id'] == external for a in self.active.values()))
