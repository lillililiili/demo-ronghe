"""Item-2 input scenes only. Business outcomes are always produced by the platform."""
import copy
import json
from pathlib import Path


def business(name, prohibited=True):
    devices = [dict(id='item2-'+kind, name='第二条模拟 '+kind, kind=kind,
                    health='正常', heartbeat='持续上报', interval=1)
               for kind in ('tdoa', 'ifr', 'eo', 'radar')]
    devices[1]['protocolB'] = dict(enabled=True, response='success')
    devices[2]['coverage'] = dict(kind='circle', radiusM=5000, sourceLabel='第二条模拟覆盖配置')
    path = [[470, 300], [474, 300]] if prohibited else [[530, 300], [534, 300]]
    route_id = 'item2-route' if prohibited else 'item2-legal-route'
    target_id = 'item2-uav' if prohibited else 'item2-legal-uav'
    zones = [dict(id='item2-permitted', name='第二条模拟允许空域', kindCode='PERMITTED',
                  points=[[420,250],[580,250],[580,360],[420,360]], min=0, max=300,
                  altitudeDatum='AMSL', start='00:00', end='23:59')]
    if prohibited:
        zones.append(dict(id='item2-prohibited', name='第二条模拟禁飞空域', kindCode='PROHIBITED',
                          points=[[465,295],[480,295],[480,307],[465,307]], min=0, max=150,
                          altitudeDatum='AMSL', start='00:00', end='23:59'))
    return dict(version=1, name=name, duration=15,
                sites=[dict(id='item2-site', name='第二条模拟设备组', x=450, y=300, devices=devices)],
                targets=[dict(id=target_id, name='第二条模拟无人机', kind='uav', deviceId='item2-tdoa',
                              path=path, height=100, heightAgl=60, altitudeDatum='AMSL', speed=1,
                              probability=.99, motionMode='pingpong', transport='normalized',
                              pilotPoint=[path[0][0]-2,299], planId=route_id, notificationBehavior='none')],
                plans=[dict(id=route_id, name='第二条模拟航线', points=copy.deepcopy(path),
                            min=0, max=150, width=100, start='00:00', end='23:59',
                            timeMode='current', altitudeDatum='AMSL')],
                zones=zones, risks=[], fullchain=dict(enabled=True, categories=[], filing={},
                                                    observationSourceCount=3, airspaceLifecycle=False))


def samples():
    result = {'01-normalized-legal': business('B01 标准化输入·合法基线', False),
              '02-normalized-disposal': business('B02 标准化输入·处置移送主链')}
    for key, behavior in [('03-after-sms', 'after_sms'), ('04-after-voice', 'after_voice'),
                          ('05-stop-reports', 'drop_sms')]:
        scene = business(key+'·通知后位置观察')
        scene['targets'][0].update(notificationBehavior=behavior,
                                   departurePath=[[500,300],[510,300]], departureSpeed=15)
        if behavior in ('after_sms', 'after_voice'):
            # Departure observes every airspace at the origin. Keep this
            # scene outside the main scene's overlapping permitted area.
            route = 'notification-exit-route'
            path = [[679.8,300], [679.9,300]]
            scene['targets'][0].update(path=path, pilotPoint=[678,299], planId=route,
                                       departurePath=[[700,300],[710,300]])
            scene['plans'][0].update(id=route, name='模拟通知撤离航线', points=copy.deepcopy(path))
            zone = scene['zones'][-1]
            zone.update(id='notification-exit-prohibited', name='模拟通知撤离专用禁飞空域',
                        points=[[665,295],[680,295],[680,307],[665,307]])
            scene['zones'] = [zone]
        result[key] = scene
    scene = business('B06 协议 A MQTT·未知高度基准必须保留')
    scene['targets'][0].update(transport='mqtt', protocolA=dict(uavModel='ITEM2-MODEL', reportSn=True))
    scene['targets'][0].pop('altitudeDatum')
    result['06-mqtt-height-unknown'] = scene
    scene = copy.deepcopy(scene)
    scene['name'] = 'B06 协议 A MQTT·缺少序列号'
    scene['targets'][0]['protocolA']['reportSn'] = False
    result['07-mqtt-no-sn'] = scene
    for key, kind in [('08-device-fault', 'fault'), ('09-device-offline', 'offline')]:
        scene = business(key+'·独立设备恢复核验', False)
        # An already matched flight does not show the existing preflight check.
        # Keep a separate, unmatched plan; operators set its future HH:mm window
        # before importing, without changing the platform's visibility rules.
        check_plan = copy.deepcopy(scene['plans'][0])
        check_plan.update(id='item2-maintenance-route', name='第二条模拟运维检查航线',
                          start='23:00', end='23:59')
        scene['plans'].append(check_plan)
        scene['risks'] = [dict(id='item2-'+kind, name='第二条独立设备异常', type=kind,
                               enabled=True, deviceId='item2-radar', at=10, seconds=60)]
        result[key] = scene
    result['10-eo-video'] = business('E01/V01 光电跟踪与动态测试视频')
    for mode in ('failure', 'no_receipt', 'late', 'duplicate'):
        scene = business('B08 处置回执·'+mode)
        config = scene['sites'][0]['devices'][1]['protocolB']
        if mode in ('failure', 'no_receipt'): config['response'] = mode
        if mode == 'late': config['delayMs'] = 120000
        if mode == 'duplicate': config['duplicateCount'] = 1
        result['b-'+mode] = scene
    return result


def notification_configs():
    """Existing realtime-control payloads; not notification qualification data."""
    base = dict(mode='normal', continuous=True, notifications_enabled=True,
                countermeasure_enabled=False, countermeasure_scope='',
                command_mode='success', play_seconds=3,
                outcomes=dict(ADVISORY_SMS='success', ADVISORY_VOICE='success',
                              UAV_PUNISHMENT='success'))
    result = {'normal': base}
    for name, kind, mode in [('sms-failed', 'ADVISORY_SMS', 'failed'),
                             ('sms-no-receipt', 'ADVISORY_SMS', 'no_receipt'),
                             ('voice-answered-only', 'ADVISORY_VOICE', 'answered_only'),
                             ('voice-delayed', 'ADVISORY_VOICE', 'delayed'),
                             ('handoff-no-receipt', 'UAV_PUNISHMENT', 'no_receipt')]:
        config = copy.deepcopy(base)
        config['mode'] = 'abnormal'
        config['outcomes'][kind] = mode
        result[name] = config
    return result


def write(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, scene in samples().items():
        (directory/(name+'.json')).write_text(json.dumps(scene, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    configs = directory/'notification-configs'
    configs.mkdir(exist_ok=True)
    for name, config in notification_configs().items():
        (configs/(name+'.json')).write_text(json.dumps(config, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    write(Path(__file__).parent/'scenarios'/'item2')
