"""Scenario compiler for project MQTT A/C. No business outcomes are fabricated."""
import copy
import math
import re
import time
import protocol_a
from protocol_b import validate_config as validate_protocol_b

KINDS = {**protocol_a.SENSING_TYPES, 'dec': 5, 'ifr': 6, 'bsc': 12, 'weather': 1001, 'countermeasure': 1002}
LABELS = {'radar': '雷达', 'tdoa': 'TDOA', '5ga': '5G-A', 'aoa': 'AOA', 'dcd': '协议破解', 'rid': 'RemoteID', 'dec': '诱骗', 'ifr': '干扰', 'bsc': '驱鸟炮', 'eo': '光电', '5da': '5D-A', 'weather': '气象设备', 'countermeasure': '反制设备'}
HEARTBEAT_KINDS = frozenset((*KINDS, 'eo'))
TARGET_REPORT_KINDS = frozenset(protocol_a.SENSING_TYPES)
RISK_TYPES = {'zone', 'deviation', 'no-plan', 'height', 'time', 'bird', 'balloon', 'offline', 'fault'}
AUXILIARY_DEVICE_RADIUS_METRES = 5000

def number(value, low, high, label):
    try:
        value = float(value)
    except (ValueError, TypeError):
        raise ValueError(label + '必须为数字')
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(label + '超出允许范围')
    return value


def normalize_coverage_config(raw):
    """Validate optional static sensing coverage without inventing defaults."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError('设备覆盖参数必须为对象')
    raw_kind = raw.get('kind', raw.get('coverage_kind', ''))
    kind = str(raw_kind).strip().lower()
    source = raw.get('sourceLabel', raw.get('source_label', ''))
    if not isinstance(source, str) or not source.strip() or len(source.strip()) > 128:
        raise ValueError('设备覆盖参数来源必须为 1–128 个字符')
    source = source.strip()

    def value(name, low, high, label):
        aliases = {'radiusM': 'radius_m', 'rangeM': 'range_m',
                   'azimuthDeg': 'azimuth_deg', 'fovDeg': 'fov_deg'}
        raw_value = raw.get(name, raw.get(aliases[name]))
        if isinstance(raw_value, bool) or raw_value in (None, ''):
            return None
        return number(raw_value, low, high, label)

    if kind == 'circle':
        radius = value('radiusM', 0, 1_000_000, '圆形覆盖半径')
        aliases = {'rangeM': 'range_m', 'azimuthDeg': 'azimuth_deg', 'fovDeg': 'fov_deg'}
        if radius is None or radius <= 0 or any(raw.get(key, raw.get(aliases[key])) not in (None, '')
                                               for key in ('rangeM', 'azimuthDeg', 'fovDeg')):
            raise ValueError('圆形覆盖只允许提供正数 radiusM')
        return {'kind': 'circle', 'radiusM': radius, 'sourceLabel': source}
    if kind == 'sector':
        range_m = value('rangeM', 0, 1_000_000, '扇形覆盖距离')
        azimuth = value('azimuthDeg', 0, 360, '扇形覆盖方位')
        fov = value('fovDeg', 0, 360, '扇形覆盖视场')
        if (range_m is None or range_m <= 0 or azimuth is None or azimuth >= 360
                or fov is None or fov <= 0 or fov > 360
                or raw.get('radiusM', raw.get('radius_m')) not in (None, '')):
            raise ValueError('扇形覆盖需要有效的 rangeM、azimuthDeg 和 fovDeg')
        return {'kind': 'sector', 'rangeM': range_m, 'azimuthDeg': azimuth,
                'fovDeg': fov, 'sourceLabel': source}
    raise ValueError('设备覆盖类型只能为 circle 或 sector')

def coordinates(point):
    return [118.56 + point[0] * .00012, 37.50 - point[1] * .00012]

def metres(a, b):
    a, b = coordinates(a), coordinates(b)
    return math.hypot((b[0]-a[0])*111320*math.cos(math.radians((a[1]+b[1])/2)), (b[1]-a[1])*111320)


def target_path_distance(target, device):
    return min(metres(point, [device['x'], device['y']]) for point in target['path'])


def auto_target_for_risk(risk, targets):
    """Select the simulator observation source without making it a user input."""
    risk_type = risk.get('type')
    target_kind = 'bird' if risk_type == 'bird' else 'balloon' if risk_type == 'balloon' else 'uav'
    candidates = [target for target in targets.values() if target.get('kind') == target_kind]
    if risk_type == 'no-plan':
        candidates = [target for target in candidates if not target.get('planId')]
    elif risk_type in ('deviation', 'time', 'bird', 'balloon') or (
            risk_type == 'height' and risk.get('basis') == 'plan'):
        candidates = [target for target in candidates if target.get('planId') == risk.get('planId')]
    current = targets.get(risk.get('targetId'))
    if current in candidates:
        return current
    return candidates[0] if candidates else None

def target_motion(target, elapsed):
    """Return position and east/north velocity from the same active path segment."""
    point, east, north, _, _ = _motion_sample(target, elapsed)
    return point, east, north


def _motion_sample(target, elapsed):
    """Sample a time-parametrized route; return point, E/N velocity, altitude and climb rate."""
    motion = target.get('_notification_motion') or {}
    if motion.get('suppress'):
        return motion['origin'], 0.0, 0.0, target['height'], 0.0
    departing = bool(motion.get('path'))
    points = motion['path'] if departing else target['path']
    if departing:
        original = dict(target)
        original.pop('_notification_motion', None)
        departure_altitude = _motion_sample(original, motion.get('at_elapsed', 0))[3]
        heights = [departure_altitude] * len(points)
    else:
        heights = target.get('altitudePath') or [target['height']] * len(points)
    speed = motion.get('speed', target['speed']) if departing else target['speed']
    mode = 'once' if departing else target.get('motionMode', 'once')
    dwell = [0] * len(points) if departing else target.get('dwellSeconds') or [0] * len(points)
    elapsed = max(0.0, elapsed - motion.get('at_elapsed', 0)) if departing else max(0.0, elapsed)
    if len(points) == 1 or speed <= 0:
        return points[0], 0.0, 0.0, heights[0], 0.0
    indices = list(range(len(points)))
    if mode == 'loop':
        indices.append(0)
    elif mode == 'pingpong':
        indices.extend(range(len(points) - 2, -1, -1))
    sections = []
    for a, b in zip(indices, indices[1:]):
        sections.append(('hold', a, a, dwell[a]))
        length = metres(points[a], points[b])
        if length:
            sections.append(('move', a, b, length / speed))
    if mode == 'once':
        sections.append(('hold', indices[-1], indices[-1], dwell[indices[-1]]))
    cycle = sum(section[3] for section in sections)
    if cycle == 0:
        return points[-1], 0.0, 0.0, heights[-1], 0.0
    if mode != 'once':
        elapsed %= cycle
    elif elapsed >= cycle:
        return points[-1], 0.0, 0.0, heights[-1], 0.0
    for action, a, b, seconds in sections:
        if elapsed < seconds:
            if action == 'hold':
                return points[a], 0.0, 0.0, heights[a], 0.0
            fraction = elapsed / seconds
            point = [points[a][axis] + fraction * (points[b][axis] - points[a][axis]) for axis in (0, 1)]
            start, end = coordinates(points[a]), coordinates(points[b])
            east = (end[0] - start[0]) * 111320 * math.cos(math.radians((start[1] + end[1]) / 2)) / seconds
            north = (end[1] - start[1]) * 111320 / seconds
            vertical = (heights[b] - heights[a]) / seconds
            return point, east, north, heights[a] + fraction * (heights[b] - heights[a]), vertical
        elapsed -= seconds
    return points[-1], 0.0, 0.0, heights[-1], 0.0


def target_sample(target, elapsed):
    """Geographic observation shared by MQTT and normalized ingestion."""
    point, east, north, altitude, vertical = _motion_sample(target, elapsed)
    longitude, latitude = coordinates(point)
    horizontal = math.hypot(east, north)
    return {'longitude': longitude, 'latitude': latitude, 'altitude': altitude,
            'height_agl': altitude if target.get('altitudeDatum', 'AMSL') == 'AGL' else target.get('heightAgl'),
            'speed_x': east, 'speed_y': north, 'speed_z': vertical,
            'speed': math.hypot(horizontal, vertical),
            'heading': (math.degrees(math.atan2(east, north)) + 360) % 360 if horizontal else 0.0}


def target_reporting(target, elapsed):
    """Both transports honor notification stops and finite silence windows."""
    if (target.get('_notification_motion') or {}).get('suppress'):
        return False
    return not any(window['at'] <= elapsed < window['at'] + window['seconds']
                   for window in target.get('silenceWindows', []))

def position(target, elapsed):
    return target_motion(target, elapsed)[0]

def point_list(points, minimum, label):
    if not isinstance(points, list) or not minimum <= len(points) <= 2000:
        raise ValueError(label + '节点数量无效')
    if any(not isinstance(p,list) or len(p)!=2 for p in points):
        raise ValueError(label+'坐标格式错误')
    result = [[number(p[0], -3_000_000, 3_000_000, label), number(p[1], -2_000_000, 2_000_000, label)] for p in points]
    for point in result:
        lon, lat = coordinates(point)
        number(lon, -180, 180, label+'经度')
        number(lat, -85, 85, label+'纬度')
    return result

def duration_reached(scene, elapsed):
    """Zero explicitly means continuous; finite scenes keep their original deadline."""
    return scene['duration'] > 0 and elapsed >= scene['duration'] * 60


def compile_scene(raw):
    s = copy.deepcopy(raw)
    if not isinstance(s, dict):
        raise ValueError('场景格式错误')
    source_count = s.get('fullchain', {}).get('observationSourceCount', 1)
    if type(source_count) is not int or not 1 <= source_count <= 3:
        raise ValueError('标准化模拟观测来源数量须为 1 至 3 的整数')
    if isinstance(s.get('duration'), bool):
        raise ValueError('时长格式无效')
    s['duration'] = 0 if s.get('duration') == 0 else number(s.get('duration'), .05, 20, '时长')
    for collection in ['sites', 'targets', 'plans', 'zones', 'risks']:
        rows = s.get(collection)
        if not isinstance(rows, list) or len(rows) > 200:
            raise ValueError(collection + '数量无效')
        ids = [x.get('id') for x in rows]
        if any(not isinstance(i, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', i) for i in ids) or len(ids) != len(set(ids)):
            raise ValueError(collection + '编号缺失或重复')
    devices = {}
    seen_devices=set()
    skipped = []
    for site in s['sites']:
        site['x'], site['y'] = point_list([[site['x'], site['y']]], 1, '设备位置')[0]
        if not isinstance(site.get('devices'), list) or len(site['devices']) > 100:
            raise ValueError('设备组数量无效')
        for d in site['devices']:
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', str(d.get('id', ''))) or d['id'] in seen_devices:
                raise ValueError('设备编号缺失或重复')
            seen_devices.add(d['id'])
            if d.get('kind') not in LABELS:
                raise ValueError('未知设备类型')
            d['coverage'] = normalize_coverage_config(d.get('coverage'))
            if d.get('health') not in ('正常', '故障') or d.get('heartbeat') not in ('持续上报', '停止心跳'):
                raise ValueError('设备状态无效')
            if d['kind']=='eo' and d['health']=='故障':
                raise ValueError('光电故障码尚未确认，请使用正常心跳或离线模拟')
            d['interval'] = number(d.get('interval'), 1, 300, '心跳间隔')
            if 'emitEmpty' in d and not isinstance(d['emitEmpty'], bool):
                raise ValueError('空目标帧开关必须为布尔值')
            if 'protocolB' in d:
                d['protocolB'] = validate_protocol_b(d['protocolB'], d['kind'])
            if d['kind'] == '5da' or d.get('send') is False:
                skipped.append(d.get('name', d['id']))
            else:
                devices[d['id']] = dict(d, x=site['x'], y=site['y'])
    if not devices or len(devices) > 100:
        raise ValueError('请配置 1 至 100 台可发送设备')
    plans = {p['id']: p for p in s['plans']}
    zones = {z['id']: z for z in s['zones']}
    targets = {t['id']: t for t in s['targets']}
    for p in s['plans'] + s['zones']:
        minimum = 2 if p['id'] in plans else 3
        valid = point_list(p['points'], minimum, p.get('name', '区域'))
        if len(valid) != len(p['points']):
            raise ValueError('坐标格式错误')
        p['points'] = valid
        p['max'] = number(p['max'], 0, 10000, '高度上限')
        if p.get('altitudeDatum', 'AMSL') not in ('AGL', 'AMSL'):
            raise ValueError('高度基准须为 AGL 或 AMSL')
        for key in ['start', 'end']:
            if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', str(p.get(key, ''))):
                raise ValueError('时间格式须为 HH:mm')
        if p['start'] >= p['end']:
            raise ValueError('结束时间必须晚于开始时间')
        if p['id'] in plans:
            p['min'] = number(p['min'], 0, p['max'], '最低高度')
            p['width'] = number(p['width'], 1, 10000, '走廊宽度')
    for t in targets.values():
        protocol_a.validate_target(t)
        t.pop('_notification_motion', None)  # Imported data cannot inject a runtime trigger.
        behavior = t.get('notificationBehavior', 'none')
        if behavior not in ('none', 'after_sms', 'after_voice', 'hold', 'drop_sms'):
            raise ValueError('通知后的飞行行为无效')
        if behavior != 'none' and t.get('kind') != 'uav':
            raise ValueError('通知后的飞行行为只适用于无人机')
        if behavior in ('after_sms', 'after_voice'):
            t['departurePath'] = point_list(t.get('departurePath'), 1, '撤离航线')
            t['departureSpeed'] = number(t.get('departureSpeed'), .1, 100, '撤离速度')
        t['path'] = point_list(t.get('path'), 1, t.get('name', '目标'))
        if not t['path']:
            raise ValueError('目标轨迹为空')
        t['height'] = number(t.get('height'), 0, 10000, '目标海拔高度')
        if t.get('motionMode', 'once') not in ('once', 'loop', 'pingpong'):
            raise ValueError('轨迹运动方式无效')
        t['motionMode'] = t.get('motionMode', 'once')
        declared_altitude_datum = t.get('altitudeDatum') in ('AMSL', 'AGL')
        if 'altitudeDatum' in t and not declared_altitude_datum:
            raise ValueError('目标高度基准无效')
        if t.get('altitudePath') is not None:
            if not isinstance(t['altitudePath'], list) or len(t['altitudePath']) != len(t['path']):
                raise ValueError('航点高度数量须与轨迹节点一致')
            t['altitudePath'] = [number(value, 0, 10000, '航点高度') for value in t['altitudePath']]
        if t.get('dwellSeconds') is not None:
            if not isinstance(t['dwellSeconds'], list) or len(t['dwellSeconds']) != len(t['path']):
                raise ValueError('航点停留数量须与轨迹节点一致')
            t['dwellSeconds'] = [number(value, 0, 86400, '航点停留时间') for value in t['dwellSeconds']]
        windows = t.get('silenceWindows', [])
        if not isinstance(windows, list) or len(windows) > 100:
            raise ValueError('暂停上报时段无效')
        for window in windows:
            if not isinstance(window, dict):
                raise ValueError('暂停上报时段无效')
            window['at'] = number(window.get('at'), 0, 86400, '暂停开始时间')
            window['seconds'] = number(window.get('seconds'), .1, 86400, '暂停持续时间')
            if window['at'] + window['seconds'] > 86400:
                raise ValueError('暂停上报时段不能超过一天')
        t['silenceWindows'] = windows
        if t.get('pilotPoint') is not None:
            t['pilotPoint'] = point_list([t['pilotPoint']], 1, '模拟飞手位置')[0]
        for key, limit, label in [('heightAgl', 10000, '模拟离地高度'), ('probability', 1, '模拟识别概率')]:
            if t.get(key) not in (None, ''):
                t[key] = number(t[key], 0, limit, label)
            else:
                t.pop(key, None)
        t['speed'] = number(t.get('speed'), 0, 100, '目标速度')
        t['count'] = number(t.get('count',1), 1, 100, '目标数量')
        if not t['count'].is_integer(): raise ValueError('目标数量必须为整数')
        if t.get('kind') not in ('uav', 'bird', 'balloon'):
            if t.get('kind') not in ('unknown', 'identifying', 'person', 'vehicle', 'ship', 'remote_controller'):
                raise ValueError('未知目标类型')
        # Infer a channel only when absent. Export/import must preserve an
        # explicit channel and must not invent an AMSL datum for protocol A.
        default_transport = 'normalized' if t['kind'] == 'balloon' or declared_altitude_datum else 'mqtt'
        if t.get('transport', default_transport) not in ('mqtt', 'normalized'):
            raise ValueError('目标上报通道无效')
        t['transport'] = t.get('transport', default_transport)
        if t['transport'] == 'normalized':
            t.setdefault('altitudeDatum', 'AMSL')  # Existing normalized-scene default.
        if t['kind'] == 'balloon' and t['transport'] != 'normalized':
            raise ValueError('气球须通过规范化观测入口上报')
        if t.get('altitudeDatum') == 'AGL' and t['transport'] != 'normalized':
            raise ValueError('AGL 高度须通过规范化观测入口上报')
        source = devices.get(t.get('deviceId'))
        if not source or source['kind'] not in TARGET_REPORT_KINDS:
            raise ValueError(t.get('name', '目标') + '：须选择已启用的协议 A 感知设备')
        if t['transport'] == 'mqtt' and not protocol_a.supports(source['kind'], t['kind']):
            raise ValueError(t.get('name', '目标') + '：该设备协议不支持此目标类别')
        secondary = t.get('secondaryDeviceId')
        if secondary and (secondary == t['deviceId'] or secondary not in devices):
            raise ValueError(t.get('name', '目标') + '：辅助上报设备须为另一台已启用的周边设备')
        if secondary and target_path_distance(t, devices[secondary]) > AUXILIARY_DEVICE_RADIUS_METRES:
            raise ValueError(t.get('name', '目标') + '：辅助上报设备须位于目标轨迹周边 5 公里内')
    active = []
    for r in s['risks']:
        if not r.get('enabled'):
            continue
        if r['type'] not in RISK_TYPES:
            raise ValueError('未知风险类型')
        if r['type'] in ('offline', 'fault'):
            if r.get('deviceId') not in devices:
                raise ValueError(r['name'] + '：关联设备未启用或协议未接入')
            window = s['duration'] * 60 if s['duration'] else 86400
            r['at'] = number(r.get('at'), 0, window, '触发时间')
            r['seconds'] = number(r.get('seconds'), 1, window, '持续时间')
            if r['at']+r['seconds'] > window:
                raise ValueError(r['name'] + '超出任务时长')
            if r['type'] == 'fault' and devices[r['deviceId']]['kind'] == 'eo':
                raise ValueError('光电故障码未确认；可模拟光电离线，不能伪造故障码')
        else:
            t = auto_target_for_risk(r, targets)
            if not t:
                raise ValueError(r['name'] + '需要目标观测输入；风险由平台根据目标位置、航线、空域和时间规则自动判定')
            # Keep the match as an internal simulator fixture detail. The
            # business risk still uses the plan/airspace reference and the
            # platform determines the final target association from reports.
            r['targetId'] = t['id']
            r['deviceId'] = t['deviceId']
            if devices[r['deviceId']]['kind'] not in TARGET_REPORT_KINDS:
                raise ValueError(r['name'] + '须选择支持目标上报的雷达或 TDOA')
            if r['deviceId'] != t['deviceId']:
                raise ValueError(r['name'] + '：关联设备须与目标上报设备一致')
            if r['type'] == 'no-plan' and t.get('planId'):
                raise ValueError('无任务场景的目标不能关联任务')
            if r['type'] in ('zone', 'height') and r.get('basis') != 'plan' and r.get('zoneId') not in zones:
                raise ValueError(r['name'] + '缺少区域')
            if r['type'] in ('deviation', 'time', 'bird', 'balloon') or r['type'] == 'height' and r.get('basis') == 'plan':
                if r.get('planId') not in plans:
                    raise ValueError(r['name'] + '缺少任务')
            if r['type'] == 'height':
                base = plans[r['planId']] if r.get('basis') == 'plan' else zones[r['zoneId']]
                t['height'] = number(t.get('height'), 0, 10000, '目标高度')
                if t['height'] <= base['max']:
                    raise ValueError('超高场景的目标高度必须大于依据上限')
            if r['type'] == 'time':
                r['offset'] = number(r.get('offset'), 1, 1440, '超出时长')
                if r.get('mode') not in ('开始前提前飞行','结束后继续飞行'): raise ValueError('时间场景无效')
            active.append((r, t))
    return s, devices, targets, skipped

def messages(scene, devices, targets, manifest, elapsed, now, last_sent, sequence):
    out = []
    active_risks = [r for r in scene['risks'] if r.get('enabled')]
    for device_id, d in devices.items():
        faults = [r for r in active_risks if r['type'] in ('offline', 'fault') and r['deviceId'] == device_id and r['at'] <= elapsed < r['at']+r['seconds']]
        offline = d['heartbeat'] == '停止心跳' or any(r['type'] == 'offline' for r in faults)
        if offline:
            continue  # stop all reports, since either report may refresh platform last_seen
        entry = manifest['devices'][device_id]
        external = entry['external_id']
        if elapsed-last_sent.get(device_id, -1000) >= d['interval']:
            kind = d['kind']
            if kind not in HEARTBEAT_KINDS:
                # 未确认上报报文的模拟器对象可以登记和调测，但不伪造设备工参。
                last_sent[device_id] = elapsed
                continue
            if kind == 'eo':
                payload = {'event': 'HeartBeat', 'edgeId': entry['edge_id'], 'timestamp': now,
                           'metadata': {'deviceId': external, 'codeStatus': 200, 'workState': 0, 'cameraStatus': {}}}
                topic = 'iot-reporting/cmlc/edge/' + entry['edge_id']
            else:
                lon, lat = coordinates([d['x'], d['y']])
                payload = {'providerCode': manifest['provider'], 'deviceId': external, 'deviceName': d['name'],
                           'deviceType': KINDS[kind], 'workState': 2 if d['health']=='故障' or any(r['type']=='fault' for r in faults) else 1,
                           'ptTime': now, 'deviceLongitude': lon, 'deviceLatitude': lat, 'deviceAltitude': 0}
                topic = f"bridge/{manifest['provider']}/device/{kind}/{external}"
            out.append((topic, payload))
            last_sent[device_id] = elapsed
        objects = []
        for index, t in enumerate(targets.values(), 1):
            if (t.get('_notification_motion') or {}).get('suppress'): continue
            if not target_reporting(t, elapsed): continue
            # MQTT 目标由主、辅设备各自上报。规范化观测的目标由主设备走规范化入口，选了辅助上报设备时辅助设备照常发 MQTT 目标报文：
            # 平台要看到两路来源，融合置信度才够研判；只有一路时只能判“不可判定”，不出告警。
            normalized = t['transport'] != 'mqtt'
            if device_id not in ((t.get('secondaryDeviceId'),) if normalized else (t['deviceId'], t.get('secondaryDeviceId'))):
                continue
            if not protocol_a.supports(d['kind'], t['kind']):
                continue
            sample = target_sample(t, elapsed)
            # 辅助设备报的离地高度与规范化观测一致（AGL 目标按逐航点高度），两路不打架。
            height = sample['height_agl'] if normalized else t.get('heightAgl')
            lon, lat = sample['longitude'], sample['latitude']
            ext = protocol_a.extension(d['kind'], t, sample, manifest['targets'][t['id']].get('uav_sn'),
                manifest.get('batch', 'sim') + '-' + device_id, coordinates([d['x'], d['y']]),
                coordinates(t['pilotPoint']) if t.get('pilotPoint') is not None else None)
            for member in range(int(t['count']) if t['kind']=='bird' else 1):
                objects.append({'objectId': str(index*1000+member), 'time': now, 'longitude': lon+member%10*.00002, 'latitude': lat+member//10*.00002,
                                'altitude': sample['altitude'], 'speed': sample['speed'], 'extension': ext,
                                **({'height': height} if height is not None else {})})
        # Only the confirmed target-reporting device protocols emit target objects.
        # EO, weather, and countermeasure devices remain selectable as nearby
        # auxiliary devices but their own protocol payloads must not be invented.
        if (objects or d.get('emitEmpty', False)) and d['kind'] in TARGET_REPORT_KINDS:
            out.append((f"bridge/{manifest['provider']}/device_data/{d['kind']}/{external}",
                        {'deviceId': external, 'ptTime': now, 'msgCnt': sequence % 2147483648, 'objects': objects}))
    return out
