"""Build importable K03 input scenes; no service calls, database access or result seeding."""
import argparse
import copy
import json
import math
from pathlib import Path
import re
import uuid

from engine import compile_scene

CASES = {'avoid': '接近后转向避开', 'silence': '接近后停止目标上报', 'enter': '继续飞行并实测入区'}


def build_scenes(longitude=118.62, latitude=37.45, speed=20.0, entry_seconds=90.0,
                 action_seconds=80.0, duration_seconds=180.0, identity=None):
    """Coordinates identify a configurable west boundary, never a business target or special case."""
    values = (longitude, latitude, speed, entry_seconds, action_seconds, duration_seconds)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
        raise ValueError('坐标、速度和时长须为有限数字')
    if not -179 < longitude < 179 or not -80 < latitude < 80:
        raise ValueError('请使用非极区且不跨日期变更线的 WGS84 位置')
    if not 5 <= speed <= 40 or not 60 <= entry_seconds <= 120:
        raise ValueError('速度须为 5 至 40 m/s，预计抵达边界时间须为 60 至 120 秒')
    if not entry_seconds - 20 <= action_seconds <= entry_seconds - 8:
        raise ValueError('转向／断流应在到达边界前 8 至 20 秒')
    if not entry_seconds + 60 <= duration_seconds <= 600:
        raise ValueError('场景须持续到预计抵达边界后至少 60 秒，最多 600 秒')
    token = identity or uuid.uuid4().hex[:12]
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', token):
        raise ValueError('场景包标识须为 1 至 32 位字母、数字、下划线或短横线')

    def point(east, north):
        lon = longitude + east / (111320 * math.cos(math.radians(latitude)))
        lat = latitude + north / 111320
        # Version-1 scene coordinates are the existing simulator's reversible WGS84 grid.
        return [(lon - 118.56) / .00012, (37.50 - lat) / .00012]

    radar, tdoa = f'radar-{token}', f'tdoa-{token}'
    start = point(-speed * entry_seconds, 0)
    corner = point(-speed * (entry_seconds - action_seconds), 0)
    zone_depth = max(1000, speed * 40)
    site = point(-speed * entry_seconds / 2, -150)
    common = {'version': 1, 'coordinate_system': 'WGS84', 'duration': duration_seconds / 60,
        'sites': [{'id': f'site-{token}', 'name': 'K03 模拟观测设备组', 'x': site[0], 'y': site[1],
            'coordinate_system': 'WGS84', 'devices': [
                {'id': radar, 'name': 'K03 模拟雷达', 'kind': 'radar', 'health': '正常', 'heartbeat': '持续上报', 'interval': 1},
                {'id': tdoa, 'name': 'K03 模拟 TDOA', 'kind': 'tdoa', 'health': '正常', 'heartbeat': '持续上报', 'interval': 1}]}],
        'zones': [{'id': f'prohibited-{token}', 'name': 'K03 模拟禁飞区', 'kindCode': 'PROHIBITED',
            'coordinate_system': 'WGS84', 'points': [point(0, -500), point(zone_depth, -500), point(zone_depth, 500), point(0, 500)],
            'min': 0, 'max': 300, 'altitudeDatum': 'AMSL', 'start': '00:00', 'end': '23:59'}],
        'risks': [], 'fullchain': {'enabled': True, 'categories': [], 'filing': {}, 'airspaceLifecycle': False}}
    result = {}
    for case, label in CASES.items():
        scene = copy.deepcopy(common)
        path = [start, corner, point(-speed * (entry_seconds - action_seconds), speed * (duration_seconds - action_seconds))] if case == 'avoid' else [start, point(zone_depth, 0)]
        plan_id = f'route-{token}-{case}'
        target = {'id': f'uav-{token}-{case}', 'name': f'K03 模拟无人机·{label}', 'kind': 'uav',
            'coordinate_system': 'WGS84', 'deviceId': radar, 'secondaryDeviceId': tdoa,
            'transport': 'normalized', 'secondaryTransport': 'auto', 'motionMode': 'once',
            'path': copy.deepcopy(path), 'height': 100, 'heightAgl': 80, 'altitudeDatum': 'AMSL',
            'speed': speed, 'count': 1, 'probability': .99, 'planId': plan_id,
            'pilotPoint': point(-speed * entry_seconds / 2, -100), 'notificationBehavior': 'none'}
        if case == 'silence':
            target['silenceWindows'] = [{'at': action_seconds, 'seconds': duration_seconds - action_seconds + 1}]
        scene.update(name=f'K03 {label}', targets=[target], plans=[{
            'id': plan_id, 'name': 'K03 模拟配套航线', 'coordinate_system': 'WGS84', 'points': copy.deepcopy(path),
            'min': 20, 'max': 150, 'width': 200, 'start': '00:00', 'end': '23:59',
            'timeMode': 'current', 'altitudeDatum': 'AMSL'}])
        compile_scene(scene)  # Validate using the same compiler as /api/start; no runtime actions.
        result[case] = scene
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True, help='新的场景输出目录；不覆盖已有 JSON')
    parser.add_argument('--longitude', type=float, default=118.62, help='禁飞区西侧边界中点经度 WGS84')
    parser.add_argument('--latitude', type=float, default=37.45, help='禁飞区西侧边界中点纬度 WGS84')
    parser.add_argument('--speed', type=float, default=20)
    parser.add_argument('--entry-seconds', type=float, default=90)
    parser.add_argument('--action-seconds', type=float, default=80)
    parser.add_argument('--duration-seconds', type=float, default=180)
    args = parser.parse_args()
    scenes = build_scenes(args.longitude, args.latitude, args.speed, args.entry_seconds, args.action_seconds, args.duration_seconds)
    if any((args.output_dir / f'{case}.json').exists() for case in scenes):
        parser.error('输出目录已有同名场景，请换新目录；不会覆盖原草稿')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for case, scene in scenes.items():
        destination = args.output_dir / f'{case}.json'
        with destination.open('x', encoding='utf-8') as stream:
            json.dump(scene, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        print(destination.resolve())


if __name__ == '__main__':
    main()
