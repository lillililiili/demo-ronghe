"""Explicit lifecycle for local simulated transports; never creates business outcomes."""
import copy
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import uuid

from realtime_notification_receiver import Receiver, ReceiverError, InstanceLock, KINDS, MODES

ACTIVE = {'PREPARING', 'RUNNING', 'PAUSED', 'STOPPING'}
DEFAULT_CONFIG = {'mode': 'normal', 'continuous': True, 'notifications_enabled': True,
                  'countermeasure_enabled': True, 'countermeasure_scope': '',
                  'command_mode': 'success', 'play_seconds': 3, 'outcomes': {}}


def validate_config(value):
    if isinstance(value, dict) and 'countermeasure_plan_id' in value:
        # 旧设置文件：反制设备曾借计划取单位与区县，现在直接选单位与区县，旧值丢弃。
        value = {k: v for k, v in value.items() if k != 'countermeasure_plan_id'}
    if not isinstance(value, dict) or set(value) - set(DEFAULT_CONFIG):
        raise ValueError('实时收发配置包含未知字段')
    config = {**copy.deepcopy(DEFAULT_CONFIG), **copy.deepcopy(value)}
    if config['mode'] not in ('normal', 'abnormal', 'mixed'):
        raise ValueError('请选择正常或异常模式')
    for key in ('continuous', 'notifications_enabled', 'countermeasure_enabled'):
        if type(config[key]) is not bool:
            raise ValueError('收发开关必须为布尔值')
    if config['command_mode'] not in ('success', 'no_receipt', 'unchanged'):
        raise ValueError('设备指令模式无效')
    seconds = config['play_seconds']
    if type(seconds) not in (float, int) or not math.isfinite(seconds) or not 0 < seconds <= 60:
        raise ValueError('电话播放时长须大于 0 且不超过 60 秒')
    scope = config['countermeasure_scope']
    if not isinstance(scope, str) or (scope and not re.fullmatch(r'[A-Za-z0-9_-]{1,64}\|[A-Za-z0-9_-]{1,64}', scope)):
        raise ValueError('反制设备所属单位与区县无效')
    modes = config['outcomes']
    if not isinstance(modes, dict) or set(modes) - KINDS:
        raise ValueError('通知渠道无效')
    for kind, mode in modes.items():
        if not isinstance(mode, str) or mode not in MODES or (mode in ('no_answer', 'answered_only') and kind != 'ADVISORY_VOICE'):
            raise ValueError('通知结果配置无效')
        if mode in ('dispersed', 'not_dispersed') and kind != 'RISK_NOTICE':
            raise ValueError('风险处理结果不能用于其他通知')
    return config


def prepare_scene(raw, config):
    scene = copy.deepcopy(raw)
    if config['continuous']:
        scene['duration'] = 0
    if config['mode'] == 'normal' and not scene.get('fullchain', {}).get('enabled'):
        for site in scene.get('sites', []):
            for device in site.get('devices', []):
                device.update(health='正常', heartbeat='持续上报')
        for risk in scene.get('risks', []):
            if risk.get('type') in ('offline', 'fault'):
                risk['enabled'] = False
        for target in scene.get('targets', []):
            if target.get('notificationBehavior') == 'drop_sms':
                target['notificationBehavior'] = 'none'
    return scene


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class BridgeClient:
    """Same in-memory session and allowlist as the HTTP proxy, pinned to its login."""
    def __init__(self, session):
        self.session = session
        self.version = session.version

    def call(self, method, path, body=None, key=None):
        if self.session.version != self.version:
            raise ReceiverError('登录身份已变化，请停止收发后重新启动', 401)
        command = {'method': method, 'path': path}
        if method == 'POST':
            command.update(body=body, key=key or uuid.uuid4().hex)
        try:
            return self.session.request(command)
        except ValueError as error:
            raise ReceiverError(str(error), 401 if self.session.platform is None else None) from None


class RealtimeController:
    def __init__(self, runtime, port=8766):
        self.runtime, self.port = runtime, port
        self.root = runtime.data_dir
        self.config_path = self.root / 'realtime-config.json'
        self.config = validate_config(json.loads(self.config_path.read_text(encoding='utf-8')) if self.config_path.exists() else {})
        self.lock = threading.RLock()
        self.operation_lock = threading.RLock()
        self.thread = None
        self.receiver = None
        self.tcp = None
        self.receiver_lock = None
        self.presence_lock = None
        self.cancel = threading.Event()
        self.state = 'STOPPED'
        self.error = ''
        self.session_verified_at = None
        self.notification_status = {}
        self.countermeasure_device_id = None

    def active(self):
        return self.state in ('STARTING', 'RUNNING', 'STOPPING') or bool(self.thread and self.thread.is_alive())

    def configure(self, value):
        with self.operation_lock, self.runtime.lock, self.lock:
            if self.active() or self.runtime.phase in ACTIVE:
                raise ValueError('请先停止全部收发，再修改正常／异常配置')
            config = validate_config(value)
            atomic_json(self.config_path, config)
            self.config = config
            return copy.deepcopy(config)

    def snapshot(self):
        # Do not acquire the runtime lock while holding this controller lock.
        with self.lock:
            result = {'state': self.state, 'error': self.error, 'config': copy.deepcopy(self.config),
                      'session_verified_at': self.session_verified_at,
                      'notifications': copy.deepcopy(self.notification_status),
                      'countermeasure': self.tcp.snapshot() if self.tcp else {'listening': False},
                      'countermeasure_device_id': self.countermeasure_device_id,
                      'independent_presence_allowed': False}
        return result

    def start(self):
        with self.operation_lock:
            return self._start()

    def _start(self):
        with self.lock:
            if self.active():
                if self.state == 'RUNNING':
                    return self.snapshot()
                raise ValueError('收发服务正在启动或停止')
            self.state = 'STARTING'
            self.error = ''
            self.receiver = None
            self.tcp = None
            self.notification_status = {}
            self.countermeasure_device_id = None
            self.thread = None
            config = copy.deepcopy(self.config)
            self.cancel.clear()
        try:
            if not self.runtime.platform:
                raise ValueError('请先登录系统')
            self.presence_lock = InstanceLock(Path(__file__).parent / '.data' / f'device-presence-{self.port}.lock')
            self.presence_lock.__enter__()
            client = BridgeClient(self.runtime.session)
            client.call('GET', '/local-interface-simulator/context')
            self.session_verified_at = int(time.time() * 1000)
            if config['countermeasure_enabled']:
                # 反制设备属于单位与区县，不跟飞行计划绑定；没选时跟随模拟器连接的单位与区县。
                if config['countermeasure_scope']:
                    org, district = config['countermeasure_scope'].split('|', 1)
                else:
                    # 本轮还没用过连接（刚登录、还没开始模拟）时，像空域页一样去平台上查设备数据连接。
                    scope = self.runtime.session.connection_scope()
                    org, district = scope.get('owner_org_id'), scope.get('district_id')
                    if not org or not district:
                        reason = ('读取设备数据连接失败' if '读取失败' in (scope.get('message') or '')
                                  else '还没有启用的设备数据连接 local-lingyun-replay')
                        raise ValueError(reason + '：请先在管理端“接口配置 → 设备数据连接”里建好并启用，'
                                         '或在实时收发设置中选择反制设备所属单位和区县')
                if not org or not district:
                    raise ValueError('请在实时收发设置中选择反制设备所属单位和区县')
                device = client.call('POST', '/local-interface-simulator/countermeasure-device',
                                     {'owner_org_id': org, 'district_id': district})
                detail = device.get('device', {}) if isinstance(device, dict) else {}
                connection = (detail.get('connection') or {}) if isinstance(detail, dict) else {}
                host = connection.get('host') or '127.0.0.1'
                port = connection.get('port') or 10006
                from countermeasure_tcp import CountermeasureSimulator, is_address_in_use
                transport = CountermeasureSimulator(
                    host=host,
                    port=int(port),
                    command_mode=config['command_mode'] if config['mode'] == 'abnormal' else 'success')
                try:
                    transport.start()
                except OSError as error:
                    if not is_address_in_use(error):
                        raise
                    # A reachable socket cannot attest its owner, fault mode,
                    # relay state or receipts. Never silently reuse it.
                    raise ValueError('四通道模拟端口已被占用，请停止占用进程后重试；'
                                     '升级后须重启后台与模拟器，四通道由模拟器统一接收') from None
                self.tcp = transport
                self.countermeasure_device_id = device['device']['device_id']
            if config['notifications_enabled']:
                # Share the exact lock with the optional standalone receiver.
                self.receiver_lock = InstanceLock(Path(__file__).parent / '.data' / f'notification-receiver-{self.port}.lock')
                self.receiver_lock.__enter__()
                outcome_file = self.root / 'realtime-outcomes.json'
                outcomes = config['outcomes'] if config['mode'] in ('abnormal','mixed') else {}
                if getattr(self.runtime,'scene',{}).get('fullchain',{}).get('notificationPolicy') == 'mixed':
                    outcomes = {kind:'mixed' for kind in KINDS}
                atomic_json(outcome_file, outcomes)
                self.receiver = Receiver(client, self.root / 'realtime-notifications', config['play_seconds'], outcome_file)
                if not self.receiver.step():
                    raise ValueError(self.receiver.last_error)
                self.update_receiver_status()
            with self.lock:
                self.state = 'RUNNING'
                self.thread = threading.Thread(target=self.run, args=(client,), name='realtime-receiver', daemon=True)
                self.thread.start()
            return self.snapshot()
        except Exception as error:
            self.cleanup()
            with self.lock:
                self.state, self.error = 'FAILED', str(error)
            raise ValueError(str(error)) from None

    def update_receiver_status(self):
        receiver = self.receiver
        if receiver is None:
            return
        records = list(receiver.state['messages'].values())
        times = [r['received_at'] for r in records]
        with self.lock:
            self.notification_status = {'received_count': len(records),
                'last_received_at': int(max(times) * 1000) if times else None,
                'lease_expires_at': int((receiver.last_heartbeat + 30) * 1000) if receiver.leased and receiver.last_heartbeat else None,
                'last_error': receiver.last_error,
                'receipt_count': sum(r['current']['state'] != 'SUBMITTED' for r in records)}

    def run(self, client):
        last_check = time.monotonic()
        backoff = .5
        try:
            while not self.cancel.wait(backoff):
                if self.receiver:
                    ok = self.receiver.step()
                    self.update_receiver_status()
                    if self.cancel.is_set():
                        break
                    backoff = .5 if ok else min(max(1, backoff * 2), 30)
                    if not ok and self.runtime.platform is None:
                        raise ValueError('系统登录失效，全部收发已停止')
                else:
                    ok = True
                if time.monotonic() - last_check >= 5:
                    client.call('GET', '/local-interface-simulator/context')
                    self.session_verified_at = int(time.time() * 1000)
                    last_check = time.monotonic()
                if self.tcp and not ok:
                    raise ValueError('平台连接不可用，设备指令接收已停止，请恢复后重新启动')
        except Exception as error:
            self.error = str(error)
            self.runtime.cancel.set()
        finally:
            self.cleanup()
            with self.lock:
                self.state = 'FAILED' if self.error else 'STOPPED'

    def cleanup(self):
        if self.tcp:
            self.tcp.stop()
        if self.receiver:
            self.receiver.close()
            self.update_receiver_status()
        if self.receiver_lock:
            self.receiver_lock.__exit__()
            self.receiver_lock = None
        if self.presence_lock:
            self.presence_lock.__exit__()
            self.presence_lock = None

    def stop(self):
        with self.operation_lock:
            return self._stop()

    def _stop(self):
        with self.lock:
            self.cancel.set()
            if self.receiver:
                self.receiver.stop_event.set()
            if self.active():
                self.state = 'STOPPING'
            thread = self.thread
        if self.tcp:
            self.tcp.stop()
        if thread and thread is not threading.current_thread():
            thread.join(timeout=16)
        elif not thread:
            self.cleanup()
            self.state = 'STOPPED'
        return self.snapshot()
