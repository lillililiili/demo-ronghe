import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from platform_client import Prerequisites

class AirspaceKindTest(unittest.TestCase):
    def prepare(self, kind):
        seed=Prerequisites('test_only')
        calls=[]
        seed.query=lambda statement: calls.append(statement) or ('1' if statement.startswith('SELECT') else '')
        zone=dict(id='z1',name='测试边界',points=[[100,100],[200,100],[200,200]],max=100,start='08:00',end='18:00')
        if kind is not None: zone['kindCode']=kind
        scene=dict(risks=[dict(type='zone',zoneId='z1',enabled=True)],plans=[],zones=[zone])
        manifest=dict(batch='kind-test',zones={},plans={},targets={})
        return seed,calls,scene,manifest

    def test_selected_types_are_preserved_in_legacy_prerequisites(self):
        for kind in ('PROHIBITED','RESTRICTED','ALTITUDE_LIMIT','PERMITTED','TEMPORARY_CONTROL'):
            seed,calls,scene,manifest=self.prepare(kind)
            seed.create(scene,{},dict(broker_id='b',owner_org_id='o',district_id='d'),manifest,1790467200000)
            self.assertIn(",1,'"+kind+"',ST_GeomFromText",calls[-1])
            if kind!='PROHIBITED': self.assertNotIn("'PROHIBITED'",calls[-1])

    def test_missing_or_invalid_type_is_rejected_before_database_access(self):
        for kind in (None,'',"invalid'"):
            seed,calls,scene,manifest=self.prepare(kind)
            with self.assertRaisesRegex(ValueError,'尚未选择空域类型'):
                seed.create(scene,{},dict(broker_id='b'),manifest,1790467200000)
            self.assertEqual(calls,[])

    def test_demo_sample_zones_can_be_issued_directly(self):
        # The demo's prohibited zone must carry its kind; a drawn boundary alone is never treated as prohibited.
        sample=json.loads((Path(__file__).resolve().parents[1]/'web'/'demo-samples.json').read_text(encoding='utf-8'))
        self.assertTrue(sample['zones'])
        for zone in sample['zones']:
            self.assertIn(zone.get('kindCode'),('PROHIBITED','RESTRICTED','ALTITUDE_LIMIT','PERMITTED','TEMPORARY_CONTROL'),zone['name'])
        self.assertEqual({z['id']:z['kindCode'] for z in sample['zones']}['restricted-zone'],'PROHIBITED')

if __name__=='__main__': unittest.main()
