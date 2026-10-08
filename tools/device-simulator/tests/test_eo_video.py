import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eo_video import EoSimulator, DEFAULT_VIDEO, video_config, public_video_config, sanitize_video_error, ffmpeg_arguments

TASK='11111111-1111-1111-1111-111111111111'
STREAM='22222222-2222-2222-2222-222222222222'
BINDING={'kind':'eo','platform_id':'ops-1','external_id':'ext-1','edge_id':'edge-1',
         'dispatcher_topic':'iot-dispatcher/cmlc/edge/ext-1','reporting_topic':'iot-reporting/cmlc/edge/edge-1'}
class Process:
    def __init__(self): self.returncode=None; self.terminated=0; self.killed=0
    def poll(self): return self.returncode
    def terminate(self): self.terminated+=1; self.returncode=0
    def wait(self, timeout): return self.returncode
    def kill(self): self.killed+=1; self.returncode=-9
class Platform:
    def __init__(self): self.calls=[]; self.task=TASK; self.stream=STREAM; self.fail=False; self.status='OPEN'
    def call(self, method, path, body=None):
        self.calls.append((method,path,body))
        if self.fail: raise ValueError('API unavailable')
        if method=='GET': return {'details': {'open_task': {'task_id':self.task,'status':self.status}}}
        return {'task_id':self.task,'device_id':'ops-1','stream_id':self.stream,'stream_path':'qa/'+self.stream}
class EoVideoTests(unittest.TestCase):
    def setUp(self):
        self.api=Platform(); self.sent=[]; self.processes=[]; self.now=1000
        def spawn(args, **kwargs):
            self.last_args=args
            self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
            self.watermark=(Path(kwargs['cwd'])/'watermark.txt').read_text(encoding='utf-8')
            p=Process(); self.processes.append(p); return p
        self.spawn=spawn
        self.eo=EoSimulator(self.api,{'devices':{'one':BINDING}}, {**DEFAULT_VIDEO,'enabled':True,'publisher_password':'test-only-password'},
                            lambda t,p:self.sent.append((t,p)), lambda *args:None, spawn,lambda:self.now)
    def tearDown(self): self.eo.suspend()
    def command(self, event='BeginTracking', task=TASK, **overrides):
        payload={'event':event,'edgeId':'edge-1','timestamp':int(self.now*1000),
                 'metadata':{'deviceId':'ext-1','taskId':task}}
        payload.update(overrides)
        return json.dumps(payload).encode()
    def begin(self): self.eo.handle(BINDING['dispatcher_topic'],self.command())
    def test_restarted_idle_device_confirms_only_platform_pending_stop(self):
        import uuid
        for task in (str(uuid.uuid4()), str(uuid.uuid4())):
            self.api.task=task; self.api.status='ENDING'
            self.eo.handle(BINDING['dispatcher_topic'], self.command('EndTracking', task))
            self.assertEqual(self.sent[-1][1]['metadata']['taskId'], task)
            self.assertEqual(self.sent[-1][1]['metadata']['workState'], 0)
            self.assertIn(task, self.eo.retired)
        self.assertFalse(self.processes)
    def test_idle_stop_rejects_wrong_or_unconfirmed_task_and_api_failure(self):
        for status, task, fail in [('OPEN', TASK, False), ('ENDING', 'another-task', False), ('ENDING', TASK, True)]:
            self.api.status=status; self.api.task=task; self.api.fail=fail
            with self.assertRaises(ValueError):
                self.eo.handle(BINDING['dispatcher_topic'], self.command('EndTracking'))
            self.assertFalse(self.sent)
    def test_receipt_matches_binding_and_task_and_keeps_video_separate(self):
        self.begin(); topic,payload=self.sent[0]
        self.assertEqual(topic,BINDING['reporting_topic']); self.assertEqual(payload['edgeId'],'edge-1')
        self.assertEqual(payload['metadata'],{'deviceId':'ext-1','taskId':TASK,'codeStatus':200,'workState':1,'cameraStatus':{}})
        self.assertNotIn('aiStatus',payload['metadata'])
        self.assertEqual(self.eo.snapshot()['devices'][0]['video'],'PUBLISHING')
        self.assertIn('TEST VIDEO',self.watermark); self.assertIn('ext-1',self.watermark); self.assertIn(TASK,self.watermark)
        self.assertIn('-an',self.last_args); self.assertEqual(self.last_args[-1],'rtsp://qa-publisher:test-only-password@127.0.0.1:8554/qa/'+STREAM)
    def test_duplicates_do_not_spawn_and_stale_task_cannot_takeover(self):
        self.begin(); self.begin(); self.assertEqual(len(self.processes),1)
        with self.assertRaises(ValueError): self.eo.handle(BINDING['dispatcher_topic'], self.command(task='other'))
        self.assertEqual(self.eo.active['ops-1']['task'],TASK)
    def test_tracking_reports_do_not_wait_for_video_lease_refresh(self):
        self.begin()
        registrations=lambda:sum(method=='PUT' for method,_,_ in self.api.calls)
        self.assertEqual(registrations(),1)
        self.now+=5; self.eo.tick()
        self.assertEqual(len(self.sent),2)
        self.assertEqual(self.sent[-1][1]['metadata']['taskId'],TASK)
        self.assertEqual(registrations(),1)
        self.now+=5; self.eo.tick()
        self.assertEqual(len(self.sent),3)
        self.assertEqual(registrations(),1)
        self.now+=5; self.eo.tick()
        self.assertEqual(registrations(),2)
        self.assertEqual(len(self.processes),1)
    def test_periodic_report_rechecks_current_task_before_sending(self):
        self.begin(); self.api.task='replacement'
        self.now+=5; self.eo.tick()
        self.assertEqual(len(self.sent),1)
        self.assertFalse(self.eo.active)
        self.assertEqual(self.processes[0].terminated,1)
    def test_identity_retained_and_timestamp_rejected(self):
        for changes in ({'edgeId':'wrong'}, {'timestamp':999000}, {'metadata':{'deviceId':'wrong','taskId':TASK}}):
            with self.assertRaises(ValueError): self.eo.handle(BINDING['dispatcher_topic'], self.command(**changes))
        self.eo.enqueue(BINDING['dispatcher_topic'],self.command(),True); self.eo.drain()
        self.assertEqual(self.sent,[])
    def test_current_platform_task_required(self):
        self.api.task='new'
        with self.assertRaises(ValueError): self.begin()
        self.assertEqual(self.sent,[])
    def test_end_only_matching_task_stops_owned_process_and_deregisters(self):
        self.begin(); process=self.processes[0]
        with self.assertRaises(ValueError): self.eo.handle(BINDING['dispatcher_topic'],self.command('EndTracking','wrong'))
        self.assertEqual(process.terminated,0)
        self.eo.handle(BINDING['dispatcher_topic'],self.command('EndTracking'))
        self.assertEqual(process.terminated,1); self.assertFalse(self.eo.active)
        self.assertEqual(self.sent[-1][1]['metadata']['workState'],0)
        self.assertEqual(self.api.calls[-1][0],'DELETE')
        with self.assertRaises(ValueError): self.begin()
        self.eo.handle(BINDING['dispatcher_topic'],self.command('EndTracking'))
        self.assertEqual(self.sent[-1][1]['event'],'EndTracking')
        self.assertEqual(len(self.processes),1)
    def test_ffmpeg_failure_does_not_change_tracking_receipt(self):
        self.eo.popen=lambda *args,**kwargs: (_ for _ in ()).throw(OSError('missing encoder'))
        self.begin()
        status=self.eo.snapshot()['devices'][0]
        self.assertEqual(status['tracking'],'TRACKING'); self.assertEqual(status['video'],'FAILED')
        self.assertEqual(self.sent[0][1]['metadata']['codeStatus'],200)
        self.assertTrue(self.eo.active['ops-1']['registered'])
        self.assertFalse(any(method=='DELETE' for method,_,_ in self.api.calls))
        self.eo.popen=self.spawn; self.now+=14; self.eo.tick(); self.assertFalse(self.processes)
        self.now+=1; self.eo.tick(); self.assertEqual(len(self.processes),1)
        self.assertEqual(self.eo.active['ops-1']['task'],TASK)
    def test_encoder_exception_cannot_expose_url_credentials(self):
        def rejected(*args,**kwargs): raise OSError('encoder failure '+args[0][-1])
        self.eo.popen=rejected
        self.begin()
        self.assertNotIn('test-only-password',json.dumps(self.eo.snapshot()))
        self.assertIn('[redacted]',self.eo.snapshot()['devices'][0]['error'])
    def test_encoder_exit_keeps_lease_and_recovers_same_task_at_limited_rate(self):
        self.begin(); self.processes[0].returncode=2; self.eo.tick()
        status=self.eo.snapshot()['devices'][0]
        self.assertEqual(status['exit_code'],2); self.assertEqual(status['video'],'FAILED')
        self.assertEqual(status['tracking'],'TRACKING')
        self.assertFalse(any(method=='DELETE' for method,_,_ in self.api.calls))
        self.now+=14; self.eo.tick(); self.assertEqual(len(self.processes),1)
        self.now+=1; self.eo.tick(); self.assertEqual(len(self.processes),2)
        self.assertEqual(self.eo.active['ops-1']['stream_id'],STREAM)
        self.assertEqual(self.eo.active['ops-1']['task'],TASK)
        self.assertEqual(self.eo.snapshot()['devices'][0]['video'],'PUBLISHING')
    def test_alive_but_stalled_encoder_is_replaced_without_ending_tracking(self):
        self.begin()
        first = self.processes[0]
        self.now += 29; self.eo.tick()
        self.assertEqual(first.terminated, 0)
        self.now += 1; self.eo.tick()
        self.assertEqual(first.terminated, 1)
        self.assertEqual(self.eo.snapshot()['devices'][0]['tracking'], 'TRACKING')
        self.assertEqual(self.eo.snapshot()['devices'][0]['video'], 'FAILED')
        self.assertFalse(any(method == 'DELETE' for method, _, _ in self.api.calls))
        self.now += 14; self.eo.tick()
        self.assertEqual(len(self.processes), 1)
        self.now += 1; self.eo.tick()
        self.assertEqual(len(self.processes), 2)
        self.assertEqual(self.eo.active['ops-1']['task'], TASK)

    def test_only_advancing_output_keeps_encoder_alive(self):
        self.begin()
        progress = Path(self.eo.active['ops-1']['directory'].name) / 'progress.txt'
        for frame in range(1, 5):
            self.now += 20
            progress.write_text(f'frame={frame}\nout_time_us={frame * 1000000}\nprogress=continue\n')
            self.eo.tick()
        self.assertEqual(len(self.processes), 1)
        self.assertEqual(self.processes[0].terminated, 0)
        # A running encoder rewriting the same frame is not recovered output.
        self.now += 30
        progress.write_text('frame=4\nout_time_us=4000000\nprogress=continue\n')
        self.eo.tick()
        self.assertEqual(self.processes[0].terminated, 1)

    def test_stalled_encoder_cannot_restart_after_task_closes(self):
        self.begin(); self.now += 30; self.eo.tick()
        self.api.task = 'replacement'; self.now += 15; self.eo.tick()
        self.assertEqual(len(self.processes), 1)
        self.assertFalse(self.eo.active)

    def test_failed_encoder_never_recovers_after_stop_or_closed_task(self):
        self.begin(); self.processes[0].returncode=2; self.eo.tick()
        self.api.task='replacement'; self.now+=16; self.eo.tick()
        self.assertFalse(self.eo.active); self.assertEqual(len(self.processes),1)
        self.assertEqual(self.api.calls[-1][0],'DELETE')
        self.now+=20; self.eo.tick(); self.assertEqual(len(self.processes),1)
    def test_lease_refresh_does_not_spawn_and_new_registry_stream_replaces_process(self):
        self.begin(); self.now+=16; self.eo.tick(); self.assertEqual(len(self.processes),1)
        (Path(self.eo.active['ops-1']['directory'].name)/'progress.txt').write_text('frame=30\nout_time_us=2000000\nprogress=continue\n')
        self.api.stream='33333333-3333-3333-3333-333333333333'; self.now+=16; self.eo.tick()
        self.assertEqual(len(self.processes),2); self.assertEqual(self.processes[0].terminated,1)
    def test_pause_and_resume_never_restore_old_task(self):
        self.begin(); self.eo.suspend(); self.assertEqual(self.processes[0].terminated,1)
        self.now+=1; self.eo.resume()
        with self.assertRaises(ValueError): self.begin()
        self.assertFalse(self.eo.active)
    def test_offline_ends_owned_video_and_rejects_commands(self):
        self.begin(); self.eo.availability({'ops-1'}); self.assertFalse(self.eo.active)
        self.eo.handle(BINDING['dispatcher_topic'],self.command('CameraStatus'))
        self.assertEqual(len(self.sent),1)
    def test_closed_task_or_api_failure_terminates_stream(self):
        self.begin(); self.api.task='replacement'; self.now+=16; self.eo.tick()
        self.assertFalse(self.eo.active); self.assertEqual(self.processes[0].terminated,1)
    def test_disabled_video_never_registers_or_spawns(self):
        self.eo.config['enabled']=False; self.begin()
        self.assertFalse(self.processes); self.assertTrue(all(c[0]=='GET' for c in self.api.calls))
    def test_video_toggle_keeps_current_tracking_and_restarts_only_owned_encoder(self):
        self.assertTrue(callable(getattr(self.eo,'configure_video',None)), 'running video toggle is missing')
        self.eo.config['enabled']=False; self.begin()
        config={**self.eo.config,'enabled':True}
        self.eo.configure_video(config); self.eo.tick()
        self.assertEqual(len(self.processes),1)
        self.eo.configure_video(config); self.eo.tick()
        self.assertEqual(len(self.processes),1)
        self.eo.configure_video({**config,'enabled':False})
        self.assertEqual(self.processes[0].terminated,1)
        self.assertEqual(self.eo.active['ops-1']['task'],TASK)
        self.assertNotIn(TASK,self.eo.retired)
        self.assertEqual(self.eo.snapshot()['devices'][0]['tracking'],'TRACKING')
        self.assertEqual(self.eo.snapshot()['devices'][0]['video'],'DISABLED')
        self.assertEqual(self.api.calls[-1][0],'DELETE')
        self.now+=5; self.eo.tick()
        self.assertEqual(self.sent[-1][1]['metadata']['workState'],1)
        self.eo.configure_video(config); self.eo.tick()
        self.assertEqual(len(self.processes),2)
        self.assertEqual(self.eo.active['ops-1']['task'],TASK)
    def test_enable_waits_for_task_and_never_revives_replaced_or_ending_task(self):
        self.assertTrue(callable(getattr(self.eo,'configure_video',None)), 'running video toggle is missing')
        import uuid
        for status in ('OPEN','ENDING'):
            with self.subTest(status=status):
                self.eo.config['enabled']=False
                self.api.task=str(uuid.uuid4()); self.api.status='OPEN'
                self.eo.handle(BINDING['dispatcher_topic'], self.command(task=self.api.task))
                if status=='OPEN': self.api.task=str(uuid.uuid4())
                self.api.status=status
                self.eo.configure_video({**self.eo.config,'enabled':True}); self.eo.tick()
                self.assertFalse(self.processes)
                self.assertFalse(self.eo.active)
                self.eo.configure_video({**self.eo.config,'enabled':True}); self.eo.tick()
                self.assertFalse(self.processes)
    def test_camera_status_does_not_spawn(self):
        self.eo.handle(BINDING['dispatcher_topic'],self.command('CameraStatus'))
        self.assertFalse(self.processes); self.assertEqual(self.sent[-1][1]['metadata']['workState'],0)
    def test_pause_during_registration_cannot_start_an_encoder(self):
        original=self.api.call
        def interrupted(method,path,body=None):
            result=original(method,path,body)
            if method=='PUT': self.eo.is_running=lambda:False
            return result
        self.api.call=interrupted
        self.begin(); self.assertFalse(self.processes)
        self.assertEqual(self.api.calls[-1][0],'DELETE')
    def test_malformed_duplicate_json_rejected(self):
        with self.assertRaises(ValueError): self.eo.handle(BINDING['dispatcher_topic'],b'{"event":"BeginTracking","event":"EndTracking"}')
        for raw in (b'null',b'[]',b'42'):
            with self.assertRaises(ValueError): self.eo.handle(BINDING['dispatcher_topic'],raw)
class ConfigTests(unittest.TestCase):
    def test_enabled_requires_publisher_secret_and_public_config_masks_it(self):
        with self.assertRaises(ValueError): video_config({'enabled':True})
        public=public_video_config({**DEFAULT_VIDEO,'publisher_password':'secret-qa-only'})
        self.assertTrue(public['publisher_password_set'])
        self.assertNotIn('publisher_password',public)
        self.assertNotIn('secret-qa-only',json.dumps(public))
    def test_publisher_credentials_are_url_encoded_and_errors_are_redacted(self):
        config={**DEFAULT_VIDEO,'publisher_user':'qa user','publisher_password':'s@cr:et/+#'}
        args=ffmpeg_arguments(config,'qa/'+STREAM,None)
        self.assertIn('qa%20user:s%40cr%3Aet%2F%2B%23@',args[-1])
        message=sanitize_video_error('encoder failed '+args[-1]+' s@cr:et/+#',config)
        self.assertNotIn('s@cr:et/+#',message)
        self.assertNotIn('s%40cr%3Aet%2F%2B%23',message)
    def test_runtime_status_and_export_view_never_contain_video_password(self):
        from server import Runtime
        with tempfile.TemporaryDirectory() as directory:
            runtime=Runtime(directory)
            runtime.video_config={**DEFAULT_VIDEO,'publisher_password':'secret-qa-only'}
            text=json.dumps(runtime.status())
            self.assertNotIn('secret-qa-only',text)
            self.assertNotIn('"publisher_password"',text)
            self.assertTrue(runtime.status()['video_config']['publisher_password_set'])
    def test_defaults_off_and_non_loopback_rejected(self):
        self.assertFalse(video_config({})['enabled'])
        for base in ('rtsp://example.com:8554','rtsp://user:pass@127.0.0.1:8554','rtsp://127.0.0.1:8554/other','http://127.0.0.1:8554','rtsp://127.0.0.1'):
            with self.assertRaises(ValueError): video_config({'rtsp_base':base})
    def test_missing_program_or_remote_source_rejected(self):
        with self.assertRaises(ValueError): video_config({'enabled':True,'ffmpeg':'no-such-program-12345','publisher_password':'test-only-password'})
        with patch('eo_video.shutil.which',return_value='C:/ffmpeg.exe'):
            for source in ('https://example.com/video.mp4','relative.mp4','//server/video.mp4'):
                with self.assertRaises(ValueError): video_config({'enabled':True,'source':source,'publisher_password':'test-only-password'})
    def test_ffmpeg_has_no_shell_and_path_is_validated(self):
        with self.assertRaises(ValueError): ffmpeg_arguments(DEFAULT_VIDEO,'../bad',None)
        args=ffmpeg_arguments({**DEFAULT_VIDEO,'source':'C:/movie.mp4'},'qa/'+STREAM,None)
        self.assertIn('-stream_loop',args); self.assertIn('-an',args)

if __name__=='__main__': unittest.main()
