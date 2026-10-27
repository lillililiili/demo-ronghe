"""流程 10「反制前附近有航班」（2026-10-26 用户确认）：模拟一台 ADS-B 航班接收机和附近的民航航班。

无人机部分沿用流程 5（有报备、偏离航线、中低风险、人工申请反制），这里只加航班：
- enter：一架航班在反制设备附近盘旋等待，降到 3000 米以下进入提醒范围，再飞近进入禁止反制范围，最后爬升飞远。
- no_data：航班接收机中途断开 4 分钟，平台收不到航班信息，再恢复。
航班位置以平台上反制设备的位置为中心计算；能不能反制只由平台判断，这里只送位置。
模拟结束时停用这台模拟接收机，后面别的流程的反制不再受它影响。
"""
import copy
import math

from engine import compile_scene

RECEIVER_NO = 'SIM-ADSB-DY01'
RECEIVER_NAME = '东营 ADS-B 航班接收机（模拟）'
RANGE_KM = 350
REPORT_EVERY = 2
OUTAGE = (60, 300)
DEFAULT_CENTER = (118.614, 37.464)
PREFIX = '/local-interface-simulator/adsb-receiver'

# 远处高空巡航的背景航班：(icao24, 航班号, 航空公司, 起点东向公里, 起点北向公里, 航向度, 高度米, 速度米每秒)
BACKGROUND = [
    ('781D3A', 'CCA1519', '中国国航', -120, 60, 110, 9800, 235),
    ('7808F2', 'CHH7671', '海南航空', 90, 140, 200, 10400, 240),
    ('780B44', 'CDG4703', '山东航空', 150, -40, 285, 8900, 225),
    ('781F09', 'CXA8213', '厦门航空', -60, -130, 20, 10100, 238),
    ('780E61', 'CSN6875', '南方航空', 40, 95, 160, 7600, 220),
]
PLANE = ('780A1B', 'CES2471', '东方航空')


def _offset(center, east_km, north_km):
    lon, lat = center
    return (lon + east_km / (111.32 * math.cos(math.radians(lat))), lat + north_km / 111.32)


def _wrap(value, limit=170):
    """背景航班飞出范围后从另一边再进来，一直有航班可看。"""
    return (value + limit) % (2 * limit) - limit


def _background_xy(row, elapsed):
    _, _, _, east, north, heading, _, speed = row
    distance = speed * elapsed / 1000
    rad = math.radians(heading)
    return _wrap(east + distance * math.sin(rad)), _wrap(north + distance * math.cos(rad))


def _orbit(radius, start_deg, elapsed, speed=110):
    angle = math.radians(start_deg) + speed * elapsed / (radius * 1000)
    return radius * math.sin(angle), radius * math.cos(angle)


def _plane_xy(variant, t):
    """反制设备为原点的位置（公里）和高度（米）。"""
    if variant == 'no_data':
        x, y = _orbit(45, 60, t)
        return x, y, 2600
    # 0–140 秒在 20 公里处盘旋等待：前 50 秒在 3600 米（高于规则高度，不算），62 秒降到 2400 米。
    if t <= 140:
        x, y = _orbit(20, 40, t)
        height = 3600 if t < 50 else max(2400, 3600 - (t - 50) * 100)
        return x, y, height
    # 140–230 秒向反制设备飞近，到 7 公里处。
    sx, sy = _orbit(20, 40, 140)
    ex, ey = sx * 7 / 20, sy * 7 / 20
    if t <= 230:
        k = (t - 140) / 90
        return sx + (ex - sx) * k, sy + (ey - sy) * k, 2400 - 900 * k
    # 230–330 秒在 7 公里处盘旋。
    start = math.degrees(math.atan2(ex, ey))
    if t <= 330:
        x, y = _orbit(7, start, t - 230)
        return x, y, 1500
    # 330 秒以后爬升并飞远。
    hx, hy = _orbit(7, start, 100)
    k = t - 330
    norm = math.hypot(hx, hy) or 1
    return hx + hx / norm * k * 0.2, hy + hy / norm * k * 0.2, min(6000, 1500 + k * 40)


def _sample(xy_at, t):
    x, y, height = xy_at(t)
    nx, ny, _ = xy_at(t + 1)
    track = (math.degrees(math.atan2(nx - x, ny - y)) + 360) % 360
    speed = math.hypot(nx - x, ny - y) * 1000
    return x, y, height, track, speed


def aircraft_at(variant, elapsed, center, observed_at):
    """这一刻接收机收到的航班。no_data 在断开期间返回 None（不送数据）。"""
    if variant == 'no_data' and OUTAGE[0] <= elapsed < OUTAGE[1]:
        return None
    rows = []
    for row in BACKGROUND:
        x, y = _background_xy(row, elapsed)
        lon, lat = _offset(center, x, y)
        rows.append({'icao24': row[0], 'callsign': row[1], 'airline': row[2], 'longitude': round(lon, 6),
                     'latitude': round(lat, 6), 'altitude_m': row[6], 'ground_speed_mps': row[7],
                     'track_deg': row[5], 'observed_at': observed_at})
    x, y, height, track, speed = _sample(lambda t: _plane_xy(variant, t), elapsed)
    lon, lat = _offset(center, x, y)
    rows.append({'icao24': PLANE[0], 'callsign': PLANE[1], 'airline': PLANE[2], 'longitude': round(lon, 6),
                 'latitude': round(lat, 6), 'altitude_m': int(height), 'ground_speed_mps': round(min(speed, 400), 1),
                 'track_deg': round(track, 1), 'observed_at': observed_at})
    return rows


def counter_center(api):
    """平台上启用的反制设备的位置；读不到时用东营默认位置。"""
    try:
        page = api.call('GET', '/devices?page=1&size=50&enabled=true&device_type_code=countermeasure') or {}
    except Exception:
        return DEFAULT_CENTER
    for device in page.get('items') or []:
        if device.get('longitude') is not None and device.get('latitude') is not None:
            return (float(device['longitude']), float(device['latitude']))
    return DEFAULT_CENTER


class AdsbFeed:
    """在全链路模拟的每一拍里送航班位置。"""

    def __init__(self, api, scope, variant):
        self.api, self.scope, self.variant = api, scope, variant
        self.receiver_id = None
        self.center = DEFAULT_CENTER
        self.next_at = 0

    def prepare(self):
        self.center = counter_center(self.api)
        receiver = self.api.call('POST', PREFIX, dict(self.scope, device_no=RECEIVER_NO, name=RECEIVER_NAME,
                                                      longitude=self.center[0], latitude=self.center[1],
                                                      receive_range_km=RANGE_KM))
        self.receiver_id = receiver['device_id']
        return receiver

    def tick(self, elapsed, now):
        if not self.receiver_id or elapsed < self.next_at:
            return 0
        self.next_at = elapsed + REPORT_EVERY
        rows = aircraft_at(self.variant, elapsed, self.center, now)
        if rows is None:
            return 0
        self.api.call('POST', f'{PREFIX}/{self.receiver_id}/aircraft', {'aircraft': rows})
        return len(rows)

    def release(self):
        if self.receiver_id:
            self.api.call('POST', f'{PREFIX}/{self.receiver_id}/release', {})


TITLE = '反制前附近有航班'

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
            '约 60 秒接收机断开，约 30 秒后显示收不到航班信息：反制弹窗要勾选「仍要反制」才能提交，自动反制不会启动。',
            '约 300 秒接收机恢复，反制恢复正常。',
        ],
        'todo': [
            '约 90 秒后发起反制，看反制弹窗显示「暂时收不到航班信息」，勾选「仍要反制」后提交。',
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
    scene['fullchain'].update(acceptanceFlow=10, categories=['adsb'], adsb={'variant': variant})
    for target in scene['targets']:
        target['name'] = '流程 10 偏航无人机'
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
