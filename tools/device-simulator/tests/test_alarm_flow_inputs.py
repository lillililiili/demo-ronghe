"""Check actual simulator outputs for the three alarm scenarios, not alarm fixtures."""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import compile_scene, messages
from full_scenario import allocate_identities
from fullchain import FullChain


class AlarmFlowInputTests(unittest.TestCase):
    def setUp(self):
        raw = json.loads((ROOT / 'scenarios/alarm-flows-03-06-07.json').read_text())
        self.scene, self.devices, self.targets, _ = compile_scene(raw)
        self.manifest = {'batch': 'input-check', 'provider': 'map-sim',
                         'targets': allocate_identities(self.scene, 'input-check'),
                         'devices': {key: {'external_id': key, 'edge_id': key, 'gb_id': key}
                                     for key in self.devices}}

    def packets(self, target_id):
        index = list(self.targets).index(target_id) + 1
        return [(topic, item) for topic, payload in messages(
            self.scene, self.devices, self.targets, self.manifest, 0, 1000, {}, 1)
                for item in payload.get('objects', []) if item['objectId'] == str(index * 1000)]

    def test_unplanned_observations_exceed_exemption_without_a_plan(self):
        packets = self.packets('unmatched-uav')
        self.assertEqual(len(packets), 2)
        self.assertTrue(all(item['height'] > 120 for _, item in packets))
        self.assertFalse(self.targets['unmatched-uav'].get('planId'))

    def test_early_takeoff_reports_plan_identity_through_two_real_device_channels(self):
        packets = self.packets('time-uav')
        self.assertEqual(len(packets), 2)
        serial = self.manifest['targets']['time-uav']['uav_sn']
        self.assertTrue(any(item['extension'].get('uavSN') == serial for _, item in packets))
        risk = next(r for r in self.scene['risks'] if r['type'] == 'time')
        self.assertEqual(risk['mode'], '开始前提前飞行')
        self.assertEqual(risk['offset'], 30)

    def test_height_reports_both_datums_and_a_second_device_without_duplicate_sources(self):
        target = self.targets['height-uav']
        self.assertEqual(target['transport'], 'normalized')
        self.assertEqual(target['altitudeDatum'], 'AMSL')
        self.assertEqual(target['heightAgl'], 200)
        plan = next(p for p in self.scene['plans'] if p['id'] == target['planId'])
        self.assertEqual(plan['altitudeDatum'], 'AGL')
        self.assertGreater(target['heightAgl'], plan['max'])
        self.assertEqual(FullChain.normalized_device_ids(target, self.devices), [target['deviceId']])
        packets = self.packets('height-uav')
        self.assertEqual(len(packets), 1)
        self.assertEqual(packets[0][1]['height'], 200)
        self.assertEqual(packets[0][1]['extension']['uavSN'], self.manifest['targets']['height-uav']['uav_sn'])


if __name__ == '__main__':
    unittest.main()
