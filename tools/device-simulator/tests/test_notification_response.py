import copy
import sys
import time
import unittest
from pathlib import Path
from urllib.parse import urlsplit
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from notification_response import NotificationResponse


class Platform:
    def __init__(self):
        self.now = int(time.time()*1000)
        self.rows = [{'target_id': 'target', 'source_mode': 'replay'}]
        self.observations = [{'source_type': 'TDOA', 'source_mode': 'replay',
            'device_id': 'fusion', 'identity_clue': 'batch-u1', 'observed_at': self.now}]

    def call(self, method, path):
        path = urlsplit(path).path
        if path == '/devices/device': return {'device': {'fusion_device_id': 'fusion'}}
        if path == '/targets': return {'items': self.rows, 'total': len(self.rows)}
        if path.endswith('/observations'): return {'items': self.observations, 'total': len(self.observations)}
        if path.startswith('/targets/'): return self.rows[0]
        if path == '/alarms': return {'items': [], 'total': 0}
        raise AssertionError(path)


class NotificationIdentityTests(unittest.TestCase):
    def setUp(self):
        self.platform = Platform()
        self.response = NotificationResponse(self.platform,
            {'created_at': self.platform.now-1000, 'devices': {'d': {'platform_id': 'device'}},
             'targets': {'t': {'uav_sn': 'batch-u1'}}}, {'t': {'notificationBehavior': 'after_sms'}})

    def test_fresh_batch_rf_identity_resolves_target_without_canonical_serial(self):
        self.assertEqual('target', self.response.read('t').get('target_id'))

    def test_untrusted_observations_never_trigger(self):
        for change in [{'source_type': 'RADAR'}, {'source_mode': 'live'},
                       {'device_id': 'foreign'}, {'identity_clue': 'foreign'},
                       {'observed_at': self.platform.now-6000},
                       {'observed_at': self.platform.now+60000}]:
            with self.subTest(change=change):
                original = copy.deepcopy(self.platform.observations)
                self.platform.observations[0].update(change)
                self.assertNotIn('target_id', self.response.read('t'))
                self.platform.observations = original

    def test_conflicting_rf_identity_does_not_match(self):
        self.platform.observations.append(dict(self.platform.observations[0], identity_clue='other'))
        self.assertNotIn('target_id', self.response.read('t'))

    def test_multiple_targets_for_same_identity_block(self):
        self.platform.rows.append({'target_id': 'second', 'source_mode': 'replay'})
        with self.assertRaisesRegex(ValueError, '多个目标'):
            self.response.read('t')

    def test_linked_target_identity_is_rechecked(self):
        self.assertEqual('target', self.response.read('t').get('target_id'))
        self.platform.observations[0]['identity_clue'] = 'other'
        with self.assertRaisesRegex(ValueError, '身份或来源'):
            self.response.read('t')

    def test_normalized_source_is_not_looked_up_as_a_device(self):
        # 全量场景的目标走规范化观测源；它不在设备台账里，按设备查会 404，撤离观察一直卡住。
        response = NotificationResponse(self.platform,
            {'created_at': self.platform.now-1000, 'targets': {'t': {'uav_sn': 'batch-u1'}},
             'devices': {'d': {'platform_id': 'device'},
                         'normalized-source': {'platform_id': 'normalized-device', 'kind': 'normalized'}}},
            {'t': {'notificationBehavior': 'after_sms'}})
        self.assertEqual('target', response.read('t').get('target_id'))

    def test_conflicting_canonical_serial_blocks_rf_fallback(self):
        self.platform.rows[0]['uav_sn'] = 'other'
        self.assertNotIn('target_id', self.response.read('t'))


if __name__ == '__main__': unittest.main()
