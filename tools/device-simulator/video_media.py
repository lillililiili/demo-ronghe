"""Private local MediaMTX bootstrap for the simulator's one-click test video."""
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
from urllib.parse import urlparse


_SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'


def credentials_path():
    return Path(os.environ.get('QA_VIDEO_CREDENTIALS_FILE',
                               str(Path.home() / '.dongying-qa' / 'qa-video-credentials.json'))).expanduser()


def _valid_secret(value):
    return isinstance(value, str) and 24 <= len(value) <= 128 and all(char in _SECRET_ALPHABET for char in value)


def _environment_credentials():
    publish, read = os.environ.get('QA_VIDEO_PUBLISH_PASSWORD', ''), os.environ.get('QA_VIDEO_READ_PASSWORD', '')
    if _valid_secret(publish) and _valid_secret(read) and publish != read:
        return {'publish': publish, 'read': read}
    return None


def load_or_create_credentials(path=None):
    """Read the private credentials file, or create it once when absent."""
    path = Path(path or credentials_path()).expanduser()
    from_environment = _environment_credentials()
    if from_environment:
        return from_environment
    if path.exists():
        try:
            value = json.loads(path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError) as error:
            raise ValueError('本机视频凭据文件无法读取，请修复或移走该文件后重试') from error
        if _valid_secret(value.get('publish')) and _valid_secret(value.get('read')) and value['publish'] != value['read']:
            return {'publish': value['publish'], 'read': value['read']}
        raise ValueError('本机视频凭据文件格式无效，请修复或移走该文件后重试')
    value = {'publish': secrets.token_urlsafe(32), 'read': secrets.token_urlsafe(32)}
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix='.qa-video-', suffix='.json', dir=str(path.parent), text=True)
        os.chmod(temporary, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except OSError as error:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass
        raise ValueError('无法保存本机视频凭据，请检查用户目录权限') from error
    return value


def _port_is_open(host, port):
    try:
        with socket.create_connection((host, port), timeout=.2):
            return True
    except OSError:
        return False


def _port_from_rtsp(rtsp_base):
    parsed = urlparse(rtsp_base)
    if parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or not parsed.port:
        raise ValueError('RTSP 地址需要有效的本机端口')
    return parsed.port


class LocalMediaService:
    """Starts only a simulator-owned local MediaMTX process/container."""
    def __init__(self, popen=subprocess.Popen, runner=subprocess.run, clock=time.monotonic):
        self.popen = popen
        self.runner = runner
        self.clock = clock
        self.process = None
        self.container_id = None
        self.container_name = None

    @property
    def owned(self):
        return self.process is not None or self.container_id is not None

    def _wait_ready(self, host, ports, timeout=12):
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            if all(_port_is_open(host, port) for port in ports):
                return
            time.sleep(.2)
        raise ValueError('本机视频服务启动超时，请检查 MediaMTX 或 Docker')

    @staticmethod
    def _media_environment(publish_user, credentials, rtsp_port, hls_port, api_port):
        return {
            'MTX_RTSPADDRESS': f'127.0.0.1:{rtsp_port}',
            'MTX_HLSADDRESS': f'127.0.0.1:{hls_port}',
            'MTX_APIADDRESS': f'127.0.0.1:{api_port}',
            'MTX_AUTHINTERNALUSERS_0_USER': publish_user,
            'MTX_AUTHINTERNALUSERS_0_PASS': credentials['publish'],
            'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_ACTION': 'publish',
            'MTX_AUTHINTERNALUSERS_0_PERMISSIONS_0_PATH': '~^qa/[a-f0-9-]{36}$',
            'MTX_AUTHINTERNALUSERS_1_USER': 'qa-platform',
            'MTX_AUTHINTERNALUSERS_1_PASS': credentials['read'],
            'MTX_AUTHINTERNALUSERS_1_PERMISSIONS_0_ACTION': 'read',
            'MTX_AUTHINTERNALUSERS_1_PERMISSIONS_0_PATH': '~^qa/[a-f0-9-]{36}$',
            'MTX_AUTHINTERNALUSERS_1_PERMISSIONS_1_ACTION': 'api',
        }

    def ensure(self, rtsp_base, publish_user='qa-publisher'):
        """Return the publisher password, starting a private media service if needed."""
        credentials = load_or_create_credentials()
        rtsp_port = _port_from_rtsp(rtsp_base)
        hls_port = int(os.environ.get('QA_VIDEO_HLS_PORT', '8888'))
        api_port = int(os.environ.get('QA_VIDEO_API_PORT', '9997'))
        if self.owned or all(_port_is_open('127.0.0.1', port) for port in (rtsp_port, hls_port, api_port)):
            return credentials['publish']
        environment = os.environ.copy()
        environment.update(self._media_environment(publish_user, credentials, rtsp_port, hls_port, api_port))
        binary = os.environ.get('QA_MEDIAMTX_PATH') or shutil.which('mediamtx')
        if binary:
            self.process = self.popen([binary], env=environment, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        else:
            docker = shutil.which('docker')
            if not docker:
                raise ValueError('未找到 MediaMTX 或 Docker，无法自动开启视频推流')
            self.container_name = 'qa-video-simulator-' + uuid.uuid4().hex[:12]
            command = [docker, 'run', '--rm', '--name', self.container_name, '-d']
            docker_environment = dict(environment)
            docker_environment.update({'MTX_RTSPADDRESS': ':8554', 'MTX_HLSADDRESS': ':8888', 'MTX_APIADDRESS': ':9997'})
            for key, value in docker_environment.items():
                if key.startswith('MTX_'):
                    command.extend(('-e', f'{key}={value}'))
            command.extend(('-p', f'127.0.0.1:{rtsp_port}:8554', '-p', f'127.0.0.1:{hls_port}:8888',
                            '-p', f'127.0.0.1:{api_port}:9997', 'bluenviron/mediamtx:1.21.1'))
            try:
                result = self.runner(command, check=True, capture_output=True, text=True)
            except (OSError, subprocess.CalledProcessError) as error:
                self.container_name = None
                raise ValueError('Docker 启动本机视频服务失败，请检查 Docker 是否运行') from error
            self.container_id = result.stdout.strip()
        try:
            self._wait_ready('127.0.0.1', (rtsp_port, hls_port, api_port))
        except ValueError:
            self.close()
            raise
        return credentials['publish']

    def close(self):
        process, container_id, container_name = self.process, self.container_id, self.container_name
        self.process = self.container_id = self.container_name = None
        if process is not None:
            try:
                process.terminate()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    process.kill()
                except OSError:
                    pass
        if container_id or container_name:
            docker = shutil.which('docker')
            if docker:
                self.runner([docker, 'rm', '-f', container_id or container_name],
                            check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
