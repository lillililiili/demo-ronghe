"""Normalized observations retain the devices that actually report a target."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import compile_scene, coordinates, messages
from full_scenario import allocate_identities
from fullchain import FullChain
from test_engine import scene
from test_fullchain import FakePlatform


class SourcePlatform(FakePlatform):
    def call(self, method, path, body=None, key=None):
        result = super().call(method, path, body, key)
        if path.endswith('/observation-devices'):
            return {'device_id': 'device-' + body['message_id'],
                    'source_id': 'source-' + body['message_id']}
        return result


def fixture(main='radar-a', secondary='tdoa-b', secondary_kind='tdoa', location=(450, 300)):
    raw = scene()
    raw['risks'] = []
    site = raw['sites'][0]
    site.update(x=location[0], y=location[1])
    device = site['devices'][0]
    device.update(id=main, name='主探测设备')
    site['devices'].extend([
        dict(device, id=secondary, kind=secondary_kind, name='辅助探测设备'),
        dict(device, id='unselected', kind='5ga', name='未参与设备')])
    raw['targets'][0].update(deviceId=main, secondaryDeviceId=secondary,
        altitudeDatum='AMSL', transport='normalized', path=[list(location)], probability=.91)
    compiled, devices, targets, _ = compile_scene(raw)
    manifest = {'batch': 'sim-multi', 'created_at': 2000000, 'devices': {}, 'plans': {},
                'zones': {}, 'targets': allocate_identities(compiled, 'sim-multi')}
    api = SourcePlatform()
    chain = FullChain(api, compiled, manifest, {'owner_org_id': 'o', 'district_id': 'd'},
                      lambda: None, clock=lambda: 2000000)
    return chain, api, manifest, compiled, devices, targets


def posts(api, ending):
    return [body for _, path, body, _ in api.calls if path.endswith(ending)]


class NormalizedSourceTests(unittest.TestCase):
    def test_each_selected_device_has_independent_source_and_same_target(self):
        for main, auxiliary, position in [('radar-a', 'tdoa-b', (450, 300)),
                ('primary-' + 'a'*65, 'secondary-' + 'b'*65, (620, 410))]:
            with self.subTest(main=main):
                chain, api, manifest, compiled, _, targets = fixture(main, auxiliary, location=position)
                chain.prepare()
                registrations = posts(api, '/observation-devices')
                self.assertEqual(len(registrations), 2)
                self.assertEqual(set(manifest['normalized_sources']), {main, auxiliary})
                self.assertTrue(all(len(row['message_id']) <= 64 for row in registrations))
                self.assertTrue(all([row['longitude'], row['latitude']] == coordinates(position) for row in registrations))
                chain.tick(targets, 0, 1)
                frames = posts(api, '/target-observations')
                self.assertEqual(len({row['source_id'] for row in frames}), 2)
                self.assertEqual(len({row['message_id'] for row in frames}), 2)
                self.assertTrue(all(len(row['message_id']) <= 64 for row in frames))
                self.assertEqual(frames[0]['items'], frames[1]['items'])
                self.assertEqual(frames[0]['items'][0]['class_confidence'], .91)
                self.assertEqual(frames[0]['items'][0]['altitude_amsl_m'], 50)
                count = len(registrations)
                chain.prepare()
                self.assertEqual(len(posts(api, '/observation-devices')), count)

    def test_shared_device_gets_one_frame_containing_only_its_targets(self):
        chain, api, manifest, compiled, _, targets = fixture()
        other = copy.deepcopy(compiled['targets'][0])
        other.update(id='neighbor', secondaryDeviceId='', kind='bird')
        compiled['targets'].append(other)
        targets['neighbor'] = other
        manifest['targets'] = allocate_identities(compiled, manifest['batch'])
        chain.prepare()
        chain.tick(targets, 0, 1)
        frames = {row['source_id']: row for row in posts(api, '/target-observations')}
        primary = frames[manifest['normalized_sources']['radar-a']['source_id']]
        auxiliary = frames[manifest['normalized_sources']['tdoa-b']['source_id']]
        self.assertEqual(len(primary['items']), 2)
        self.assertEqual(len(auxiliary['items']), 1)
        self.assertNotIn('uav_sn', primary['items'][1])
        self.assertEqual(manifest['fullchain']['coverage']['normalized']['accepted'], 3)

    def test_non_observation_auxiliary_does_not_inflate_source_count(self):
        for kind in ('eo', 'weather', 'countermeasure'):
            with self.subTest(kind=kind):
                chain, api, manifest, _, _, targets = fixture(secondary_kind=kind)
                chain.prepare()
                chain.tick(targets, 0, 1)
                self.assertEqual(set(manifest['normalized_sources']), {'radar-a'})
                self.assertEqual(len(posts(api, '/target-observations')), 1)

    def test_offline_source_stops_and_recovers_without_replacing_identity(self):
        chain, api, manifest, compiled, _, targets = fixture()
        compiled['risks'] = [dict(id='off', type='offline', enabled=True,
                                 deviceId='tdoa-b', at=2, seconds=5)]
        chain.prepare()
        for elapsed, expected in [(0, 2), (3, 1), (8, 2)]:
            api.calls.clear()
            chain.tick(targets, elapsed, int(elapsed) + 1)
            frames = posts(api, '/target-observations')
            self.assertEqual(len(frames), expected)
            self.assertIn(manifest['normalized_sources']['radar-a']['source_id'],
                          [row['source_id'] for row in frames])
        compiled['sites'][0]['devices'][0]['heartbeat'] = '停止心跳'
        api.calls.clear()
        chain.tick(targets, 9, 10)
        self.assertEqual(len(posts(api, '/target-observations')), 1)

    def test_silence_and_notification_suppression_stop_all_sources(self):
        for extra in ({'silenceWindows': [{'at': 0, 'seconds': 10}]},
                      {'_notification_motion': {'suppress': True, 'origin': [118.61, 37.46]}}):
            with self.subTest(extra=extra):
                chain, api, _, _, _, targets = fixture()
                targets['t1'].update(extra)
                chain.prepare()
                chain.tick(targets, 1, 2)
                self.assertFalse(posts(api, '/target-observations'))

    def test_mqtt_targets_keep_original_device_protocol_without_normalized_duplicate(self):
        chain, api, manifest, compiled, devices, targets = fixture()
        targets['t1']['transport'] = 'mqtt'
        manifest['provider'] = 'test'
        manifest['devices'] = {key: {'external_id': key} for key in devices}
        chain.prepare()
        chain.tick(targets, 0, 1)
        packets = messages(compiled, devices, targets, manifest, 0, 2000000, {}, 1)
        self.assertFalse(posts(api, '/observation-devices'))
        self.assertFalse(posts(api, '/target-observations'))
        self.assertEqual(len([p for _, p in packets if 'objects' in p]), 2)


if __name__ == '__main__':
    unittest.main()
