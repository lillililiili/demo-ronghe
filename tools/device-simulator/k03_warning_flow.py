"""Simple flow-9 inputs: approach a rectangle, then turn away or enter.

Only ordinary measured motion and airspace inputs are produced. Map and stage
guides describe the simulated route, never a platform prediction or action result.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import re

from engine import compile_scene, metres

FILES = {'avoid': 'flow-9-prediction-warning.json', 'enter': 'flow-9-prediction-entry.json'}


def build_scenes(longitude=118.6104, latitude=37.464, start_distance=1500.0, entry_start_distance=2400.0,
                 speed=30.0, turn_clearance=120.0, turn_radius=60.0, zone_width=900.0,
                 zone_half_height=600.0, return_distance=1500.0,
                 duration_seconds=300, identity='acceptance-flow9'):
    """Build two portable variants with the same devices and rectangular zone.

    Dimensions are input metres; no live K03 thresholds are overridden. The
    entry route starts 2.4 km before the zone boundary. At 30 m/s, the simulated
    120-second prediction horizon begins near scene start and leaves about 70
    seconds for handling before measured entry.
    """
    values = (longitude, latitude, start_distance, entry_start_distance, speed, turn_clearance, turn_radius,
              zone_width, zone_half_height, return_distance, duration_seconds)
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        raise ValueError('坐标、尺寸、速度和时长须为有限数字')
    if not -179 < longitude < 179 or not -80 < latitude < 80:
        raise ValueError('请使用非极区且不跨日期变更线的 WGS84 位置')
    if not 0 < speed <= 100:
        raise ValueError('速度须大于0且不超过100米/秒')
    if any(not 0 < v <= 20_000 for v in (start_distance, entry_start_distance, turn_clearance, turn_radius,
                                        zone_width, zone_half_height, return_distance)):
        raise ValueError('场景尺寸须大于0且不超过20公里')
    if start_distance <= turn_clearance + turn_radius + speed * 15:
        raise ValueError('接近路线须在转向前保留至少15秒直线飞行')
    if return_distance / speed < 30:
        raise ValueError('转向后须保留至少30秒持续远离的飞行观测')
    if duration_seconds != int(duration_seconds) or not 120 <= duration_seconds <= 1200:
        raise ValueError('总时长须为120至1200的整数秒')
    if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', identity):
        raise ValueError('场景包标识须为1至32位字母、数字、下划线或短横线')
    duration_seconds = int(duration_seconds)

    def point(east, north):
        lon = longitude + east / (111320 * math.cos(math.radians(latitude)))
        lat = latitude + north / 111320
        return [(lon - 118.56) / .00012, (37.50 - lat) / .00012]

    def travel(path):
        return sum(metres(a, b) for a, b in zip(path, path[1:])) / speed

    def marker(key, role, label, position):
        return dict(id=key, role=role, label=label, point=copy.deepcopy(position))

    def stage(at, label, description):
        return dict(at_seconds=round(at, 2), label=label, description=description)

    start = point(-start_distance, 0)
    turn_x = -turn_clearance - turn_radius
    turn = point(turn_x, 0)
    # A single short bend makes the change of direction visible without an orbit.
    arc = [point(turn_x + turn_radius * math.cos(-math.pi / 2 + i * 3 * math.pi / 32),
                 turn_radius + turn_radius * math.sin(-math.pi / 2 + i * 3 * math.pi / 32))
           for i in range(1, 9)]
    arc_end_east = turn_x + turn_radius / math.sqrt(2)
    arc_end_north = turn_radius + turn_radius / math.sqrt(2)
    safe_end = point(arc_end_east - return_distance / math.sqrt(2),
                     arc_end_north + return_distance / math.sqrt(2))
    avoid_path = [start, turn, *arc, safe_end]
    entry_start = point(-entry_start_distance, 0)
    entry_end = point(zone_width / 2, 0)
    entry_path = [entry_start, entry_end]
    turn_at, turned_at, safe_at = travel([start, turn]), travel(avoid_path[:-1]), travel(avoid_path)
    entry_at, hold_at = travel([entry_start, point(0, 0)]), travel(entry_path)
    entry_duration = max(duration_seconds + 60, math.ceil(hold_at + 120))
    if safe_at > duration_seconds - 30 or entry_duration > 1200:
        raise ValueError('航迹结束后须保留30秒观测，入区停留须保留两分钟且总时长不超过20分钟')

    site_point = point(-150, -300)
    radar, tdoa = 'radar-' + identity, 'tdoa-' + identity
    # Both routes stay north of this site; declare the simulated camera's full
    # observation sector from the route geometry, without changing real devices.
    eo_range = math.ceil(max(metres(site_point, p) for p in avoid_path + entry_path) / 100) * 100 + 100
    common = {
        'version': 1, 'coordinate_system': 'WGS84', 'duration': duration_seconds / 60,
        'sites': [{'id': 'site-' + identity, 'name': '观测设备组',
                   'x': site_point[0], 'y': site_point[1], 'coordinate_system': 'WGS84', 'devices': [
                       {'id': radar, 'name': '流程 9 模拟雷达', 'kind': 'radar',
                        'health': '正常', 'heartbeat': '持续上报', 'interval': 1,
                        'coverage': {'kind': 'circle', 'radiusM': 2500,
                                     'sourceLabel': '流程9入区航线雷达范围（模拟参数）'}},
                       {'id': tdoa, 'name': '流程 9 模拟 TDOA', 'kind': 'tdoa',
                        'health': '正常', 'heartbeat': '持续上报', 'interval': 1,
                        'coverage': {'kind': 'circle', 'radiusM': 2500,
                                     'sourceLabel': '流程9入区航线TDOA范围（模拟参数）'}},
                       {'id': 'eo-' + identity, 'name': '流程 9 模拟光电', 'kind': 'eo',
                        'health': '正常', 'heartbeat': '持续上报', 'interval': 1,
                        'coverage': {'kind': 'sector', 'rangeM': eo_range, 'azimuthDeg': 0,
                                     'fovDeg': 220, 'sourceLabel': '流程9模拟光电范围（模拟参数）'}}]}],
        # This new named rectangle is a separate upstream business identity.
        # Reusing the annular scene ID would violate its immutable source name,
        # even after withdrawal. Both variants/reruns reuse this stable ID.
        'zones': [{'id': 'prohibited-rectangle-v2-' + identity, 'name': '禁飞区 · 矩形内禁止飞行',
                   'kindCode': 'PROHIBITED', 'coordinate_system': 'WGS84',
                   'points': [point(0, -zone_half_height), point(zone_width, -zone_half_height),
                              point(zone_width, zone_half_height), point(0, zone_half_height)],
                   'holes': [], 'min': 0, 'max': 300, 'altitudeDatum': 'AMSL',
                   'start': '00:00', 'end': '23:59'}],
        'risks': [],
        'fullchain': {'enabled': True, 'categories': [], 'filing': {},
                      'airspaceLifecycle': False, 'acceptanceFlow': 9},
    }
    result = {}
    for variant, label in [('avoid', '接近后转向避开'), ('enter', '继续入区并人工反制')]:
        scene = copy.deepcopy(common)
        path = avoid_path if variant == 'avoid' else entry_path
        if variant == 'enter':
            scene['duration'] = entry_duration / 60
        plan = 'route-' + identity + '-' + variant
        target = {
            'id': 'uav-' + identity + '-' + variant, 'name': '演示无人机',
            'kind': 'uav', 'coordinate_system': 'WGS84', 'deviceId': radar, 'secondaryDeviceId': tdoa,
            'transport': 'normalized', 'secondaryTransport': 'auto', 'motionMode': 'once',
            'path': copy.deepcopy(path), 'height': 100, 'heightAgl': 80, 'altitudeDatum': 'AMSL',
            'speed': speed, 'count': 1, 'probability': .99, 'planId': plan,
            'pilotPoint': copy.deepcopy(site_point), 'notificationBehavior': 'none',
        }
        scene.update(name='流程 9 · ' + ('转向避开' if variant == 'avoid' else '继续入区'), targets=[target], plans=[{
            'id': plan, 'name': '配套航线', 'coordinate_system': 'WGS84',
            'points': copy.deepcopy(path), 'min': 20, 'max': 150, 'width': 200,
            'start': '00:00', 'end': '23:59', 'timeMode': 'current', 'altitudeDatum': 'AMSL',
        }])
        scene['fullchain']['predictionVariant'] = variant
        scene['fullchain']['expectedChecks'] = [
            '仅本地模拟目标显示+10／20／30／60／90／120秒预测；真实目标维持原10／20／30秒预测',
            '预警由平台按有效新实测计算；仅在当前依据有效时人工核实，再查看短信和预测专用电话回执',
            '有效预警自动排队光电观察；选中无人机点实时视频，收到跟踪回执且媒体就绪后显示带模拟标识的视频',
            '反制须由有权限人员人工发起，通知、授权、启停均以平台实际结果为准',
            ('无人机在边界外转向并远离；平台收到连续明确安全观测后撤销预警并保留历史'
             if variant == 'avoid' else '无人机继续飞入区内并停留；在关联实测告警办理人工反制，通知与处置按同次风险防重'),
            '持续上报到场景结束；沿既有流程撤销本场景空域并保留历史',
        ]
        route_start = start if variant == 'avoid' else entry_start
        markers = [marker('start', 'start', '① 起点 · 向右飞行', route_start)]
        forecast_note = ('打开融合感知，查看模拟目标未来10、20、30、60、90、120秒预测。'
                         if variant == 'enter' else '打开融合感知，选中无人机，查看未来10、20、30秒预测。')
        warning_at = max(10, entry_at - 120) if variant == 'enter' else max(10, start_distance / speed - 30)
        warning_note = ('进入预测窗口。有效预警触发光电观察，查看实时视频；按流程完成人工核实和反制。'
                        if variant == 'enter' else
                        '临近禁飞区。有效预警触发光电观察，点实时视频查看；人工核实后查看短信、电话回执。')
        stages = [stage(0, '① 直线接近', forecast_note),
                  stage(warning_at, '② 留意提前预警', warning_note)]
        directions = [{'from': copy.deepcopy(route_start), 'to': copy.deepcopy(turn if variant == 'avoid' else entry_end)}]
        if variant == 'avoid':
            markers.extend([marker('turn', 'turn', '② 转向避开', turn),
                            marker('safe', 'end', '③ 区外终点', safe_end)])
            directions.append({'from': copy.deepcopy(arc[-1]), 'to': copy.deepcopy(safe_end)})
            stages.extend([stage(turn_at, '③ 转向远离', '无人机在边界外转向；等待平台依据新观测判断风险是否解除。'),
                           stage(safe_at, '④ 区外停留', '无人机保持上报。在告警事件中查看撤销原因和处置历史。')])
            summary = '从左向右接近 → 边界外转向 → 向左上方远离，全程不进入矩形禁飞区。'
        else:
            markers.extend([marker('entry', 'entry', '② 穿过边界入区', point(0, 0)),
                            marker('hold', 'end', '③ 区内停留', entry_end)])
            stages.extend([stage(entry_at, '③ 飞入禁飞区', '查看平台关联的实测入区告警，按当前资格人工办理反制。'),
                           stage(hold_at, '④ 区内停留', '持续上报位置，留出核实、申请审批及执行时间；查看实际启停回执。')])
            summary = '从左向右接近 → 穿过矩形边界 → 区内停留，在平台人工办理反制。'
        scene['mapGuide'] = dict(title='路线导读', compactPaths=True, markers=markers, directions=directions)
        scene['sceneGuide'] = dict(summary=summary, stages=stages)
        compile_scene(scene)
        result[variant] = scene
    return result


def build_scene(variant='avoid', **kwargs):
    if variant not in FILES:
        raise ValueError('预警流程变式须为 avoid 或 enter')
    return build_scenes(**kwargs)[variant]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path(__file__).resolve().parent / 'scenarios' / 'acceptance-flows-1-7-20261008')
    parser.add_argument('--overwrite', action='store_true', help='明确替换该目录下两份流程9文件；不修改流程清单')
    defaults = dict(longitude=118.6104, latitude=37.464, start_distance=1500, entry_start_distance=2400, speed=30,
                    turn_clearance=120, turn_radius=60, zone_width=900, zone_half_height=600, return_distance=1500)
    for name, default in defaults.items():
        parser.add_argument('--' + name.replace('_', '-'), type=float, default=default)
    parser.add_argument('--duration-seconds', type=int, default=300)
    parser.add_argument('--identity', default='acceptance-flow9')
    args = vars(parser.parse_args())
    output, overwrite = args.pop('output_dir'), args.pop('overwrite')
    scenes = build_scenes(**args)
    if not overwrite and any((output / name).exists() for name in FILES.values()):
        parser.error('目标目录已有流程9文件，请换输出目录或显式使用 --overwrite')
    output.mkdir(parents=True, exist_ok=True)
    for variant, scene in scenes.items():
        destination = output / FILES[variant]
        with destination.open('w' if overwrite else 'x', encoding='utf-8') as stream:
            json.dump(scene, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        print(destination.resolve())


if __name__ == '__main__':
    main()
