"""Opt-in independent MediaMTX/FFmpeg tests; platform is a contract fixture, not business evidence."""
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
import urllib.request
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eo_video import EoSimulator, DEFAULT_VIDEO


@unittest.skipUnless(os.environ.get('ITEM4_MEDIA_CONTAINER'), 'requires independent item4 media service')
class MediaFaultProcessTests(unittest.TestCase):
    def setUp(self):
        self.docker = os.environ['ITEM4_DOCKER']
        self.name = os.environ['ITEM4_MEDIA_CONTAINER']
        owned = json.loads(self.command('inspect', self.name))[0]
        self.assertEqual(owned['Name'], '/' + self.name)
        self.assertTrue(self.name.startswith('item4-mediamtx-'))
        self.assertEqual(owned['Config']['Labels']['uav.acceptance'], os.environ['ITEM4_RUN_LABEL'])
        self.ports = {}
        for key, mappings in owned['HostConfig']['PortBindings'].items():
            self.assertEqual(len(mappings), 1)
            self.assertEqual(mappings[0]['HostIp'], '127.0.0.1')
            self.ports[key] = int(mappings[0]['HostPort'])
        self.identifier = owned['Id']
        self.ffmpeg = os.environ['ITEM4_FFMPEG']
        self.eo = None
        self.addCleanup(self.cleanup)

    def command(self, *args):
        return subprocess.check_output([self.docker, *args], text=True, encoding='utf-8',
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), timeout=25)

    def cleanup(self):
        if self.eo: self.eo.suspend()
        self.command('start', self.identifier)

    def begin(self):
        task, stream, device = (str(uuid.uuid4()) for _ in range(3))
        binding = {'kind':'eo', 'platform_id':device, 'external_id':device, 'edge_id':'item4-test',
                   'dispatcher_topic':'item4/dispatch', 'reporting_topic':'item4/report'}
        class Platform:
            def call(_, method, path, body=None):
                if method == 'GET': return {'details':{'open_task':{'task_id':task,'status':'OPEN'}}}
                return {'task_id':task,'device_id':device,'stream_id':stream,'stream_path':'qa/'+stream}
        config = {**DEFAULT_VIDEO,'enabled':True,'publisher_user':'item4','publisher_password':'isolated-unused',
                  'rtsp_base':f'rtsp://127.0.0.1:{self.ports["8554/tcp"]}', 'ffmpeg':self.ffmpeg}
        self.eo = EoSimulator(Platform(), {'devices':{'eo':binding}}, config, lambda *args:None, lambda *args:None)
        self.stream, self.device, self.task = stream, device, task
        self.eo.handle('item4/dispatch', json.dumps({'event':'BeginTracking','edgeId':binding['edge_id'],
            'timestamp':int(time.time()*1000),'metadata':{'deviceId':device,'taskId':task}}).encode())
        self.until(self.ready, 20)

    def ready(self):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{self.ports["9997/tcp"]}/v3/paths/get/qa/{self.stream}', timeout=2) as response:
                return json.load(response).get('ready', False)
        except (OSError, ValueError): return False

    def until(self, predicate, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.eo.tick()
            if predicate(): return
            time.sleep(.1)
        self.fail('Media recovery deadline exceeded')

    def decode(self):
        url=f'http://127.0.0.1:{self.ports["8888/tcp"]}/qa/{self.stream}/index.m3u8'
        result=subprocess.run([self.ffmpeg,'-hide_banner','-loglevel','error','-nostdin','-i',url,
            '-t','2','-an','-vf','fps=3','-f','framemd5','-'], capture_output=True, text=True, timeout=30,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(result.returncode,0,result.stderr[-600:])
        frames=[line.rsplit(',',1)[-1].strip() for line in result.stdout.splitlines() if line and not line.startswith('#')]
        self.assertGreaterEqual(len(set(frames)),3,'HLS must decode changing frames')
        return len(frames)

    def evidence(self, item):
        if not os.environ.get('ITEM4_EVIDENCE_DIR'): return
        path=Path(os.environ['ITEM4_EVIDENCE_DIR'])/'media-fault-process.jsonl'
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('a',encoding='utf-8') as stream: stream.write(json.dumps(item)+'\n')

    def test_media_restart_recovers_same_task_and_decodes_three_rounds(self):
        for round_no in range(1,4):
            with self.subTest(round=round_no):
                self.begin()
                before=self.eo.active[self.device]['process'].pid
                self.decode()
                self.command('kill',self.identifier)
                self.until(lambda:self.eo.snapshot()['devices'][0]['video']=='FAILED',40)
                self.assertEqual(self.eo.snapshot()['devices'][0]['tracking'],'TRACKING')
                self.command('start',self.identifier)
                self.until(lambda:self.ready() and self.eo.active[self.device]['process'].pid!=before,45)
                frames=self.decode()
                self.assertEqual(self.eo.active[self.device]['task'],self.task)
                self.evidence({'round':round_no,'cut':'media-restart','task':self.task,'decoded_frames':frames,'same_task':True})
                process=self.eo.active[self.device]['process']
                self.eo.suspend()
                self.assertIsNotNone(process.poll())
                self.assertFalse(self.eo.active)

    @unittest.skipUnless(os.name=='nt','Windows owned encoder suspension')
    def test_alive_stalled_encoder_is_replaced_after_real_timeout(self):
        self.begin()
        self.decode()
        process=self.eo.active[self.device]['process']
        ntdll=ctypes.WinDLL('ntdll')
        suspend=ntdll.NtSuspendProcess
        suspend.argtypes=[ctypes.c_void_p];suspend.restype=ctypes.c_long
        self.assertEqual(suspend(int(process._handle)),0)
        started=time.monotonic()
        self.assertIsNone(process.poll())
        self.until(lambda:self.eo.snapshot()['devices'][0]['video']=='FAILED',40)
        self.assertGreaterEqual(time.monotonic()-started,28)
        self.assertEqual(self.eo.snapshot()['devices'][0]['tracking'],'TRACKING')
        self.until(lambda:self.ready() and self.eo.active[self.device]['process'].pid!=process.pid,45)
        frames=self.decode()
        self.evidence({'cut':'encoder-stall','task':self.task,'decoded_frames':frames,'same_task':True})


if __name__=='__main__': unittest.main()
