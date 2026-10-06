import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from platform_client import Platform, stable_device_identity
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


class MqttRecoveryTests(unittest.TestCase):
    def test_wait_for_mqtt_reconnect_is_bounded_and_reports_recovery(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            client = SimpleNamespace(is_connected=Mock(side_effect=[False, False, True]))
            self.assertTrue(runtime.wait_for_mqtt_reconnect(client, timeout=2))
            self.assertEqual([row['kind'] for row in runtime.logs], ['MQTT_RECONNECT', 'MQTT_RECONNECTED'])


if __name__ == '__main__':
    unittest.main()
