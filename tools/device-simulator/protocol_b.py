"""Bounded Protocol B device responder. Only replies to received replay commands."""
import copy
import hashlib
import heapq
import json
import threading
import time

COMMANDS = {10000: 'radar', 30000: 'oe', 30001: 'oe', 30002: 'oe', 30003: 'oe',
            50002: 'dec', 50003: 'dec', 50005: 'dec', 50100: 'dec', 50101: 'dec',
            60002: 'ifr', 60003: 'ifr', 60100: 'ifr', 60101: 'ifr',
            70001: 'bsc', 90000: 'aoa', 100000: 'tdoa'}
PARAMS = {'direction', 'angle', 'induceLongitude', 'induceLatitude', 'bands', 'targetId',
          'targetLongitude', 'targetLatitude', 'targetAltitude', 'duration', 'defenseZoneId', 'cameraId'}
MAX_COMMANDS = 10000


def validate_config(value, kind):
    if not isinstance(value, dict) or set(value) - {'enabled', 'response', 'delayMs', 'duplicateCount', 'failureMessage'}:
        raise ValueError('协议 B 响应配置无效')
    config = {'enabled': True, 'response': 'success', 'delayMs': 0, 'duplicateCount': 0,
              'failureMessage': '模拟设备拒绝执行', **value}
    if not isinstance(config['enabled'], bool) or kind not in set(COMMANDS.values()):
        raise ValueError('该设备不支持协议 B 响应')
    if config['response'] not in ('success', 'failure', 'no_receipt'):
        raise ValueError('协议 B 响应须为 success、failure 或 no_receipt')
    for key, maximum in [('delayMs', 300000), ('duplicateCount', 2)]:
        if type(config[key]) is not int or not 0 <= config[key] <= maximum:
            raise ValueError('协议 B ' + key + ' 超出范围')
    if not isinstance(config['failureMessage'], str) or not config['failureMessage'].strip() or len(config['failureMessage']) > 200:
        raise ValueError('协议 B 失败说明须为1至200字')
    return config


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('重复 JSON 字段')
        result[key] = value
    return result


def decode(topic, payload, binding):
    if len(payload) > 1048576:
        raise ValueError('报文过大')
    root = json.loads(payload.decode('utf-8'), object_pairs_hook=unique_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('非法数值')))
    if not isinstance(root, dict) or not isinstance(root.get('head'), dict) or not isinstance(root.get('data'), dict):
        raise ValueError('报文结构错误')
    head, data = root['head'], root['data']
    msg = head.get('msgNo')
    if not isinstance(msg, str) or not msg.strip() or len(msg) > 128:
        raise ValueError('当前平台 msgNo 须为非空字符串')
    if head.get('deviceId') != binding['external_id']:
        raise ValueError('设备身份不匹配')
    if type(head.get('time')) is not int or head['time'] < 0:
        raise ValueError('指令时间无效')
    cmd, operation = data.get('operationCmd'), data.get('operationType')
    if type(cmd) is not int or COMMANDS.get(cmd) != binding['kind']:
        raise ValueError('指令未支持或与设备类型不符')
    if type(operation) is not int or operation not in (0, 1, 2):
        raise ValueError('操作类型无效')
    params = data.get('operationParams', {})
    if not isinstance(params, dict) or set(params) - PARAMS or (operation == 0 and params):
        raise ValueError('指令参数无效')
    if operation != 0 and cmd in (30002, 50005) and not str(params.get('targetId') or '').strip():
        raise ValueError('指令缺少编号')
    if 'duration' in params and (type(params['duration']) is not int or not 10 <= params['duration'] <= 300):
        raise ValueError('duration 须为10至300秒')
    return root


class ProtocolBResponder:
    def __init__(self, manifest, devices, publish, log, is_running):
        if manifest.get('source_mode') != 'replay':
            raise ValueError('协议 B 模拟响应仅允许 replay 批次')
        self.publish, self.log, self.is_running = publish, log, is_running
        self.bindings = {}
        for device_id, device in devices.items():
            if 'protocolB' not in device:
                continue
            cfg = validate_config(device['protocolB'], device['kind'])
            if not cfg['enabled']:
                continue
            entry = manifest['devices'][device_id]
            if entry['kind'] != device['kind']:
                raise ValueError('协议 B 批次设备类型不一致')
            parts = (manifest['provider'], entry['kind'], entry['external_id'])
            if any(not isinstance(x, str) or not x or any(c in x for c in '/+#\x00') for x in parts):
                raise ValueError('协议 B 主题身份无效')
            topic = 'bridge/%s/device_control/%s/%s' % parts
            self.bindings[topic] = {**entry, 'config': cfg, 'response_topic': 'bridge/%s/device_control_resp/%s/%s' % parts}
        self.condition = threading.Condition()
        self.pending, self.records = [], {}
        self.closed = False
        self.error = None
        self.published = 0
        self.thread = threading.Thread(target=self._run, name='protocol-b-responder', daemon=True)
        self.thread.start()

    def enqueue(self, topic, payload, retained=False, qos=1):
        binding = self.bindings.get(topic)
        if not binding or retained or qos != 1 or not self.is_running():
            return False
        try:
            root = decode(topic, payload, binding)
        except (ValueError, UnicodeError, TypeError, AttributeError) as error:
            self.log('B_REJECTED', str(error), topic=topic)
            return False
        key = (topic, root['head']['msgNo'])
        digest = hashlib.sha256(json.dumps(root, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        conflict = False
        with self.condition:
            if self.closed:
                return False
            previous = self.records.get(key)
            if previous:
                conflict = previous['digest'] != digest
                if not conflict and not previous['queued'] and previous['response'] is not None:
                    previous['queued'] = True
                    previous['remaining'] = previous['copies']
                    heapq.heappush(self.pending, (time.monotonic(), key))
                    self.condition.notify_all()
            else:
                if len(self.records) >= MAX_COMMANDS:
                    self.error = '协议 B 批次指令达到容量上限，请停止并新建批次'
                    return False
                cfg, data = binding['config'], root['data']
                response = None if cfg['response'] == 'no_receipt' else {
                    'head': {'msgNo': root['head']['msgNo'], 'deviceId': binding['external_id'], 'time': int(time.time()*1000)},
                    'data': {'operationType': data['operationType'], 'operationCmd': data['operationCmd'],
                             'code': 1 if cfg['response'] == 'failure' else 0,
                             'msg': cfg['failureMessage'] if cfg['response'] == 'failure' else ''}}
                self.records[key] = {'digest': digest, 'response': response, 'queued': response is not None,
                                     'topic': binding['response_topic'], 'copies': 1 + cfg['duplicateCount'],
                                     'remaining': 1 + cfg['duplicateCount']}
                if response is not None:
                    heapq.heappush(self.pending, (time.monotonic() + cfg['delayMs']/1000, key))
                    self.condition.notify_all()
        if conflict:
            self.log('B_REJECTED', '同一指令号收到不同载荷', topic=topic, msg_no=key[1])
            return False
        self.log('B_COMMAND_DUPLICATE' if previous else 'B_COMMAND',
                 '重复指令复用首次响应' if previous else '收到平台协议 B 指令', topic=topic, payload=root)
        return True

    def _run(self):
        while True:
            with self.condition:
                if self.closed:
                    return
                if not self.pending:
                    self.condition.wait(.1)
                    continue
                deadline, key = self.pending[0]
                remaining = deadline - time.monotonic()
                if remaining > 0:
                    self.condition.wait(min(remaining, .1))
                    continue
            if not self.is_running():
                with self.condition:
                    self.condition.wait(.1)
                continue
            with self.condition:
                if self.closed:
                    return
                heapq.heappop(self.pending)
                record = copy.deepcopy(self.records[key])
            remaining_copies = record['remaining']
            try:
                for _ in range(remaining_copies):
                    if self.closed or not self.is_running():
                        break
                    # The publisher checks the lifecycle again immediately before the network write.
                    if self.publish(record['topic'], record['response']) is False:
                        break
                    with self.condition:
                        self.published += 1
                    remaining_copies -= 1
            except Exception as error:
                self.error = '协议 B 回执发送失败：' + str(error)[:200]
                self.log('B_ERROR', self.error)
                return
            finally:
                with self.condition:
                    # A pause/disconnect can occur between dequeue and publish. Keep only
                    # the unsent copies in this run; suspend permanently discards them.
                    retry = remaining_copies > 0 and not self.closed and self.error is None
                    self.records[key]['queued'] = retry
                    self.records[key]['remaining'] = remaining_copies
                    if retry:
                        heapq.heappush(self.pending, (time.monotonic() + .1, key))

    def snapshot(self):
        with self.condition:
            return {'commands': len(self.records), 'published': self.published, 'pending': len(self.pending),
                    'error': self.error, 'stopped': self.closed}

    def suspend(self):
        with self.condition:
            self.closed = True
            self.pending.clear()
            self.condition.notify_all()
        self.thread.join(timeout=6)
        if self.thread.is_alive():
            raise RuntimeError('协议 B 响应线程未停止')
