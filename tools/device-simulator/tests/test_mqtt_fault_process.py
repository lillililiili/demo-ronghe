"""Opt-in actual Broker crashes; Runtime uses a read-only platform contract fixture.

This proves simulator transport recovery, not business authorization or device execution.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import compile_scene
from server import Runtime
from test_engine import scene


def await_true(predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate(): return
        time.sleep(.05)
    raise AssertionError('transport recovery deadline exceeded')


@unittest.skipUnless(os.environ.get('ITEM4_BROKER_CONTAINER'), 'requires owned isolated item4 Broker')
class MqttFaultProcessTests(unittest.TestCase):
    def setUp(self):
        self.docker = os.environ['ITEM4_DOCKER']
        self.container = os.environ['ITEM4_BROKER_CONTAINER']
        self.label = os.environ['ITEM4_RUN_LABEL']
        owned = json.loads(self.command('inspect', self.container))[0]
        self.assertTrue(self.container.startswith('item4-mosquitto-'))
        self.assertEqual(owned['Config']['Labels'].get('uav.acceptance'), self.label)
        mapping = owned['HostConfig']['PortBindings']['1883/tcp']
        self.assertEqual(len(mapping), 1)
        self.assertEqual(mapping[0]['HostIp'], '127.0.0.1')
        self.port = int(mapping[0]['HostPort'])
        self.identifier = owned['Id']
        self.folder = tempfile.TemporaryDirectory(prefix='item4-mqtt-')
        self.addCleanup(self.folder.cleanup)
        self.runtime = Runtime(self.folder.name)
        self.runtime.batch = 'sim-' + uuid.uuid4().hex
        (Path(self.folder.name)/self.runtime.batch).mkdir()
        raw = scene()
        raw.update(duration=10, targets=[], risks=[])
        raw['sites'][0]['devices'][0].update(kind='ifr', protocolB={})
        self.runtime.scene, devices, self.runtime.targets, self.runtime.skipped = compile_scene(raw)
        self.runtime.manifest = {'provider':'item4-'+uuid.uuid4().hex[:10], 'source_mode':'replay',
            'devices':{'d1':{'kind':'ifr','platform_id':uuid.uuid4().hex,'external_id':uuid.uuid4().hex}}}
        self.runtime.broker = {'host':'127.0.0.1','port':self.port}
        self.runtime.session.platform = SimpleNamespace(prepare_devices=Mock(),
            wait_for_subscriptions=Mock(return_value=True),call=Mock(return_value={}))
        self.worker = threading.Thread(target=self.runtime.run,args=(devices,),daemon=True)
        self.worker.start()
        self.addCleanup(self.stop_runtime)
        await_true(lambda:self.runtime.phase=='RUNNING')
        from paho.mqtt import client as mqtt
        self.peer = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='item4-control-'+uuid.uuid4().hex)
        self.peer.reconnect_delay_set(1, 2)
        self.responses = []
        self.payloads = {}
        self.ready = threading.Event()
        binding = next(iter(self.runtime.protocol_b.bindings.values()))
        self.topic = next(iter(self.runtime.protocol_b.bindings))
        self.external = binding['external_id']
        def connected(client,*args): client.subscribe(binding['response_topic'],qos=1)
        self.peer.on_connect = connected
        self.peer.on_subscribe = lambda *args:self.ready.set()
        self.peer.on_disconnect = lambda *args:self.ready.clear()
        self.peer.on_message = lambda c,u,m:self.responses.append(json.loads(m.payload))
        self.peer.connect('127.0.0.1',self.port,10)
        self.peer.loop_start()
        self.addCleanup(self.stop_peer)
        self.assertTrue(self.ready.wait(8))

    def command(self,*args):
        return subprocess.check_output([self.docker,*args],text=True,encoding='utf-8',
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)

    def stop_runtime(self):
        self.command('start',self.identifier)
        self.runtime.cancel.set()
        self.worker.join(12)
        self.assertFalse(self.worker.is_alive())

    def stop_peer(self):
        self.peer.disconnect()
        self.peer.loop_stop()

    def send(self,msg,retain=False,qos=1):
        payload=self.payloads.setdefault(msg,{'head':{'deviceId':self.external,'msgNo':msg,'time':int(time.time()*1000)},
                 'data':{'operationType':1,'operationCmd':60003}})
        info=self.peer.publish(self.topic,json.dumps(payload),qos=qos,retain=retain)
        info.wait_for_publish(5)
        self.assertTrue(info.is_published())

    def evidence(self,case,**values):
        directory=os.environ.get('ITEM4_EVIDENCE_DIR')
        if directory:
            path=Path(directory);path.mkdir(parents=True,exist_ok=True)
            with (path/'mqtt-fault-process.jsonl').open('a',encoding='utf-8') as stream:
                stream.write(json.dumps({'case':case,'batch':self.runtime.batch,'result':'PASS',**values})+'\n')

    def test_three_short_outages_restore_actual_control_subscription(self):
        for iteration in range(3):
            with self.subTest(iteration=iteration):
                msg='LY-'+uuid.uuid4().hex
                before=self.runtime.protocol_b.snapshot()['commands']
                self.command('kill',self.identifier)
                await_true(lambda:not self.runtime.mqtt_connected)
                down_at=time.monotonic()
                time.sleep(5)
                self.command('start',self.identifier)
                self.assertTrue(self.ready.wait(15))
                await_true(lambda:self.runtime.mqtt_connected)
                self.send(msg)
                await_true(lambda:any(p['head']['msgNo']==msg for p in self.responses))
                self.send(msg)
                await_true(lambda:sum(p['head']['msgNo']==msg for p in self.responses)==2)
                self.assertEqual(self.runtime.protocol_b.snapshot()['commands'],before+1)
                self.assertEqual(self.runtime.phase,'RUNNING')
                self.evidence('short-reconnect',round=iteration+1,recovered_seconds=time.monotonic()-down_at,
                              logical_commands=1,reply_copies=2)

    def test_ninety_second_outage_stops_batch_without_automatic_replay(self):
        self.command('kill',self.identifier)
        down_at=time.monotonic()
        await_true(lambda:self.runtime.phase=='FAILED',40)
        self.assertTrue('30 秒' in self.runtime.error or '结果未知' in self.runtime.error)
        self.worker.join(8)
        self.assertFalse(self.worker.is_alive())
        count=self.runtime.sent
        time.sleep(max(0,90-(time.monotonic()-down_at)))
        self.command('start',self.identifier)
        self.assertTrue(self.ready.wait(15))
        time.sleep(2)
        self.assertEqual(self.runtime.phase,'FAILED')
        self.assertEqual(self.runtime.sent,count)
        self.assertEqual(self.responses,[])
        self.evidence('long-outage',outage_seconds=90,phase=self.runtime.phase,published_count=count,
                      automatically_resumed=False)


if __name__=='__main__': unittest.main()
