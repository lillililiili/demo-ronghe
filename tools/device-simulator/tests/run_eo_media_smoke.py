"""Opt-in local media smoke: real MQTT/FFmpeg/MediaMTX, in-memory platform contract double.
No platform login, database mutation, notification, or production target is used.
"""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
import time
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError
from urllib.parse import quote
import uuid
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eo_video import EoSimulator, video_config
from paho.mqtt import client as mqtt

HTTP=build_opener(ProxyHandler({}))
READ_AUTH=None
def fetch(url, auth=None):
    headers={'Authorization':auth or READ_AUTH} if auth or READ_AUTH else {}
    with HTTP.open(Request(url,headers=headers),timeout=3) as response: return response.read()
def paths(): return json.loads(fetch('http://127.0.0.1:9997/v3/paths/list'))['items']

class ContractDouble:
    def __init__(self, binding): self.binding=binding; self.task=None; self.stream=None; self.calls=[]
    def call(self, method, path, body=None):
        self.calls.append((method,path,body))
        if method=='GET': return {'details':{'open_task':{'task_id':self.task,'status':'OPEN'}}}
        if method=='PUT':
            assert path.endswith(self.task) and body['device_id']==self.binding['platform_id']
            return {'task_id':self.task,'device_id':self.binding['platform_id'],'target_id':'contract-double-target',
                    'stream_id':self.stream,'stream_path':'qa/'+self.stream}
        if method=='DELETE': return {}
        raise AssertionError(method)

def run(output, credentials_file):
    output.mkdir(parents=True,exist_ok=True)
    credentials=json.loads(credentials_file.read_text(encoding='utf-8-sig'))
    config=video_config({'enabled':True,'publisher_password':credentials['publish']})
    global READ_AUTH
    READ_AUTH='Basic '+base64.b64encode(('qa-platform:'+credentials['read']).encode()).decode()
    publisher_auth='Basic '+base64.b64encode(('qa-publisher:'+credentials['publish']).encode()).decode()
    binary=Path(config['ffmpeg']); ffprobe=binary.with_name('ffprobe.exe' if sys.platform=='win32' else 'ffprobe')
    run_id=uuid.uuid4().hex
    binding={'kind':'eo','platform_id':'qa-smoke-ops-'+run_id,'external_id':'qa-smoke-'+run_id,
             'edge_id':'qa-smoke-edge-'+run_id,'dispatcher_topic':'iot-dispatcher/cmlc/edge/qa-smoke-'+run_id,
             'reporting_topic':'iot-reporting/cmlc/edge/qa-smoke-edge-'+run_id}
    platform=ContractDouble(binding); receipts=[]; logs=[]
    receiver=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,client_id='qa-eo-receiver-'+run_id)
    sender=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,client_id='qa-eo-sender-'+run_id)
    connected=[threading.Event(),threading.Event()]; subscribed=[threading.Event(),threading.Event()]
    receiver.on_connect=lambda *args:connected[0].set()
    sender.on_connect=lambda *args:connected[1].set()
    receiver.on_subscribe=lambda *args:subscribed[0].set()
    sender.on_subscribe=lambda *args:subscribed[1].set()
    sender.on_message=lambda c,u,m:receipts.append(json.loads(m.payload))
    def publish(topic,payload):
        info=receiver.publish(topic,json.dumps(payload),qos=1,retain=False); info.wait_for_publish(3)
        assert info.is_published()
    eo=EoSimulator(platform,{'devices':{'eo':binding}},config,publish,lambda *args:logs.append(args))
    receiver.on_message=lambda c,u,m:eo.enqueue(m.topic,m.payload,m.retain)
    def pump(predicate,timeout=15):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            eo.tick()
            if predicate():return
            time.sleep(.05)
        raise AssertionError('timeout: '+json.dumps(eo.snapshot(),ensure_ascii=False))
    def command(event='BeginTracking', task=None, stamp=None):
        message={'event':event,'edgeId':binding['edge_id'],'timestamp':stamp or int(time.time()*1000),
                 'metadata':{'deviceId':binding['external_id'],'taskId':task or platform.task}}
        info=sender.publish(binding['dispatcher_topic'],json.dumps(message),qos=1,retain=False)
        info.wait_for_publish(3); assert info.is_published()
    summary={'scope':'real MQTT + FFmpeg + RTSP + HLS; platform API is in-memory contract double',
             'media_version':'MediaMTX v1.21.1','run_id':run_id,'cases':[]}
    source_directory=tempfile.TemporaryDirectory(prefix='eo-local-source-')
    try:
        for client in (receiver,sender):client.connect('127.0.0.1',1883,15);client.loop_start()
        assert all(event.wait(5) for event in connected)
        receiver.subscribe(binding['dispatcher_topic'],1);sender.subscribe(binding['reporting_topic'],1)
        assert all(event.wait(5) for event in subscribed)
        source=Path(source_directory.name)/'local-video-with-audio.mp4'
        subprocess.run([str(binary),'-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x360:rate=15',
            '-f','lavfi','-i','sine=frequency=440','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',str(source)],check=True,timeout=20,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        for kind in ('dynamic-chart','local-file-loop'):
            platform.task=str(uuid.uuid4());platform.stream=str(uuid.uuid4())
            eo.config['source']='' if kind=='dynamic-chart' else str(source)
            command()
            pump(lambda:bool(eo.active))
            active=eo.active[binding['platform_id']]; process=active['process']; pid=process.pid
            stream_path='qa/'+platform.stream
            pump(lambda:any(p['name']==stream_path and p['ready'] for p in paths()))
            hls='http://127.0.0.1:8888/'+stream_path+'/index.m3u8'
            pump(lambda:bool(receipts and receipts[-1]['metadata'].get('taskId')==platform.task))
            playlists=[]
            def playlist_ready():
                try: content=fetch(hls).decode()
                except HTTPError as error:
                    if error.code not in (404,503): raise
                    error.close();return False
                except TimeoutError:return False
                assert '#EXTM3U' in content
                playlists.append(content);return True
            pump(playlist_ready)
            master=playlists[-1]
            denied={}
            for label,auth in (('anonymous_read',None),('publisher_read',publisher_auth)):
                try:
                    with HTTP.open(Request(hls,headers={'Authorization':auth} if auth else {}),timeout=3) as response:
                        response.read()
                    raise AssertionError('media unexpectedly allowed '+label)
                except HTTPError as error:
                    denied[label]=error.code;assert error.code in (401,403);error.close()
            for label,user,password in (('anonymous_publish',None,None),('platform_publish','qa-platform',credentials['read'])):
                destination=config['rtsp_base']+'/qa/'+str(uuid.uuid4())
                if user:destination=destination.replace('rtsp://','rtsp://'+quote(user,safe='')+':'+quote(password,safe='')+'@')
                result=subprocess.run([str(binary),'-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x90:rate=5',
                    '-t','1','-an','-c:v','libx264','-f','rtsp','-rtsp_transport','tcp',destination],capture_output=True,timeout=8)
                assert result.returncode!=0
                assert b'401' in result.stderr or b'403' in result.stderr
                denied[label]=True
            # Real HLS parse proves codec and no audio after an audio-bearing source.
            probe=subprocess.run([str(ffprobe),'-v','error','-show_entries','stream=codec_name,codec_type','-of','json','-headers','Authorization: '+READ_AUTH+'\r\n',hls],capture_output=True,text=True,timeout=20,check=True)
            streams=json.loads(probe.stdout)['streams'];assert streams and all(s['codec_type']=='video' for s in streams)
            command();pump(lambda:len([r for r in receipts if r['event']=='BeginTracking' and r['metadata'].get('taskId')==platform.task])>=2)
            assert eo.active[binding['platform_id']]['process'].pid==pid
            command(task='stale-other-task',stamp=int(time.time()*1000)-31000)
            pump(lambda:any('过期' in str(log) for log in logs))
            assert eo.active[binding['platform_id']]['task']==platform.task
            case={'source':kind,'task':platform.task,'stream':stream_path,'ready':True,'hls_master':re.sub(r'(session=)[0-9a-f-]{36}',r'\1[redacted]',master),'probe':streams,
                  'duplicate_pid_unchanged':True,'stale_cannot_takeover':True,'authorization_rejections':denied}
            if kind=='dynamic-chart':
                fixture=output/'eo-hls-fixture';fixture.mkdir(exist_ok=True)
                subprocess.run([str(binary),'-hide_banner','-loglevel','error','-rtsp_transport','tcp','-i',config['rtsp_base'].replace('rtsp://','rtsp://qa-platform:'+quote(credentials['read'],safe='')+'@')+'/'+stream_path,
                    '-t','4','-an','-c:v','copy','-f','hls','-hls_time','1','-hls_list_size','0','-hls_playlist_type','vod',
                    '-hls_segment_filename',str(fixture/'segment-%03d.ts'),'-y',str(fixture/'index.m3u8')],check=True,timeout=20,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                case['fixture']=str(fixture)
            else:
                # Source is two seconds. Probe + wait beyond one complete repeat.
                end=time.monotonic()+3
                while time.monotonic()<end:eo.tick();time.sleep(.05)
                assert process.poll() is None
                case['loop_beyond_source_duration']=True
            count=len(receipts);command('EndTracking')
            pump(lambda:not eo.active and len(receipts)>count)
            assert process.poll() is not None
            pump(lambda:not any(p['name']==stream_path and p['ready'] for p in paths()))
            assert receipts[-1]['event']=='EndTracking' and receipts[-1]['metadata']['workState']==0
            case.update(stop_process_exit=process.returncode,stop_media_ready=False,delete_called=platform.calls[-1][0]=='DELETE')
            summary['cases'].append(case)
            print(kind+' passed',flush=True)
        summary['passed']=True
    finally:
        eo.suspend()
        source_directory.cleanup()
        for client in (receiver,sender):client.disconnect();client.loop_stop()
        summary['receipt_count']=len(receipts);summary['diagnostics']=logs
        report='eo-media-smoke.json' if summary.get('passed') else 'eo-media-smoke-failed.json'
        (output/report).write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    return summary

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-local-media-smoke',action='store_true',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--credentials-file',type=Path,required=True)
    args=parser.parse_args()
    try:run(args.output,args.credentials_file)
    except Exception as error:
        print('Local media smoke failed: '+type(error).__name__+' (details suppressed to protect media credentials)',file=sys.stderr)
        import traceback
        print([(Path(frame.filename).name,frame.lineno,frame.name) for frame in traceback.extract_tb(error.__traceback__)],file=sys.stderr)
        raise SystemExit(1) from None
