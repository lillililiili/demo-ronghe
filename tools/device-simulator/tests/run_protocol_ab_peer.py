"""Disposable real-MQTT peer for the guarded Java PostgreSQL acceptance test."""
import json
from pathlib import Path
import signal
import sys
import threading
import time
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from paho.mqtt import client as mqtt
from build_acceptance_samples import samples
from engine import compile_scene, messages
from full_scenario import allocate_identities
from protocol_b import ProtocolBResponder

cfg=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
if cfg.get('test_scope')!='stage456_verify' or cfg.get('host')!='127.0.0.1':
    raise ValueError('Only the explicitly isolated loopback test is allowed')
connected,subscribed,stop=threading.Event(),threading.Event(),threading.Event()
lock=threading.Lock()
def log(kind,message,**extra):
    with lock:
        with Path(cfg['events']).open('a',encoding='utf-8') as f:
            f.write(json.dumps({'kind':kind,'message':message,**extra},ensure_ascii=False)+'\n')
client=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,client_id=cfg['client_id'])
client.on_connect=lambda c,u,f,rc,p:connected.set() if not rc.is_failure else None
client.on_subscribe=lambda c,u,m,codes,p:subscribed.set() if all(not code.is_failure for code in codes) else None
def publish(topic,payload):
    info=client.publish(topic,json.dumps(payload),qos=1,retain=False)
    info.wait_for_publish(timeout=5)
    if not info.is_published():raise RuntimeError('PUBACK timeout')
    log('PUBLISHED','broker acknowledged',topic=topic,payload=payload)
worker=ProtocolBResponder(cfg['manifest'],cfg['devices'],publish,log,lambda:connected.is_set() and not stop.is_set())
client.on_message=lambda c,u,m:worker.enqueue(m.topic,m.payload,m.retain,m.qos)
try:
    client.connect('127.0.0.1',cfg['port'],30);client.loop_start()
    if not connected.wait(5):raise RuntimeError('MQTT connect timeout')
    client.subscribe([(topic,1) for topic in worker.bindings])
    if not subscribed.wait(5):raise RuntimeError('MQTT SUBACK timeout')
    raw=samples()['01-six-types'];raw['fullchain']={'enabled':False}
    scene,devices,targets,_=compile_scene(raw)
    manifest=cfg['manifest'];manifest['targets']=allocate_identities(scene,'item1-python')
    now=int(time.time()*1000)
    for topic,payload in messages(scene,devices,targets,manifest,0,now,{},1):publish(topic,payload)
    for key,device in cfg['devices'].items():
        if device['kind'] not in ('dec','ifr','bsc'):continue
        e=manifest['devices'][key]
        publish('bridge/%s/device/%s/%s'%(manifest['provider'],e['kind'],e['external_id']),
            {'providerCode':manifest['provider'],'deviceId':e['external_id'],'deviceName':'isolated test',
             'deviceType':{'dec':5,'ifr':6,'bsc':12}[device['kind']],'workState':1,'ptTime':now})
    Path(cfg['ready']).write_text('ready',encoding='utf-8')
    deadline=time.monotonic()+90
    while time.monotonic()<deadline and not stop.wait(.1):
        if worker.error:raise RuntimeError(worker.error)
finally:
    stop.set();worker.suspend();client.disconnect();client.loop_stop()
