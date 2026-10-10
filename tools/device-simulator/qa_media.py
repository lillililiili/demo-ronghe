"""One-click local QA media service: credentials file plus a loopback-only MediaMTX.

The simulator and the backend's local,qa profile share one private credentials file
(default ~/.dongying-qa/qa-video-credentials.json, owner-only). The simulator publishes
with "publish"; the backend reads with "read". Passwords never enter logs or status.
"""
import atexit
import base64
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request

MEDIAMTX_IMAGE = 'bluenviron/mediamtx:1.21.1'
CONTAINER = 'dongying-qa-video'
CONFIG = Path(__file__).resolve().parent / 'media' / 'mediamtx-qa.yml'
SECRET = re.compile(r'[A-Za-z0-9_-]{24,128}')
STREAM_PATH = '~^qa/[a-f0-9-]{36}$'
RTSP_PORT, HLS_PORT, API_PORT = 8554, 8888, 9997


def credentials_file():
    configured = os.environ.get('QA_VIDEO_CREDENTIALS_FILE', '').strip()
    return Path(configured) if configured else Path.home() / '.dongying-qa' / 'qa-video-credentials.json'


def load_or_create_credentials(path=None):
    """Reuse existing credentials unchanged; create them only when the file is absent."""
    path = Path(path or credentials_file())
    try:
        value = json.loads(path.read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        pass
    except OSError:
        raise ValueError('本机视频凭据文件无法读取，请检查文件和访问权限；现有文件不会被覆盖') from None
    except ValueError:
        raise ValueError('本机视频凭据文件格式无效，请修复原文件；现有文件不会被覆盖') from None
    else:
        if (isinstance(value, dict) and all(isinstance(value.get(k), str) and SECRET.fullmatch(value[k]) for k in ('publish', 'read'))
                and value['publish'] != value['read']):
            return value
        raise ValueError('本机视频凭据文件格式无效，请修复原文件；现有文件不会被覆盖')
    value = {'publish': secrets.token_urlsafe(32), 'read': secrets.token_urlsafe(32)}
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(value, stream)
    os.replace(temporary, path)
    return value


def media_environment(credentials):
    return {
        'MTX_AUTHINTERNALUSERS_0_USER': 'qa-publisher',
        'MTX_AUTHINTERNALUSERS_0_PASS': credentials['publish'],
        'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_ACTION': 'publish',
        'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_PATH': STREAM_PATH,
        'MTX_AUTHINTERNALUSERS_1_USER': 'qa-platform',
        'MTX_AUTHINTERNALUSERS_1_PASS': credentials['read'],
        'MTX_AUTHINTERNALUSERS_1_PERMISSIONS_0_ACTION': 'read',
        'MTX_AUTHINTERNALUSERS_1_PERMISSIONS_0_PATH': STREAM_PATH,
        'MTX_AUTHINTERNALUSERS_1_PERMISSIONS_1_ACTION': 'api',
    }


def api_status(credentials, timeout=2):
    """HTTP status of the media API with the platform read account; None when nothing listens."""
    token = base64.b64encode(('qa-platform:' + credentials['read']).encode()).decode()
    request = urllib.request.Request(f'http://127.0.0.1:{API_PORT}/v3/paths/list', headers={'Authorization': 'Basic ' + token})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response: return response.status
    except urllib.error.HTTPError as error: return error.code
    except (OSError, ValueError): return None


def port_open(port):
    with socket.socket() as probe:
        probe.settimeout(.5)
        return probe.connect_ex(('127.0.0.1', port)) == 0


class MediaService:
    """Starts MediaMTX once per simulator process: a local binary first, then Docker."""
    def __init__(self, popen=subprocess.Popen, run=subprocess.run, which=shutil.which, status=api_status,
                 is_port_open=port_open, sleep=time.sleep, clock=time.monotonic):
        self.popen, self.run, self.which, self.status = popen, run, which, status
        self.is_port_open, self.sleep, self.clock = is_port_open, sleep, clock
        self.process = None

    def ensure(self, credentials):
        state = self.status(credentials)
        if state == 200: return
        if state in (401, 403):
            raise ValueError(f'本机视频服务拒绝读取账号（HTTP {state}），请检查媒体服务与本机凭据文件的账号、密码和 API 权限是否一致')
        if state is not None:
            raise ValueError(f'本机视频服务 API 响应异常（HTTP {state}），请检查现有媒体服务')
        if any(self.is_port_open(port) for port in (RTSP_PORT, HLS_PORT, API_PORT)):
            raise ValueError('本机 8554/8888/9997 端口已被占用，但视频服务 API 无法访问；请检查现有服务和端口配置')
        environment = {**os.environ, **media_environment(credentials)}
        binary = os.environ.get('QA_MEDIAMTX_PATH', '').strip() or self.which('mediamtx')
        if binary:
            self.process = self.popen([binary, str(CONFIG)], env=environment, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            atexit.register(self.stop)
        elif self.which('docker'):
            self._docker(environment)
        else:
            raise ValueError('本机还没有视频服务程序（MediaMTX 或 Docker），需要先装一次')
        deadline = self.clock() + 60
        while self.clock() < deadline:
            if self.process is not None and self.process.poll() is not None:
                self.process = None
                raise ValueError('视频服务程序启动后立即退出，请检查 8554/8888/9997 端口')
            if self.status(credentials) == 200: return
            self.sleep(.5)
        raise ValueError('视频服务启动超时，请稍后再点一次开启')

    def _docker(self, environment):
        self.run(['docker', 'rm', '-f', CONTAINER], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                 stderr=subprocess.DEVNULL, timeout=30, check=False)
        # Secrets are passed by name and read from this process's environment, never on the command line.
        args = ['docker', 'run', '-d', '--rm', '--name', CONTAINER,
                '-e', 'MTX_RTSPADDRESS=:8554', '-e', 'MTX_HLSADDRESS=:8888', '-e', 'MTX_APIADDRESS=:9997']
        for name in media_environment({'publish': '', 'read': ''}): args += ['-e', name]
        for port in (RTSP_PORT, HLS_PORT, API_PORT): args += ['-p', f'127.0.0.1:{port}:{port}']
        args += ['-v', f'{CONFIG}:/mediamtx.yml:ro', MEDIAMTX_IMAGE]
        try:
            result = self.run(args, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.PIPE, timeout=300, check=False)
        except subprocess.TimeoutExpired:
            raise ValueError('下载或启动视频服务超时，请稍后再点一次开启') from None
        if result.returncode != 0:
            raise ValueError('用 Docker 启动视频服务失败，请确认 Docker 已打开')

    def stop(self):
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            process.terminate()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill()
