"""#12 模拟器正常停止时声明计划下线；#25 场景配置的反制作用半径随反制设备登记交给平台。"""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch, Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from platform_client import PlatformError

SCENES = Path(__file__).resolve().parents[1] / 'scenarios' / 'acceptance-flows-1-7-20261008'


class FakePlatform:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail or {}

    def call(self, method, path, body=None, key=None, *, timeout=12):
        self.calls.append((method, path, body, key))
        error = self.fail.get((body or {}).get('device_id'))
        if error:
            raise error
        return {'device_id': body['device_id'], 'declared_at': 1, 'simulated': True}


def manifest():
    return {'devices': {
        'radar-a': {'external_id': 'map-sim-a-radar', 'platform_id': 'dev-a', 'source_id': 'src-a', 'kind': 'radar'},
        'eo-b': {'external_id': 'map-sim-b-eo', 'platform_id': 'dev-b', 'source_id': 'src-b', 'kind': 'eo'},
        'normalized-c': {'external_id': 'norm-c', 'platform_id': 'dev-c', 'source_id': 'src-c', 'kind': 'normalized'},
        'unregistered-d': {'external_id': 'map-sim-d', 'kind': 'radar'},
    }}


class PlannedOfflineTests(unittest.TestCase):
    def test_declares_each_registered_ops_device_but_not_normalized_sources(self):
        from device_health import declare_planned_offline, PLANNED_OFFLINE_PATH
        platform, logs = FakePlatform(), []
        result = declare_planned_offline(platform, manifest(), lambda *a, **k: logs.append(a))
        self.assertEqual(['map-sim-a-radar', 'map-sim-b-eo'], result['declared'])
        self.assertEqual([], result['failed'])
        self.assertEqual([('dev-a', 'src-a'), ('dev-b', 'src-b')],
                         [(c[2]['device_id'], c[2]['source_id']) for c in platform.calls])
        self.assertTrue(all(c[0] == 'POST' and c[1] == PLANNED_OFFLINE_PATH for c in platform.calls))
        self.assertEqual(len({c[3] for c in platform.calls}), 2)
        self.assertIn('PLANNED_OFFLINE', [entry[0] for entry in logs])

    def test_one_refused_device_is_logged_and_the_others_still_declared(self):
        from device_health import declare_planned_offline
        refused = PlatformError('系统接口 x 返回 409：只有当前启用、来源一致的回放模拟设备可以声明计划下线', 409)
        platform, logs = FakePlatform({'dev-a': refused}), []
        result = declare_planned_offline(platform, manifest(), lambda *a, **k: logs.append(a))
        self.assertEqual(['map-sim-b-eo'], result['declared'])
        self.assertEqual(['map-sim-a-radar'], result['failed'])
        self.assertIn('PLANNED_OFFLINE_FAILED', [entry[0] for entry in logs])

    def test_platform_without_the_interface_stops_after_the_first_404(self):
        from device_health import declare_planned_offline
        platform = FakePlatform({'dev-a': PlatformError('系统接口 x 返回 404：', 404)})
        logs = []
        result = declare_planned_offline(platform, manifest(), lambda *a, **k: logs.append(a))
        self.assertEqual(1, len(platform.calls))
        self.assertEqual([], result['declared'])
        self.assertEqual('PLANNED_OFFLINE_OFF', logs[-1][0])

    def runtime(self, phase, error=''):
        from server import Runtime
        logs = []
        fake = SimpleNamespace(lock=threading.RLock(), phase=phase, error=error, manifest=manifest(),
                               platform=FakePlatform(), log=lambda *a, **k: logs.append(a))
        Runtime.declare_planned_offline(fake)
        return fake

    def test_normal_stop_or_finished_scene_declares_planned_offline(self):
        for phase in ('STOPPED', 'COMPLETED', 'STOPPING'):
            fake = self.runtime(phase)
            self.assertEqual(2, len(fake.platform.calls), phase)
            self.assertEqual(['map-sim-a-radar', 'map-sim-b-eo'], fake.manifest['planned_offline']['declared'])

    def test_failed_run_is_not_planned_so_the_platform_still_opens_a_case(self):
        for phase, error in (('FAILED', 'MQTT 连接或认证失败'), ('STOPPED', '实时收发服务停止：登录失效')):
            fake = self.runtime(phase, error)
            self.assertEqual([], fake.platform.calls)
            self.assertNotIn('planned_offline', fake.manifest)


class SceneCoverageTests(unittest.TestCase):
    def test_scene_radius_is_validated_and_kept(self):
        from engine import countermeasure_config
        self.assertIsNone(countermeasure_config(None))
        config = countermeasure_config({'coverage': {'kind': 'circle', 'radiusM': 1500, 'sourceLabel': '场景'}})
        self.assertEqual(1500, config['coverage']['radiusM'])
        for bad in ({'coverage': {'kind': 'sector', 'rangeM': 1000, 'azimuthDeg': 10, 'fovDeg': 90, 'sourceLabel': '场景'}},
                    {'coverage': {'kind': 'circle', 'radiusM': 0, 'sourceLabel': '场景'}},
                    {'coverage': {'kind': 'circle', 'radiusM': 100, 'sourceLabel': ''}},
                    {'range': 3000}, 'circle'):
            with self.assertRaises(ValueError, msg=str(bad)):
                countermeasure_config(bad)

    def test_acceptance_flows_keep_explicit_radius_or_use_simulator_default(self):
        from engine import compile_scene
        from realtime_control import countermeasure_radius
        from coverage_defaults import default_coverage
        manifest = json.loads((SCENES / 'manifest.json').read_text(encoding='utf-8'))
        files = [SCENES / item['file'] for item in manifest['flows']]
        self.assertEqual(set(files), set(SCENES.glob('flow-*.json')))
        for path in files:
            scene = compile_scene(json.loads(path.read_text(encoding='utf-8')))[0]
            radius = countermeasure_radius(scene)
            if scene.get('countermeasure') is None:
                self.assertIsNone(radius, path.name)
                radius = default_coverage('countermeasure')['radiusM']
            self.assertIsNotNone(radius, path.name)
            self.assertGreater(radius, 821, path.name)  # 流程 5 反制设备离目标约 821 米，须在作用范围内

    def test_radius_absent_or_not_circle_is_not_invented(self):
        from realtime_control import countermeasure_radius
        self.assertIsNone(countermeasure_radius(None))
        self.assertIsNone(countermeasure_radius({'sites': []}))
        self.assertIsNone(countermeasure_radius({'countermeasure': {'coverage': None}}))
        self.assertEqual(800, countermeasure_radius({'countermeasure': {'coverage': {'kind': 'circle', 'radiusM': 800}}}))


class CountermeasureRegistrationTests(unittest.TestCase):
    def setUp(self):
        from realtime_control import RealtimeController
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.registered = []
        self.has_coverage = False

        def request(command):
            if command['path'].endswith('/countermeasure-device'):
                body = command.get('body')
                self.registered.append(body)
                device = {'device_id': 'cm-test'}
                if 'longitude' in body:
                    device.update(longitude=body['longitude'], latitude=body['latitude'])
                if body.get('coverage_radius_m') is not None or self.has_coverage:
                    device['coverage'] = {'kind': 'CIRCLE', 'radius_m': body.get('coverage_radius_m')}
                return {'device': device}
            return {}
        self.range_sync = Mock()
        session = SimpleNamespace(version='first', platform=SimpleNamespace(sync_simulated_range=self.range_sync), request=request,
                                  connection_scope=lambda: {'owner_org_id': None, 'district_id': None})
        self.runtime = SimpleNamespace(data_dir=Path(self.temp.name), platform=True, session=session,
                                       lock=threading.RLock(), phase='STOPPED', cancel=threading.Event())
        self.controller = RealtimeController(self.runtime, port=19873)
        self.addCleanup(self.controller.stop)
        self.controller.configure({'notifications_enabled': False, 'countermeasure_scope': 'org-x|district-y'})

    def start(self, scene):
        from countermeasure_tcp import CountermeasureSimulator
        from test_countermeasure_tcp import free_port
        self.range_sync.reset_mock()
        with patch('countermeasure_tcp.CountermeasureSimulator', return_value=CountermeasureSimulator(port=free_port())):
            self.controller.start(scene)
        coverage = (scene.get('countermeasure') or {}).get('coverage')
        if coverage is None:
            self.range_sync.assert_called_once_with('cm-test', 'countermeasure')
        else:
            self.range_sync.assert_called_once_with('cm-test', 'countermeasure', coverage)

    def test_scene_radius_goes_with_the_registration(self):
        radar = {'x': 100, 'y': 50, 'devices': [{'kind': 'radar'}]}
        self.start({'sites': [radar], 'countermeasure': {'coverage': {'kind': 'circle', 'radiusM': 2000}}})
        self.assertEqual(2000, self.registered[-1]['coverage_radius_m'])
        self.assertEqual('org-x', self.registered[-1]['owner_org_id'])
        # 已有位置、已有覆盖范围：之后的场景不再去平台登记。
        count = len(self.registered)
        self.start({'sites': [radar], 'countermeasure': {'coverage': {'kind': 'circle', 'radiusM': 900}}})
        self.assertEqual(count, len(self.registered))

    def test_scene_without_radius_registers_without_coverage_and_a_later_scene_fills_it(self):
        radar = {'x': 100, 'y': 50, 'devices': [{'kind': 'radar'}]}
        self.start({'sites': [radar]})
        self.assertNotIn('coverage_radius_m', self.registered[-1])
        # 收发端常驻，下一个场景配置了作用半径：设备还没有覆盖范围，补登一次。
        self.start({'sites': [radar], 'countermeasure': {'coverage': {'kind': 'circle', 'radiusM': 1500}}})
        self.assertEqual(2, len(self.registered))
        self.assertEqual(1500, self.registered[-1]['coverage_radius_m'])

    def test_device_already_configured_in_the_platform_is_not_asked_again(self):
        self.has_coverage = True
        radar = {'x': 100, 'y': 50, 'devices': [{'kind': 'radar'}]}
        self.start({'sites': [radar]})
        self.start({'sites': [radar], 'countermeasure': {'coverage': {'kind': 'circle', 'radiusM': 1500}}})
        self.assertEqual(1, len(self.registered))


if __name__ == '__main__':
    unittest.main()
