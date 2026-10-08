import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from build_acceptance_samples import samples
from engine import compile_scene, coordinates
from export_mqttx_messages import export, receipts
from prerequisite_check import verify


class Item1InputsTests(unittest.TestCase):
    def test_all_delivered_scenes_compile_and_match_generator(self):
        for name, scene in samples().items():
            with self.subTest(name=name):
                compile_scene(scene)
                saved=json.loads((Path(__file__).resolve().parents[1]/'scenarios'/'item1'/(name+'.json')).read_text(encoding='utf-8'))
                self.assertEqual(saved,scene)

    def test_mqttx_export_keeps_negative_samples_separate_and_duplicate_exact(self):
        rows=export(samples()['01-six-types'])['messages']
        cases={r['case']:r for r in rows if r['case']!='normal'}
        original=next(r for r in rows if '/device_data/' in r['topic'])
        self.assertEqual(cases['duplicate']['payload'],original['payload'])
        self.assertNotEqual(cases['wrong-device']['payload']['deviceId'],original['payload']['deviceId'])
        self.assertTrue(cases['retained']['retain'])
        self.assertFalse(original['retain'])

    def test_readback_checks_plan_identity_scope_time_route_geometry_and_device_binding(self):
        scene=samples()['08-controlled-inputs']
        plan=scene['plans'][0]
        body={'uav_sn':'SIM-SN','start_at':10,'end_at':20,'source_mode':'replay','route_version_id':'v'}
        manifest={'broker_id':'b','provider':'map-sim','plan_expectations':{'p':body},
                  'plans':{'item1-plan':{'route_version_id':'v','ids':['p']}},
                  'devices':{'d':{'kind':'tdoa','external_id':'ext','platform_id':'d'}}}
        scope={'owner_org_id':'org','district_id':'district'}
        responses={'/flight-plans/p':{**body,**scope,'route':{'route_version_id':'v'}},
                   '/route-versions/v':{'corridor_width_m':100,'min_altitude_m':0,'max_altitude_m':150,
                       'altitude_datum':'AMSL','valid_from':1,'valid_to':30,
                       'centerline':{'coordinates':[coordinates(p) for p in plan['points']]}},
                   '/devices/d/protocol-status':{'details':{'broker_id':'b','provider_code':'map-sim',
                       'external_device_id':'ext','device_type_abbr':'tdoa'}}}
        class Api:
            def call(self,method,path):
                self_test.assertEqual(method,'GET')
                return copy.deepcopy(responses[path])
        self_test=self
        self.assertEqual(len(verify(Api(),scene,manifest,scope)['plans']),1)
        # A newly submitted route is stored as the API message envelope; reused
        # routes use the direct result. Both must verify the same saved version.
        manifest['plans']['item1-plan']={'message_id':'receipt-id','result':{'route_version_id':'v'},'ids':['p']}
        self.assertEqual(len(verify(Api(),scene,manifest,scope)['routes']),1)
        mutations=[('/flight-plans/p','uav_sn','WRONG'),('/flight-plans/p','start_at',11),
                   ('/flight-plans/p','district_id','OTHER'),('/route-versions/v','altitude_datum','AGL'),
                   ('/route-versions/v','valid_to',19),('/route-versions/v','centerline',{'coordinates':[]})]
        for path,key,value in mutations:
            previous=responses[path][key];responses[path][key]=value
            with self.assertRaises(ValueError):verify(Api(),scene,manifest,scope)
            responses[path][key]=previous
        responses['/devices/d/protocol-status']['details']['broker_id']='other'
        with self.assertRaises(ValueError):verify(Api(),scene,manifest,scope)

    def test_mqttx_receipts_require_captured_command_and_only_mutate_requested_field(self):
        command={'head':{'msgNo':'LY-observed','deviceId':'ext','time':1},
                 'data':{'operationType':1,'operationCmd':60003,'operationParams':{}}}
        rows={r['case']:r for r in receipts('bridge/test/device_control/ifr/ext',command)['messages']}
        self.assertEqual(rows['success']['payload'],rows['duplicate']['payload'])
        self.assertEqual(rows['success']['payload']['head']['msgNo'],'LY-observed')
        self.assertEqual(rows['failure']['payload']['data']['code'],1)
        self.assertNotEqual(rows['wrong-source']['topic'],rows['success']['topic'])
        self.assertEqual(rows['wrong-msg-no']['payload']['head']['msgNo'],'LY-observed-wrong')
        with self.assertRaises(ValueError):receipts('bridge/test/device_control/ifr/other',command)
