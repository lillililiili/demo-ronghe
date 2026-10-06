"""Editable, linked input scenes. Contains no fabricated platform outcomes."""
import copy

CATEGORIES = {'uav': '无人机与飞行情形', 'bird': '单鸟与鸟群', 'unknown': '未知类别',
              'identifying': '识别中', 'balloon': '气球', 'person': '人员', 'vehicle': '车辆',
              'ship': '船舶', 'remote_controller': '遥控器', 'weather': '气象实测、预报与预警',
              'airspaces': '五类空域', 'device_faults': '设备故障与离线'}


def allocate_identities(scene, batch):
    return {t['id']: {'external_id': batch + '-t' + str(i),
                      **({'uav_sn': t.get('uavSn') or batch + '-u' + str(i)} if t['kind'] == 'uav' else {})}
            for i, t in enumerate(scene['targets'], 1)}


def full_scene(categories=None):
    selected = set(CATEGORIES if categories is None else categories)
    if not selected or selected - CATEGORIES.keys():
        raise ValueError('请选择有效的数据分类')
    scene = {'version': 1, 'name': '全量关联场景 · 正常与异常并行', 'duration': 0,
             'fullchain': {'enabled': True, 'categories': sorted(selected), 'weatherInterval': 5,
                           'notificationPolicy': 'success', 'filing': {},
                           'weather': {'longitude':118.61,'latitude':37.464,'temperature_c':22,
                            'wind_speed_ms':6,'gust_ms':11,'wind_from_degrees':90,'humidity_percent':65,
                            'pressure_hpa':1013,'precipitation_mm':0,'visibility_m':8000,
                            'area_name':'东营全量模拟区域','summary':'模拟多云转大风'},
                           'airspaceLifecycle': True},
             'sites': [], 'plans': [], 'zones': [], 'targets': [], 'risks': []}
    device_specs = [
        ('radar', '正常雷达', {'kind': 'circle', 'radiusM': 8000, 'sourceLabel': '全量模拟场景配置'}),
        ('tdoa', '身份探测', None),
        ('5ga', '5G-A探测', None),
        ('eo', '光电跟踪', {'kind': 'sector', 'rangeM': 6000, 'azimuthDeg': 0, 'fovDeg': 120,
                            'sourceLabel': '全量模拟场景配置'}),
        ('radar-fault', '独立故障雷达', {'kind': 'circle', 'radiusM': 8000, 'sourceLabel': '全量模拟场景配置'}),
        ('radar-offline', '独立离线雷达', {'kind': 'circle', 'radiusM': 8000, 'sourceLabel': '全量模拟场景配置'}),
    ]
    scene['sites'] = [{'id': 'full-site', 'name': '全量模拟设备组', 'x': 420, 'y': 300,
                      'devices': [{'id': key, 'kind': key.split('-')[0], 'name': name,
                                   'health': '正常', 'heartbeat': '持续上报', 'interval': 2,
                                   **({'coverage': coverage} if coverage else {})}
                                  for key, name, coverage in device_specs]}]

    def target(key, name, kind, x, y, **fields):
        row = {'id': key, 'name': name, 'kind': kind, 'path': [[x,y],[x+24,y],[x+24,y+18],[x,y+18]],
               'motionMode': 'loop', 'height': 80, 'heightAgl': 60, 'altitudeDatum': 'AMSL',
               'speed': 4, 'count': 1, 'probability': .98, 'planId': '',
               'deviceId': 'tdoa' if kind == 'uav' else 'radar', 'notificationBehavior': 'none',
               # 无人机由 TDOA 和雷达两路上报：只有一路时平台融合置信度不够，研判只能“不可判定”，异常飞行也不出告警。
               **({'secondaryDeviceId': 'radar'} if kind == 'uav' else {}), **fields}
        if kind == 'uav': row['pilotPoint'] = [x-5,y-5]
        scene['targets'].append(row)
        return row

    def plan(row, suffix='', **fields):
        key = row['id'] + '-plan' + suffix
        scene['plans'].append({'id': key, 'name': row['name']+'配套计划',
            'points': copy.deepcopy(row['path']) + [copy.deepcopy(row['path'][0])],
            'min': 20, 'max': 150, 'width': 120, 'start': '00:00', 'end': '23:59',
            'altitudeDatum': 'AMSL', **fields})
        row['planId'] = key

    if 'uav' in selected:
        for i, (key, name) in enumerate([('normal','正常巡航'),('deviation','偏航'),
                ('prohibited','进入禁飞区'),('height','超高'),('overtime','超出计划时段'),
                ('unplanned','无计划'),('departure','通知后撤离'),('lost','停报后恢复')]):
            row = target(key, name, 'uav', 120 + i * 72, 170,
                         transport='normalized' if key in ('height','overtime','normal') else 'mqtt')
            if key != 'unplanned': plan(row, timeMode='past' if key == 'overtime' else 'current')
            if key == 'height': row.update(height=200, altitudePath=[180,220,220,180], heightAgl=180)
            if key == 'deviation':
                row['path'] = [[192,170],[216,170],[245,190],[245,220]]
                row['motionMode'] = 'pingpong'
            if key == 'departure':
                row.update(notificationBehavior='after_sms', departurePath=[[580,100],[600,70]], departureSpeed=8)
            if key == 'lost': row['silenceWindows'] = [{'at': 45, 'seconds': 150}]
            risk_type = {'deviation':'deviation','prohibited':'zone','height':'height','overtime':'time','unplanned':'no-plan'}.get(key)
            if risk_type:
                scene['risks'].append({'id':'risk-'+key,'name':name,'type':risk_type,'enabled':True,
                    'targetId':key,'deviceId':row['deviceId'],'planId':row['planId'],
                    **({'basis':'plan'} if key=='height' else {}),
                    **({'zoneId':'zone-prohibited'} if key=='prohibited' else {}),
                    **({'mode':'结束后继续飞行','offset':5} if key=='overtime' else {})})
    for i, kind in enumerate(['bird','unknown','identifying','balloon','person','vehicle','ship','remote_controller']):
        if kind not in selected: continue
        row=target(kind, CATEGORIES[kind], kind, 130+i*72, 400,
                   speed=1 if kind in ('person','remote_controller','balloon') else 4,
                   transport='normalized' if kind=='balloon' else 'mqtt',
                   height=0 if kind in ('person','vehicle','ship','remote_controller') else 80,
                   heightAgl=0 if kind in ('person','vehicle','ship','remote_controller') else 60)
        if kind in ('bird','balloon'):
            plan(row)
            scene['risks'].append({'id':'risk-'+kind,'name':row['name']+'邻近航线','type':kind,
                                  'enabled':True,'targetId':row['id'],'deviceId':row['deviceId'],'planId':row['planId']})
        if kind=='bird':
            flock=target('flock','鸟群（5只）','bird', 130,470,count=5)
            plan(flock)
    if 'airspaces' in selected or any(r['type']=='zone' for r in scene['risks']):
        for i, (code,name) in enumerate([('PERMITTED','允许区'),('RESTRICTED','限制区'),
                ('PROHIBITED','禁飞区'),('ALTITUDE_LIMIT','限高区'),('TEMPORARY_CONTROL','临时管制区')]):
            x=260 if code=='PROHIBITED' else 110+i*140
            scene['zones'].append({'id':'zone-'+('prohibited' if code=='PROHIBITED' else code.lower()),
                'name':name,'kindCode':code,'points':[[x,155],[x+65,155],[x+65,215],[x,215]],
                'max':120 if code=='ALTITUDE_LIMIT' else 300,'min':0,'altitudeDatum':'AMSL',
                'start':'00:00','end':'23:59'})
    if 'weather' in selected and not scene['plans']:
        row={'id':'weather-anchor','name':'气象关联','path':[[420,280],[460,280]],'planId':''}
        plan(row)
    if 'device_faults' in selected:
        for kind, device, start, seconds in [('fault','radar-fault',20,100),('offline','radar-offline',40,140)]:
            scene['risks'].append({'id':'risk-'+kind,'name':'独立设备'+kind,'type':kind,
                                  'deviceId':device,'enabled':True,'at':start,'seconds':seconds})
    return scene
