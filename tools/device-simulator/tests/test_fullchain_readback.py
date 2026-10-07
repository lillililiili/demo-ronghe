import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import Runtime


class ReadbackTest(unittest.TestCase):
    def test_multiple_normalized_sources_are_counted_once_per_target(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.batch = 'sim-multi-readback'
            (Path(root) / runtime.batch).mkdir()
            runtime.manifest = {'batch': runtime.batch, 'created_at': 1,
                'devices': {key: {'kind': 'normalized', 'platform_id': key, 'external_id': key}
                            for key in ('n1', 'n2')},
                'normalized_sources': {'main': {'device_id': 'n1'}, 'aux': {'device_id': 'n2'}},
                'plans': {}, 'zones': {}, 'targets': {},
                'fullchain': {'coverage': {'normalized': {'submitted': 8, 'accepted': 8}}}}

            def call(method, path):
                if path.startswith('/targets?page='):
                    return {'items': [{'target_id': 'merged'}], 'total': 1}
                if path.endswith('/observations?page=1&size=1'):
                    return {'total': 8, 'items': []}
                if path == '/targets/merged':
                    return {'target_id': 'merged', 'object_type_code': 'UAV',
                            'source_links': [{'device_id': 'n1'}, {'device_id': 'n2'}]}
                return {'items': [], 'total': 0}

            runtime.session.platform = SimpleNamespace(call=call)
            result = runtime.verify()
            self.assertEqual(len(result['targets']), 1)
            self.assertEqual(result['normalized_observations_count'], 8)
            self.assertEqual(runtime.manifest['fullchain']['coverage']['normalized']['processed'], 8)

    def test_reads_second_target_page_and_keeps_processed_separate_from_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            runtime=Runtime(root)
            runtime.batch='sim-readback';(Path(root)/runtime.batch).mkdir()
            runtime.manifest={'batch':runtime.batch,'created_at':1,'devices':{'normalized-source':{'kind':'normalized','platform_id':'n','external_id':'source'}},
                'normalized_source':{'device_id':'n'},'plans':{},'zones':{},'targets':{},
                'fullchain':{'coverage':{'normalized':{'submitted':9,'accepted':9,'processed':None}}}}
            calls=[]
            def call(method,path):
                calls.append(path)
                if path.startswith('/targets?page='):
                    ids=range(100) if 'page=1&' in path else [100]
                    return {'items':[{'target_id':str(i)} for i in ids],'total':101}
                if path.endswith('/observations?page=1&size=1'):return {'total':7,'items':[{'observed_at':2}]}
                if path.endswith('/tracks?page=1&size=100'):return {'items':[{'track_id':'track'}],'total':1}
                if path.startswith('/tracks/'):return {'items':[],'total':14}
                if path.startswith('/targets/'):
                    return {'target_id':path.split('/')[-1],'object_type_code':'UNKNOWN','subtype':'BALLOON',
                            'source_links':[{'device_id':'n' if path=='/targets/100' else 'other'}]}
                return {'items':[],'total':0}
            runtime.session.platform=SimpleNamespace(call=call)
            result=runtime.verify()
            self.assertEqual(result['target_scan_pages'],2)
            self.assertEqual(len(result['targets']),1)
            self.assertEqual(result['track_point_count'],14)
            self.assertEqual(result['category_observations'],{'balloon':7})
            self.assertEqual(runtime.manifest['fullchain']['coverage']['normalized']['accepted'],9)
            self.assertEqual(runtime.manifest['fullchain']['coverage']['normalized']['processed'],7)


if __name__=='__main__':unittest.main()
