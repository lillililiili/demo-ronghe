"""Independent native radar TCP v3.0.0 counterpart. No MQTT or database writes."""
import math
import socket
import struct
import threading
import time
import uuid

PORT = 15001
MANUAL_PORT = 15002
MAX_CLIENTS = 8
DEVICE_NO = 'QA-LOCAL-RADAR-TCP'
HEADER = 0x55AA55AA
LOGIN, HEARTBEAT, GETREG, RTK_REQUEST, RTK, TRACK = 2, 1, 0x41, 0x10005, 0x10006, 0x30002

def crc16(data):
    value = 0xffff
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0xa001 if value & 1 else 0)
    return value

def frame(command, seq, payload=b''):
    body = struct.pack('>II', command, seq & 0xffffffff) + payload
    return struct.pack('>II', HEADER, len(body) + 2) + body + struct.pack('>H', crc16(body))

class Decoder:
    def __init__(self):
        self.pending = b''
    def feed(self, chunk):
        self.pending += chunk
        result = []
        while len(self.pending) >= 8:
            header, length = struct.unpack('>II', self.pending[:8])
            if header != HEADER or not 10 <= length <= 4096:
                raise ValueError('雷达请求帧头或长度无效')
            if len(self.pending) < 8 + length:
                break
            raw, self.pending = self.pending[:8+length], self.pending[8+length:]
            if crc16(raw[8:-2]) != struct.unpack('>H', raw[-2:])[0]:
                raise ValueError('雷达请求 CRC 校验失败')
            command, seq = struct.unpack('>II', raw[8:16])
            result.append((command, seq, raw[16:-2]))
        return result

def track_payload(boot, seq, uploaded_at, elapsed):
    # Centimetres; relative station height is NOT AGL/AMSL.
    angle = elapsed / 30
    x, y = 300 + 100 * math.cos(angle), 300 + 100 * math.sin(angle)
    vx, vy = -100 / 30 * math.sin(angle), 100 / 30 * math.cos(angle)
    header = struct.pack('>QQQiiBBBBI', boot, seq, uploaded_at, 0, 3600000, 0, 0, 1, 0, 1)
    item = struct.pack('>iiiiiiIhh6xBB16xii',
                       round(x*100), round(y*100), 8000, round(vx*100), round(vy*100), 0,
                       1, 1500, 1, 3, 0, 10000, 0)
    return header + item

class TcpRadar:
    def __init__(self, session, port=PORT, *, manual=False):
        self.session, self.port, self.manual = session, port, manual
        self.position = None
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.listener = self.thread = None
        self.clients, self.authenticated_clients, self.workers = set(), set(), set()
        self.state, self.error = 'STOPPED', ''
        self.device = None
        self.connected, self.frames, self.last_sent_at = False, 0, None
        self.boot, self.sequence = 0, 0
        self.started = self.next_auth = 0
        self.platform = None

    def context(self):
        api = self.session.platform
        if api is None:
            raise ValueError('请先在信号地图页面登录系统')
        return {'scopes': api.call('GET', '/mqtt-brokers/scopes'),
                'device_no': DEVICE_NO, 'port': self.port}

    def start(self, body):
        from coordinate_contract import simulator_wgs84
        fields = {'longitude', 'latitude', 'coordinate_system', 'coordinateSystem'} if self.manual else {'owner_org_id', 'district_id', 'longitude', 'latitude', 'coordinate_system', 'coordinateSystem'}
        if not isinstance(body, dict) or set(body) - fields:
            raise ValueError('TCP 雷达配置字段无效')
        body = dict(body, coordinate_system=simulator_wgs84(body))
        body.pop('coordinateSystem', None)
        if self.manual:
            for field, limit in (('longitude', 180), ('latitude', 90)):
                value = body.get(field)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > limit:
                    raise ValueError('请填写有效的 WGS-84 经度和纬度')
        with self.lock:
            if self.state == 'RUNNING':
                return self.snapshot()
            if (self.thread and self.thread.is_alive()) or any(worker.is_alive() for worker in self.workers):
                raise ValueError('上次 TCP 雷达正在停止，请稍后重试')
            api = self.session.platform
            if api is None:
                raise ValueError('请先在信号地图页面登录系统')
            api.call('GET', '/local-interface-simulator/session')
            listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                # Exclusive bind: never take over an existing native or simulated radar.
                if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                listener.bind(('127.0.0.1', self.port))
                listener.listen(MAX_CLIENTS)
                listener.settimeout(.25)
                detail = None if self.manual else api.call('POST', '/local-interface-simulator/radar-device', body,
                                  key='tcp-radar-' + uuid.uuid4().hex)
                if not self.manual:
                    api.sync_simulated_range(detail['device']['device_id'], 'radar')
            except Exception:
                listener.close()
                raise
            self.device = None if self.manual else detail['device']
            self.position = dict(body) if self.manual else self.device
            self.platform = api
            self.listener = listener
            self.stop_event.clear()
            self.error, self.state = '', 'RUNNING'
            self.frames, self.connected, self.last_sent_at = 0, False, None
            self.started, self.next_auth = time.monotonic(), 0
            # Unique boot session even across process restarts; wire frame IDs keep increasing per run.
            self.boot, self.sequence = time.time_ns() // 1000, 0
            self.thread = threading.Thread(target=self._run, name='manual-tcp-radar' if self.manual else 'native-tcp-radar', daemon=True)
            self.thread.start()
            return self.snapshot()

    def snapshot(self):
        with self.lock:
            return {'state': self.state, 'error': self.error, 'connected': self.connected,
                    'frames_sent': self.frames, 'last_sent_at': self.last_sent_at,
                    'device_id': (self.device or {}).get('device_id'), 'device_no': None if self.manual else DEVICE_NO,
                    'mode': 'manual' if self.manual else 'registered',
                    'longitude': (self.position or {}).get('longitude'), 'latitude': (self.position or {}).get('latitude'),
                    'device_name': None if self.manual else (self.device or {}).get('name', '模拟 独立 TCP 雷达'),
                    'host': '127.0.0.1', 'port': self.listener.getsockname()[1] if self.listener and self.state == 'RUNNING' else self.port, 'simulated': True}

    def stop(self):
        # Local emergency stop must work even after a session expires.
        self.stop_event.set()
        with self.lock:
            self._close_connections()
            if self.state != 'FAILED':
                self.state = 'STOPPED'
            self.connected = False
        if self.thread and self.thread is not threading.current_thread():
            self.thread.join(timeout=1)
        with self.lock:
            workers = tuple(self.workers)
        for worker in workers:
            if worker is not threading.current_thread():
                worker.join(timeout=1)
        return self.snapshot()

    @staticmethod
    def _close_socket(sock):
        if sock:
            try: sock.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            sock.close()

    def _close_connections(self):
        # Caller holds the lifecycle lock. A stop or expired platform session
        # closes every data/diagnostic connection, including clients not logged in.
        self._close_socket(self.listener)
        for client in self.clients:
            self._close_socket(client)
        self.authenticated_clients.clear()
        self.connected = False

    def _check_session(self):
        now = time.monotonic()
        if now < self.next_auth:
            return
        if self.session.platform is not self.platform:
            raise ValueError('登录已失效或账号已切换，TCP 模拟发送已停止')
        self.platform.call('GET', '/local-interface-simulator/session', timeout=4)
        self.next_auth = now + 5

    def _run(self):
        try:
            while not self.stop_event.is_set():
                self._check_session()
                try:
                    client, _ = self.listener.accept()
                except socket.timeout:
                    continue
                with self.lock:
                    if self.stop_event.is_set() or len(self.clients) >= MAX_CLIENTS:
                        self._close_socket(client)
                        continue
                    # Monitoring keeps a persistent connection; port probes and
                    # commissioning must be accepted without waiting for it to close.
                    worker = threading.Thread(target=self._serve_client, args=(client,),
                                              name='tcp-radar-client', daemon=True)
                    self.clients.add(client)
                    self.workers.add(worker)
                    worker.start()
        except Exception as error:
            if not self.stop_event.is_set():
                with self.lock: self.state, self.error = 'FAILED', str(error)[:250]
        finally:
            self.stop_event.set()
            with self.lock:
                self._close_connections()
                self.listener = None

    def _serve_client(self, client):
        try:
            self._serve(client)
        except (OSError, ValueError) as error:
            if not self.stop_event.is_set():
                with self.lock: self.error = str(error)[:250]
        finally:
            client.close()
            with self.lock:
                self.clients.discard(client)
                self.authenticated_clients.discard(client)
                self.connected = bool(self.authenticated_clients)
                self.workers.discard(threading.current_thread())

    def _send(self, client, command, payload):
        with self.lock:
            self.sequence += 1
            sequence = self.sequence
            body = payload(sequence) if callable(payload) else payload
        client.sendall(frame(command, sequence, body))

    def _serve(self, client):
        client.settimeout(.2)
        client.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        decoder, logged_in, rtk_enabled = Decoder(), False, False
        next_track, last_request = 0, time.monotonic()
        while not self.stop_event.is_set():
            # The listener checks the shared platform session for all clients.
            # Authentication loss closes all sockets through _run's finally block.
            try:
                chunk = client.recv(4096)
                if not chunk: return
                requests = decoder.feed(chunk)
            except socket.timeout:
                requests = []
            for command, seq, payload in requests:
                last_request = time.monotonic()
                if command == LOGIN:
                    valid = len(payload) == 8 and struct.unpack('>II', payload) == (5, 0)
                    client.sendall(frame(LOGIN, seq, struct.pack('>IH', 5, 0 if valid else 1)))
                    if not valid: return
                    logged_in = True
                    with self.lock:
                        if self.stop_event.is_set(): return
                        self.authenticated_clients.add(client)
                        self.connected, self.error = True, ''
                elif not logged_in:
                    return
                elif command == HEARTBEAT and len(payload) == 8:
                    client.sendall(frame(HEARTBEAT, seq, payload))
                elif command == GETREG:
                    if len(payload) < 4: raise ValueError('寄存器请求长度无效')
                    count = struct.unpack('>I', payload[:4])[0]
                    if count > 2 or len(payload) != 4 + count * 4: raise ValueError('寄存器请求无效')
                    addresses = struct.unpack('>' + 'I'*count, payload[4:])
                    values = {0x440: 0x07030201, 0x401: 0x0401}
                    if len(set(addresses)) != count or any(a not in values for a in addresses):
                        raise ValueError('不支持的寄存器')
                    answer = struct.pack('>I', count) + b''.join(struct.pack('>II', a, values[a]) for a in addresses)
                    client.sendall(frame(GETREG, seq, answer))
                elif command == RTK_REQUEST and payload in (b'\x01\x00', b'\x00\x00'):
                    rtk_enabled = payload[0] == 1
                    client.sendall(frame(RTK_REQUEST, seq, payload))
                else:
                    raise ValueError('仅支持数据登录、心跳、寄存器读取及 RTK 订阅')
            now = time.monotonic()
            if now - last_request > 30: return
            if logged_in and now >= next_track:
                stamp = int(time.time()*1000)
                if rtk_enabled:
                    latitude = round(float(self.position['latitude']) * 1e9)
                    longitude = round(float(self.position['longitude']) * 1e9)
                    self._send(client, RTK, struct.pack('>qqqii', latitude, longitude, 0, 18, 0))
                self._send(client, TRACK, lambda seq: track_payload(self.boot, seq, stamp, now-self.started))
                with self.lock: self.frames += 1; self.last_sent_at = stamp
                next_track = now + 1
