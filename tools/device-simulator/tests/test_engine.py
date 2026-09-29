import copy
import math
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from engine import compile_scene, messages, position, metres, coordinates

def scene():
    return {'version':1,'name':'隔离验证','duration':.1,'sites':[{'id':'s1','name':'验证组','x':450,'y':300,'devices':[{'id':'d1','name':'雷达','kind':'radar','health':'正常','heartbeat':'持续上报','interval':1}]}],
            'plans':[],'zones':[],'targets':[{'id':'t1','kind':'uav','name':'验证目标','path':[[450,300],[451,300],[451,301]],'height':50,'speed':5,'planId':'','deviceId':'d1'}],
            'risks':[{'id':'r1','name':'无匹配计划','type':'no-plan','enabled':True,'targetId':'t1','deviceId':'d1'}]}

class EngineTests(unittest.TestCase):
    def test_object_identifiers_are_strings_and_stable_across_frames(self):
        raw = scene()
        compiled, devices, targets, _ = compile_scene(raw)
        manifest = {'provider': 'test', 'devices': {'d1': {'external_id': 'external'}},
                    'targets': {'t1': {'uav_sn': 'TEST'}}}
        ids = []
        for sequence in (1, 2):
            packets = messages(compiled, devices, targets, manifest, .01, 1000 + sequence, {}, sequence)
            objects = next(payload['objects'] for _, payload in packets if 'objects' in payload)
            self.assertTrue(objects)
            self.assertTrue(all(isinstance(item['objectId'], str) and item['objectId'] for item in objects))
            ids.append([item['objectId'] for item in objects])
        self.assertEqual(ids[0], ids[1])

    def motion_packet(self, target, elapsed, kind='radar'):
        raw = scene()
        raw['sites'][0]['devices'][0]['kind'] = kind
        raw['targets'][0].update(target)
        compiled, devices, targets, _ = compile_scene(raw)
        # Runtime motion is added only after the scenario has been validated.
        if '_notification_motion' in target:
            targets['t1']['_notification_motion'] = target['_notification_motion']
        manifest = {'provider': 'test', 'devices': {'d1': {'external_id': 'external'}},
                    'targets': {'t1': {'uav_sn': 'TEST'}}}
        packets = messages(compiled, devices, targets, manifest, elapsed, 1000, {}, 1)
        return next(payload['objects'][0] for _, payload in packets if 'objects' in payload)

    def test_speed_and_axes_follow_turns_and_stop_at_endpoint(self):
        target = scene()['targets'][0]
        corner = metres(target['path'][0], target['path'][1]) / target['speed']
        end = corner + metres(target['path'][1], target['path'][2]) / target['speed']
        for elapsed, east, north in [(0, 5, 0), (corner, 0, -5), (end, 0, 0), (end+1, 0, 0)]:
            with self.subTest(elapsed=elapsed):
                packet = self.motion_packet({}, elapsed)
                self.assertAlmostEqual(packet['speed'], math.hypot(east, north))
                self.assertAlmostEqual(packet['extension']['speedX'], east)
                self.assertAlmostEqual(packet['extension']['speedY'], north)
                self.assertEqual(packet['extension']['speedZ'], 0)

    def test_diagonal_axes_match_scalar_speed_and_existing_position(self):
        target = dict(scene()['targets'][0], path=[[450,300],[460,290]], speed=8)
        packet = self.motion_packet(target, 2)
        ext = packet['extension']
        self.assertAlmostEqual(packet['speed'], 8)
        self.assertGreater(ext['speedX'], 0)
        self.assertGreater(ext['speedY'], 0)
        self.assertAlmostEqual(math.hypot(ext['speedX'], ext['speedY']), 8)
        self.assertEqual([packet['longitude'], packet['latitude']], coordinates(position(target, 2)))

    def test_single_point_zero_speed_and_duplicate_points(self):
        for target in [{'path': [[450,300]]}, {'speed': 0},
                       {'path': [[450,300],[450,300]]}]:
            with self.subTest(target=target):
                packet = self.motion_packet(target, 1)
                self.assertEqual(packet['speed'], 0)
                self.assertEqual(packet['extension']['speedX'], 0)
                self.assertEqual(packet['extension']['speedY'], 0)
        packet = self.motion_packet({'path': [[450,300],[450,300],[451,300]]}, 0)
        self.assertEqual(packet['speed'], 5)

    def test_departure_uses_runtime_speed_and_stops_at_new_endpoint(self):
        motion = {'path': [[450,300],[450,290]], 'at_elapsed': 10, 'speed': 2,
                  'origin': [450,300]}
        packet = self.motion_packet({'_notification_motion': motion}, 11)
        self.assertAlmostEqual(packet['speed'], 2)
        self.assertAlmostEqual(packet['extension']['speedY'], 2)
        packet = self.motion_packet({'_notification_motion': motion}, 1000)
        self.assertEqual(packet['speed'], 0)

    def test_protocol_specific_velocity_fields(self):
        for kind in ('radar', '5ga', 'tdoa'):
            with self.subTest(kind=kind):
                packet = self.motion_packet({}, 0, kind)
                self.assertEqual(packet['speed'], 5)
                self.assertEqual('speedX' in packet['extension'], kind in ('radar', '5ga'))

    def test_explicit_pilot_position_is_transmitted_without_inventing_one(self):
        s=scene();s['targets'][0]['pilotPoint']=[450,300]
        s,d,t,_=compile_scene(s)
        m={'provider':'test','devices':{'d1':{'external_id':'external'}},'targets':{'t1':{'uav_sn':'TEST'}}}
        ext=messages(s,d,t,m,0,1000,{},1)[1][1]['objects'][0]['extension']
        self.assertEqual([ext.get('pilotLon'),ext.get('pilotLat')],coordinates([450,300]))
        raw=scene();s,d,t,_=compile_scene(raw)
        self.assertNotIn('pilotLon',messages(s,d,t,m,0,1000,{},1)[1][1]['objects'][0]['extension'])
    def test_secondary_sensor_reports_same_identity_and_position(self):
        s=scene();s['sites'][0]['devices'].append(dict(s['sites'][0]['devices'][0],id='d2',kind='tdoa'))
        s['targets'][0]['secondaryDeviceId']='d2'
        s,d,t,_=compile_scene(s)
        m={'provider':'test','devices':{'d1':{'external_id':'radar'},'d2':{'external_id':'tdoa'}},'targets':{'t1':{'uav_sn':'TEST'}}}
        objects=[p['objects'][0] for _,p in messages(s,d,t,m,1,1000,{},1) if 'objects' in p]
        self.assertEqual(len(objects),2)
        # Common target facts agree; velocity axes belong to radar/5G-A extensions.
        for obj in objects:
            for key in ('speedX', 'speedY', 'speedZ'):
                obj['extension'].pop(key, None)
        self.assertEqual(objects[0],objects[1])
    def test_secondary_sensor_must_exist_and_support_targets(self):
        s=scene();s['targets'][0]['secondaryDeviceId']='missing'
        with self.assertRaises(ValueError):compile_scene(s)
    def test_explicit_simulated_quality_and_agl_are_transmitted(self):
        s=scene();s['targets'][0].update(probability=.98,heightAgl=60)
        s,d,t,_=compile_scene(s)
        m={'provider':'test','devices':{'d1':{'external_id':'external'}},'targets':{'t1':{'uav_sn':'TEST'}}}
        obj=messages(s,d,t,m,0,1000,{},1)[1][1]['objects'][0]
        self.assertEqual(obj.get('height'),60)
        self.assertEqual(obj['extension'].get('probability'),.98)
        self.assertEqual(obj['altitude'],50)
    def test_missing_quality_and_agl_remain_missing(self):
        s,d,t,_=compile_scene(scene())
        m={'provider':'test','devices':{'d1':{'external_id':'external'}},'targets':{'t1':{'uav_sn':'TEST'}}}
        obj=messages(s,d,t,m,0,1000,{},1)[1][1]['objects'][0]
        self.assertNotIn('height',obj)
        self.assertNotIn('probability',obj['extension'])
    def test_invalid_optional_observation_values_are_rejected(self):
        for key,value in [('probability',1.01),('probability',float('nan')),('heightAgl',-1)]:
            s=scene();s['targets'][0][key]=value
            with self.assertRaises(ValueError):compile_scene(s)
    def test_speed_and_corner(self):
        target=scene()['targets'][0]
        duration=metres(target['path'][0],target['path'][1])/target['speed']
        self.assertEqual(position(target,duration),[451,300])
        self.assertEqual(position(target,100),[451,301])
    def test_offline_stops_all_reports_and_restores(self):
        s=scene();s['risks'].append({'id':'r2','name':'离线','type':'offline','deviceId':'d1','enabled':True,'at':1,'seconds':2})
        s,d,t,_=compile_scene(s);m={'provider':'test','devices':{'d1':{'external_id':'external'}},'targets':{'t1':{'uav_sn':'TEST'}}}
        self.assertEqual(messages(s,d,t,m,1,1000,{},1),[])
        self.assertEqual(len(messages(s,d,t,m,3,3000,{},2)),2)
    def test_fault_recovers(self):
        s=scene();s['risks'].append({'id':'r2','name':'故障','type':'fault','deviceId':'d1','enabled':True,'at':1,'seconds':2})
        s,d,t,_=compile_scene(s);m={'provider':'test','devices':{'d1':{'external_id':'external'}},'targets':{'t1':{'uav_sn':'TEST'}}}
        self.assertEqual(messages(s,d,t,m,1,1000,{},1)[0][1]['workState'],2)
        self.assertEqual(messages(s,d,t,m,3,3000,{},2)[0][1]['workState'],1)
    def test_unsupported_is_not_falsified(self):
        s=scene();s['targets'][0]['kind']='balloon'
        with self.assertRaisesRegex(ValueError,'气球分类码'): compile_scene(s)
    def test_invalid_numbers_and_dangling_refs(self):
        for field,value in [('speed',float('nan')),('height',-1)]:
            s=scene();s['targets'][0][field]=value
            with self.assertRaises(ValueError):compile_scene(s)
        s=scene();s['risks'][0]['deviceId']='missing'
        with self.assertRaises(ValueError):compile_scene(s)
    def test_freezes_input(self):
        raw=scene(); compiled,*_=compile_scene(raw);raw['targets'][0]['path'][0][0]=0
        self.assertEqual(compiled['targets'][0]['path'][0][0],450)
    def test_real_map_outside_old_canvas_preserves_mqtt_coordinates(self):
        s=scene();lon,lat=118.82,37.78
        point=[(lon-118.56)/.00012,(37.50-lat)/.00012]
        s['sites'][0].update(x=point[0],y=point[1]);s['targets'][0]['path']=[point]
        s,d,t,_=compile_scene(s)
        manifest={'provider':'test','devices':{'d1':{'external_id':'external'}},'targets':{'t1':{'uav_sn':'TEST'}}}
        packets=messages(s,d,t,manifest,0,1000,{},1)
        for actual in ([packets[0][1]['deviceLongitude'],packets[0][1]['deviceLatitude']],
                       [packets[1][1]['objects'][0]['longitude'],packets[1][1]['objects'][0]['latitude']]):
            self.assertAlmostEqual(actual[0],lon);self.assertAlmostEqual(actual[1],lat)
        self.assertEqual(coordinates([450,300]),[118.614,37.464])
    def test_real_map_rejects_invalid_wgs84(self):
        for lon,lat in [(181,37),(118,86),(float('nan'),37)]:
            s=scene();s['sites'][0].update(x=(lon-118.56)/.00012,y=(37.50-lat)/.00012)
            with self.assertRaises(ValueError): compile_scene(s)

if __name__=='__main__': unittest.main()
