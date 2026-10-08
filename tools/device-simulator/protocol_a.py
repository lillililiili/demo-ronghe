"""Protocol A 8.6 device-specific fields; no platform business decisions."""
import math

SENSING_TYPES = {'radar': 1, '5ga': 0, 'tdoa': 10, 'aoa': 9, 'dcd': 11, 'rid': 102}
RADIO_TYPES = frozenset(('tdoa', 'aoa', 'dcd'))
IDENTIFIED_TYPES = frozenset(('tdoa', 'dcd', 'rid'))
OBJECT_TYPES = {'unknown': 0, 'person': 3, 'vehicle': 7, 'uav': 30,
                'bird': 40, 'ship': 50, 'remote_controller': 100, 'identifying': 255}


def supports(kind, target_kind):
    if kind in ('radar', '5ga'):
        return target_kind in OBJECT_TYPES
    if kind in ('tdoa', 'aoa'):
        return target_kind in ('uav', 'remote_controller')
    return kind in ('dcd', 'rid') and target_kind == 'uav'


def validate_target(target):
    config = target.get('protocolA', {})
    if not isinstance(config, dict) or set(config) - {'uavModel', 'channel', 'bandWidth', 'reportSn'}:
        raise ValueError('协议 A 测试字段无效')
    for key in ('uavModel', 'channel', 'bandWidth'):
        if key in config and (not isinstance(config[key], str) or not config[key].strip() or len(config[key]) > 128):
            raise ValueError('协议 A ' + key + ' 必须为非空文本（最多128字）')
    if 'reportSn' in config and not isinstance(config['reportSn'], bool):
        raise ValueError('协议 A reportSn 必须为布尔值')


def extension(kind, target, sample, serial, task_id, device_position, pilot_position=None):
    """Defaults are labelled synthetic fixture values, never real identity claims."""
    cfg = target.get('protocolA', {})
    result = {'objectType': OBJECT_TYPES[target['kind']]}
    if kind in ('radar', '5ga'):
        result.update(speedX=sample['speed_x'], speedY=sample['speed_y'], speedZ=sample['speed_z'])
        if 'probability' in target:
            result['probability'] = target['probability']
        if kind == '5ga':
            result['taskId'] = task_id
    else:
        result['uavModel'] = cfg.get('uavModel', 'SIM-UAV')
        if kind in RADIO_TYPES:
            result.update(channel=cfg.get('channel', '5.73'), bandWidth=cfg.get('bandWidth', '10.00'))
        if target['kind'] == 'uav' and kind in IDENTIFIED_TYPES and (kind != 'tdoa' or cfg.get('reportSn', True)):
            if not isinstance(serial, str) or not serial.strip():
                raise ValueError('协议 A 目标缺少模拟 SN')
            result['uavSN'] = serial
        if pilot_position is not None:
            result['pilotLon'], result['pilotLat'] = pilot_position
        if kind == 'aoa':
            lon, lat = device_position
            east = (sample['longitude'] - lon) * math.cos(math.radians((lat + sample['latitude']) / 2))
            north = sample['latitude'] - lat
            if abs(east) + abs(north) < 1e-12:
                raise ValueError('AOA 目标与设备重合，无法生成有效方位角')
            result['direction'] = math.degrees(math.atan2(east, north)) % 360
    return result
