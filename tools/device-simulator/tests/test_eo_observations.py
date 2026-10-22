import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eo_observations import EoObservations

class ObservationsTest(unittest.TestCase):
    def setUp(self):
        self.target={'id':'a','deviceId':'radar','secondaryDeviceId':'tdoa','kind':'uav','path':[[0,0],[100,0]],'speed':10,'height':80,'transport':'mqtt'}
        self.manifest={'batch':'batch-a','devices':{'radar':{'platform_id':'radar-1'},'tdoa':{'platform_id':'tdoa-1'}},'targets':{'a':{'mqtt_object_id':'1000','external_id':'batch-a-t1'}}}
        self.links=[{'device_id':'radar-1','external_target_id':'1000','source_mode':'replay'}]
        self.generator=EoObservations({'enabled':True,'detectConfidence':.9,'trackConfidence':.8},self.manifest,{'a':self.target},lambda:5)
    def test_valid_scene_motion_without_fused_position_or_amsl(self):
        result=self.generator.observation({'source_links':self.links,'longitude':0}, {})
        self.assertEqual(result['className'],'drone')
        self.assertGreater(result['longitude'],100)
        self.assertNotIn('altitude',result)
    def test_ambiguity_wrong_batch_and_live_fail_closed(self):
        self.assertIsNone(self.generator.observation({'source_links':[dict(self.links[0],source_mode='live')]},{}))
        self.assertIsNone(self.generator.observation({'source_links':[dict(self.links[0],external_target_id='other')]},{}))
        second=dict(self.target,id='b'); self.generator.targets['b']=second
        self.generator.manifest['targets']['b']=dict(self.manifest['targets']['a'])
        self.assertIsNone(self.generator.observation({'source_links':self.links},{}))
    def test_disabled_and_silence(self):
        self.generator.config['enabled']=False
        self.assertIsNone(self.generator.observation({'source_links':self.links},{}))
        self.generator.config.update(enabled=True,silenceWindows=[{'at':0,'seconds':10}])
        self.assertIsNone(self.generator.observation({'source_links':self.links},{}))
    def test_known_category_confidence_and_ellipsoid_only(self):
        self.target['kind']='unknown'
        self.assertIsNone(self.generator.observation({'source_links':self.links},{}))
        self.target.update(kind='bird',altitudeDatum='ELLIPSOID')
        self.assertEqual(self.generator.observation({'source_links':self.links},{})['altitude'],80)
        self.generator.config['detectConfidence']=float('nan')
        self.assertIsNone(self.generator.observation({'source_links':self.links},{}))

class NormalizedSecondaryTest(unittest.TestCase):
    def test_uses_only_explicit_secondary_mqtt_identity(self):
        import uuid
        for _ in range(2):
            entity, primary, secondary, mqtt_id = (uuid.uuid4().hex for i in range(4))
            target = {'id': entity, 'deviceId': primary, 'secondaryDeviceId': secondary,
                      'kind': 'uav', 'path': [[430, 260], [432, 260]], 'speed': .2,
                      'height': 180, 'altitudeDatum': 'AMSL', 'transport': 'normalized'}
            manifest = {'batch': uuid.uuid4().hex,
                        'devices': {primary: {'platform_id': primary}, secondary: {'platform_id': secondary}},
                        'targets': {entity: {'mqtt_object_id': mqtt_id, 'external_id': 'normalized-' + entity}}}
            generator = EoObservations({'enabled': True, 'detectConfidence': .9, 'trackConfidence': .8},
                                       manifest, {entity: target}, lambda: 5)
            link = {'device_id': secondary, 'external_target_id': mqtt_id, 'source_mode': 'replay'}
            self.assertEqual(generator.observation({'source_links': [link]}, {})['className'], 'drone')
            self.assertNotIn('altitude', generator.observation({'source_links': [link]}, {}))
            for altered in (dict(link, device_id=primary), dict(link, source_mode='live'),
                            dict(link, external_target_id='normalized-' + entity)):
                self.assertIsNone(generator.observation({'source_links': [altered]}, {}))
            target['secondaryTransport'] = 'normalized'
            self.assertIsNone(generator.observation({'source_links': [link]}, {}))
            target.pop('secondaryTransport')
            target.pop('secondaryDeviceId')
            self.assertIsNone(generator.observation({'source_links': [link]}, {}))

class LifecycleTest(unittest.TestCase):
    def test_video_off_ai_enabled_echo_and_stop(self):
        import json
        from eo_video import EoSimulator, DEFAULT_VIDEO
        from test_eo_video import BINDING, Platform, TASK
        api=Platform(); original=api.call
        api.call=lambda method,path,body=None: ({'details':{'open_task':{'task_id':api.task,'status':api.status,'target_id':'target'}}} if method=='GET' else original(method,path,body))
        class Generator:
            def observation(self,detail,binding): return {'className':'drone','longitude':118,'latitude':37}
        sent=[]; now=[1000]
        eo=EoSimulator(api,{'devices':{'eo':BINDING}},dict(DEFAULT_VIDEO,enabled=False),lambda t,p:sent.append(p),lambda *a:None,clock=lambda:now[0],observations=Generator())
        command={'event':'BeginTracking','edgeId':BINDING['edge_id'],'timestamp':1000000,'metadata':{'deviceId':BINDING['external_id'],'taskId':TASK,'objectData':{'dataId':'guide'},'extention':{'test':True}}}
        eo.handle(BINDING['dispatcher_topic'],json.dumps(command))
        now[0]+=5; eo.tick()
        self.assertEqual(sent[-1]['metadata']['aiStatus']['className'],'drone')
        self.assertEqual(sent[-1]['metadata']['objectData'],{'dataId':'guide'})
        api.task='switched'; now[0]+=5; eo.tick()
        self.assertFalse(eo.active)
        self.assertEqual(len(sent),2)

class AnomalyTest(ObservationsTest):
    def test_explicit_anomalies_do_not_borrow_guidance(self):
        self.generator.config['anomalyWindows']=[{'at':0,'seconds':10,'kind':'missing_position'}]
        self.assertNotIn('longitude',self.generator.observation({'source_links':self.links},{}))
        self.generator.config['anomalyWindows'][0]['kind']='missing_confidence'
        self.assertNotIn('detectConfidence',self.generator.observation({'source_links':self.links},{}))
        self.generator.config['anomalyWindows'][0]['kind']='class_conflict'
        self.assertEqual(self.generator.observation({'source_links':self.links},{})['className'],'bird')
    def test_operations_and_fusion_source_ids_are_different_layers(self):
        # Registration returns the operations-layer source id; target source_links carry the fusion-layer one.
        # The link is found by the fusion device bound to the registered device, not by comparing the two source ids.
        self.manifest['devices']['radar'].update(platform_id='ops-radar',fusion_device_id='radar-1',source_id='ops-source')
        self.links[0]['source_id']='fusion-source'
        self.assertEqual(self.generator.observation({'source_links':self.links},{})['className'],'drone')
        # Another batch's device (or any other device) with the same MQTT object id is still not accepted.
        self.links[0]['device_id']='other-batch-radar'
        self.assertIsNone(self.generator.observation({'source_links':self.links},{}))

class StatusOnlyTest(unittest.TestCase):
    def test_ai_silence_keeps_reports_and_heartbeat(self):
        import json
        from eo_video import EoSimulator, DEFAULT_VIDEO
        from test_eo_video import BINDING, Platform, TASK
        api=Platform()
        api.call=lambda method,path,body=None: {'details':{'open_task':{'task_id':TASK,'status':'OPEN','target_id':'target'}}}
        class Silent:
            config={'enabled':True,'intervalSeconds':2}
            def observation(self,detail,binding): return None
        sent=[]; now=[1000]
        eo=EoSimulator(api,{'devices':{'eo':BINDING}},dict(DEFAULT_VIDEO,enabled=False),lambda t,p:sent.append(p),lambda *a:None,clock=lambda:now[0],observations=Silent())
        command={'event':'BeginTracking','edgeId':BINDING['edge_id'],'timestamp':1000000,'metadata':{'deviceId':BINDING['external_id'],'taskId':TASK}}
        eo.handle(BINDING['dispatcher_topic'],json.dumps(command))
        for _ in range(5): now[0]+=5;eo.tick()
        self.assertEqual(len(sent),6)
        self.assertTrue(all('aiStatus' not in p['metadata'] for p in sent))
        heartbeat={'metadata':{'deviceId':BINDING['external_id']}}
        eo.heartbeat(heartbeat)
        self.assertEqual(heartbeat['metadata']['workState'],1)
        eo.suspend(); now[0]+=5;eo.tick()
        # 暂停时只多发一条“结束跟踪”回执，告诉平台这个任务结束了；之后不再上报。
        self.assertEqual(len(sent),7)
        self.assertEqual(sent[-1]['event'],'EndTracking')
        self.assertEqual(sent[-1]['metadata']['taskId'],TASK)
        eo.tick()
        self.assertEqual(len(sent),7)

class CadenceTest(unittest.TestCase):
    def test_video_off_ai_every_two_seconds_independent_of_status(self):
        import json
        from eo_video import EoSimulator, DEFAULT_VIDEO
        from test_eo_video import BINDING, Platform, TASK
        api=Platform(); api.call=lambda *args: {'details':{'open_task':{'task_id':TASK,'status':'OPEN','target_id':'target'}}}
        class Generator:
            config={'enabled':True,'intervalSeconds':2}
            def observation(self,detail,binding): return {'className':'drone','longitude':118,'latitude':37}
        sent=[];now=[1000]
        eo=EoSimulator(api,{'devices':{'eo':BINDING}},dict(DEFAULT_VIDEO,enabled=False),lambda t,p:sent.append(p),lambda *a:None,clock=lambda:now[0],observations=Generator())
        eo.handle(BINDING['dispatcher_topic'],json.dumps({'event':'BeginTracking','edgeId':BINDING['edge_id'],'timestamp':1000000,'metadata':{'deviceId':BINDING['external_id'],'taskId':TASK}}))
        for i in range(1,7):now[0]=1000+i;eo.tick()
        self.assertEqual([p['timestamp'] for p in sent if 'aiStatus' in p['metadata']],[1002000,1004000,1006000])
        self.assertIn(1005000,[p['timestamp'] for p in sent])
    def test_interval_must_be_bounded_finite_number(self):
        for value in (True,0,-1,float('nan'),301):
            with self.assertRaises(ValueError): EoObservations({'enabled':True,'intervalSeconds':value},{},{},lambda:0)

class DisabledInjectedTest(unittest.TestCase):
    def test_server_injected_disabled_generator_never_reads_target(self):
        import json
        from eo_video import EoSimulator, DEFAULT_VIDEO
        from test_eo_video import BINDING, Platform, TASK
        api=Platform(); calls=[]
        def call(method,path,body=None):
            calls.append(path)
            return {'details':{'open_task':{'task_id':TASK,'status':'OPEN','target_id':'target'}}}
        api.call=call; sent=[]; now=[1000]
        eo=EoSimulator(api,{'devices':{'eo':BINDING}},dict(DEFAULT_VIDEO,enabled=False),lambda t,p:sent.append(p),lambda *a:None,clock=lambda:now[0],observations=EoObservations(None,{}, {},lambda:0))
        eo.handle(BINDING['dispatcher_topic'],json.dumps({'event':'BeginTracking','edgeId':BINDING['edge_id'],'timestamp':1000000,'metadata':{'deviceId':BINDING['external_id'],'taskId':TASK,'extention':{'echo':True}}}))
        now[0]+=5;eo.tick()
        self.assertFalse(any(path.startswith('/targets/') for path in calls))
        self.assertEqual(eo.snapshot()['devices'][0]['ai_observation'],'DISABLED')
        self.assertNotIn('aiStatus',sent[-1]['metadata'])
        self.assertEqual(sent[-1]['metadata']['extention'],{'echo':True})
