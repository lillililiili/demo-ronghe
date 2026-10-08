"""Batch ownership is required even when the target already has a selected SN."""
import copy
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from notification_response import NotificationResponse
from full_scenario import allocate_identities


class Platform:
    def __init__(self, tag):
        self.now = int(time.time() * 1000)
        self.calls = []
        self.target = {'target_id': tag + '-target', 'source_mode': 'replay', 'uav_sn': tag + '-sn',
                       'source_links': [{'source_id': tag + '-source', 'device_id': tag + '-normalized',
                                         'external_target_id': tag + '-external', 'source_mode': 'replay'}]}
        self.rows = [{'observation_id': tag + '-observation', 'source_type': 'SIM_NORMALIZED',
                      'source_mode': 'replay', 'device_id': tag + '-normalized',
                      'external_target_id': tag + '-external', 'identity_clue': tag + '-sn',
                      'observed_at': self.now}]

    def call(self, method, path):
        self.calls.append(path)
        path = urlsplit(path).path
        if path == '/targets':
            return {'items': [self.target], 'total': 1}
        if path.endswith('/observations'):
            return {'items': self.rows, 'total': len(self.rows)}
        if path.startswith('/targets/'):
            return self.target
        if path == '/alarms':
            return {'items': [], 'total': 0}
        raise AssertionError('Unexpected API, normalized source is not an ops device: ' + path)


class Item2NotificationOwnershipTest(unittest.TestCase):
    def setup_case(self, tag='first'):
        api = Platform(tag)
        manifest = {'created_at': api.now - 1000,
                    'normalized_source': {'source_id': tag + '-source', 'device_id': tag + '-normalized'},
                    'devices': {'normalized-source': {'platform_id': tag + '-normalized', 'kind': 'normalized'}},
                    'targets': {'t': {'uav_sn': tag + '-sn', 'external_id': tag + '-external'}}}
        response = NotificationResponse(api, manifest, {'t': {'notificationBehavior': 'after_sms', 'transport': 'normalized'}})
        return api, response

    def test_current_normalized_observation_matches_two_distinct_batches(self):
        for tag in ('first', 'different'):
            with self.subTest(tag=tag):
                api, response = self.setup_case(tag)
                self.assertEqual(tag + '-target', response.read('t').get('target_id'))
                self.assertFalse(any(path.startswith('/devices/') for path in api.calls))

    def test_source_collections_match_current_link_not_the_first_registered_device(self):
        for shape in ('list', 'dict'):
            with self.subTest(shape=shape):
                api, response = self.setup_case(shape)
                own = response.manifest.pop('normalized_source')
                unrelated = {'source_id': 'other-source', 'device_id': 'other-device'}
                response.manifest['normalized_sources'] = ([unrelated, own] if shape == 'list'
                                                          else {'other': unrelated, 'selected': own})
                self.assertEqual(shape+'-target', response.read('t').get('target_id'))
                api.rows[0]['device_id'] = unrelated['device_id']
                with self.assertRaisesRegex(ValueError, '身份或来源'):
                    response.read('t')

    def test_mqtt_identity_uses_wire_object_id_not_normalized_external_id(self):
        from test_notification_response import Platform as MqttPlatform
        for target_index in (1, 3):
            api = MqttPlatform()
            scene = {'targets': [{'id': 't'+str(i), 'kind': 'uav'} for i in range(target_index)]}
            key = 't'+str(target_index-1)
            manifest = {'created_at': api.now-1000, 'devices': {'d': {'platform_id': 'device'}},
                        'targets': allocate_identities(scene, 'batch')}
            api.observations[0].update(external_target_id=str(target_index*1000),
                                       identity_clue='batch-u'+str(target_index))
            response = NotificationResponse(api, manifest, {key: {'transport': 'mqtt', 'notificationBehavior': 'after_sms'}})
            self.assertEqual('target', response.read(key).get('target_id'))
            api.observations[0]['external_target_id'] = 'other-target'
            with self.assertRaisesRegex(ValueError, '身份或来源'):
                response.read(key)

    def test_selected_serial_alone_does_not_prove_batch_ownership(self):
        changes = [{'device_id': 'foreign'}, {'external_target_id': 'foreign'},
                   {'source_mode': 'live'}, {'source_type': 'RADAR'}, {'identity_clue': 'other'}]
        for change in changes:
            with self.subTest(change=change):
                api, response = self.setup_case()
                api.rows[0].update(change)
                self.assertNotIn('target_id', response.read('t'))

    def test_missing_stale_future_and_prebatch_observations_do_not_trigger(self):
        for age in (6000, -60000, 1500, None):
            with self.subTest(age=age):
                api, response = self.setup_case()
                if age is None:
                    api.rows = []
                else:
                    api.rows[0]['observed_at'] = api.now - age
                self.assertNotIn('target_id', response.read('t'))

    def test_source_link_must_match_registered_source_device_and_external_identity(self):
        for field in ('source_id', 'device_id', 'external_target_id', 'source_mode'):
            with self.subTest(field=field):
                api, response = self.setup_case()
                api.target['source_links'][0][field] = 'foreign'
                self.assertNotIn('target_id', response.read('t'))

    def test_missing_selected_identity_does_not_crash_on_normalized_device_lookup(self):
        api, response = self.setup_case()
        api.target.pop('uav_sn')
        self.assertEqual('first-target', response.read('t').get('target_id'))

    def test_cached_target_ownership_is_rechecked(self):
        api, response = self.setup_case()
        self.assertEqual('first-target', response.read('t').get('target_id'))
        api.rows[0]['device_id'] = 'foreign'
        with self.assertRaisesRegex(ValueError, '身份或来源'):
            response.read('t')

    def test_conflicting_current_identity_blocks_even_with_selected_serial(self):
        api, response = self.setup_case()
        api.rows.append(dict(api.rows[0], identity_clue='conflict'))
        self.assertNotIn('target_id', response.read('t'))


if __name__ == '__main__':
    unittest.main()
