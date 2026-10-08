import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from build_acceptance_samples import samples
from engine import compile_scene, messages


class TransportRoundtripTests(unittest.TestCase):
    def test_six_protocol_a_sources_keep_mqtt_and_unknown_datum_after_roundtrip(self):
        raw = samples()['01-six-types']
        for cycle in range(3):
            compiled, devices, targets, _ = compile_scene(raw)
            with self.subTest(cycle=cycle):
                self.assertEqual({t['transport'] for t in targets.values()}, {'mqtt'})
                self.assertTrue(all('altitudeDatum' not in t for t in targets.values()))
                manifest = {'provider': 'roundtrip',
                            'devices': {key: {'external_id': 'roundtrip-' + key} for key in devices},
                            'targets': {key: {'uav_sn': 'SN-' + key} for key in targets}}
                packets = messages(compiled, devices, targets, manifest, 0, 1900000000000, {}, 1)
                frames = [p for _, p in packets if p.get('objects')]
                self.assertEqual(len(frames), 6)
            raw = json.loads(json.dumps(compiled))

    def test_explicit_mqtt_with_amsl_stays_mqtt(self):
        raw = samples()['01-six-types']
        for target in raw['targets']:
            target['altitudeDatum'] = 'AMSL'
        compiled, _, _, _ = compile_scene(raw)
        self.assertTrue(all(t['transport'] == 'mqtt' for t in compiled['targets']))

    def test_agl_mqtt_is_rejected_instead_of_silently_switching_channel(self):
        raw = samples()['01-six-types']
        raw['targets'][0]['altitudeDatum'] = 'AGL'
        with self.assertRaisesRegex(ValueError, 'AGL'):
            compile_scene(raw)

    def test_explicit_normalized_and_declared_datum_default_remain_supported(self):
        for datum in ('AMSL', 'AGL'):
            for explicit in (True, False):
                with self.subTest(datum=datum, explicit=explicit):
                    raw = copy.deepcopy(samples()['01-six-types'])
                    for target in raw['targets']:
                        target['altitudeDatum'] = datum
                        if explicit:
                            target['transport'] = 'normalized'
                        else:
                            target.pop('transport', None)
                    compiled, _, _, _ = compile_scene(raw)
                    self.assertTrue(all(t['transport'] == 'normalized' for t in compiled['targets']))
                    self.assertEqual(compile_scene(compiled)[0], compiled)


if __name__ == '__main__':
    unittest.main()
