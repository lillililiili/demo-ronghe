"""Build reusable flow-9 input scenes; prediction, verification and actions remain platform decisions.

The vehicle circles inside a prohibited polygon's hole. Current measured positions
remain outside the zone while a constant-velocity forecast can cross the ring.
The entry variant continues tangentially into its smaller ring and holds there.
Only ordinary route points, device observations and a polygon with a hole are used.
This module neither calls services nor imports forecast/notification outcomes.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import re

from engine import compile_scene, metres

FILES = {
    'avoid': 'flow-9-prediction-warning.json',
    'enter': 'flow-9-prediction-entry.json',
}
RING_VERTICES = 120


def build_scenes(longitude=118.6104, latitude=37.464, radius=900.0, speed=30.0,
                 inner_radius=1000.0, outer_radius=1600.0, action_seconds=240,
                 duration_seconds=300, identity='acceptance-flow9'):
    """Return two variants, with configurable WGS84 center, geometry and timing.

    Changed parameters are input geometry, not prediction settings. Their actual
    forecasting reliability must still be checked against the platform model.
    Variants share the two logical devices and versioned logical airspace.
    Only entry scales the input geometry to 75%; its default hold radius is 875m,
    inside the existing 1km countermeasure coverage. It runs for at least two
    minutes after action_seconds; no platform threshold or outcome is supplied.
    """
    values = (longitude, latitude, radius, speed, inner_radius, outer_radius,
              action_seconds, duration_seconds)
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        raise ValueError('坐标、尺寸、速度和时长须为有限数字')
    if not -179 < longitude < 179 or not -80 < latitude < 80:
        raise ValueError('请使用非极区且不跨日期变更线的 WGS84 中心位置')
    if not 0 < radius < inner_radius < outer_radius <= 20_000:
        raise ValueError('尺寸须满足 0 < 巡航半径 < 内孔半径 < 外沿半径，外沿不超过20公里')
    if radius >= inner_radius * math.cos(math.pi / RING_VERTICES):
        raise ValueError('巡航轨迹须完整位于多边形内孔内，不能与内孔边界相交')
    if not 0 < speed <= 100 or speed / radius > .1:
        raise ValueError('速度须大于0且不超过100米/秒；每秒巡航转角不能超过0.1弧度')
    if action_seconds != int(action_seconds) or duration_seconds != int(duration_seconds):
        raise ValueError('动作时间和总时长须为整数秒')
    if not 30 <= action_seconds < duration_seconds <= 1200:
        raise ValueError('动作应在开始30秒以后，总时长须晚于动作且不超过20分钟')
    if duration_seconds - action_seconds < radius / speed + 20:
        raise ValueError('动作后须留出飞到圆心及至少20秒观察时间')
    if not isinstance(identity, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,32}', identity):
        raise ValueError('场景包标识须为1至32位字母、数字、下划线或短横线')
    action_seconds, duration_seconds = int(action_seconds), int(duration_seconds)

    def point(east, north):
        lon = longitude + east / (111320 * math.cos(math.radians(latitude)))
        lat = latitude + north / 111320
        # Version-1 coordinates use the simulator's documented reversible WGS84 grid.
        return [(lon - 118.56) / .00012, (37.50 - lat) / .00012]

    def circle_ring(size, clockwise=False):
        result = [point(size * math.cos(i * math.tau / RING_VERTICES),
                        size * math.sin(i * math.tau / RING_VERTICES)) for i in range(RING_VERTICES)]
        return list(reversed(result)) if clockwise else result

    def orbit(seconds, orbit_radius=radius):
        # Match the existing sampler's distance formula so the configured turn
        # happens at action_seconds, without chord-length or latitude drift.
        path, theta = [point(orbit_radius, 0)], 0.0
        for _ in range(seconds):
            low, high = theta, theta + .2
            for _ in range(45):
                middle = (low + high) / 2
                candidate = point(orbit_radius * math.cos(middle), orbit_radius * math.sin(middle))
                if metres(path[-1], candidate) < speed:
                    low = middle
                else:
                    high = middle
            theta = (low + high) / 2
            path.append(point(orbit_radius * math.cos(theta), orbit_radius * math.sin(theta)))
        return path

    entry_duration = max(duration_seconds, action_seconds + 120)
    entry_radius, entry_inner, entry_outer = radius * .75, inner_radius * .75, outer_radius * .75
    entry_hold = inner_radius * .875
    if entry_duration > 1200 or entry_hold >= entry_outer * math.cos(math.pi / RING_VERTICES):
        raise ValueError('入区场景须保留两分钟办理时间且驻留点完整位于环带内')

    def entry_path():
        path = orbit(action_seconds, entry_radius)
        # Continue the final delivered segment exactly: no heading jump and no
        # position teleport. Solve the forward ray's intersection with the hold
        # circle in the same center-relative metric used to construct the rings.
        origin = point(0, 0)
        scale_x = .00012 * 111320 * math.cos(math.radians(latitude))
        scale_y = -.00012 * 111320
        x, y = (path[-1][0] - origin[0]) * scale_x, (path[-1][1] - origin[1]) * scale_y
        dx, dy = (path[-1][0] - path[-2][0]) * scale_x, (path[-1][1] - path[-2][1]) * scale_y
        magnitude = math.hypot(dx, dy)
        dx, dy = dx / magnitude, dy / magnitude
        projection = x * dx + y * dy
        distance = -projection + math.sqrt(projection ** 2 + entry_hold ** 2 - x ** 2 - y ** 2)
        path.append(point(x + dx * distance, y + dy * distance))
        if sum(metres(a, b) for a, b in zip(path, path[1:])) / speed > entry_duration - 60:
            raise ValueError('入区场景到达区内驻留点后须保留至少一分钟持续观测')
        return path

    center = point(0, 0)
    circular_path = orbit(duration_seconds)
    radar, tdoa = 'radar-' + identity, 'tdoa-' + identity
    common = {
        'version': 1, 'coordinate_system': 'WGS84', 'duration': duration_seconds / 60,
        'sites': [{'id': 'site-' + identity, 'name': '流程 9 模拟观测设备组',
                   'x': center[0], 'y': center[1], 'coordinate_system': 'WGS84', 'devices': [
                       {'id': radar, 'name': '流程 9 模拟雷达', 'kind': 'radar',
                        'health': '正常', 'heartbeat': '持续上报', 'interval': 1},
                       {'id': tdoa, 'name': '流程 9 模拟 TDOA', 'kind': 'tdoa',
                        'health': '正常', 'heartbeat': '持续上报', 'interval': 1}]}],
        'zones': [{'id': 'prohibited-' + identity, 'name': '流程 9 环带禁飞区', 'kindCode': 'PROHIBITED',
                   'coordinate_system': 'WGS84', 'points': circle_ring(outer_radius),
                   'holes': [circle_ring(inner_radius, clockwise=True)],
                   'min': 0, 'max': 300, 'altitudeDatum': 'AMSL', 'start': '00:00', 'end': '23:59'}],
        'risks': [],
        'fullchain': {'enabled': True, 'categories': [], 'filing': {}, 'airspaceLifecycle': False,
                      'acceptanceFlow': 9},
    }
    result = {}
    for variant, label in [('avoid', '转向避开'), ('enter', '继续入区后人工反制')]:
        scene = copy.deepcopy(common)
        path = circular_path[:action_seconds + 1] + [center]
        if variant == 'enter':
            path = entry_path()
            scene['duration'] = entry_duration / 60
            scene['zones'][0]['points'] = circle_ring(entry_outer)
            scene['zones'][0]['holes'] = [circle_ring(entry_inner, clockwise=True)]
        plan = 'route-' + identity + '-' + variant
        target = {
            'id': 'uav-' + identity + '-' + variant, 'name': '流程 9 预测入区预警·' + label,
            'kind': 'uav', 'coordinate_system': 'WGS84', 'deviceId': radar, 'secondaryDeviceId': tdoa,
            'transport': 'normalized', 'secondaryTransport': 'auto', 'motionMode': 'once',
            'path': copy.deepcopy(path), 'height': 100, 'heightAgl': 80, 'altitudeDatum': 'AMSL',
            'speed': speed, 'count': 1, 'probability': .99, 'planId': plan,
            'pilotPoint': copy.deepcopy(center), 'notificationBehavior': 'none',
        }
        scene.update(name=target['name'], targets=[target], plans=[{
            'id': plan, 'name': '流程 9 配套飞行航线·' + label, 'coordinate_system': 'WGS84',
            'points': copy.deepcopy(path), 'min': 20, 'max': 150, 'width': 200,
            'start': '00:00', 'end': '23:59', 'timeMode': 'current', 'altitudeDatum': 'AMSL',
        }])
        scene['fullchain']['predictionVariant'] = variant
        scene['fullchain']['expectedChecks'] = [
            '实测始终在禁飞区内孔内，未来10／20／30秒预测单独显示',
            '预测预警由连续新实测产生，人工核实后核对短信与专用录音电话回执',
            '预测反制由有权限人员人工发起，核对真实设备指令及回执',
            '约第' + str(action_seconds) + '秒转向孔内；先失效停止，稳定安全新观测后撤销并留存历史',
            '场景结束沿既有流程撤销本场景环带空域，保留历史',
        ]
        if variant == 'enter':
            scene['fullchain']['expectedChecks'] = [
                '前段实测在禁飞区内孔内，未来10／20／30秒预测独立显示，持续上报不跳点',
                '预测预警人工核实后核对短信与预测专用录音电话的实际模拟回执',
                '约第' + str(action_seconds) + '秒沿当前切线继续飞入禁飞区，区内驻留并持续上报至第' + str(entry_duration) + '秒',
                '实测入区后核对关联的实际告警，预测核实不替代实际违法核实；短信电话和设备处置防重',
                '实测入区后由有权限人员人工申请、审批和执行或使用已有直接权限，核对设备指令及真实回执',
                '同次预测衍生事件保持人工反制，不自动核实预测、不自动反制、不以预测自动移送处罚',
                '场景结束沿既有流程撤销本场景环带空域，保留历史',
            ]
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
    parser.add_argument('--longitude', type=float, default=118.6104)
    parser.add_argument('--latitude', type=float, default=37.464)
    parser.add_argument('--radius', type=float, default=900)
    parser.add_argument('--speed', type=float, default=30)
    parser.add_argument('--inner-radius', type=float, default=1000)
    parser.add_argument('--outer-radius', type=float, default=1600)
    parser.add_argument('--action-seconds', type=int, default=240)
    parser.add_argument('--duration-seconds', type=int, default=300)
    parser.add_argument('--identity', default='acceptance-flow9')
    args = parser.parse_args()
    params = vars(args).copy()
    output, overwrite = params.pop('output_dir'), params.pop('overwrite')
    scenes = build_scenes(**params)
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
