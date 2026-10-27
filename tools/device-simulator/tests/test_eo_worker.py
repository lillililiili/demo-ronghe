import copy
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eo_worker import EoWorker
from engine import compile_scene
from server import Runtime
from test_engine import scene
from test_mqtt_recovery import FastReconnectClient


class SlowCamera:
    def __init__(self, identity):
        self.bindings = {identity: {'external_id': identity}}
        self.config = {'enabled': True}
        self.accepting = True
        self.active = {'task': {'binding': {'external_id': identity}}}
        self.entered, self.release = threading.Event(), threading.Event()
        self.calls = []

    def snapshot(self):
        return {'enabled': self.config['enabled'], 'devices': []}

    def heartbeat(self, payload):
        payload['metadata']['workState'] = 0

    def enable_metadata_worker(self): pass
    def close_metadata(self): pass
    def settle_leftovers(self): pass
    def enqueue(self, *args): pass
    def configure_video(self, config):
        self.config = copy.deepcopy(config)
    def availability(self, unavailable): pass

    def tick(self):
        self.calls.append(('tick', threading.get_ident()))
        self.entered.set()
        if not self.release.wait(5):
            raise RuntimeError('test camera was not released')

    def suspend(self):
        self.calls.append(('suspend', threading.get_ident()))
        self.accepting = False
        self.active.clear()

    def resume(self):
        self.calls.append(('resume', threading.get_ident()))
        self.accepting = True


class EoWorkerTests(unittest.TestCase):
    def test_blocked_media_never_blocks_observation_controls_or_heartbeats(self):
        for identity in ('camera-alpha', 'another-camera'):
            with self.subTest(identity=identity):
                camera = SlowCamera(identity)
                worker = EoWorker(camera)
                try:
                    worker.tick()
                    self.assertTrue(camera.entered.wait(2))
                    completed = threading.Event()
                    def publish_frames():
                        for _ in range(6):
                            worker.tick()
                            worker.configure_video({'enabled': False})
                            worker.availability(set())
                            worker.heartbeat({'metadata': {'deviceId': identity}})
                            worker.snapshot()
                        completed.set()
                    producer = threading.Thread(target=publish_frames)
                    producer.start()
                    self.assertTrue(completed.wait(1), 'blocked EO HTTP must not stall measured frames')
                    producer.join()
                    worker.suspend()
                    worker.resume()
                finally:
                    camera.release.set()
                    worker.close()
                self.assertFalse(worker.thread.is_alive())
                self.assertFalse(camera.active)
                self.assertEqual(len({owner for _, owner in camera.calls}), 1)

    def test_close_waits_for_inflight_operation_before_final_stop(self):
        camera = SlowCamera('camera-beta')
        worker = EoWorker(camera)
        worker.tick()
        self.assertTrue(camera.entered.wait(2))
        closed = threading.Event()
        closer = threading.Thread(target=lambda: (worker.close(), closed.set()))
        closer.start()
        try:
            self.assertFalse(closed.wait(.05))
        finally:
            camera.release.set()
            closer.join(2)
        self.assertTrue(closed.is_set())
        self.assertEqual(camera.calls[-1][0], 'suspend')
        self.assertEqual(sum(action == 'tick' for action, _ in camera.calls), 1)

    def test_worker_failure_is_reported_without_successful_observation_claim(self):
        camera = SlowCamera('camera-gamma')
        def fail(): raise ValueError('unavailable')
        camera.tick = fail
        worker = EoWorker(camera)
        worker.tick()
        worker.thread.join(2)
        with self.assertRaises(RuntimeError): worker.tick()
        worker.close()
        self.assertFalse(camera.active)

    def test_real_runtime_publishes_coherent_frames_while_media_is_blocked(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = Runtime(root)
            runtime.batch = 'isolated-cadence'
            (Path(root) / runtime.batch).mkdir()
            raw = scene()
            raw['fullchain'] = {'enabled': True}
            raw['targets'][0]['path'] = [[450, 300], [460, 300]]
            runtime.scene, devices, runtime.targets, runtime.skipped = compile_scene(raw)
            runtime.broker = {'host': '127.0.0.1', 'port': 1883}
            runtime.manifest = {'provider': 'cadence-test', 'source_mode': 'replay',
                'created_at': int(time.time() * 1000), 'plans': {}, 'zones': {},
                'devices': {'d1': {'external_id': 'radar-cadence', 'platform_id': 'registered-cadence', 'kind': 'radar'}},
                'targets': {'t1': {'uav_sn': 'INDEPENDENT-CADENCE'}}}
            runtime.session.platform = SimpleNamespace(prepare_devices=Mock(),
                wait_for_subscriptions=Mock(return_value=True), call=Mock(return_value={}))
            camera = SlowCamera('optical-command-topic')
            frames, captured = [], []
            class PublishingClient(FastReconnectClient):
                def publish(self, topic, payload, **kwargs):
                    packet = json.loads(payload)
                    if packet.get('objects'):
                        frames.append(packet)
                        if len(frames) == 3:
                            runtime.cancel.set()
                    return SimpleNamespace(wait_for_publish=lambda **kw: None, is_published=lambda: True)
            chain = Mock()
            chain.withdraw_zones.return_value = []
            def slow_normalized_send(targets, elapsed, sequence, *, observed_at):
                captured.append(observed_at)
                time.sleep(.12)  # Both transports must keep the original capture time.
            chain.tick.side_effect = slow_normalized_send
            runner = threading.Thread(target=runtime.run, args=(devices,))
            with patch('paho.mqtt.client.Client', return_value=PublishingClient(runtime)), \
                 patch('server.EoSimulator', return_value=camera), \
                 patch('server.FullChain', return_value=chain), \
                 patch('prerequisite_check.verify', return_value={}), \
                 patch('server.DeviceHealthReporter'), patch('server.NotificationResponse') as response:
                response.return_value.snapshot.return_value = {}
                try:
                    runner.start()
                    self.assertTrue(camera.entered.wait(2))
                    self.assertTrue(runtime.cancel.wait(3.5), 'EO media blocked real measured-frame publication')
                    self.assertEqual(len(frames), 3)
                    self.assertFalse(camera.release.is_set())
                    times = [packet['objects'][0]['time'] for packet in frames]
                    self.assertEqual(times, captured)
                    self.assertTrue(all(900 <= b-a < 2000 for a, b in zip(times, times[1:])))
                    self.assertTrue(all(b['objects'][0]['longitude'] > a['objects'][0]['longitude']
                                        for a, b in zip(frames, frames[1:])))
                finally:
                    runtime.cancel.set()
                    camera.release.set()
                    runner.join(3)
            self.assertFalse(runner.is_alive())
            self.assertEqual(runtime.error, '')
            self.assertFalse(camera.active)


if __name__ == '__main__': unittest.main()

class MetadataSchedulingTest(unittest.TestCase):
    def test_two_blocked_frame_uploads_do_not_starve_tracking_or_queue_unbounded_jobs(self):
        from eo_video import EoSimulator, DEFAULT_VIDEO
        from types import SimpleNamespace
        now=[1000.0]; records=[]
        bindings={key:{'kind':'eo','platform_id':key,'external_id':key,'edge_id':'edge-'+key,
                       'dispatcher_topic':'dispatch/'+key,'reporting_topic':'report/'+key} for key in ('camera-a','camera-b')}
        eo=EoSimulator(SimpleNamespace(call=lambda *a:{}),{'devices':bindings},dict(DEFAULT_VIDEO,enabled=False),
                       lambda *a:None,lambda *a:None,clock=lambda:now[0],
                       observations=SimpleNamespace(config={'enabled':True,'intervalSeconds':2}))
        for key,b in bindings.items():
            eo.active[key]={'binding':b,'task':'task-'+key,'process':None,'next_check':2000,'next_report':1000,
                            'next_ai':1000,'registered':False}
            eo.gimbals[key].state='TRACKING'
        eo._details=lambda b:{'open_task':{'task_id':eo.active[b['platform_id']]['task'],'status':'OPEN','target_id':'target-'+b['platform_id']}}
        eo._tracking_report=lambda active,facts,include_ai=True:records.append((active['binding']['platform_id'],now[0]))
        release=threading.Event(); entered={key:threading.Event() for key in bindings}; finished={key:threading.Event() for key in bindings}
        calls=[]
        def blocked(active, expected=None):
            key=active['binding']['platform_id'];calls.append(key);entered[key].set()
            release.wait(5)
            eo._metadata_state(active,expected,video_metadata='LINKED')
            finished[key].set()
        eo._report_video_frame=blocked
        eo.enable_metadata_worker()
        try:
            eo.tick()
            self.assertTrue(all(event.wait(1) for event in entered.values()))
            for step in (2,4,6):now[0]=1000+step;eo.tick()
            for key in bindings:
                self.assertEqual([t for device,t in records if device==key],[1000,1002,1004,1006])
            self.assertEqual(sorted(calls),sorted(bindings))
            self.assertEqual(len(eo.metadata_pending),2)
            eo._stop('camera-a','STOPPED')
            eo.active['camera-b']['stream_id']='new-stream-session'
            started=time.monotonic();eo.close_metadata()
            self.assertLess(time.monotonic()-started,.2)
            eo._schedule_video_frame(eo.active['camera-b'])
            self.assertEqual(sorted(calls),sorted(bindings))
            release.set()
            self.assertTrue(all(event.wait(1) for event in finished.values()))
            self.assertNotEqual(eo._state(bindings['camera-a']).get('video_metadata'),'LINKED')
            self.assertNotEqual(eo._state(bindings['camera-b']).get('video_metadata'),'LINKED')
        finally:
            release.set();eo.suspend();eo.close_metadata()


    def test_owner_discards_completed_old_stream_results_including_both_frame_cursors(self):
        from eo_video import EoSimulator, DEFAULT_VIDEO
        from types import SimpleNamespace
        binding={'kind':'eo','platform_id':'camera','external_id':'camera','edge_id':'edge',
                 'dispatcher_topic':'dispatch','reporting_topic':'report'}
        eo=EoSimulator(SimpleNamespace(),{'devices':{'camera':binding}},dict(DEFAULT_VIDEO,enabled=False),lambda *a:None,lambda *a:None)
        process=object();active={'binding':binding,'task':'task','stream_id':'old','process':process,'last_frame_number':1,'last_frame_pts':1000}
        eo.active['camera']=active;eo.gimbals['camera'].state='TRACKING';eo.enable_metadata_worker()
        expected=('task','old',process,0,None)
        try:
            eo._metadata_state(active,expected,active_values={'last_frame_number':90,'last_frame_pts':9000},video_metadata='LINKED')
            self.assertEqual(active['last_frame_number'],1,'background completion may only enqueue')
            active.update(stream_id='new',process=object(),last_frame_number=2,last_frame_pts=2000)
            eo._state(binding)['video_metadata']='NEW_STREAM'
            eo._drain_metadata()
            self.assertEqual(active['last_frame_number'],2)
            self.assertEqual(active['last_frame_pts'],2000)
            self.assertEqual(eo._state(binding)['video_metadata'],'NEW_STREAM')
            current=('task','new',active['process'],0,None)
            eo._metadata_state(active,current,active_values={'last_frame_number':3,'last_frame_pts':3000},video_metadata='LINKED')
            eo._drain_metadata()
            self.assertEqual(active['last_frame_pts'],3000)
            eo._metadata_state(active,current,active_values={'last_frame_number':99},video_metadata='LINKED')
            replacement=dict(active,task='new-task',last_frame_number=0)
            eo.active['camera']=replacement
            eo._state(binding)['video_metadata']='NEW_TASK'
            eo._drain_metadata()
            self.assertEqual(replacement['last_frame_number'],0)
            self.assertEqual(eo._state(binding)['video_metadata'],'NEW_TASK')
        finally:eo.close_metadata()

    def test_lost_capture_discards_late_linked_frame_result(self):
        from eo_video import EoSimulator, DEFAULT_VIDEO
        from types import SimpleNamespace
        binding={'kind':'eo','platform_id':'camera','external_id':'camera','edge_id':'edge',
                 'dispatcher_topic':'dispatch','reporting_topic':'report'}
        eo=EoSimulator(SimpleNamespace(),{'devices':{'camera':binding}},dict(DEFAULT_VIDEO,enabled=False),lambda *a:None,lambda *a:None)
        process=object();active={'binding':binding,'task':'task','stream_id':'stream','process':process}
        eo.active['camera']=active;eo.gimbals['camera'].state='TRACKING';eo.enable_metadata_worker()
        try:
            eo._metadata_state(active,('task','stream',process,0,None),active_values={'last_frame_number':40,'last_frame_pts':4000,'last_frame_timestamp':1000,'last_frame_media_ms':900},video_metadata='LINKED')
            eo._acquire(active,{'target_id':'target'})
            self.assertEqual(eo._state(binding)['video_metadata'],'UNAVAILABLE')
            eo._drain_metadata()
            self.assertEqual(eo._state(binding)['video_metadata'],'UNAVAILABLE')
            self.assertEqual(active['last_frame_number'],40)
            self.assertEqual(active['last_frame_pts'],4000)
            self.assertEqual(eo._state(binding)['video_last_accepted_frame_timestamp'],1000)
        finally:eo.close_metadata()
