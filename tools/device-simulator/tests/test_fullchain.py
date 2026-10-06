import copy
import datetime as dt
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from full_scenario import full_scene, allocate_identities


class FakePlatform:
    def __init__(self, airspace_items=None, input_context=None):
        self.calls=[]
        self.airspace_items = airspace_items or []
        self.input_context = input_context or {'routes': [], 'messages': []}
    def call(self, method, path, body=None, key=None):
        self.calls.append((method,path,copy.deepcopy(body),key))
        if path.endswith('/plan-options'): return {'pilots':[], 'organizations':[], 'source_bindings':[]}
        if path.endswith('/airspaces/context'): return {'items':copy.deepcopy(self.airspace_items)}
        if path.endswith('/context'): return copy.deepcopy(self.input_context)
        if path.endswith('/routes'): return {'route_id':'r'+body['message_id'], 'route_version_id':'v'+body['message_id']}
        if path.endswith('/plans'): return {'subject_id':'p'+body['message_id'], 'result':{'plan_id':'p'+body['message_id']}}
        if path.endswith('/airspaces'): return {'airspace_id':'a'+body['airspace_no'], 'airspace_version_id':'av', 'revision':body['revision']}
        if path.endswith('/observation-devices'): return {'device_id':'norm-dev','source_id':'norm-source'}
        if path.endswith('/weather-devices'): return {'device_id':'weather-dev'}
        return {'state':'ACCEPTED'}


class FullChainTests(unittest.TestCase):
    def setup_chain(self):
        from fullchain import FullChain
        scene=full_scene()
        manifest={'batch':'sim-unit','created_at':1000000,'devices':{},'plans':{},'zones':{},
                  'targets':allocate_identities(scene,'sim-unit')}
        platform=FakePlatform()
        chain=FullChain(platform,scene,manifest,{'owner_org_id':'o','district_id':'d'},lambda:None,
                        clock=lambda:1000000)
        return chain,platform,manifest,scene

    def test_preparation_links_plan_identity_without_seed_or_fake_verification(self):
        chain,p,m,s=self.setup_chain(); chain.prepare()
        calls=p.calls
        plans=[b for _,path,b,_ in calls if path.endswith('/plans')]
        for target in s['targets']:
            if target['kind']=='uav' and target.get('planId'):
                self.assertIn(m['targets'][target['id']]['uav_sn'],[b['uav_sn'] for b in plans])
        self.assertTrue(m['realtime_plan_id'])
        self.assertTrue(m['normalized_source']['source_id'])
        self.assertEqual(m['weather_device']['device_id'],'weather-dev')
        self.assertFalse(any('verifications' in path or '/contacts' in path for _,path,_,_ in calls))

    def test_non_uav_routes_use_separate_support_plan_identity(self):
        chain,p,m,s=self.setup_chain();chain.prepare()
        plans={row['route_version_id']:row for _,path,row,_ in p.calls if path.endswith('/plans')}
        self.assertTrue(all('uav_sn' not in m['targets'][t['id']] for t in s['targets'] if t['kind']!='uav'))
        for target in s['targets']:
            if target['kind']!='uav' and target.get('planId'):
                self.assertNotIn('plan_id',m['targets'][target['id']])
        support=[row['uav_sn'] for row in plans.values() if 'support-uav-p' in row['uav_sn']]
        self.assertTrue(support)
        self.assertTrue(all(serial not in {v.get('uav_sn') for v in m['targets'].values()} for serial in support))

    def test_normalized_observation_uses_batch_external_identity(self):
        chain,p,m,s=self.setup_chain();chain.prepare()
        targets={t['id']:t for t in s['targets']}
        chain.tick(targets,0,1)
        frame=next(body for _,path,body,_ in p.calls if path.endswith('/target-observations'))
        for item in frame['items']:
            key=next(key for key,value in m['targets'].items() if value['external_id']==item['external_target_id'])
            self.assertEqual(item['external_track_id'],item['external_target_id'])
            self.assertEqual('uav_sn' in item,targets[key]['kind']=='uav')

    def test_airspace_version_update_keeps_name_and_owner(self):
        # 平台要求空域版本更新保持原名称和归属；改名会被拒（409），整批模拟在第 2 分钟停下。
        chain,p,m,s=self.setup_chain();chain.prepare()
        targets={t['id']:t for t in s['targets']}
        no='sim-map-airspace-zone-temporary_control'
        original=next(body for _,path,body,_ in p.calls if path.endswith('/airspaces') and body.get('airspace_no')==no)
        chain.tick(targets,120,2)
        update=[body for _,path,body,_ in p.calls if path.endswith('/airspaces') and body.get('airspace_no')==no][-1]
        self.assertEqual(update['revision'],original['revision']+1)
        self.assertEqual(update['action'],'UPSERT')
        for key in ('name','owner_org_id','district_id','kind_code','boundary'):
            self.assertEqual(update[key],original[key],key)

    def test_checkpoint_reprepare_does_not_create_other_objects(self):
        chain,p,m,s=self.setup_chain(); chain.prepare(); n=len(p.calls)
        chain.prepare()
        writes=[c for c in p.calls[n:] if c[0]=='POST']
        self.assertEqual(writes,[])

    def test_repeated_batch_reuses_airspace_identity_and_advances_revision(self):
        first_chain, first_platform, first_manifest, scene = self.setup_chain()
        first_chain.prepare()
        first_rows = [body for _, path, body, _ in first_platform.calls if path.endswith('/airspaces')]
        self.assertEqual({row['airspace_no'] for row in first_rows},
                         {'sim-map-airspace-' + zone['id'] for zone in scene['zones']})

        existing = [{'airspace_no': row['airspace_no'], 'revision': row['revision'],
                     'payload': row} for row in first_rows]
        second_scene = copy.deepcopy(scene)
        second_manifest = {'batch':'sim-next', 'created_at':1001000, 'devices':{}, 'plans':{}, 'zones':{},
                          'targets':allocate_identities(second_scene,'sim-next')}
        from fullchain import FullChain
        second_platform = FakePlatform(existing)
        second_chain = FullChain(second_platform, second_scene, second_manifest,
                                 {'owner_org_id':'o','district_id':'d'}, lambda:None,
                                 clock=lambda:1001000)
        second_chain.prepare()
        second_rows = [body for _, path, body, _ in second_platform.calls if path.endswith('/airspaces')]
        self.assertEqual([row['airspace_no'] for row in second_rows], [row['airspace_no'] for row in first_rows])
        self.assertEqual({row['revision'] for row in second_rows}, {2})

    def test_repeated_batch_reuses_routes_and_plans(self):
        first_chain, first_platform, first_manifest, scene = self.setup_chain()
        first_chain.prepare()
        route_posts = [(body, {'route_id':'r'+body['message_id'], 'route_version_id':'v'+body['message_id']})
                       for _, path, body, _ in first_platform.calls if path.endswith('/routes')]
        plan_posts = [body for _, path, body, _ in first_platform.calls if path.endswith('/plans')]
        self.assertTrue(route_posts and plan_posts)
        self.assertTrue(all(body['message_id'].startswith('sim-map-route-') for body, _ in route_posts))
        self.assertTrue(all(body['message_id'].startswith('sim-map-plan-') for body in plan_posts))
        self.assertTrue(all(body['uav_sn'].startswith('map-sim-uav-') or body['uav_sn'].startswith('map-sim-support-uav-')
                            for body in plan_posts))
        context = {
            'routes': [{'route_id': result['route_id'], 'route_version_id': result['route_version_id'],
                        'route_no': body['message_id'], 'name': body['name'], 'valid_from': body['valid_from'],
                        'valid_to': body['valid_to']} for body, result in route_posts],
            'messages': [{'message_id': body['message_id'], 'kind': 'FLIGHT_PLAN',
                          'subject_id': 'p'+body['message_id']} for body in plan_posts]
        }
        existing_airspaces = [{'airspace_no': body['airspace_no'], 'revision': body['revision'], 'payload': body}
                              for _, path, body, _ in first_platform.calls if path.endswith('/airspaces')]
        second_scene = copy.deepcopy(scene)
        second_manifest = {'batch':'sim-next', 'created_at':1001000, 'devices':{}, 'plans':{}, 'zones':{},
                          'targets':allocate_identities(second_scene,'sim-next')}
        from fullchain import FullChain
        second_platform = FakePlatform(existing_airspaces, context)
        second_chain = FullChain(second_platform, second_scene, second_manifest,
                                 {'owner_org_id':'o','district_id':'d'}, lambda:None,
                                 clock=lambda:1001000)
        second_chain.prepare()
        self.assertFalse([row for _, path, row, _ in second_platform.calls if path.endswith('/routes')])
        self.assertFalse([row for _, path, row, _ in second_platform.calls if path.endswith('/plans')])

    def test_changed_current_window_gets_new_route_and_plan_message(self):
        from fullchain import FullChain
        scene = full_scene(['uav'])
        scene['plans'][0].update(start='13:00', end='14:32')
        shanghai = dt.timezone(dt.timedelta(hours=8))
        first_now = int(dt.datetime(2026, 10, 4, 17, 7, tzinfo=shanghai).timestamp() * 1000)
        first_manifest = {'batch':'sim-old', 'created_at':first_now, 'devices':{}, 'plans':{}, 'zones':{},
                          'targets':allocate_identities(scene,'sim-old')}
        first_platform = FakePlatform()
        FullChain(first_platform, scene, first_manifest, {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:first_now).prepare()
        old_route = next(body for _, path, body, _ in first_platform.calls if path.endswith('/routes'))
        old_plan = next(body for _, path, body, _ in first_platform.calls if path.endswith('/plans') and body['uav_sn'] == 'map-sim-uav-normal')
        context = {
            'routes': [{'route_id':'old-route', 'route_version_id':'old-version', 'route_no':old_route['message_id'],
                        'name':old_route['name'], 'valid_from':old_route['valid_from'], 'valid_to':old_route['valid_to']}],
            'messages': [{'message_id':old_plan['message_id'], 'kind':'FLIGHT_PLAN', 'subject_id':'old-plan',
                          'payload':old_plan}]
        }
        second_now = int(dt.datetime(2026, 10, 5, 9, 0, tzinfo=shanghai).timestamp() * 1000)
        second_manifest = {'batch':'sim-new', 'created_at':second_now, 'devices':{}, 'plans':{}, 'zones':{},
                           'targets':allocate_identities(scene,'sim-new')}
        second_platform = FakePlatform(input_context=context)
        FullChain(second_platform, scene, second_manifest, {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:second_now).prepare()
        new_route = next(body for _, path, body, _ in second_platform.calls if path.endswith('/routes'))
        new_plan = next(body for _, path, body, _ in second_platform.calls
                        if path.endswith('/plans') and body['uav_sn'] == 'map-sim-uav-normal')
        self.assertNotEqual(new_route['message_id'], old_route['message_id'])
        self.assertNotEqual(new_plan['message_id'], old_plan['message_id'])
        self.assertEqual(new_plan['route_version_id'], 'v' + new_route['message_id'])

    def test_plan_retry_uses_payload_key_when_legacy_message_is_not_in_context(self):
        from fullchain import FullChain

        class LegacyMessageCollisionPlatform(FakePlatform):
            def call(self, method, path, body=None, key=None):
                if path.endswith('/plans') and body['message_id'] == 'sim-map-plan-normal-plan-1':
                    raise ValueError('同一消息编号的内容已变化，请使用新编号')
                return super().call(method, path, body, key)

        scene = full_scene(['uav'])
        manifest = {'batch':'sim-retry', 'created_at':1000000, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene,'sim-retry')}
        platform = LegacyMessageCollisionPlatform()

        FullChain(platform, scene, manifest, {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:1000000).prepare()

        plan = next(body for _, path, body, _ in platform.calls if path.endswith('/plans'))
        legacy = 'sim-map-plan-' + scene['plans'][0]['id'] + '-1'
        self.assertNotEqual(plan['message_id'], legacy)
        self.assertTrue(plan['message_id'].startswith(legacy + '-'))
        self.assertRegex(plan['message_id'], r'-[0-9a-f]{12}$')

    def test_route_lookup_preserves_version_window(self):
        from fullchain import FullChain

        class RouteLookupPlatform(FakePlatform):
            def call(self, method, path, body=None, key=None):
                if path.startswith('/routes?'):
                    return {'items': [{'route_id': 'old-route', 'route_no': 'route-old'}]}
                if path.startswith('/routes/old-route/versions'):
                    return {'items': [{'route_version_id': 'old-version', 'valid_from': 1, 'valid_to': 100}]}
                return super().call(method, path, body, key)

        scene = full_scene(['uav'])
        manifest = {'batch':'sim-route', 'created_at':1000, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene,'sim-route')}
        chain = FullChain(RouteLookupPlatform(), scene, manifest,
                          {'owner_org_id':'o','district_id':'d'}, lambda:None)
        route = chain.route_record('route-old')
        self.assertEqual(route['valid_to'], 100)
        self.assertIsNone(chain.reusable_route('route-old', 101, 200))

    def test_plan_upload_uses_scene_local_time_window(self):
        from fullchain import FullChain
        scene = full_scene(['uav'])
        scene['plans'][0].update(start='13:00', end='14:32')
        shanghai = dt.timezone(dt.timedelta(hours=8))
        now = int(dt.datetime(2026, 10, 4, 17, 7, tzinfo=shanghai).timestamp() * 1000)
        manifest = {'batch':'sim-time', 'created_at':now, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene,'sim-time')}
        platform = FakePlatform()
        chain = FullChain(platform, scene, manifest, {'owner_org_id':'o','district_id':'d'}, lambda:None,
                          clock=lambda:now)
        chain.prepare()
        body = next(body for _, path, body, _ in platform.calls
                    if path.endswith('/plans') and body['uav_sn'] == 'map-sim-uav-normal')
        expected_start = int(dt.datetime(2026, 10, 4, 13, 0, tzinfo=shanghai).timestamp() * 1000)
        expected_end = int(dt.datetime(2026, 10, 4, 14, 32, tzinfo=shanghai).timestamp() * 1000)
        self.assertEqual(body['start_at'], expected_start)
        self.assertEqual(body['end_at'], expected_end)
        self.assertEqual(body['status_code'], 'COMPLETED')
        route = next(body for _, path, body, _ in platform.calls
                     if path.endswith('/routes') and body['message_id'] == 'sim-map-route-normal-plan')
        self.assertEqual(route['valid_from'], expected_start)
        self.assertEqual(route['valid_to'], expected_end)

    def test_partial_failure_keeps_successful_ids_and_retry_payload(self):
        chain,p,m,s=self.setup_chain()
        original=p.call; once=[True]
        def fail(method,path,body=None,key=None):
            if path.endswith('/plans') and once[0]: once[0]=False; raise ValueError('unavailable')
            return original(method,path,body,key)
        p.call=fail
        with self.assertRaises(ValueError): chain.prepare()
        self.assertTrue(m['fullchain']['requests'])
        chain.prepare()
        route_calls=[c for c in p.calls if c[1].endswith('/routes')]
        self.assertEqual(len(route_calls), len(s['plans']))


if __name__=='__main__': unittest.main()
