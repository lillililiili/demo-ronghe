import copy
import unittest
import test_fullchain
from engine import compile_scene


class Item2SourcesTest(unittest.TestCase):
    def test_identical_accepted_airspace_is_reused_but_changed_facts_are_submitted(self):
        chain, api, _, scene = test_fullchain.FullChainTests().setup_chain()
        chain.prepare()
        saved = [dict(airspace_id='a'+body['airspace_no'], airspace_version_id='version-'+body['airspace_no'],
                      airspace_no=body['airspace_no'], revision=body['revision'], action='UPSERT',
                      state='ACCEPTED', payload=copy.deepcopy(body))
                 for _,path,body,_ in api.calls if path.endswith('/airspaces')]
        for changed in (None, 'max_altitude_m', 'owner_org_id', 'valid_from', 'boundary'):
            following, _, manifest, _ = test_fullchain.FullChainTests().setup_chain()
            manifest['batch'] = 'another-batch'
            previous = copy.deepcopy(saved)
            if changed:
                previous[0]['payload'][changed] = 'different'
            following.api = test_fullchain.FakePlatform(airspace_items=previous)
            following.prepare()
            writes = [body for _,path,body,_ in following.api.calls if path.endswith('/airspaces')]
            self.assertEqual(1 if changed else 0, len(writes), changed)
            if not changed:
                self.assertEqual({1}, {value['revision'] for value in manifest['zones'].values()})
                self.assertTrue(all(value['id'] for value in manifest['zones'].values()))

    def test_three_explicit_sources_publish_same_facts_with_separate_message_ids(self):
        chain, api, manifest, scene = test_fullchain.FullChainTests().setup_chain()
        scene['fullchain']['observationSourceCount'] = 3
        from fullchain import FullChain
        chain = FullChain(api, scene, manifest, chain.scope, lambda: None, clock=chain.clock)
        original = api.call
        def call(method, path, body=None, key=None):
            result = original(method, path, body, key)
            if path.endswith('/observation-devices'):
                return {'device_id': 'device-'+body['message_id'], 'source_id': 'source-'+body['message_id']}
            return result
        api.call = call
        chain.prepare()
        self.assertEqual(3, len(manifest['normalized_sources']))
        self.assertEqual(manifest['normalized_source'], manifest['normalized_sources'][0])
        chain.tick({t['id']: t for t in scene['targets']}, 0, 1)
        frames = [body for _,path,body,_ in api.calls if path.endswith('/target-observations')]
        self.assertEqual(3, len(frames))
        self.assertEqual(3, len({f['source_id'] for f in frames}))
        self.assertEqual(3, len({f['message_id'] for f in frames}))
        self.assertTrue(all(f['items'] == frames[0]['items'] for f in frames))
        count = len(api.calls)
        chain.prepare()
        self.assertFalse(any(method == 'POST' for method,_,_,_ in api.calls[count:]))

    def test_source_count_validation_and_old_scene_default(self):
        _,_,_,scene = test_fullchain.FullChainTests().setup_chain()
        compile_scene(scene)
        for value in (0, 4, 1.5, True, '3', None):
            invalid = copy.deepcopy(scene)
            invalid['fullchain']['observationSourceCount'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                compile_scene(invalid)


if __name__ == '__main__': unittest.main()
