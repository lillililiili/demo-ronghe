import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class FullScenarioTests(unittest.TestCase):
    def test_catalog_covers_classes_and_separate_flight_behaviors(self):
        from full_scenario import full_scene
        scene = full_scene()
        from engine import compile_scene
        self.assertEqual(len(scene['targets']), len(compile_scene(scene)[2]))
        self.assertEqual(scene['duration'], 0)
        self.assertEqual({t['kind'] for t in scene['targets']},
                         {'uav', 'bird', 'unknown', 'identifying', 'balloon', 'person', 'vehicle', 'ship', 'remote_controller'})
        self.assertTrue({'normal', 'deviation', 'prohibited', 'height', 'overtime', 'unplanned', 'departure', 'lost'} <= {t['id'] for t in scene['targets']})
        self.assertEqual({z['kindCode'] for z in scene['zones']},
                         {'PERMITTED', 'RESTRICTED', 'PROHIBITED', 'ALTITUDE_LIMIT', 'TEMPORARY_CONTROL'})
        self.assertFalse(next(t for t in scene['targets'] if t['id'] == 'unplanned')['planId'])
        devices = {row['id']: row for row in scene['sites'][0]['devices']}
        self.assertEqual(devices['radar']['coverage']['radiusM'], 8000)
        self.assertEqual(devices['eo']['coverage']['kind'], 'sector')
        self.assertNotIn('coverage', devices['tdoa'])

    def test_fresh_copy_and_shared_serial_allocation(self):
        from full_scenario import full_scene, allocate_identities
        first, second = full_scene(), full_scene()
        first['targets'][0]['name'] = 'changed'
        self.assertNotEqual(first['targets'][0]['name'], second['targets'][0]['name'])
        result = allocate_identities(second, 'sim-proof')
        self.assertEqual(result, allocate_identities(second, 'sim-proof'))
        self.assertEqual(len({r['external_id'] for r in result.values()}), len(result))
        self.assertTrue(all(('uav_sn' in result[t['id']]) == (t['kind'] == 'uav') for t in second['targets']))

    def test_categories_filter_without_dangling_risks(self):
        from full_scenario import full_scene
        scene = full_scene(['unknown', 'weather'])
        self.assertEqual({t['kind'] for t in scene['targets']}, {'unknown'})
        ids = {t['id'] for t in scene['targets']}
        self.assertTrue(all(not r.get('targetId') or r['targetId'] in ids for r in scene['risks']))
        with self.assertRaises(ValueError):
            full_scene(['nonexistent'])

    def test_mixed_does_not_erase_device_fault_windows(self):
        from full_scenario import full_scene
        from realtime_control import prepare_scene, validate_config
        scene = full_scene()
        prepared = prepare_scene(scene, validate_config({'mode':'mixed'}))
        self.assertTrue(all(r['enabled'] for r in prepared['risks']))
        self.assertEqual(scene, prepare_scene(scene, validate_config({})))


if __name__ == '__main__': unittest.main()
