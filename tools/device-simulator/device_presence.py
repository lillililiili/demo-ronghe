#!/usr/bin/env python3
"""Keep existing replay devices present while the scenario runner is stopped."""
import argparse
import copy
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import signal
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.request import Request

from engine import messages, number, point_list
from realtime_notification_receiver import InstanceLock, ProxyClient, ReceiverError

ROOT = Path(__file__).resolve().parent
LOG = logging.getLogger('device-presence')
IDLE_PHASES = {'STOPPED', 'IDLE', 'COMPLETED'}


class SimulatorApi(ProxyClient):
    def local(self, path, body=None):
        request = Request(self.base + path, method='GET' if body is None else 'POST',
                          data=None if body is None else json.dumps(body).encode(),
                          headers={'Content-Type': 'application/json'})
        try:
            with self.http.open(request, timeout=self.timeout) as response:
                value = json.load(response)
        except HTTPError as error:
            status = error.code
            error.close()
            raise ReceiverError(f'本机模拟器返回 HTTP {status}；检查登录和服务状态', status) from None
        except (URLError, OSError, ValueError):
            raise ReceiverError('本机模拟器状态不可读取') from None
        if not isinstance(value, dict) or (path != '/api/status' and value.get('error')):
            raise ReceiverError('本机模拟器接口返回无效结果')
        return value

    def status(self):
        return self.local('/api/status')

    def broker(self):
        return self.local('/api/connect', {})

    def verify_session(self):
        self.call('GET', '/local-interface-simulator/context')


class MqttPublisher:
    def __init__(self, broker):
        if (broker.get('host') not in ('localhost', '127.0.0.1')
                or broker.get('name') != 'local-lingyun-replay'
                or type(broker.get('port')) is not int or not 1 <= broker['port'] <= 65535):
            raise ReceiverError('保活只允许现有本机 local-lingyun-replay MQTT 连接')
        if any(broker.get(key) for key in ('tls', 'username', 'password', 'auth_required')):
            raise ReceiverError('当前代理未提供可用 MQTT 证书或认证会话，停止保活；不猜测凭据')
        try:
            import paho.mqtt.client as mqtt
        except ImportError:
            raise ReceiverError('缺少现有 paho-mqtt 运行依赖，无法启动设备保活') from None
        self.connected = False
        ready = threading.Event()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id='device-presence-' + uuid.uuid4().hex[:16],
                                  protocol=mqtt.MQTTv311, reconnect_on_failure=False)
        def on_connect(client, userdata, flags, reason, properties):
            self.connected = not reason.is_failure
            ready.set()
        def on_disconnect(client, userdata, flags, reason, properties):
            self.connected = False
        self.client.on_connect = on_connect
        self.client.on_disconnect = on_disconnect
        self.client.connect_timeout = 5
        try:
            self.client.connect(broker['host'], broker['port'], 15)
            self.client.loop_start()
            if not ready.wait(6) or not self.connected:
                raise ReceiverError('MQTT连接或认证失败；若需凭据/证书，须先提供受支持的代理能力')
        except Exception:
            self.close()
            raise

    def publish(self, topic, payload):
        if not self.connected:
            raise ReceiverError('MQTT连接已断开，停止设备保活')
        info = self.client.publish(topic, json.dumps(payload, ensure_ascii=False), qos=1, retain=False)
        if info.rc != 0:
            raise ReceiverError('MQTT消息提交失败')
        info.wait_for_publish(timeout=5)
        if not info.is_published():
            raise ReceiverError('MQTT PUBACK确认超时，不能记为已发送')

    def close(self):
        self.connected = False
        self.client.disconnect()
        self.client.loop_stop()


def extract_devices(status):
    scene, manifest = status.get('scene'), status.get('manifest')
    if not isinstance(scene, dict) or not isinstance(manifest, dict):
        raise ReceiverError('场景或设备清单不存在')
    if (manifest.get('source_mode') != 'replay' or not manifest.get('batch')
            or manifest.get('batch') != status.get('batch')
            or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', str(manifest.get('provider', '')))):
        raise ReceiverError('设备清单必须与当前 replay 批次匹配')
    registered = manifest.get('devices')
    if not isinstance(registered, dict) or not registered:
        raise ReceiverError('没有已注册的模拟设备；保活不会注册新设备')
    scene_devices = {}
    for site in scene.get('sites', []):
        x, y = point_list([[site['x'], site['y']]], 1, '设备位置')[0]
        for device in site.get('devices', []):
            device_id = device['id']
            if device_id in scene_devices:
                raise ReceiverError('场景设备标识重复')
            scene_devices[device_id] = dict(device, x=x, y=y)
    devices = {}
    for device_id, entry in registered.items():
        device = scene_devices.get(device_id)
        if (device is None or device.get('kind') != entry.get('kind')
                or device.get('kind') not in ('radar', 'tdoa', '5ga', 'eo')
                or not entry.get('platform_id')
                or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', str(entry.get('external_id', '')))):
            raise ReceiverError('设备清单身份与当前场景不匹配')
        if device.get('health') not in ('正常', '故障') or device.get('heartbeat') not in ('持续上报', '停止心跳'):
            raise ReceiverError('设备健康或心跳配置未知，停止保活')
        device['interval'] = number(device.get('interval'), 1, 300, '心跳间隔')
        if device['kind'] == 'eo' and (device['health'] != '正常' or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', str(entry.get('edge_id', '')))):
            raise ReceiverError('光电故障协议或设备身份不明确，停止保活')
        if device.get('send') is not False:
            devices[device_id] = device
    # Newly drawn devices must be registered by the existing scenario runner first.
    if any(key not in registered and d.get('send') is not False and d.get('kind') in ('radar', 'tdoa', '5ga', 'eo')
           for key, d in scene_devices.items()):
        raise ReceiverError('场景包含尚未登记设备，停止保活')
    return devices, manifest


def signature(status):
    identity = {key: status.get(key) for key in ('session_version', 'batch', 'scene', 'manifest')}
    return hashlib.sha256(json.dumps(identity, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class DevicePresence:
    def __init__(self, api, data_dir, mqtt_factory=MqttPublisher, clock=time.time):
        self.api, self.clock, self.mqtt_factory = api, clock, mqtt_factory
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.client = None
        self.identity = None
        self.last_sent = {}
        self.verified_at = None
        self.stop_event = threading.Event()
        self.snapshot = {'state': 'STARTING', 'connected': False, 'last_published_at': None,
                         'published_count': 0, 'devices': {}, 'error': None}

    def save(self, state, error=None):
        self.snapshot.update(state=state, connected=bool(self.client and self.client.connected),
                             error=error, checked_at=int(self.clock() * 1000))
        temporary = self.data_dir / 'status.json.tmp'
        with temporary.open('w', encoding='utf-8') as stream:
            json.dump(self.snapshot, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.data_dir / 'status.json')

    def disconnect(self):
        if self.client:
            try:
                self.client.close()
            finally:
                self.client = None
        self.identity = None
        self.last_sent = {}
        self.verified_at = None

    def verify_session(self):
        now = self.clock()
        if self.verified_at is None or now - self.verified_at >= 5 or now < self.verified_at:
            self.api.verify_session()
            self.verified_at = self.clock()

    def step(self):
        try:
            status = self.api.status()
            if isinstance(status.get('realtime'), dict) and status['realtime'].get('independent_presence_allowed') is False:
                self.disconnect()
                self.save('PAUSED', '统一收发控制已接管；独立保活不再恢复旧批次')
                return True
            if status.get('connected') is not True:
                raise ReceiverError('系统登录已失效，停止设备保活')
            self.snapshot['scenario_phase'] = status.get('phase')
            if status.get('phase') not in IDLE_PHASES:
                self.disconnect()
                self.save('PAUSED', '场景运行、暂停或状态未知，独立保活已让出控制')
                return True
            devices, manifest = extract_devices(status)
            identity = signature(status)
            if self.identity != identity:
                self.disconnect()
            self.verify_session()
            if not any(d['heartbeat'] == '持续上报' for d in devices.values()):
                self.disconnect()
                self.save('PAUSED', '设备均已停止心跳或取消发送')
                return True
            if self.client and not self.client.connected:
                raise ReceiverError('MQTT连接已断开，停止保活并等待重连')
            if not self.client:
                self.client = self.mqtt_factory(self.api.broker())
                self.identity = identity
                self.snapshot.update(batch=manifest['batch'], provider=manifest['provider'])
            now = self.clock()
            # No old targets, motion, or timed risk injection is resumed by the presence loop.
            reports = messages({'risks': []}, devices, {}, manifest, now, int(now * 1000), self.last_sent, 0)
            for topic, payload in reports:
                current = self.api.status()
                if current.get('connected') is not True:
                    raise ReceiverError('系统登录已失效，停止设备保活')
                if current.get('phase') not in IDLE_PHASES or signature(current) != self.identity:
                    self.disconnect()
                    self.save('PAUSED', '场景或设备身份已变化，停止旧设备连接')
                    return True
                self.verify_session()
                if '/device_data/' in topic or 'objects' in payload or not (
                        topic.startswith('bridge/' + manifest['provider'] + '/device/')
                        or (topic.startswith('iot-reporting/cmlc/edge/') and payload.get('event') == 'HeartBeat')):
                    raise ReceiverError('拒绝发送非设备心跳或工参消息')
                self.client.publish(topic, payload)
                acknowledged_at = int(self.clock() * 1000)
                external = payload.get('deviceId') or payload['metadata']['deviceId']
                self.snapshot['last_published_at'] = acknowledged_at
                self.snapshot['published_count'] += 1
                self.snapshot['devices'][external] = {'last_published_at': acknowledged_at, 'topic': topic,
                                                      'payload': copy.deepcopy(payload)}
                self.save('CONNECTED')
            self.save('CONNECTED')
            return True
        except Exception as error:
            self.disconnect()
            self.save('INVALID', str(error))
            LOG.error('设备保活已停止：%s', error)
            return False

    def run(self, stop_file):
        stop_file = Path(stop_file)
        backoff = 1.0
        try:
            while not self.stop_event.is_set() and not stop_file.exists():
                success = self.step()
                delay = 0.5 if success else backoff
                backoff = 1.0 if success else min(backoff * 2, 30.0)
                deadline = time.monotonic() + delay
                while not self.stop_event.is_set() and not stop_file.exists():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    self.stop_event.wait(min(remaining, 0.25))
        finally:
            self.disconnect()
            self.save('STOPPED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proxy', default='http://127.0.0.1:8766')
    parser.add_argument('--data-dir', type=Path, default=ROOT / '.data' / 'device-presence')
    parser.add_argument('--stop-file', type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        api = SimulatorApi(args.proxy, timeout=8)
        with InstanceLock(ROOT / '.data' / f'device-presence-{api.port}.lock'):
            presence = DevicePresence(api, args.data_dir)
            for signum in (signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, lambda *_: presence.stop_event.set())
            LOG.info('独立设备保活启动；只使用既有模拟设备，不发送目标；状态目录：%s', args.data_dir.resolve())
            presence.run(args.stop_file or args.data_dir / 'stop')
    except (ReceiverError, OSError) as error:
        LOG.error('%s', error)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
