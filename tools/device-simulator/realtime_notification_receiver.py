#!/usr/bin/env python3
"""Independent local notification receiver; all receipts go through the logged-in proxy."""
import argparse
import copy
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import re
import signal
import threading
import time
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

LOG = logging.getLogger('notification-receiver')
PREFIX = '/local-interface-simulator'
KINDS = {'ADVISORY_SMS', 'ADVISORY_VOICE', 'RISK_NOTICE', 'UAV_PUNISHMENT',
         'PLAN_FEEDBACK', 'DEVICE_MAINTENANCE'}
MODES = {'success', 'no_receipt', 'failed', 'timeout', 'no_answer', 'answered_only', 'delayed', 'mixed'}
ROOT = Path(__file__).resolve().parent


class ReceiverError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class ProxyClient:
    """Uses only the running simulator's memory session; never reads credentials."""
    def __init__(self, base='http://127.0.0.1:8766', timeout=15):
        parsed = urlsplit(base)
        if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost')
                or parsed.username or parsed.password or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment):
            raise ReceiverError('代理地址必须是本机 http://127.0.0.1:8766 一类地址')
        self.base = base.rstrip('/')
        self.port = parsed.port or 80
        self.timeout = timeout
        self.http = build_opener(ProxyHandler({}), NoRedirect())

    def call(self, method, path, body=None, key=None):
        command = {'method': method, 'path': path}
        if method == 'POST':
            command.update(body=body, key=key or uuid.uuid4().hex)
        elif method != 'GET' or body is not None or key is not None:
            raise ReceiverError('读取请求不得携带 body/key')
        request = Request(self.base + '/api/external/request', method='POST',
                          data=json.dumps(command, ensure_ascii=False).encode('utf-8'),
                          headers={'Content-Type': 'application/json'})
        try:
            with self.http.open(request, timeout=self.timeout) as response:
                value = json.load(response)
        except HTTPError as error:
            # Do not log arbitrary server response bodies or credentials.
            status = error.code
            error.close()
            raise ReceiverError(f'代理接口返回 HTTP {status}；检查系统登录和平台服务', status) from None
        except (URLError, OSError, ValueError):
            raise ReceiverError('无法读取代理接口；检查本机代理及平台服务') from None
        if not isinstance(value, dict) or value.get('error'):
            raise ReceiverError('代理接口返回失败或无效对象')
        return value


class InstanceLock:
    """OS lock survives stale files and is automatically released on process exit."""
    def __init__(self, path):
        self.path = Path(path)
        self.file = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open('a+b')
        try:
            if self.path.stat().st_size == 0:
                self.file.write(b'0')
                self.file.flush()
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            self.file = None
            raise ReceiverError('该代理已有通知接收器运行，请先停止原接收器') from None
        return self

    def __exit__(self, *args):
        if self.file:
            self.file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            self.file.close()
            self.file = None


class Receiver:
    def __init__(self, client, data_dir, play_seconds=3.0, outcome_file=None, clock=time.time):
        if not math.isfinite(play_seconds) or play_seconds <= 0:
            raise ReceiverError('电话播放时长必须是大于零的有限秒数')
        self.client, self.clock = client, clock
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.data_dir / 'state.json'
        self.events_path = self.data_dir / 'events.jsonl'
        self.play_seconds = play_seconds
        self.outcome_file = Path(outcome_file) if outcome_file else None
        self.last_heartbeat = None
        self.leased = False
        self.last_error = None
        self.stop_event = threading.Event()
        self.state = {'schema_version': 1, 'messages': {}}
        if self.state_path.exists():
            try:
                self.state = json.loads(self.state_path.read_text(encoding='utf-8'))
                if self.state['schema_version'] != 1 or not isinstance(self.state['messages'], dict):
                    raise ValueError('invalid state')
            except (OSError, ValueError, KeyError, TypeError):
                raise ReceiverError('接收器持久化状态损坏，停止处理以免重复回执；请检查 state.json') from None

    def save(self):
        temporary = self.state_path.with_suffix('.json.tmp')
        with temporary.open('w', encoding='utf-8', newline='\n') as stream:
            json.dump(self.state, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.state_path)
        if os.name != 'nt':
            descriptor = os.open(self.data_dir, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    def event(self, name, **fields):
        with self.events_path.open('a', encoding='utf-8', newline='\n') as stream:
            stream.write(json.dumps({'at': self.clock(), 'event': name, **fields}, ensure_ascii=False) + '\n')
            stream.flush()
            os.fsync(stream.fileno())

    def outcomes(self):
        if not self.outcome_file:
            return {}
        try:
            modes = json.loads(self.outcome_file.read_text(encoding='utf-8-sig'))
            if not isinstance(modes, dict) or set(modes) - KINDS:
                raise ValueError('unknown kind')
            if any(not isinstance(mode, str) or mode not in MODES for mode in modes.values()):
                raise ValueError('unknown outcome')
            if any(mode in ('no_answer', 'answered_only') and kind != 'ADVISORY_VOICE'
                   for kind, mode in modes.items()):
                raise ValueError('voice-only mode')
            return modes
        except (OSError, ValueError, TypeError):
            raise ReceiverError('outcome-file 无效；停止回执和续租，请检查按 kind 配置的结果') from None

    def receive(self, message, mode='success'):
        message_id = message.get('message_id')
        if (not isinstance(message_id, str) or not re.fullmatch(r'simn-[A-Za-z0-9_-]{1,59}', message_id)
                or type(message.get('version')) is not int):
            raise ReceiverError('通知 message_id/version 无效')
        if type(message.get('created_at')) is not int or message['created_at'] <= 0:
            raise ReceiverError('通知 created_at 必须为有效 epoch 毫秒整数')
        record = self.state['messages'].get(message_id)
        if record is None:
            if mode == 'mixed':
                choices = ['success','failed','delayed','no_receipt']
                if message['kind'] == 'ADVISORY_VOICE': choices.append('answered_only')
                ordinal = sum(r['original']['kind'] == message['kind'] for r in self.state['messages'].values())
                mode = choices[ordinal % len(choices)]
            record = {'original': copy.deepcopy(message), 'current': copy.deepcopy(message),
                      'received_at': self.clock(), 'answered_at': None, 'pending': None,
                      'mode': mode, 'play_seconds': self.play_seconds}
            self.state['messages'][message_id] = record
            self.save()
            self.event('received', message=copy.deepcopy(message))
        else:
            if message['version'] < record['current']['version']:
                return None
            record['current'] = copy.deepcopy(message)
            # Legacy records freeze their policy on the first upgraded read.
            record.setdefault('mode', mode)
            record.setdefault('play_seconds', self.play_seconds)
        if message['kind'] == 'ADVISORY_VOICE' and message['state'] == 'ANSWERED' and record['answered_at'] is None:
            # If local timing was lost, wait a full playback interval conservatively.
            record['answered_at'] = self.clock()
        pending = record.get('pending')
        if pending and message['version'] > pending['body']['expected_version']:
            if pending['body']['outcome'] == 'ANSWERED' and message['state'] == 'ANSWERED':
                # A response lost during ANSWERED cannot prove when playback began.
                record['answered_at'] = self.clock()
            record['pending'] = None
        self.save()
        return record

    def next_outcome(self, message, record, mode):
        state, kind = message['state'], message['kind']
        if mode == 'no_receipt':
            return None
        if state in ('SUBMITTED', 'ANSWERED') and self.clock() * 1000 - message['created_at'] >= 60_000:
            return 'TIMEOUT'
        if mode == 'delayed' and self.clock() - record['received_at'] < 8:
            return None
        if state == 'SUBMITTED':
            if mode in ('failed', 'no_answer'):
                return 'FAILED'
            if mode == 'timeout':
                return 'TIMEOUT'
            return 'ANSWERED' if kind == 'ADVISORY_VOICE' else 'DELIVERED'
        if kind == 'ADVISORY_VOICE' and state == 'ANSWERED':
            if mode not in ('success', 'delayed'):
                return None
            elapsed = self.clock() - record['answered_at']
            return 'PLAYED' if elapsed >= record.get('play_seconds', self.play_seconds) else None
        if kind not in ('ADVISORY_SMS', 'ADVISORY_VOICE') and state == 'DELIVERED':
            return 'ACKNOWLEDGED' if mode in ('success', 'delayed') else None
        return None

    def send_receipt(self, message, record, outcome):
        body = {'expected_version': message['version'], 'outcome': outcome}
        pending = record.get('pending')
        if pending is None or pending['body'] != body:
            identity = f"{message['message_id']}:{message['version']}:{outcome}"
            pending = {'body': body, 'key': hashlib.sha256(identity.encode()).hexdigest()}
            record['pending'] = pending
        if outcome == 'ANSWERED' and record['answered_at'] is None:
            record['answered_at'] = self.clock()
        self.save()
        # Re-log original before every attempt, including recovery after a crash between save/event.
        self.event('receipt_attempt', message=record['original'], request=pending)
        updated = self.client.call('POST', PREFIX + '/messages/' + message['message_id'] + '/receipt',
                                   pending['body'], pending['key'])
        if (updated.get('message_id') != message['message_id'] or updated.get('state') != outcome
                or not isinstance(updated.get('version'), int) or updated['version'] <= message['version']):
            raise ReceiverError('回执 API 未返回预期的新消息状态；等待下一次查询确认')
        record['current'] = copy.deepcopy(updated)
        record['pending'] = None
        # Start playback only after ANSWERED is acknowledged by the platform.
        if outcome == 'ANSWERED':
            record['answered_at'] = self.clock()
        self.save()
        result = updated.get('result')
        projection = result.get('projection_status') if isinstance(result, dict) else None
        if projection == 'APPLIED':
            self.event('receipt_confirmed', message=updated)
            LOG.info('模拟通知外部回执已记录，业务已采纳：%s %s -> %s',
                     message['message_id'], message['kind'], outcome)
        elif projection == 'IGNORED_STALE_ATTEMPT':
            self.event('receipt_recorded_unapplied', message=updated)
            LOG.warning('模拟通知外部回执已记录，但业务未采纳（原尝试已失效）；不重复发送：%s %s -> %s',
                        message['message_id'], message['kind'], outcome)
        else:
            self.event('receipt_recorded_projection_unknown', message=updated)
            LOG.warning('模拟通知外部回执已记录，业务采纳状态未确认；不重复发送：%s %s -> %s',
                        message['message_id'], message['kind'], outcome)

    def step(self):
        if self.stop_event.is_set():
            return False
        try:
            modes = self.outcomes()
            context = self.client.call('GET', PREFIX + '/context')
            messages = context.get('receiver_messages')
            if not isinstance(messages, list):
                raise ReceiverError('平台尚未提供 receiver_messages；停止续租')
            now = self.clock()
            if self.stop_event.is_set():
                return False
            if self.last_heartbeat is None or now - self.last_heartbeat >= 5 or now < self.last_heartbeat:
                self.client.call('POST', PREFIX + '/bindings',
                                 {'source_kind': 'NOTIFICATION_CHANNEL', 'source_id': 'receiver', 'enabled': True},
                                 uuid.uuid4().hex)
                self.last_heartbeat = self.clock()
                self.leased = True
            for message in messages:
                if self.stop_event.is_set():
                    return False
                if message.get('kind') not in KINDS or message.get('direction') != 'OUT':
                    continue
                record = self.receive(message, modes.get(message['kind'], 'success'))
                if record is None:
                    continue
                outcome = self.next_outcome(message, record, record['mode'])
                if outcome:
                    if self.stop_event.is_set():
                        return False
                    self.send_receipt(message, record, outcome)
            if self.last_error:
                LOG.info('代理和平台连接已恢复，继续接收通知')
            self.last_error = None
            return True
        except (ReceiverError, OSError, ValueError, KeyError, TypeError) as error:
            self.last_error = str(error)
            LOG.error('停止本轮回执和续租：%s', error)
            return False

    def close(self):
        if self.leased:
            try:
                self.client.call('POST', PREFIX + '/bindings',
                                 {'source_kind': 'NOTIFICATION_CHANNEL', 'source_id': 'receiver', 'enabled': False},
                                 uuid.uuid4().hex)
                self.leased = False
            except (ReceiverError, OSError, ValueError):
                LOG.warning('无法注销接收器，等待平台 30 秒租约到期')

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
            self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proxy', default='http://127.0.0.1:8766')
    parser.add_argument('--data-dir', type=Path, default=ROOT / '.data' / 'realtime-notifications')
    parser.add_argument('--play-seconds', type=float, default=3.0)
    parser.add_argument('--outcome-file', type=Path)
    parser.add_argument('--stop-file', type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    try:
        client = ProxyClient(args.proxy)
        # Same endpoint shares a lock even when callers use different data directories.
        with InstanceLock(ROOT / '.data' / f'notification-receiver-{client.port}.lock'):
            receiver = Receiver(client, args.data_dir, args.play_seconds, args.outcome_file)
            for signum in (signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, lambda *_: receiver.stop_event.set())
            LOG.info('独立模拟通知接收器启动，数据目录：%s', args.data_dir.resolve())
            receiver.run(args.stop_file or args.data_dir / 'stop')
    except (ReceiverError, OSError) as error:
        LOG.error('%s', error)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
