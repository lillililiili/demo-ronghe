"""航班接收机与民航航班（2026-10-28 按用户确认的方案改）。

场景里可以放「航班接收机」设备（kind=adsb，放在某个点位上）和画「民航航班」目标（kind=flight，像任务航线一样一点一点画）。
开始模拟时：
- 每台接收机按它所在点位的位置登记到平台（/local-interface-simulator/adsb-receiver，带识别码），停止时停用；
- 每秒按真实接收机 pingStation3（uAvionix ICD Rev F）的格式、通过 UDP 把航班位置推给平台，一架一条，每 30 秒一条状态报文——
  和正式设备走同一条路，到现场只要把真实接收机的发送地址指向平台、在接入设备里填它的识别码，不用改平台；
- 画出来的航班按航线飞；另外每台接收机周围还有若干架高空巡航的「背景航班」（数量可设，默认 60），只为地图上有航班可看，
  它们飞在 7000 米以上，不会影响反制判断。
能不能反制只由平台判断，这里只送位置。
流程 10「反制前附近有航班」也用这套：流程 5 的无人机 + 一台接收机 + 一架画好航线的航班（见 flight_flow）。
"""
import copy
import datetime
import json
import math
import os
import random
import socket
import urllib.parse

from engine import adsb_devices, compile_scene, coordinates, target_reporting, target_sample

# 平台收数据的 UDP 端口（平台配置 app.adsb.pingstation.udp-port）。
UDP_PORT = int(os.environ.get('ADSB_UDP_PORT') or 30021)
STATUS_EVERY = 30
PREFIX = '/local-interface-simulator/adsb-receiver'
# 流程 10 用的接收机：编号和识别码固定，平台上一直是同一台。
STATION_GUID = 'a1b2c3d4e5f60001'
RECEIVER_NO = 'SIM-ADSB-DY01'
RECEIVER_NAME = '东营 ADS-B 航班接收机（模拟）'

AIRLINES = [('CCA', '中国国航'), ('CES', '东方航空'), ('CSN', '南方航空'), ('CHH', '海南航空'), ('CDG', '山东航空'),
            ('CXA', '厦门航空'), ('CSC', '四川航空'), ('CSZ', '深圳航空'), ('CQH', '春秋航空'), ('DKH', '吉祥航空')]
AIRLINE_BY_PREFIX = dict(AIRLINES)


def airline_for(callsign):
    """按航班号前三位认航空公司（和平台 PingStationMessage 一样的常见表）。"""
    return AIRLINE_BY_PREFIX.get(str(callsign or '')[:3].upper(), '')


def _iso(millis):
    return datetime.datetime.fromtimestamp(millis / 1000, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def pingstation_traffic(row, guid, sequence):
    """一架航班的 pingStation3 航班报文（ICD Rev F 的 JSON Traffic object，一条一架）。"""
    return json.dumps({'aircraft': [{
        'icaoAddress': row['icao24'].upper(), 'trafficSource': 0, 'latDD': row['latitude'], 'lonDD': row['longitude'],
        'altitudeMM': int(row['altitude_m'] * 1000), 'headingDE2': int(round(row['track_deg'] * 100)),
        'horVelocityCMS': int(round(row['ground_speed_mps'] * 100)), 'verVelocityCMS': int(round(row.get('vertical_mps', 0) * 100)),
        'altitudeType': 0, 'callsign': row['callsign'].ljust(8)[:8], 'emitterType': 5, 'sequenceNumber': sequence,
        'pingStationGuid': guid, 'utcSync': 1, 'timeStamp': _iso(row['observed_at']),
        'detail': {'airGroundState': 0, 'emergencyStatus': 0, 'navIntegrity': 8}}]}).encode()


def pingstation_status(guid, center, now):
    """接收机每 30 秒的状态报文：平台据此知道它在线，哪怕附近没有航班。"""
    return json.dumps({'status': {'pingStationGuid': guid, 'pingStationVersionMajor': 1, 'pingStationVersionMinor': 0,
                                  'pingStationVersionBuild': 29, 'timeStamp': _iso(now), 'pingStationLatDD': center[1],
                                  'pingStationLonDD': center[0], 'pingStationAltType': 1, 'pingStationAltMM': 12000,
                                  'gpsStatus': 3, 'receiverStatus': 0}}).encode()


def udp_target(api):
    """平台收航班数据的地址：和接口同一台机器，端口按平台配置。"""
    host = urllib.parse.urlparse(getattr(api, 'base', '') or '').hostname or '127.0.0.1'
    return (host, UDP_PORT)


def _km(a, b):
    return math.hypot((b[0] - a[0]) * 111.32 * math.cos(math.radians((a[1] + b[1]) / 2)), (b[1] - a[1]) * 111.32)


def _offset(center, east_km, north_km):
    lon, lat = center
    return (lon + east_km / (111.32 * math.cos(math.radians(lat))), lat + north_km / 111.32)


def background_flights(guid, count, range_km):
    """接收机周围的背景航班：由识别码决定，每次开始都一样。高空巡航（7000 米以上），不影响反制。"""
    rows = []
    limit = range_km / math.sqrt(2) * .95  # 在接收范围内接的正方形里飞，飞出去从另一边再进来
    for index in range(int(count)):
        rng = random.Random(f'{guid}:{index}')
        prefix, airline = AIRLINES[rng.randrange(len(AIRLINES))]
        rows.append({'icao24': '78' + ''.join(rng.choice('0123456789abcdef') for _ in range(4)),
                     'callsign': prefix + str(rng.randint(1000, 9999)), 'airline': airline,
                     'east': rng.uniform(-limit, limit), 'north': rng.uniform(-limit, limit), 'heading': rng.uniform(0, 360),
                     'altitude_m': rng.randrange(7000, 11600, 100), 'speed': rng.randint(210, 250), 'limit': limit})
    return rows


def _wrap(value, limit):
    return (value + limit) % (2 * limit) - limit


def background_at(row, elapsed, center, observed_at):
    distance = row['speed'] * elapsed / 1000
    rad = math.radians(row['heading'])
    east, north = _wrap(row['east'] + distance * math.sin(rad), row['limit']), _wrap(row['north'] + distance * math.cos(rad), row['limit'])
    lon, lat = _offset(center, east, north)
    return {'icao24': row['icao24'], 'callsign': row['callsign'], 'airline': row['airline'], 'longitude': round(lon, 6),
            'latitude': round(lat, 6), 'altitude_m': row['altitude_m'], 'ground_speed_mps': row['speed'],
            'track_deg': round(row['heading'], 1), 'observed_at': observed_at}


def flight_at(flight, elapsed, observed_at):
    """画出来的航班这一刻的位置；跟踪航线算航向，速度按设定。"""
    sample = target_sample(flight, elapsed)
    return {'icao24': flight['icao24'], 'callsign': flight['callsign'], 'airline': flight.get('airline') or airline_for(flight['callsign']),
            'longitude': round(sample['longitude'], 6), 'latitude': round(sample['latitude'], 6),
            'altitude_m': int(round(sample['altitude'])), 'ground_speed_mps': round(min(math.hypot(sample['speed_x'], sample['speed_y']), 400), 1),
            'vertical_mps': round(sample['speed_z'], 1), 'track_deg': round(sample['heading'], 1), 'observed_at': observed_at}


class AdsbReceiver:
    """一台模拟航班接收机：登记、每秒送航班、停用。"""

    def __init__(self, device, api, scope, flights, risks, sender=None):
        self.device, self.api, self.scope = device, api, scope
        self.flights = flights
        self.guid = device['stationGuid']
        self.center = tuple(coordinates([device['x'], device['y']]))
        self.range_km = float(device['rangeKm'])
        self.background = background_flights(self.guid, device.get('backgroundFlights', 0), self.range_km)
        self.outages = [(r['at'], r['at'] + r['seconds']) for r in risks
                        if r.get('enabled') and r.get('type') == 'offline' and r.get('deviceId') == device['id']]
        self.receiver_id = None
        self.next_status_at = 0
        self.sequence = 0
        self.sent = 0
        self.last_count = 0
        self.last_messages = 0
        self.last_at = None
        self.offline = False
        self.error = ''
        self._sender = sender
        self._socket = None

    def prepare(self):
        receiver = self.api.call('POST', PREFIX, dict(self.scope, device_no=self.device['deviceNo'],
                                                      name='模拟 ' + self.device['name'], longitude=self.center[0],
                                                      latitude=self.center[1], receive_range_km=int(round(self.range_km)),
                                                      station_guid=self.guid))
        self.receiver_id = receiver['device_id']
        return receiver

    def send(self, datagram):
        if self._sender:
            self._sender(datagram)
        else:
            if self._socket is None:
                self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._socket.sendto(datagram, udp_target(self.api))
        self.sent += 1

    def connected(self, elapsed):
        """断开（停止心跳）或在离线时段里：什么都不发，平台 60 秒没收到任何报文就判为收不到航班信息。"""
        if self.device.get('heartbeat') == '停止心跳':
            return False
        return not any(start <= elapsed < end for start, end in self.outages)

    def aircraft_at(self, elapsed, now):
        rows = [background_at(row, elapsed, self.center, now) for row in self.background]
        for flight in self.flights:
            if not target_reporting(flight, elapsed):
                continue
            row = flight_at(flight, elapsed, now)
            if _km(self.center, (row['longitude'], row['latitude'])) <= self.range_km:
                rows.append(row)
        return rows

    def tick(self, elapsed, now):
        """每拍（每秒）一次：在线时送一遍所有航班，到点再送一条状态；返回这拍送了几架。"""
        if not self.receiver_id:
            return 0
        self.offline = not self.connected(elapsed)
        if self.offline:
            self.last_count = self.last_messages = 0
            return 0
        messages = 0
        rows = self.aircraft_at(elapsed, now)
        try:
            if elapsed >= self.next_status_at:
                self.next_status_at = elapsed + STATUS_EVERY
                self.send(pingstation_status(self.guid, self.center, now))
                messages += 1
            for row in rows:
                self.sequence += 1
                self.send(pingstation_traffic(row, self.guid, self.sequence))
                messages += 1
            self.error = ''
        except OSError as error:  # UDP 发不出去（地址不通）：记下来，下一秒再试，不中断模拟
            self.error = str(error)
        self.last_count, self.last_messages, self.last_at = len(rows), messages, now
        return len(rows)

    def release(self):
        if self._socket is not None:
            self._socket.close()
            self._socket = None
        if self.receiver_id:
            receiver_id, self.receiver_id = self.receiver_id, None
            self.api.call('POST', f'{PREFIX}/{receiver_id}/release', {})

    def snapshot(self):
        return {'id': self.device['id'], 'name': self.device['name'], 'station_guid': self.guid, 'device_no': self.device['deviceNo'],
                'range_km': self.range_km, 'registered': bool(self.receiver_id), 'offline': self.offline,
                'aircraft': self.last_count, 'per_second': self.last_messages, 'sent': self.sent, 'last_at': self.last_at, 'error': self.error}


class AdsbReceivers:
    """场景里全部航班接收机，挂在模拟运行的每一拍上。"""

    def __init__(self, api, scope, scene, sender=None):
        flights = list(scene.get('flights') or [])
        self.receivers = [AdsbReceiver(device, api, scope, flights, scene.get('risks') or [], sender)
                          for device in adsb_devices(scene).values()]

    def __bool__(self):
        return bool(self.receivers)

    def prepare(self):
        return [receiver.prepare() for receiver in self.receivers]

    def tick(self, elapsed, now):
        return sum(receiver.tick(elapsed, now) for receiver in self.receivers)

    def release(self):
        errors = []
        for receiver in self.receivers:
            try:
                receiver.release()
            except Exception as error:  # 一台停不掉不影响其余
                errors.append(receiver.device['name'] + '：' + str(error))
        if errors:
            raise ValueError('；'.join(errors))

    def snapshot(self):
        rows = [receiver.snapshot() for receiver in self.receivers]
        return {'devices': rows, 'aircraft': sum(row['aircraft'] for row in rows), 'per_second': sum(row['per_second'] for row in rows),
                'sent': sum(row['sent'] for row in rows), 'offline': bool(rows) and all(row['offline'] for row in rows)}


# ---------------------------------------------------------------------------------------------------------------
# 流程 10「反制前附近有航班」：流程 5 的无人机 + 一台接收机 + 一架画好航线的航班。
TITLE = '反制前附近有航班'
PLANE = ('780a1b', 'CES2471', '东方航空')
FLIGHT_SPEED = 120  # 米/秒（432 公里/小时）：进近高度上的民航客机


def _grid(center, east_km, north_km):
    """以点位为原点、东北向公里数 → 场景格点。"""
    lon, lat = _offset(coordinates(center), east_km, north_km)
    return [round((lon - 118.56) / .00012, 2), round((37.50 - lat) / .00012, 2)]


def _polar(radius_km, deg):
    return radius_km * math.sin(math.radians(deg)), radius_km * math.cos(math.radians(deg))


def _arc(radius_km, start_deg, end_deg, steps):
    return [_polar(radius_km, start_deg + (end_deg - start_deg) * i / steps) for i in range(steps + 1)]


def enter_route(center):
    """航班先在 20 公里外盘旋（高度从 3600 米降到 3000 米以下，约 50 秒起算提醒范围），约 140 秒转向反制设备飞到 7 公里处
    （按航向几分钟内会进 10 公里禁止反制范围，平台即按禁止处理），在 7 公里处绕到约 330 秒，再一边爬升一边飞远，约 370 秒高于 3000 米。
    速度固定 120 米/秒，所以各阶段的时间由线段长度决定。"""
    path, heights = [], []
    # 0–140 秒：20 公里的圆弧，16.8 公里 → 48°。高度 3600 → 2900（60 秒处）→ 2400。
    for index, (east, north) in enumerate(_arc(20, 40, 88, 4)):
        path.append(_grid(center, east, north))
        heights.append([3600, 3300, 2900, 2650, 2400][index])
    # 140–248 秒：沿半径向反制设备飞到 7 公里处，高度降到 1500。
    east, north = _polar(20, 88)
    path.append(_grid(center, east * 7 / 20, north * 7 / 20)); heights.append(1500)
    # 248–330 秒：在 7 公里处绕 80°（9.8 公里）。
    for east, north in _arc(7, 88, 168, 2)[1:]:
        path.append(_grid(center, east, north)); heights.append(1500)
    # 330 秒起沿半径飞远并爬升：4.8 公里（40 秒）到 11.8 公里处 3100 米，再到 40 公里处 6000 米。
    east, north = _polar(7, 168)
    path.append(_grid(center, east * 11.8 / 7, north * 11.8 / 7)); heights.append(3100)
    path.append(_grid(center, east * 40 / 7, north * 40 / 7)); heights.append(6000)
    return path, heights


def flight_device():
    return {'id': 'acceptance-adsb', 'name': '流程验收航班接收机', 'kind': 'adsb', 'health': '正常', 'heartbeat': '持续上报',
            'interval': 1, 'rangeKm': 350, 'backgroundFlights': 60, 'stationGuid': STATION_GUID, 'deviceNo': RECEIVER_NO}


def flight_target(variant, center):
    base = {'id': 'flow10-flight', 'kind': 'flight', 'name': '东方航空 CES2471', 'icao24': PLANE[0], 'callsign': PLANE[1],
            'airline': PLANE[2], 'speed': FLIGHT_SPEED, 'deviceId': '', 'planId': ''}
    if variant == 'no_data':
        # 航班在 45 公里外、2600 米盘旋（远在 30 公里提醒范围之外），反制不受它影响；只看接收机断开。
        return dict(base, path=[_grid(center, 45 * math.sin(math.radians(60)), 45 * math.cos(math.radians(60)))],
                    height=2600, motionMode='orbit', orbitRadiusM=3000)
    path, heights = enter_route(center)
    return dict(base, path=path, altitudePath=heights, height=heights[0], motionMode='once')


GUIDE = {
    'enter': {
        'shows': '有报备的无人机偏离航线并停留（同流程 5）。附近有一架民航航班在反制设备周围盘旋，降低高度后飞近，再爬升飞远。',
        'auto_verify': True,
        'before': [
            '本流程是中低风险，不会自动反制；准备有申请或直接反制权限的账号，申请反制还需要另一个有审批权限的账号。',
            '融合感知底部的「民航航班」保持打开，点开反制设备可以看到两个范围圈。',
        ],
        'sees': [
            '开始时地图上显示附近的民航航班；这架航班飞得高，不影响反制。',
            '约 60 秒航班降到 3000 米以下，进入提醒范围：反制弹窗显示「附近有航班」，要勾选确认才能提交。',
            '约 140 秒航班飞近反制设备：正在进行的迫降自动停止，页面弹出提醒，告警详情写明原因；再迫降不能提交，可以改用驱离。',
            '约 370 秒航班爬升到 3000 米以上并飞远，反制恢复正常。',
        ],
        'todo': [
            '约 90 秒对这架无人机发起迫降，勾选「已确认附近航班，继续反制」后提交（迫降每次约 1 分钟，约 140 秒时还在进行才能看到自动停止）。',
            '约 140 秒看迫降自动停止；再点一次迫降，看提交按钮不可用，改选驱离可以提交。',
            '结束后点停止。',
        ],
    },
    'no_data': {
        'shows': '有报备的无人机偏离航线并停留（同流程 5）。航班接收机中途断开 4 分钟，再恢复。',
        'auto_verify': True,
        'before': [
            '本流程是中低风险，不会自动反制；准备有申请或直接反制权限的账号，申请反制还需要另一个有审批权限的账号。',
        ],
        'sees': [
            '开始时航班正常显示，附近没有航班，反制不受影响。',
            '约 60 秒接收机断开，约 60 秒后显示收不到航班信息：反制弹窗要勾选「仍要反制」才能提交，自动反制不会启动。',
            '约 300 秒接收机恢复，反制恢复正常。',
        ],
        'todo': [
            '约 120 秒后发起反制，看反制弹窗显示「暂时收不到航班信息」，勾选「仍要反制」后提交。',
            '结束后点停止。',
        ],
    },
}

STAGES = {
    'enter': ('民航航班在反制设备附近盘旋，降低高度后飞近，再爬升飞远。', [
        (0, '① 航班出现', '地图上显示附近的民航航班；航班飞得高，不影响反制。'),
        (60, '② 进入提醒范围', '不自动反制；勾选「已确认附近航班，继续反制」后可以反制。'),
        (140, '③ 飞进禁止反制范围', '正在进行的迫降自动停止，页面弹出提醒；不能迫降，可以改用驱离。'),
        (370, '④ 航班飞远', '航班爬升离开，反制恢复正常。'),
    ]),
    'no_data': ('航班接收机中途断开 4 分钟，再恢复。', [
        (0, '① 航班正常', '附近没有航班，反制不受影响。'),
        (60, '② 接收机断开', '收不到航班信息：自动反制不启动；人工反制要勾选「仍要反制」。'),
        (300, '③ 接收机恢复', '航班信息恢复，反制恢复正常。'),
    ]),
}

VARIANT_LABEL = {'enter': '航班先靠近，再飞进禁止反制范围', 'no_data': '收不到航班信息'}


def flight_scene(flow5_scene, variant):
    scene = copy.deepcopy(flow5_scene)
    scene['name'] = f'流程 10 · {TITLE}'
    scene['duration'] = 8
    scene['fullchain'].update(acceptanceFlow=10, adsb={'variant': variant})
    for target in scene['targets']:
        target['name'] = '流程 10 偏航无人机'
    # 接收机放在第一台雷达所在的点位：模拟反制设备没填位置时也登记在这里，航线以它为中心。
    site = next((s for s in scene['sites'] if any(d.get('kind') == 'radar' for d in s['devices'])), scene['sites'][0])
    site['devices'].append(flight_device())
    center = [site['x'], site['y']]
    scene['targets'].append(flight_target(variant, center))
    if variant == 'no_data':
        scene['risks'].append({'id': 'flow10-receiver-offline', 'name': '流程 10 接收机断开', 'type': 'offline', 'enabled': True,
                               'deviceId': 'acceptance-adsb', 'at': 60, 'seconds': 240})
    summary, stages = STAGES[variant]
    scene['sceneGuide'] = {'summary': summary, 'startHint': '在融合感知打开底部「民航航班」，点开反制设备看两个范围圈。', 'stages': [
        {'at_seconds': at, 'label': label, 'description': text} for at, label, text in stages]}
    scene['fullchain']['expectedChecks'] = list(GUIDE[variant]['sees'])
    compile_scene(scene)
    return scene


def flight_flow(flow5):
    """由流程 5 生成流程 10 的两种情况；不读写任何文件。"""
    variants = []
    for variant in ('enter', 'no_data'):
        scene = flight_scene(flow5['scene'], variant)
        variants.append({'id': variant, 'label': VARIANT_LABEL[variant], 'scene': scene,
                         'minutes': scene['duration'], 'guide': copy.deepcopy(GUIDE[variant])})
    first = variants[0]
    return {'flow': 10, 'file': flow5['file'], 'name': first['scene']['name'], 'title': TITLE,
            'minutes': first['minutes'], 'scene': first['scene'], 'guide': first['guide'],
            'expectedChecks': list(first['guide']['sees']), 'variants': variants, 'default_variant': 'enter'}
