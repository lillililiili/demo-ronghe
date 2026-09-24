import copy
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
