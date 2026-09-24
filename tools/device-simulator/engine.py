"""Scenario compiler for project MQTT A/C. No business outcomes are fabricated."""
import copy
import math
import re
import time

KINDS = {'radar': 1, 'tdoa': 10, '5ga': 0}
LABELS = {'radar': '雷达', 'tdoa': 'TDOA', '5ga': '5G-A', 'eo': '光电', '5da': '5D-A', 'weather': '气象设备'}
RISK_TYPES = {'zone', 'deviation', 'no-plan', 'height', 'time', 'bird', 'balloon', 'offline', 'fault'}

def number(value, low, high, label):
    try:
        value = float(value)
    except (ValueError, TypeError):
        raise ValueError(label + '必须为数字')
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(label + '超出允许范围')
    return value

def coordinates(point):
    return [118.56 + point[0] * .00012, 37.50 - point[1] * .00012]

def metres(a, b):
    a, b = coordinates(a), coordinates(b)
    return math.hypot((b[0]-a[0])*111320*math.cos(math.radians((a[1]+b[1])/2)), (b[1]-a[1])*111320)

def position(target, elapsed):
    motion = target.get('_notification_motion') or {}
    if motion.get('suppress'): return motion['origin']
    points = motion.get('path') or target['path']
    distance = max(0, elapsed-motion.get('at_elapsed', 0)) * motion.get('speed', target['speed']) if motion.get('path') else elapsed * target['speed']
    for a, b in zip(points, points[1:]):
        length = metres(a, b)
        if length > distance:
            u = distance / length
            return [a[0]+u*(b[0]-a[0]), a[1]+u*(b[1]-a[1])]
        distance -= length
    return points[-1]

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

def compile_scene(raw):
    s = copy.deepcopy(raw)
    if not isinstance(s, dict):
        raise ValueError('场景格式错误')
    s['duration'] = number(s.get('duration'), .05, 20, '时长')
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
            if d.get('health') not in ('正常', '故障') or d.get('heartbeat') not in ('持续上报', '停止心跳'):
                raise ValueError('设备状态无效')
            if d['kind']=='eo' and d['health']=='故障':
                raise ValueError('光电故障码尚未确认，请使用正常心跳或离线模拟')
            d['interval'] = number(d.get('interval'), 1, 300, '心跳间隔')
            if d['kind'] in ('5da', 'weather') or d.get('send') is False:
                skipped.append(d.get('name', d['id']))
            else:
                devices[d['id']] = dict(d, x=site['x'], y=site['y'])
    if not devices or len(devices) > 100:
        raise ValueError('请配置 1 至 100 台可发送设备：雷达、TDOA、光电（5D-A 与气象协议待接入）')
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
            raise ValueError('未知目标类型')
    active = []
    for r in s['risks']:
        if not r.get('enabled'):
            continue
        if r['type'] not in RISK_TYPES:
            raise ValueError('未知风险类型')
        if r.get('deviceId') not in devices:
            raise ValueError(r['name'] + '：关联设备未启用或协议未接入')
        if r['type'] in ('offline', 'fault'):
            r['at'] = number(r.get('at'), 0, s['duration']*60, '触发时间')
            r['seconds'] = number(r.get('seconds'), 1, s['duration']*60, '持续时间')
            if r['at']+r['seconds'] > s['duration']*60:
                raise ValueError(r['name'] + '超出任务时长')
            if r['type'] == 'fault' and devices[r['deviceId']]['kind'] == 'eo':
                raise ValueError('光电故障码未确认；可模拟光电离线，不能伪造故障码')
        else:
            t = targets.get(r.get('targetId'))
            if not t:
                raise ValueError(r['name'] + '缺少关联目标')
            if t['kind'] == 'balloon':
                raise ValueError('现有 MQTT 目标协议无气球分类码，不能当鸟群或未知目标发送')
            if devices[r['deviceId']]['kind'] not in KINDS:
                raise ValueError(r['name'] + '须选择支持目标上报的雷达或 TDOA')
            secondary = t.get('secondaryDeviceId')
            if secondary and (secondary == r['deviceId'] or secondary not in devices or devices[secondary]['kind'] not in KINDS):
                raise ValueError(r['name'] + '辅助上报设备须为另一台已启用的雷达、TDOA 或 5G-A')
            if r['type'] == 'no-plan' and t.get('planId'):
                raise ValueError('无计划场景的目标不能关联计划')
            if r['type'] in ('zone', 'height') and r.get('basis') != 'plan' and r.get('zoneId') not in zones:
                raise ValueError(r['name'] + '缺少区域')
            if r['type'] in ('deviation', 'time', 'bird') or r['type'] == 'height' and r.get('basis') == 'plan':
                if r.get('planId') not in plans:
                    raise ValueError(r['name'] + '缺少计划')
            if r['type'] == 'height':
                base = plans[r['planId']] if r.get('basis') == 'plan' else zones[r['zoneId']]
                t['height'] = number(r.get('height'), 0, 10000, '超高高度')
                if t['height'] <= base['max']:
                    raise ValueError('超高场景高度必须大于依据上限')
            if r['type'] == 'time':
                r['offset'] = number(r.get('offset'), 1, 1440, '超出时长')
                if r.get('mode') not in ('开始前提前飞行','结束后继续飞行'): raise ValueError('时间场景无效')
            active.append((r, t))
    # One device and one coherent identity per target; reject conflicting sources instead of overwriting.
    linked = {}
    for r, t in active:
        if t['id'] in linked and linked[t['id']]['deviceId'] != r['deviceId']:
            raise ValueError(t['name'] + '被不同风险指定了不同上报设备')
        linked[t['id']] = dict(t, deviceId=r['deviceId'])
    if not any(r.get('enabled') for r in s['risks']):
        raise ValueError('请勾选本次运行的风险场景')
    return s, devices, linked, skipped

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
            if device_id not in (t['deviceId'], t.get('secondaryDeviceId')):
                continue
            lon, lat = coordinates(position(t, elapsed))
            ext = {'objectType': 30 if t['kind']=='uav' else 40}
            if 'probability' in t:
                ext['probability'] = t['probability']
            if t['kind'] == 'uav':
                ext['uavSN'] = manifest['targets'][t['id']]['uav_sn']
                if t.get('pilotPoint') is not None:
                    ext['pilotLon'], ext['pilotLat'] = coordinates(t['pilotPoint'])
            for member in range(int(t['count']) if t['kind']=='bird' else 1):
                objects.append({'objectId': index*1000+member, 'time': now, 'longitude': lon+member%10*.00002, 'latitude': lat+member//10*.00002,
                                'altitude': t['height'], 'extension': ext,
                                **({'height': t['heightAgl']} if 'heightAgl' in t else {})})
        if objects and d['kind'] in KINDS:
            out.append((f"bridge/{manifest['provider']}/device_data/{d['kind']}/{external}",
                        {'deviceId': external, 'ptTime': now, 'msgCnt': sequence, 'objects': objects}))
    return out
