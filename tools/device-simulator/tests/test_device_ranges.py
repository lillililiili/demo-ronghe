"""Simulator inputs -> persisted range payload; fault windows do not alter capabilities."""
import copy
import sys
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from acceptance_flows import read_acceptance_flows
from engine import compile_scene, device_condition, coordinates, metres
from coverage_defaults import default_coverage
from platform_client import Platform
from realtime_control import prepare_scene, validate_config

ROOT = Path(__file__).resolve().parents[1]

class DeviceRangeTests(unittest.TestCase):
    def test_every_flow_supplies_supported_device_ranges_without_mutating_input(self):
        for item in read_acceptance_flows(ROOT)['flows']:
            raw = item['scene']; original = copy.deepcopy(raw)
            scene, devices, _, _ = compile_scene(raw)
            self.assertEqual(original, raw)
            for device in devices.values():
                if device['kind'] in ('radar','tdoa','5ga','eo','weather','countermeasure'):
                    self.assertIsNotNone(device['coverage'])
                    payload = Platform._sensing_profile_payload(device['coverage'])
                    self.assertIn('模拟', payload['source_label'])
                    self.assertIn(payload['coverage_kind'], ('CIRCLE','SECTOR'))

    def test_custom_range_survives_and_bad_explicit_range_is_not_hidden(self):
        raw = read_acceptance_flows(ROOT)['flows'][0]['scene']
        raw['sites'][0]['devices'][0]['coverage'] = dict(kind='circle', radiusM=437, sourceLabel='场景专用模拟范围')
        self.assertEqual(437, compile_scene(raw)[0]['sites'][0]['devices'][0]['coverage']['radiusM'])
        raw['sites'][0]['devices'][0]['coverage'] = dict(kind='sector', rangeM=1500, sourceLabel='缺项')
        with self.assertRaises(ValueError): compile_scene(raw)
        first = default_coverage('radar'); first['radiusM'] = 1
        self.assertEqual(3000, default_coverage('radar')['radiusM'])
        self.assertIsNone(default_coverage('unknown'))

    def test_flow_eight_fault_offline_and_recovery_with_changed_ids_location_and_time(self):
        for offset, start in [(0,30),(65,45)]:
            raw = copy.deepcopy(read_acceptance_flows(ROOT)['flows'][-1]['scene'])
            site=raw['sites'][0]; site['x']+=offset; site['y']+=offset
            for plan in raw['plans']:
                plan['points']=[[x+offset,y+offset] for x,y in plan['points']]
                plan['id']='plan-'+uuid.uuid4().hex[:12]
            for device in site['devices']:
                old=device['id']; device['id']='device-'+uuid.uuid4().hex[:12]
                for risk in raw['risks']:
                    if risk['deviceId']==old: risk['deviceId']=device['id']; risk['at']=start
            raw=prepare_scene(raw,validate_config({'mode':'normal'}))
            scene,devices,targets,_=compile_scene(raw)
            self.assertFalse(targets)
            for risk in scene['risks']:
                device=devices[risk['deviceId']]
                self.assertEqual('ok',device_condition(scene,device['id'],device,start-1))
                self.assertEqual(risk['type'],device_condition(scene,device['id'],device,start))
                self.assertEqual('ok',device_condition(scene,device['id'],device,start+risk['seconds']))
                self.assertLess(metres([device['x'],device['y']],scene['plans'][0]['points'][0]),device['coverage']['radiusM'])
                self.assertEqual(3000,device['coverage']['radiusM'])

    def test_native_radar_range_and_wrong_identity(self):
        device_id=uuid.uuid4().hex
        record={'device':dict(device_id=device_id,simulated=True,source_mode='live',device_type_code='radar',coverage={})}
        api=Platform('http://127.0.0.1:8081/api/v1')
        api.call=Mock(side_effect=[record,record])
        api.sync_simulated_range(device_id,'radar')
        self.assertEqual(3000,api.call.call_args.args[2]['radius_m'])
        record['device']['device_type_code']='countermeasure'
        api.call=Mock(return_value=record)
        with self.assertRaisesRegex(ValueError,'模拟来源'): api.sync_simulated_range(device_id,'radar')
        self.assertEqual(1,api.call.call_count)

    def test_counter_default_uses_confirmed_simulated_identity_and_current_version(self):
        for source in ('live','replay'):
            device_id=uuid.uuid4().hex
            record={'device':dict(device_id=device_id,simulated=True,source_mode=source,
                device_type_code='countermeasure',coverage={'version':None})}
            api=Platform('http://127.0.0.1:8081/api/v1')
            api.call=Mock(side_effect=[record,record])
            api.sync_simulated_range(device_id,'countermeasure')
            self.assertEqual('PUT',api.call.call_args.args[0])
            self.assertEqual(1000,api.call.call_args.args[2]['radius_m'])
            self.assertEqual(0,api.call.call_args.args[2]['expected_version'])
            record['device']['simulated']=False
            api.call=Mock(return_value=record)
            with self.assertRaisesRegex(ValueError,'模拟来源'): api.sync_simulated_range(device_id,'countermeasure')
            self.assertEqual(1,api.call.call_count)
            record['device']['simulated']=True
            record['device']['coverage']={'kind':'CIRCLE','radius_m':777,'version':3}
            api.call=Mock(return_value=record)
            api.sync_simulated_range(device_id,'countermeasure')
            self.assertEqual(1,api.call.call_count)

if __name__=='__main__': unittest.main()
