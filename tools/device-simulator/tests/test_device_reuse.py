import copy
import io
import os
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from full_scenario import allocate_identities, full_scene
from fullchain import FullChain
from platform_client import Platform, legacy_batch_device
import retire_legacy_devices


class RecordingPlatform:
    def __init__(self):
        self.calls = []

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, copy.deepcopy(body), key))
        if path.endswith('/plan-options'): return {'pilots': [], 'organizations': [], 'source_bindings': []}
        if path.endswith('/airspaces/context'): return {'items': []}
        if path.endswith('/context'): return {'routes': [], 'messages': []}
        if path.endswith('/routes'): return {'route_id': 'r' + body['message_id'], 'route_version_id': 'v' + body['message_id']}
        if path.endswith('/plans'): return {'subject_id': 'p' + body['message_id'], 'result': {'plan_id': 'p' + body['message_id']}}
        if path.endswith('/airspaces'): return {'airspace_id': 'a' + body['airspace_no'], 'revision': body['revision']}
        if path.endswith('/observation-devices'): return {'device_id': 'norm-dev', 'source_id': 'norm-source'}
        if path.endswith('/weather-devices'): return {'device_id': 'weather-dev', 'source_id': 'weather-source'}
        return {'state': 'ACCEPTED'}


def prepared(batch, scene=None):
    scene = copy.deepcopy(scene or full_scene())
    manifest = {'batch': batch, 'created_at': 1000000, 'devices': {}, 'plans': {}, 'zones': {},
                'targets': allocate_identities(scene, batch)}
    platform = RecordingPlatform()
    FullChain(platform, scene, manifest, {'owner_org_id': 'o', 'district_id': 'd'}, lambda: None,
              clock=lambda: 1000000).prepare()
    return platform


def registrations(platform, suffix):
    return [body for _, path, body, _ in platform.calls if path.endswith(suffix)]


class FullChainDeviceReuseTests(unittest.TestCase):
    def test_every_batch_registers_the_same_observation_sources_and_weather_station(self):
        # 每台参与上报的场景设备各一个观测源（主线 10-07），身份与批次无关，换批次复用同一批。
        first, second = prepared('sim-1006101010-aaaa'), prepared('sim-1006111111-bbbb')
        for suffix in ('/observation-devices', '/weather-devices'):
            rows = registrations(first, suffix)
            self.assertTrue(rows)
            self.assertEqual(rows, registrations(second, suffix))
            self.assertTrue(all(row['message_id'].startswith('map-sim-') for row in rows))
            self.assertTrue(all(len(row['message_id']) <= 64 for row in rows))
            self.assertEqual(len({row['message_id'] for row in rows}), len(rows))
            self.assertNotIn('sim-1006101010-aaaa', repr(rows))
        self.assertEqual(len(registrations(first, '/weather-devices')), 1)
        station = registrations(first, '/weather-devices')[0]
        self.assertTrue(station['device_no'].startswith('map-sim-weather-'))

    def test_moved_weather_station_gets_its_own_identity_instead_of_a_conflict(self):
        scene = full_scene()
        moved = copy.deepcopy(scene)
        moved.setdefault('fullchain', {}).setdefault('weather', {})['longitude'] = 118.7
        before = registrations(prepared('sim-1006101010-aaaa', scene), '/weather-devices')[0]
        after = registrations(prepared('sim-1006111111-bbbb', moved), '/weather-devices')[0]
        self.assertNotEqual(before['message_id'], after['message_id'])
        self.assertNotEqual(before['device_no'], after['device_no'])


def device(number, **extra):
    row = {'device_id': 'id-' + number, 'device_no': number, 'name': '模拟 雷达', 'vendor': '地图场景模拟器',
           'model': 'MQTT-SIM', 'source_mode': 'replay', 'simulated': True, 'enabled': True, 'version': 3}
    row.update(extra)
    return row


class LegacyBatchDeviceTests(unittest.TestCase):
    def test_only_old_per_batch_simulator_registrations_match(self):
        self.assertTrue(legacy_batch_device(device('sim-1004093015-a1b2-3')))
        self.assertTrue(legacy_batch_device(device('sim-1004093015-a1b2-12', enabled=False)))
        for row in (device('map-sim-radar-radar-main'),
                    device('sim-1004093015-a1b2-3', vendor='某厂家'),
                    device('sim-1004093015-a1b2-3', model='R1'),
                    device('sim-1004093015-a1b2-3', source_mode='live', simulated=False),
                    device('sim-1004093015-a1b2-3', simulated=False),
                    device('sim-1004093015-a1b2'),
                    device('sim-1004093015-a1b2-3-extra'),
                    device('sim-1004093015-a1b2-3', device_id=None), None):
            self.assertFalse(legacy_batch_device(row), row)

    def test_listing_reads_every_page_and_changes_nothing(self):
        platform = Platform('http://127.0.0.1:8081/api/v1')
        first = [device('sim-1004093015-a1b2-%d' % n) for n in range(1, 100)] + [device('map-sim-tdoa-t1')]
        platform.call = Mock(side_effect=[{'items': first, 'total': 101},
                                          {'items': [device('sim-1005010101-ffff-1')], 'total': 101}])
        result = platform.retire_legacy_batch_devices()
        self.assertEqual(len(result['found']), 100)
        self.assertEqual(result['retired'], [])
        self.assertEqual([call.args[0] for call in platform.call.call_args_list], ['GET', 'GET'])
        self.assertIn('page=2', platform.call.call_args_list[1].args[1])
        self.assertIn('vendor=', platform.call.call_args_list[0].args[1])

    def test_apply_disables_then_deletes_with_current_version_and_continues_after_failure(self):
        platform = Platform('http://127.0.0.1:8081/api/v1')
        rows = [device('sim-1004093015-a1b2-1'), device('sim-1004093015-a1b2-2', enabled=False, version=7),
                device('sim-1004093015-a1b2-3')]

        def call(method, path, body=None, key=None):
            if method == 'GET': return {'items': rows, 'total': 3}
            if path == '/devices/id-sim-1004093015-a1b2-3' and method == 'DELETE':
                raise ValueError('系统接口 /devices/id-sim-1004093015-a1b2-3 返回 409：设备仍有关联的未完成指令或调测任务')
            if method == 'PATCH': return {'device': {'device_id': path.split('/')[2], 'version': body['version'] + 1}}
            return {'device_id': path.split('/')[2]}
        platform.call = Mock(side_effect=call)
        result = platform.retire_legacy_batch_devices(apply=True)
        writes = [(c.args[0], c.args[1], c.args[2]) for c in platform.call.call_args_list if c.args[0] != 'GET']
        self.assertEqual(writes[0][:2], ('PATCH', '/devices/id-sim-1004093015-a1b2-1/enabled'))
        self.assertEqual(writes[0][2]['enabled'], False)
        self.assertEqual(writes[1][:2], ('DELETE', '/devices/id-sim-1004093015-a1b2-1'))
        self.assertEqual(writes[1][2]['version'], 4)
        self.assertEqual(writes[2][:2], ('DELETE', '/devices/id-sim-1004093015-a1b2-2'))
        self.assertEqual(writes[2][2]['version'], 7)
        self.assertTrue(all(body['reason'] for _, _, body in writes))
        self.assertEqual(result['retired'], ['sim-1004093015-a1b2-1', 'sim-1004093015-a1b2-2'])
        self.assertEqual([row['device_no'] for row in result['failed']], ['sim-1004093015-a1b2-3'])

    def test_command_line_lists_by_default_and_reports_failures_after_apply(self):
        fake = Mock()
        fake.retire_legacy_batch_devices.return_value = {
            'found': [{'device_id': 'a', 'device_no': 'sim-1004093015-a1b2-1', 'name': '模拟 雷达', 'enabled': True}],
            'retired': [], 'failed': []}
        out = io.StringIO()
        with patch.object(retire_legacy_devices, 'Platform', return_value=fake), \
                patch.dict(os.environ, {'SIM_PLATFORM_PASSWORD': 'unused-in-test'}), redirect_stdout(out):
            self.assertEqual(retire_legacy_devices.main(['--account', 'admin1']), 0)
        fake.login.assert_called_once_with('admin1', 'unused-in-test')
        fake.retire_legacy_batch_devices.assert_called_once_with(apply=False)
        self.assertIn('--apply', out.getvalue())

        fake.retire_legacy_batch_devices.return_value = {
            'found': [], 'retired': ['sim-1004093015-a1b2-1'],
            'failed': [{'device_no': 'sim-1004093015-a1b2-2', 'error': '409'}]}
        with patch.object(retire_legacy_devices, 'Platform', return_value=fake), \
                patch.dict(os.environ, {'SIM_PLATFORM_PASSWORD': 'unused-in-test'}), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(retire_legacy_devices.main(['--account', 'admin1', '--apply']), 1)


if __name__ == '__main__':
    unittest.main()
