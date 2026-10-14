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

from engine import coordinates
from friendly_errors import explain, explain_exception
from state_file import atomic_json
from realtime_notification_receiver import Receiver, ReceiverError, InstanceLock, KINDS, MODES

ACTIVE = {'PREPARING', 'RUNNING', 'PAUSED', 'STOPPING'}
DEFAULT_CONFIG = {'mode': 'normal', 'notifications_enabled': True,
                  'countermeasure_enabled': True, 'countermeasure_scope': '',
                  'countermeasure_longitude': None, 'countermeasure_latitude': None,
                  'command_mode': 'success', 'play_seconds': 3, 'outcomes': {}}
# 旧设置文件里已经不用的字段，读入时直接丢弃：
# countermeasure_plan_id——反制设备曾借计划取单位与区县，现在直接选单位与区县；
# continuous——运行时长曾在这里另设一份“持续运行”，现在只看页面顶部的“运行时长”。
RETIRED_FIELDS = ('countermeasure_plan_id', 'continuous')


def validate_config(value):
    if isinstance(value, dict) and set(value) & set(RETIRED_FIELDS):
        value = {k: v for k, v in value.items() if k not in RETIRED_FIELDS}
    if not isinstance(value, dict) or set(value) - set(DEFAULT_CONFIG):
        raise ValueError('实时收发配置包含未知字段')
    config = {**copy.deepcopy(DEFAULT_CONFIG), **copy.deepcopy(value)}
    if config['mode'] not in ('normal', 'abnormal', 'mixed'):
        raise ValueError('请选择正常或异常模式')
    for key in ('notifications_enabled', 'countermeasure_enabled'):
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
    longitude, latitude = config['countermeasure_longitude'], config['countermeasure_latitude']
    if (longitude is None) != (latitude is None):
        raise ValueError('反制设备位置的经度和纬度要一起填')
    for value, low, high, label in ((longitude, -180, 180, '经度'), (latitude, -90, 90, '纬度')):
        if value is not None and (type(value) not in (float, int) or not math.isfinite(value) or not low <= value <= high):
            raise ValueError(f'反制设备{label}须在 {low} 到 {high} 之间')
    modes = config['outcomes']
    if not isinstance(modes, dict) or set(modes) - KINDS:
        raise ValueError('通知渠道无效')
    for kind, mode in modes.items():
        if not isinstance(mode, str) or mode not in MODES or (mode in ('no_answer', 'answered_only') and kind != 'ADVISORY_VOICE'):
            raise ValueError('通知结果配置无效')
        if mode in ('dispersed', 'not_dispersed') and kind != 'RISK_NOTICE':
            raise ValueError('风险处理结果不能用于其他通知')
    return config


def notification_outcomes(config, scene):
    """每一类通知这一轮的回执结果：全量场景选了“通知轮换”就一律轮换；
    否则异常、混合模式用设置里选的结果，正常模式一律正常回执（空表示都按正常）。"""
    if (scene or {}).get('fullchain', {}).get('notificationPolicy') == 'mixed':
        return {kind: 'mixed' for kind in KINDS}
    return copy.deepcopy(config['outcomes']) if config['mode'] in ('abnormal', 'mixed') else {}


def prepare_scene(raw, config):
    scene = copy.deepcopy(raw)
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


def countermeasure_position(config, scene):
    """Where the simulator's countermeasure device is registered, only so the map can draw its 作用范围:
    the position typed in 实时收发设置, else the first radar of the scene (a 融合感知箱 carries radar,
    EO and countermeasure together), else none."""
    if config.get('countermeasure_longitude') is not None and config.get('countermeasure_latitude') is not None:
        return {'longitude': config['countermeasure_longitude'], 'latitude': config['countermeasure_latitude']}
    for site in (scene or {}).get('sites') or []:
        if not isinstance(site, dict) or not any(isinstance(d, dict) and d.get('kind') == 'radar' for d in site.get('devices') or []):
            continue
        try:
            longitude, latitude = coordinates([float(site['x']), float(site['y'])])
        except (KeyError, TypeError, ValueError):
            continue
        return {'longitude': round(longitude, 7), 'latitude': round(latitude, 7)}
    return None


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
        self.client = None
        self.state = 'STOPPED'
        self.error = ''
        self.error_detail = ''
        self.session_verified_at = None
        self.notification_status = {}
        self.countermeasure_device_id = None
        self.countermeasure_position = None

    def active(self):
        return self.state in ('STARTING', 'RUNNING', 'STOPPING') or bool(self.thread and self.thread.is_alive())

    def can_change_mode(self):
        """收发端和场景都没在跑，才能改正常／异常配置。"""
        return not (self.active() or self.runtime.phase in ACTIVE)

    def configure(self, value):
        with self.operation_lock, self.runtime.lock, self.lock:
            if not self.can_change_mode():
                raise ValueError('请先停止全部收发，再修改正常／异常配置')
            config = validate_config(value)
            atomic_json(self.config_path, config)
            self.config = config
            return copy.deepcopy(config)

    def snapshot(self):
        # Do not acquire the runtime lock while holding this controller lock.
        with self.lock:
            result = {'state': self.state, 'error': self.error, 'error_detail': self.error_detail,
                      'config': copy.deepcopy(self.config),
                      'session_verified_at': self.session_verified_at,
                      'notifications': copy.deepcopy(self.notification_status),
                      'countermeasure': self.tcp.snapshot() if self.tcp else {'listening': False},
                      'countermeasure_device_id': self.countermeasure_device_id,
                      'countermeasure_position': copy.deepcopy(self.countermeasure_position),
                      'independent_presence_allowed': False}
        return result

    def start(self, scene=None):
        """scene: the scene about to run; without one the last scene decides the countermeasure position."""
        with self.operation_lock:
            return self._start(scene)

    def _scene_for(self, scene):
        return scene if scene is not None else getattr(self.runtime, 'scene', None)

    def _countermeasure_body(self, config, scene):
        """登记模拟反制设备时交给平台的内容：设备属于哪个单位与区县，以及（知道的话）它立在哪里。"""
        # 反制设备属于单位与区县，不跟飞行计划绑定；没选时跟随模拟器连接的单位与区县。
        if config['countermeasure_scope']:
            org, district = config['countermeasure_scope'].split('|', 1)
        else:
            # 本轮还没用过连接（刚登录、还没开始模拟）时，像空域页一样去平台上查设备数据连接。
            found = self.runtime.session.connection_scope()
            org, district = found.get('owner_org_id'), found.get('district_id')
            if not org or not district:
                lead = ('读取平台上的设备数据连接失败' if '读取失败' in (found.get('message') or '')
                        else '平台上还没有可用的本机回放设备数据连接')
                raise ValueError(lead + '，模拟器不知道模拟反制设备该放在哪个单位和区县。'
                                 '请在“收发模式设置”里选好“反制设备所属单位与区县”；'
                                 '下拉里没有可选项，说明平台还没建好演示连接，请找开发人员建好后再试（模拟器自己建不了）')
        if not org or not district:
            raise ValueError('请在“收发模式设置”里选好“反制设备所属单位与区县”')
        body = {'owner_org_id': org, 'district_id': district}
        # 平台上这台设备还没有位置时才用上；已有位置（比如在设备管理里填过）的不改。
        position = countermeasure_position(config, self._scene_for(scene))
        if position:
            body.update(position)
        return body

    def _refresh_for_scene(self, scene):
        """收发端在两次模拟之间一直开着，第二个场景开始时不会重新启动；
        这一次场景要用的两项设置（通知结果、反制设备位置）在这里重新定一遍，不再沿用上一个场景的。"""
        with self.lock:
            config = copy.deepcopy(self.config)
            receiver, tcp, client = self.receiver, self.tcp, self.client
            located = self.countermeasure_position is not None
        scene = self._scene_for(scene)
        if receiver is not None:
            # 接收端每一步都会重新读这个文件：此后收到的通知用这一次场景的结果，已收到的保持首次接收时的结果。
            atomic_json(self.root / 'realtime-outcomes.json', notification_outcomes(config, scene))
        if tcp is not None and client is not None and not located and countermeasure_position(config, scene):
            # 上一个场景里没有雷达可参照、平台上这台设备还没有位置：用这个场景的雷达位置补上。
            try:
                device = client.call('POST', '/local-interface-simulator/countermeasure-device',
                                     self._countermeasure_body(config, scene))
                detail = device.get('device', {}) if isinstance(device, dict) else {}
                if isinstance(detail, dict) and detail.get('longitude') is not None and detail.get('latitude') is not None:
                    with self.lock:
                        self.countermeasure_position = {'longitude': detail['longitude'], 'latitude': detail['latitude']}
            except (ReceiverError, ValueError) as error:
                # 补位置失败不影响本次模拟；地图上暂时画不出作用范围。
                if hasattr(self.runtime, 'log'):
                    self.runtime.log('REALTIME_REFRESH_FAILED', '补充反制设备位置失败：' + str(error))
        return self.snapshot()

    def _start(self, scene=None):
        with self.lock:
            if self.active():
                if self.state != 'RUNNING':
                    raise ValueError('收发服务正在启动或停止')
                refresh = True
            else:
                refresh = False
                self.state = 'STARTING'
                self.error = ''
                self.error_detail = ''
                self.receiver = None
                self.tcp = None
                self.client = None
                self.notification_status = {}
                self.countermeasure_device_id = None
                self.countermeasure_position = None
                self.thread = None
                config = copy.deepcopy(self.config)
                self.cancel.clear()
        if refresh:
            return self._refresh_for_scene(scene)
        try:
            if not self.runtime.platform:
                raise ValueError('请先登录系统')
            self.presence_lock = InstanceLock(Path(__file__).parent / '.data' / f'device-presence-{self.port}.lock')
            self.presence_lock.__enter__()
            client = BridgeClient(self.runtime.session)
            self.client = client
            client.call('GET', '/local-interface-simulator/session')
            self.session_verified_at = int(time.time() * 1000)
            if config['countermeasure_enabled']:
                device = client.call('POST', '/local-interface-simulator/countermeasure-device',
                                     self._countermeasure_body(config, scene))
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
                if isinstance(detail, dict) and detail.get('longitude') is not None and detail.get('latitude') is not None:
                    self.countermeasure_position = {'longitude': detail['longitude'], 'latitude': detail['latitude']}
            if config['notifications_enabled']:
                # Share the exact lock with the optional standalone receiver.
                self.receiver_lock = InstanceLock(Path(__file__).parent / '.data' / f'notification-receiver-{self.port}.lock')
                self.receiver_lock.__enter__()
                outcome_file = self.root / 'realtime-outcomes.json'
                atomic_json(outcome_file, notification_outcomes(config, self._scene_for(scene)))
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
            friendly, detail = explain_exception(error)
            with self.lock:
                self.state, self.error, self.error_detail = 'FAILED', friendly, detail
            # 往外抛原文：页面这一层统一翻成人话，并把原文放进“技术详情”。
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
                'last_error': explain(receiver.last_error)[0] if receiver.last_error else receiver.last_error,
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
                    client.call('GET', '/local-interface-simulator/session')
                    self.session_verified_at = int(time.time() * 1000)
                    last_check = time.monotonic()
                if self.tcp and not ok:
                    raise ValueError('平台连接不可用，设备指令接收已停止，请恢复后重新启动')
        except Exception as error:
            self.error, self.error_detail = explain_exception(error)
            with self.runtime.lock:
                self.runtime.error = '实时收发服务停止：' + self.error
                self.runtime.error_detail = self.error_detail
                if self.runtime.phase in ACTIVE:
                    self.runtime.phase = 'STOPPING'
                self.runtime.cancel.set()
                if hasattr(self.runtime, 'log'):
                    self.runtime.log('REALTIME_FAILURE', self.runtime.error)
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
