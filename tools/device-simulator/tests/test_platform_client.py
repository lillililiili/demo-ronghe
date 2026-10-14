import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from platform_client import Platform, PlatformError, RESTORE_REASON, stable_device_identity
from server import Runtime


class PlatformIdentityTests(unittest.TestCase):
    def body(self):
        return {
            'protocol_code': 'LINGYUN_MQTT_V8_6',
            'broker_id': 'broker-1',
            'provider_code': 'map-sim',
            'external_device_id': stable_device_identity('radar-main', 'radar'),
            'device_type_abbr': 'radar',
            'source_mode': 'replay',
            'device_no': stable_device_identity('radar-main', 'radar'),
        }

    def existing_calls(self, body):
        return [
            ('GET', '/devices?page=1&size=100&keyword=' + body['device_no'] + '&sort=device_no_asc'),
            ('GET', '/devices/platform-1'),
            ('GET', '/devices/platform-1/protocol-status'),
        ]

    def test_stable_identity_is_repeatable_and_eo_fits_contract(self):
        self.assertEqual(stable_device_identity('radar-main', 'radar'),
                         stable_device_identity('radar-main', 'radar'))
        self.assertLessEqual(len(stable_device_identity('a' * 100, 'eo')), 32)
        self.assertNotEqual(stable_device_identity('main', 'radar'), stable_device_identity('main', 'tdoa'))

    def test_existing_binding_is_reused_without_post(self):
        body = self.body()
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform.call = Mock(side_effect=[
            {'items': [{'device_id': 'platform-1', 'device_no': body['device_no']}]},
            {'device': {'device_id': 'platform-1', 'device_no': body['device_no'],
                         'source_mode': 'replay', 'enabled': True},
             'external_device_id': body['external_device_id'],
             'protocol_code': body['protocol_code']},
            {'details': {'broker_id': 'broker-1', 'provider_code': 'map-sim',
                         'external_device_id': body['external_device_id'],
                         'device_type_abbr': 'radar'}},
        ])
        result = platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
        self.assertTrue(result['_reused'])
        self.assertEqual(result['device']['device_id'], 'platform-1')
        self.assertNotIn('POST', [call.args[0] for call in platform.call.call_args_list])

    def test_existing_binding_with_different_broker_is_rejected(self):
        body = self.body()
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform.call = Mock(side_effect=[
            {'items': [{'device_id': 'platform-1', 'device_no': body['device_no']}]},
            {'device': {'device_id': 'platform-1', 'device_no': body['device_no'],
                         'source_mode': 'replay', 'enabled': True},
             'external_device_id': body['external_device_id'],
             'protocol_code': body['protocol_code']},
            {'details': {'broker_id': 'other-broker', 'provider_code': 'map-sim',
                         'external_device_id': body['external_device_id'],
                         'device_type_abbr': 'radar'}},
        ])
        with self.assertRaisesRegex(ValueError, '稳定设备身份冲突'):
            platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])

    def test_existing_binding_syncs_changed_position_with_version(self):
        body = dict(self.body(), longitude=118.7, latitude=37.5, altitude_m=3)
        platform = Platform('http://127.0.0.1:8081/api/v1')
        detail = {'device': {'device_id': 'platform-1', 'device_no': body['device_no'],
                             'source_mode': 'replay', 'enabled': True, 'version': 4,
                             'longitude': 118.6, 'latitude': 37.4, 'altitude_m': 0},
                  'external_device_id': body['external_device_id'],
                  'protocol_code': body['protocol_code']}
        platform.call = Mock(side_effect=[
            {'items': [{'device_id': 'platform-1', 'device_no': body['device_no']}]},
            detail,
            {'details': {'broker_id': 'broker-1', 'provider_code': 'map-sim',
                         'external_device_id': body['external_device_id'],
                         'device_type_abbr': 'radar'}},
            {'device': {**detail['device'], 'longitude': body['longitude'], 'latitude': body['latitude'],
                        'altitude_m': body['altitude_m'], 'version': 5},
             'external_device_id': body['external_device_id'], 'protocol_code': body['protocol_code']},
        ])
        result = platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
        calls = platform.call.call_args_list
        self.assertEqual(calls[3].args[0], 'PUT')
        self.assertEqual(calls[3].args[2]['version'], 4)
        self.assertEqual(result['device']['version'], 5)

    def test_declared_coverage_writes_static_profile_once(self):
        platform = Platform('http://127.0.0.1:8081/api/v1')
        record = {'device': {'device_id': 'platform-1', 'coverage': {
            'status': 'UNKNOWN', 'version': None}}}
        platform.call = Mock(return_value={
            'device': {'device_id': 'platform-1', 'coverage': {
                'kind': 'CIRCLE', 'radius_m': 8000, 'source_label': '测试配置', 'version': 0}}})
        result = platform._sync_sensing_profile(record,
            {'kind': 'circle', 'radiusM': 8000, 'sourceLabel': '测试配置'}, 'sim-radar')
        call = platform.call.call_args
        self.assertEqual(call.args[0], 'PUT')
        self.assertEqual(call.args[1], '/devices/platform-1/sensing-profile')
        self.assertEqual(call.args[2], {'coverage_kind': 'CIRCLE', 'radius_m': 8000.0,
                                        'range_m': None, 'azimuth_deg': None, 'fov_deg': None,
                                        'source_label': '测试配置', 'expected_version': 0})
        self.assertEqual(result['device']['coverage']['version'], 0)

    def test_omitted_coverage_does_not_delete_existing_profile(self):
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform.call = Mock()
        record = {'device': {'device_id': 'platform-1', 'coverage': {
            'kind': 'CIRCLE', 'radius_m': 8000, 'source_label': '台账配置', 'version': 2}}}
        self.assertIs(platform._sync_sensing_profile(record, None, 'sim-radar'), record)
        platform.call.assert_not_called()


class RetiredDeviceRestoreTests(unittest.TestCase):
    """2026-10-14 用户确认方案 A：模拟器启动时恢复自己以前登记、后来被退役或停用的模拟设备。"""

    def body(self, kind='radar'):
        external = stable_device_identity('radar-main' if kind != 'eo' else 'eo-main', kind)
        body = {'protocol_code': 'EO_EDGE_MQTT_20250826' if kind == 'eo' else 'LINGYUN_MQTT_V8_6',
                'broker_id': 'broker-1', 'provider_code': 'map-sim', 'external_device_id': external,
                'device_type_abbr': kind, 'source_mode': 'replay', 'owner_org_id': 'org', 'district_id': 'district',
                'device_no': external, 'name': '模拟 雷达'}
        if kind == 'eo':
            body['edge_id'] = external + '-edge'
        return body

    def found(self, body, enabled=True):
        return [
            {'items': [{'device_id': 'platform-1', 'device_no': body['device_no']}]},
            {'device': {'device_id': 'platform-1', 'device_no': body['device_no'], 'source_mode': 'replay',
                        'owner_org_id': 'org', 'district_id': 'district', 'enabled': enabled},
             'external_device_id': body['external_device_id'], 'protocol_code': body['protocol_code']},
            {'details': {'broker_id': 'broker-1', 'provider_code': 'map-sim',
                         'external_device_id': body['external_device_id'], 'device_type_abbr': body['device_type_abbr'],
                         'edge_id': body.get('edge_id')}},
        ]

    def test_retired_device_is_restored_as_the_same_record_instead_of_registered_again(self):
        body = self.body()
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform.call = Mock(side_effect=[{'items': []}, {'device': {'device_id': 'platform-1'}}] + self.found(body))
        result = platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
        self.assertEqual(result['_restored'], 'retired')
        self.assertEqual(result['device']['device_id'], 'platform-1')
        calls = platform.call.call_args_list
        self.assertEqual(calls[1].args[:2], ('POST', '/devices/restore-simulated'))
        self.assertEqual(calls[1].args[2], {
            'device_no': body['device_no'], 'broker_id': 'broker-1', 'protocol_code': 'LINGYUN_MQTT_V8_6',
            'external_device_id': body['external_device_id'], 'source_mode': 'replay', 'provider_code': 'map-sim',
            'device_type_abbr': 'radar', 'reason': RESTORE_REASON})
        self.assertNotIn('/devices/onboard', [call.args[1] for call in calls])

    def test_eo_restore_names_the_edge_and_not_the_lingyun_provider(self):
        body = self.body('eo')
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform.call = Mock(side_effect=[{'items': []}, {'device': {'device_id': 'platform-1'}}] + self.found(body))
        platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
        request = platform.call.call_args_list[1].args[2]
        self.assertEqual(request['edge_id'], body['edge_id'])
        self.assertNotIn('provider_code', request)
        self.assertNotIn('device_type_abbr', request)

    def test_unknown_number_or_older_platform_registers_a_new_device(self):
        for refusal in (PlatformError('404', 404, 'DEVICE_NOT_FOUND', '没有编号为 x 的设备'),
                        PlatformError('405', 405, 'METHOD_NOT_ALLOWED', '请求方法不支持')):
            body = self.body()
            platform = Platform('http://127.0.0.1:8081/api/v1')
            platform.call = Mock(side_effect=[{'items': []}, refusal, {'device': {'device_id': 'new'}}])
            result = platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
            self.assertEqual(result['device']['device_id'], 'new')
            self.assertEqual(platform.call.call_args_list[2].args[:2], ('POST', '/devices/onboard'))
            self.assertNotIn('_restored', result)

    def test_refused_restore_says_which_device_and_why(self):
        body = self.body()
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform.call = Mock(side_effect=[{'items': []}, PlatformError(
            '409', 409, 'DEVICE_NOT_RESTORABLE', '设备 x 的接入身份和这次登记的不一致（MQTT 连接），不能恢复')])
        with self.assertRaisesRegex(ValueError, body['device_no'] + ' 没能恢复：.*MQTT 连接'):
            platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
        self.assertNotIn('/devices/onboard', [call.args[1] for call in platform.call.call_args_list])

    def test_switched_off_device_with_the_same_identity_is_switched_back_on(self):
        body = self.body()
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform.call = Mock(side_effect=self.found(body, enabled=False) + [{'device': {'device_id': 'platform-1'}}]
                             + self.found(body))
        result = platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
        self.assertEqual(result['_restored'], 'disabled')
        self.assertEqual(platform.call.call_args_list[3].args[:2], ('POST', '/devices/restore-simulated'))

    def test_switched_off_device_with_another_identity_is_left_alone(self):
        body = self.body()
        platform = Platform('http://127.0.0.1:8081/api/v1')
        responses = self.found(body, enabled=False)
        responses[2]['details']['broker_id'] = 'other-broker'
        platform.call = Mock(side_effect=responses)
        with self.assertRaisesRegex(ValueError, '稳定设备身份冲突.*broker_id.*设备已停用'):
            platform._onboard_or_reuse(body, 'sim-onboard-' + body['external_device_id'])
        self.assertNotIn('POST', [call.args[0] for call in platform.call.call_args_list])

    def test_prepare_lists_restored_devices_in_the_batch_record(self):
        platform = Platform('http://127.0.0.1:8081/api/v1')
        platform._onboard_or_reuse = Mock(return_value={'device': {'device_id': 'platform-1'}, '_restored': 'retired'})
        platform._sync_sensing_profile = Mock(side_effect=lambda record, *_: record)
        manifest = {'provider': 'map-sim', 'devices': {}}
        broker = {'broker_id': 'broker-1', 'owner_org_id': 'org', 'district_id': 'district', 'source_mode': 'live'}
        platform.prepare_devices({'a': {'kind': 'radar', 'x': 1, 'y': 1, 'name': '雷达 01'}}, broker, manifest, lambda: None)
        self.assertEqual(manifest['devices_restored'], [
            {'device_no': stable_device_identity('a', 'radar'), 'name': '模拟 雷达 01', 'before': 'retired'}])

    def test_platform_refusal_keeps_status_code_and_the_old_text(self):
        error = PlatformError('系统接口 /devices/x 返回 409：设备正忙', 409, 'DEVICE_BUSY', '设备正忙')
        self.assertIsInstance(error, ValueError)
        self.assertEqual(str(error), '系统接口 /devices/x 返回 409：设备正忙')
        self.assertEqual((error.status, error.code, error.detail), (409, 'DEVICE_BUSY', '设备正忙'))


class CatalogLogTests(unittest.TestCase):
    def test_start_says_which_devices_were_restored_retired_or_left_alone(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.manifest = {
                'devices_restored': [{'device_no': 'map-sim-eo-eo-1', 'name': '模拟 光电 01', 'before': 'retired'}],
                'device_catalog_reconciliation': {
                    'retired': ['id-2'], 'retired_devices': [{'device_id': 'id-2', 'device_no': 'map-sim-radar-r2',
                                                              'name': '模拟 雷达 02'}],
                    'skipped': [{'device_id': 'id-3', 'device_no': 'map-sim-eo-eo-3', 'name': '模拟 光电 03',
                                 'reasons': ['光电跟踪任务还没结束']}]}}
            runtime.log_catalog_changes()
            logs = {row['kind']: row['message'] for row in runtime.logs}
            self.assertIn('已恢复 1 台', logs['DEVICES_RESTORED'])
            self.assertIn('map-sim-eo-eo-1（模拟 光电 01）', logs['DEVICES_RESTORED'])
            self.assertIn('已退役 1 台', logs['CATALOG_RETIRED'])
            self.assertIn('map-sim-radar-r2（模拟 雷达 02）', logs['CATALOG_RETIRED'])
            self.assertIn('map-sim-eo-eo-3（模拟 光电 03）', logs['CATALOG_SKIPPED'])
            self.assertIn('光电跟踪任务还没结束', logs['CATALOG_SKIPPED'])
            self.assertIn('启动照常进行', logs['CATALOG_SKIPPED'])

    def test_nothing_to_say_logs_nothing(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.manifest = {'device_catalog_reconciliation': {'retired': [], 'retired_devices': [], 'skipped': []}}
            runtime.log_catalog_changes()
            self.assertEqual(runtime.logs, [])


class MqttRecoveryTests(unittest.TestCase):
    def test_wait_for_mqtt_reconnect_is_bounded_and_reports_recovery(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            client = SimpleNamespace(is_connected=Mock(side_effect=[False, False, True]))
            self.assertTrue(runtime.wait_for_mqtt_reconnect(client, timeout=2))
            self.assertEqual([row['kind'] for row in runtime.logs], ['MQTT_RECONNECT', 'MQTT_RECONNECTED'])


if __name__ == '__main__':
    unittest.main()
