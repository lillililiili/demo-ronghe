"""Mechanical QA state is derived from geometry, source association and freshness."""
import copy
import json
from pathlib import Path
import sys
import unittest
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eo_pointing import SimulatedGimbal
from eo_video import EoSimulator, DEFAULT_VIDEO
from eo_observations import EoObservations
from engine import coordinates


class PointingTests(unittest.TestCase):
    def test_rate_limited_opposite_directions_and_separate_devices(self):
        for lon, lat in ((118.0, 37.0), (119.3, 36.4)):
            binding = {'longitude': lon, 'latitude': lat, 'altitude_m': 10, 'altitude_datum': 'AMSL',
                       'coverage': {'kind': 'circle', 'radiusM': 2000}}
            east, west = SimulatedGimbal(binding, 1000), SimulatedGimbal(binding, 1000)
            sample = {'longitude': lon+.005, 'latitude': lat, 'altitude': 90,
                      'altitude_datum': 'AMSL', 'coordinate_system': 'WGS84'}
            def detail(t, position=None):
                point = position or sample
                return {'latest_state': {'observed_at': t*1000, 'location': {k:point[k] for k in ('longitude','latitude','coordinate_system')}, 'altitude_amsl_m':point['altitude']}}
            east.begin(1000); west.begin(1000)
            self.assertFalse(east.update(sample, detail(1000), 1000))
            self.assertFalse(east.update(sample, detail(1001), 1001))
            self.assertEqual(east.pan, 30)
            self.assertTrue(east.update(sample, detail(1003), 1003))
            self.assertAlmostEqual(east.pan, 90, delta=.1)
            opposite = dict(sample, longitude=lon-.005)
            self.assertFalse(west.update(opposite, detail(1001, opposite), 1001))
            self.assertEqual(west.pan, 330)
            self.assertTrue(west.update(opposite, detail(1003, opposite), 1003))
            self.assertAlmostEqual(west.pan, 270, delta=.1)
            self.assertFalse(east.update(opposite, detail(1004, opposite), 1004))
            self.assertEqual(east.state, 'TURNING')
            self.assertTrue(east.update(opposite, detail(1010, opposite), 1010))
            self.assertFalse(east.update(None, detail(1011), 1011))
            self.assertEqual(east.state, 'UNKNOWN')
            self.assertFalse(east.update(opposite, detail(1012, opposite), 1012))
            self.assertTrue(east.update(opposite, detail(1013, opposite), 1013))
            self.assertFalse(east.update(opposite, detail(1012, opposite), 1028))
            self.assertEqual(east.state, 'UNKNOWN')

    def test_static_north_sector_and_unknown_datum_never_expand(self):
        b = {'longitude':118, 'latitude':37, 'altitude_m':0,'altitude_datum':'AMSL',
             'coverage':{'kind':'sector','rangeM':1500,'azimuthDeg':0,'fovDeg':120}}
        g = SimulatedGimbal(b, 0); g.begin(0)
        s = {'longitude':118.005,'latitude':37,'altitude':80,'altitude_datum':'AMSL','coordinate_system':'WGS84'}
        self.assertFalse(g.update(s, {'latest_state':{'observed_at':5000,'location':{'longitude':s['longitude'],'latitude':s['latitude'],'coordinate_system':'WGS84'},'altitude_amsl_m':80}}, 5))
        self.assertEqual(g.state,'LOST')
        self.assertEqual(b['coverage']['fovDeg'],120)
        s.update(longitude=118,latitude=37.005,altitude_datum=None)
        self.assertFalse(g.update(s, {'latest_state':{'observed_at':6000}}, 6))
        self.assertEqual(g.state,'UNKNOWN')
        self.assertEqual(g.camera(6)['angleReference'],'TRUE_NORTH')

    def test_measured_guidance_does_not_invent_actual_acquisition(self):
        b={'longitude':118,'latitude':37,'altitude_m':0,'altitude_datum':'AMSL',
           'coverage':{'kind':'circle','radiusM':4000}}
        sample={'longitude':118.005,'latitude':37,'altitude':100,'altitude_datum':'AMSL','coordinate_system':'WGS84'}
        detail={'source_mode':'replay','latest_state':{'observed_at':1005000,
                'location':{'longitude':117.995,'latitude':37,'coordinate_system':'WGS84'},'altitude_amsl_m':100}}
        g=SimulatedGimbal(b,1000);g.begin(1000)
        self.assertFalse(g.update(sample,detail,1005))
        self.assertAlmostEqual(g.pan,270,delta=.1)  # measured guide points west, actual sample east
        self.assertEqual(g.state,'TURNING')
        for change in ({'point_kind':'PRED'}, {'status':'UNKNOWN'}, {'location':None}, {'observed_at':900000}):
            altered=copy.deepcopy(detail);altered['latest_state'].update(change)
            self.assertFalse(g.update(sample,altered,1006))
            self.assertEqual(g.state,'UNKNOWN')
        b['altitude_datum']=None
        self.assertFalse(g.update(sample,detail,1007))

    def test_long_scenes_produce_observation_inputs_for_two_actual_alarms(self):
        from engine import compile_scene, position
        folder=Path(__file__).resolve().parents[1]/'scenarios'/'eo-fusion'
        for name,count in (('one-camera-priority-900s.json',1),('two-camera-assign-900s.json',2)):
            raw=json.loads((folder/name).read_text(encoding='utf-8'))
            scene,devices,targets,skipped=compile_scene(raw)
            self.assertEqual(skipped,[])
            self.assertEqual(scene['duration'],15)
            self.assertEqual(sum(d['kind']=='eo' for d in devices.values()),count)
            self.assertTrue(scene['fullchain']['enabled'])
            self.assertEqual(len(scene['zones']),2)
            self.assertEqual(len(scene['plans']),2)
            self.assertEqual(scene['risks'],[])  # no injected alarm or execution result
            unknown=copy.deepcopy(raw);unknown['targets'][0].pop('altitudeDatum')
            _,_,unknown_targets,_=compile_scene(unknown)
            unknown_target=next(t for t in unknown_targets.values() if t['id']==unknown['targets'][0]['id'])
            self.assertTrue(unknown_target['_eo_altitude_datum_defaulted'])
            for target in targets.values():
                self.assertEqual(target['transport'],'normalized')
                self.assertEqual(target['altitudeDatum'],'AMSL')
                self.assertEqual(target['notificationBehavior'],'none')
                self.assertIn(target['planId'],{p['id'] for p in scene['plans']})
                start=position(target,50)
                self.assertTrue(any(min(p[0] for p in z['points'])<=start[0]<=max(p[0] for p in z['points'])
                                    and min(p[1] for p in z['points'])<=start[1]<=max(p[1] for p in z['points']) for z in scene['zones']))
            from engine import messages
            from fullchain import stable_uav_sn
            manifest={'provider':'fixture-'+uuid.uuid4().hex,'batch':uuid.uuid4().hex,
                      'devices':{key:{'external_id':uuid.uuid4().hex,'edge_id':uuid.uuid4().hex} for key in devices},
                      'targets':{key:{'uav_sn':stable_uav_sn(key)} for key in targets}}
            data=[p for _,p in messages(scene,devices,targets,manifest,50,1000000,{},1) if p.get('objects')]
            objects=[o for p in data for o in p['objects']]
            self.assertEqual(len(objects),2)
            self.assertEqual(len({o['objectId'] for o in objects}),2)
            self.assertEqual(len({o['extension']['uavSN'] for o in objects}),2)
            self.assertEqual({o['extension']['uavSN'] for o in objects},{row['uav_sn'] for row in manifest['targets'].values()})
            self.assertEqual(len({t['planId'] for t in targets.values()}),2)
            east=next(t for t in targets.values() if t['id'].endswith('-east'))
            end=position(east,500)
            self.assertFalse(any(min(p[0] for p in z['points'])<=end[0]<=max(p[0] for p in z['points']) for z in scene['zones']))

    def test_real_source_identity_freshness_capture_loss_and_exact_stop(self):
        for _ in range(2):
            device, radar, target, task = (uuid.uuid4().hex for i in range(4))
            lon, lat = coordinates([420,300])
            b = {'kind':'eo','platform_id':device,'external_id':device,'edge_id':'edge',
                 'dispatcher_topic':'dispatch/'+device,'reporting_topic':'report/'+device,
                 'longitude':lon,'latitude':lat,'altitude_m':0,'altitude_datum':'AMSL','coverage':{'kind':'circle','radiusM':4000}}
            now=[1000.0]; elapsed=[0.0]; messages=[]
            entity={'id':target,'kind':'uav','deviceId':radar,'transport':'mqtt','path':[[470,300],[480,300]],'height':80,'altitudeDatum':'AMSL','speed':1}
            manifest={'batch':task,'devices':{'eo':b,radar:{'platform_id':radar,'kind':'radar'}},'targets':{target:{'mqtt_object_id':target}}}
            links=[{'device_id':radar,'source_mode':'replay','external_target_id':target}]
            class Api:
                def call(self, method, path, body=None):
                    if path.startswith('/targets/'):
                        from engine import target_sample
                        sample=target_sample(entity,elapsed[0])
                        return {'latest_state':{'observed_at':now[0]*1000,'location':{k:sample[k] for k in ('longitude','latitude')} | {'coordinate_system':'WGS84'},'altitude_amsl_m':80},'source_links':links}
                    return {'details':{'open_task':{'task_id':task,'status':'OPEN','target_id':target}}}
            generator=EoObservations({'enabled':True,'detectConfidence':.95,'trackConfidence':.9},manifest,{target:entity},lambda:elapsed[0])
            eo=EoSimulator(Api(),manifest,dict(DEFAULT_VIDEO,enabled=False),lambda t,p:messages.append(p),lambda *a:None,clock=lambda:now[0],observations=generator)
            def command(event, identity=task):
                return json.dumps({'event':event,'edgeId':'edge','timestamp':int(now[0]*1000),'metadata':{'deviceId':device,'taskId':identity}})
            eo.handle(b['dispatcher_topic'],command('BeginTracking'))
            self.assertEqual(messages[-1]['metadata']['workState'],0)
            self.assertNotIn('aiStatus',messages[-1]['metadata'])
            now[0]+=5;elapsed[0]+=5;eo.tick()
            self.assertEqual(messages[-1]['metadata']['workState'],1)
            self.assertIn('aiStatus',messages[-1]['metadata'])
            heartbeat={'metadata':{'deviceId':device,'taskId':'stale'}}
            eo.heartbeat(heartbeat)
            self.assertEqual(heartbeat['metadata']['taskId'],task)
            self.assertEqual(heartbeat['metadata']['workState'],1)
            from eo_worker import EoWorker
            from unittest.mock import patch
            worker=EoWorker(eo)
            worker_beat={'metadata':{'deviceId':device,'taskId':'wrong'}}
            worker.heartbeat(worker_beat)
            self.assertEqual(worker_beat['metadata']['taskId'],task)
            self.assertEqual(worker_beat['metadata']['cameraStatus']['trackingState'],'TRACKING')
            original_camera_stamp=worker_beat['metadata']['cameraStatus']['observedAt']
            with patch('eo_worker.time.monotonic',return_value=worker.heartbeat_snapshot_at+6):
                worker.heartbeat(worker_beat)
            self.assertEqual(worker_beat['metadata']['workState'],0)
            self.assertEqual(worker_beat['metadata']['cameraStatus']['trackingState'],'UNKNOWN')
            self.assertFalse(worker_beat['metadata']['cameraStatus']['calibrated'])
            self.assertEqual(worker_beat['metadata']['cameraStatus']['observedAt'],original_camera_stamp)
            self.assertFalse(any(key in worker_beat['metadata']['cameraStatus'] for key in ('panOrientAngle','tiltOrientAngle','hfov','vfov')))
            self.assertEqual(worker_beat['metadata']['taskId'],task)
            links[0]['source_mode']='live';now[0]+=5;elapsed[0]+=5;eo.tick()
            self.assertEqual(messages[-1]['metadata']['workState'],0)
            self.assertNotIn('aiStatus',messages[-1]['metadata'])
            links[0]['source_mode']='replay';now[0]+=5;elapsed[0]+=5;eo.tick()
            self.assertEqual(messages[-1]['metadata']['workState'],0)
            now[0]+=5;elapsed[0]+=5;eo.tick()
            self.assertEqual(messages[-1]['metadata']['workState'],1)
            with self.assertRaises(ValueError):eo.handle(b['dispatcher_topic'],command('EndTracking','wrong-'+task))
            self.assertIn(device,eo.active)
            eo.handle(b['dispatcher_topic'],command('EndTracking'))
            self.assertEqual(messages[-1]['metadata']['cameraStatus']['trackingState'],'STOPPED')
            self.assertEqual(messages[-1]['metadata']['workState'],0)
            self.assertNotIn(device,eo.active)
            worker._snapshot()
            worker.heartbeat(worker_beat)
            self.assertNotIn('taskId',worker_beat['metadata'])
            self.assertEqual(worker_beat['metadata']['workState'],0)
            heartbeat={'metadata':{'deviceId':device,'taskId':task}}
            eo.heartbeat(heartbeat)
            self.assertIn('cameraStatus',heartbeat['metadata'])
            self.assertNotIn('taskId',heartbeat['metadata'])
            self.assertEqual(heartbeat['metadata']['workState'],0)

if __name__=='__main__':unittest.main()
