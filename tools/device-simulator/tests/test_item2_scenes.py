import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_item2_samples import samples, notification_configs
from engine import compile_scene
from realtime_control import validate_config


class Item2ScenesTest(unittest.TestCase):
    def test_delivered_templates_compile_and_match_generator(self):
        for name, scene in samples().items():
            with self.subTest(name=name):
                compile_scene(scene)
                saved = json.loads((Path(__file__).resolve().parents[1]/'scenarios'/'item2'/(name+'.json')).read_text(encoding='utf-8'))
                self.assertEqual(saved, scene)

    def test_mqtt_and_normalized_inputs_remain_distinct_after_roundtrip(self):
        for name, scene in samples().items():
            for _ in range(3):
                scene = compile_scene(json.loads(json.dumps(scene)))[0]
            target = scene['targets'][0]
            if '-mqtt-' in name:
                self.assertEqual('mqtt', target['transport'])
                self.assertNotIn('altitudeDatum', target)
            else:
                self.assertEqual('normalized', target['transport'])
                self.assertEqual('AMSL', target['altitudeDatum'])

    def test_no_fake_pilot_approval_or_platform_outcome_is_injected(self):
        for scene in samples().values():
            self.assertEqual({}, scene['fullchain']['filing'])
            self.assertFalse(scene['fullchain']['airspaceLifecycle'])
            self.assertNotIn('uavSn', scene['targets'][0])
            if scene['risks']:
                self.assertEqual('item2-radar', scene['risks'][0]['deviceId'])
            for field in ('event_id', 'authorization_id', 'decision_assurance', 'verified_at', 'approved_by'):
                self.assertNotIn(field, json.dumps(scene))

    def test_maintenance_has_an_independent_unmatched_preflight_plan(self):
        for name in ('08-device-fault', '09-device-offline'):
            scene = samples()[name]
            plans = {p['id'] for p in scene['plans']}
            matched = {t.get('planId') for t in scene['targets']}
            self.assertEqual({'item2-maintenance-route'}, plans - matched)

    def test_notification_payloads_use_existing_config_contract(self):
        for name, config in notification_configs().items():
            with self.subTest(name=name):
                self.assertEqual(config, validate_config(config))
                self.assertFalse(config['countermeasure_enabled'])
                saved = Path(__file__).resolve().parents[1]/'scenarios'/'item2'/'notification-configs'/(name+'.json')
                self.assertEqual(config, json.loads(saved.read_text(encoding='utf-8')))


if __name__ == '__main__': unittest.main()
