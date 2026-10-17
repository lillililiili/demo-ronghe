"""Independent batches are independent simulated flights; retries retain identity."""
import copy
import sys
import unittest
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from full_scenario import allocate_identities, full_scene
from fullchain import FullChain, plan_identity
from test_fullchain import FakePlatform, TEST_NOW, prepared_manifest


class BatchPlanIdentityTests(unittest.TestCase):
    def scene(self, with_target=False, declared_sn=None):
        scene = full_scene(['uav' if with_target else 'weather'])
        plan = copy.deepcopy(scene['plans'][0])
        old_id = plan['id']
        plan.update(id='plan-' + uuid4().hex[:12], start='00:00', end='23:59')
        targets = [copy.deepcopy(t) for t in scene['targets']
                   if with_target and t['kind'] == 'uav' and t.get('planId') == old_id][:1]
        for target in targets:
            target['id'] = 'target-' + uuid4().hex[:12]
            target['planId'] = plan['id']
            if declared_sn:
                target['uavSn'] = declared_sn
        scene.update(plans=[plan], targets=targets, risks=[], zones=[])
        scene['fullchain'].update(categories=['weather'], weather={'summary':'雷雨','wind_speed_ms':12,'gust_ms':20})
        return scene

    def prepare(self, scene, batch, api=None, now=TEST_NOW):
        manifest = {'batch':batch, 'created_at':now, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene,batch)}
        api = api or FakePlatform()
        chain = FullChain(api, scene, prepared_manifest(scene, manifest),
                          {'owner_org_id':'o','district_id':'d'}, lambda:None)
        chain.prepare()
        return chain, api, manifest

    def context(self, api):
        return {
            'routes':[dict(body, route_no=body['message_id'], route_id='r'+body['message_id'],
                           route_version_id='v'+body['message_id'])
                      for _,path,body,_ in api.calls if path.endswith('/routes')],
            'messages':[{'kind':'FLIGHT_PLAN','message_id':'receipt-'+str(index),
                         'subject_id':'p'+body['message_id'],'state':'ACCEPTED',
                         'payload':copy.deepcopy(body),'created_at':TEST_NOW}
                        for index,(_,path,body,_) in enumerate(api.calls) if path.endswith('/plans')]
        }

    def test_identical_new_batches_separate_support_and_target_plans_without_changing_flight_facts(self):
        for with_target, declared in [(False,None),(True,None),(True,'EXPLICIT-'+uuid4().hex)]:
            with self.subTest(with_target=with_target, declared=declared):
                scene=self.scene(with_target,declared); before=copy.deepcopy(scene)
                first_batch='first-'+uuid4().hex[:16]; second_batch='second-'+uuid4().hex[:16]
                _,first_api,first=self.prepare(scene,first_batch)
                context=self.context(first_api)
                second_api=FakePlatform(input_context=context,route_versions=first_api.route_versions)
                _,second_api,second=self.prepare(scene,second_batch,second_api,TEST_NOW+60000)
                old=next(b for _,p,b,_ in first_api.calls if p.endswith('/plans'))
                new=next(b for _,p,b,_ in second_api.calls if p.endswith('/plans'))
                self.assertEqual(old['simulation_batch_id'],first_batch)
                self.assertEqual(new['simulation_batch_id'],second_batch)
                self.assertNotEqual(old['message_id'],new['message_id'])
                old_identity,new_identity=plan_identity(old),plan_identity(new)
                old_identity.pop('simulation_batch_id');new_identity.pop('simulation_batch_id')
                self.assertEqual(old_identity,new_identity)
                self.assertEqual(scene,before)
                old_ids={pid for p in first['plans'].values() for pid in p['ids']}
                new_ids={pid for p in second['plans'].values() for pid in p['ids']}
                self.assertTrue(old_ids.isdisjoint(new_ids))
                self.assertFalse(any(p.endswith('/routes') for _,p,_,_ in second_api.calls))
                old_weather=next(b for _,p,b,_ in first_api.calls if p.endswith('/weather'))
                new_weather=next(b for _,p,b,_ in second_api.calls if p.endswith('/weather'))
                self.assertNotEqual(old_weather['plan_id'],new_weather['plan_id'])
                self.assertEqual(old_weather['periods'],new_weather['periods'])
                self.assertEqual(old_weather['published_at'],new_weather['published_at'])
                if with_target:
                    target=second['targets'][scene['targets'][0]['id']]
                    self.assertIn(target['plan_id'],new_ids)
                    self.assertEqual(target['uav_sn'],new['uav_sn'])
                    if declared:self.assertEqual(target['uav_sn'],declared)

    def test_same_batch_receipt_and_checkpoint_retries_keep_one_plan_identity(self):
        for with_target in (False,True):
            with self.subTest(with_target=with_target):
                scene=self.scene(with_target);batch='retry-'+uuid4().hex[:16]
                chain,api,manifest=self.prepare(scene,batch)
                original=copy.deepcopy(manifest['plans'])
                chain.prepare()
                self.assertEqual(len([1 for _,p,_,_ in api.calls if p.endswith('/plans')]),1)
                context=self.context(api)
                retry_api=FakePlatform(input_context=context,route_versions=api.route_versions)
                _,retry_api,retry=self.prepare(scene,batch,retry_api,TEST_NOW+120000)
                self.assertFalse(any(p.endswith('/plans') for _,p,_,_ in retry_api.calls))
                self.assertEqual(set(retry['plans']),set(original))
                for key in original:
                    for field in ('ids','route_id','route_version_id'):
                        self.assertEqual(retry['plans'][key][field],original[key][field])

    def test_legacy_or_payloadless_receipt_does_not_supply_a_new_batch_plan(self):
        for missing in ('batch','payload'):
            with self.subTest(missing=missing):
                scene=self.scene();batch='fresh-'+uuid4().hex[:16]
                _,api,_=self.prepare(scene,batch)
                context=self.context(api);record=context['messages'][0]
                saved=copy.deepcopy(record)
                if missing=='batch':record['payload'].pop('simulation_batch_id')
                else:
                    record['message_id']=record['payload']['message_id']
                    record.pop('payload')
                record['subject_id']='historical-plan'
                old_context=copy.deepcopy(context)
                next_api=FakePlatform(input_context=context,route_versions=api.route_versions)
                _,next_api,new=self.prepare(scene,batch,next_api)
                self.assertEqual(len([1 for _,p,_,_ in next_api.calls if p.endswith('/plans')]),1)
                self.assertNotIn('historical-plan',{pid for p in new['plans'].values() for pid in p['ids']})
                self.assertEqual(context,old_context)
                self.assertEqual(saved['payload']['simulation_batch_id'],batch)


if __name__ == '__main__':
    unittest.main()
