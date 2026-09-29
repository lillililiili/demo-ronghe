"""Explicit isolated-platform EO smoke. Uses real platform APIs, MQTT, encoder and media proxy.
Fixture and media credential files are ignored runtime input; credentials never enter reports.
"""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urljoin, urlparse, parse_qs
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from eo_video import EoSimulator, video_config
from platform_client import Platform
from paho.mqtt import client as mqtt

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):return None


def run(fixture_file, credentials_file, output, hold_until_file=None, source_file=None, interrupt_on_file=None):
    fixture=json.loads(fixture_file.read_text(encoding='utf-8-sig'))
    if fixture.get('base') != 'http://127.0.0.1:18091/api/v1' or fixture.get('target_id') != 'acceptance-eo-target':
        raise ValueError('This smoke only accepts the isolated port 18091 acceptance fixture')
    if not isinstance(fixture.get('device_id'), str) or not re.fullmatch(r'[0-9a-f-]{36}', fixture['device_id']):
        raise ValueError('Isolated acceptance fixture device ID is invalid')
    secret=json.loads(credentials_file.read_text(encoding='utf-8-sig'))
    api=Platform(fixture['base']);api.login(fixture['account'],fixture['password'])
    device,target=fixture['device_id'],fixture['target_id']
    details=api.call('GET','/devices/'+device+'/protocol-status')['details']
    if details.get('source_mode') != 'replay' or details.get('external_device_id') != 'eo-acceptance-1' or details.get('edge_id') != 'edge-acceptance-1':
        raise ValueError('Device does not match the isolated replay acceptance fixture')
    if details.get('open_task'):raise ValueError('Isolated EO device already has an open task')
    broker=next(b for b in api.brokers() if b['broker_id']==details['broker_id'])
    if broker['host'] not in ('127.0.0.1','localhost'):raise ValueError('Only local QA MQTT allowed')
    binding={'kind':'eo','platform_id':device,'external_id':details['external_device_id'],'edge_id':details['edge_id'],
             'dispatcher_topic':details['dispatcher_topic'],'reporting_topic':details['reporting_topic']}
    config=video_config({'enabled':True,'publisher_password':secret['publish'],'source':str(source_file.resolve()) if source_file else ''})
    cancel=threading.Event();api.on_unauthorized=cancel.set
    client=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,client_id='qa-platform-smoke-'+uuid.uuid4().hex)
    connected=threading.Event();subscribed=threading.Event();connect_result=[];subscribe_result=[]
    client.on_connect=lambda c,u,f,rc,p:(connect_result.append(not rc.is_failure),connected.set())
    client.on_subscribe=lambda c,u,mid,rc,p:(subscribe_result.append(all(not r.is_failure for r in rc)),subscribed.set())
    receipts=[];commands=[];logs=[];videos=[];task_id=None;process=None
    def publish(topic,payload):
        info=client.publish(topic,json.dumps(payload),qos=1,retain=False);info.wait_for_publish(5)
        if not info.is_published():raise ValueError('MQTT PUBACK timeout')
        if payload['event']!='HeartBeat':receipts.append({'event':payload['event'],'task_id':payload['metadata'].get('taskId')})
    eo=EoSimulator(api,{'devices':{'eo':binding}},config,publish,lambda *args:logs.append(args),is_running=lambda:not cancel.is_set())
    def receive(c,u,message):
        payload=json.loads(message.payload)
        commands.append({'event':payload.get('event'),'task_id':payload.get('metadata',{}).get('taskId')})
        eo.enqueue(message.topic,message.payload,message.retain)
    client.on_message=receive
    last_heartbeat=0
    def tick():
        nonlocal last_heartbeat
        if cancel.is_set():raise ValueError('Platform session no longer valid')
        if not client.is_connected():raise ValueError('MQTT disconnected')
        eo.tick()
        now=time.time()
        if now-last_heartbeat>=1:
            heartbeat={'event':'HeartBeat','edgeId':binding['edge_id'],'timestamp':int(now*1000),
                       'metadata':{'deviceId':binding['external_id'],'codeStatus':200,'workState':0,'cameraStatus':{}}}
            eo.heartbeat(heartbeat);publish(binding['reporting_topic'],heartbeat);last_heartbeat=now
    def pump(predicate,seconds=30):
        deadline=time.monotonic()+seconds
        while time.monotonic()<deadline:
            tick()
            if predicate():return
            time.sleep(.15)
        raise AssertionError('Timed out waiting for isolated platform state')
    def resource(url, token=True):
        headers={'Authorization':'Bearer '+api.token} if token else {}
        with api.http.open(Request(url,headers=headers),timeout=8) as response:return response.status,response.read()
    summary={'scope':'real isolated platform/PostgreSQL APIs + MQTT + FFmpeg + RTSP + authenticated platform HLS',
             'source':'local-file-loop' if source_file else 'dynamic-chart',
             'device_id':device,'target_id':target,'passed':False}
    if source_file:
        source_probe=subprocess.run([str(Path(config['ffmpeg']).with_name('ffprobe.exe' if sys.platform=='win32' else 'ffprobe')),
            '-v','error','-show_entries','stream=codec_type,codec_name:format=duration','-of','json',str(source_file.resolve())],
            capture_output=True,timeout=10)
        if source_probe.returncode:raise AssertionError('Local fixture codec probe failed')
        summary['input_probe']=json.loads(source_probe.stdout)
    try:
        if fixture.get('mqtt_user'):client.username_pw_set(fixture['mqtt_user'],fixture.get('mqtt_password',''))
        client.connect(broker['host'],int(broker['port']),15);client.loop_start()
        assert connected.wait(5) and all(connect_result)
        client.subscribe(binding['dispatcher_topic'],1)
        assert subscribed.wait(5) and all(subscribe_result)
        pump(lambda:api.call('GET','/targets/'+target+'/eo-tracking-availability').get('available') is True)
        task=api.call('POST','/targets/'+target+'/eo-tracking-tasks',{'device_id':device,'reason':'isolated QA video smoke'})
        task_id=task['task_id'];summary['task_id']=task_id
        def available():
            video=api.call('GET','/targets/'+target+'/video');videos.append(video)
            return video.get('video_status')=='AVAILABLE'
        pump(available,40)
        active=eo.active[device];process=active['process'];encoder_observed=time.monotonic()
        playback=videos[-1]['playback_url'];summary['video']=videos[-1]
        assert videos[-1]['task_id']==task_id and videos[-1]['device_id']==device and videos[-1]['simulated'] is True
        url=urljoin(api.base+'/',playback)
        documents=[]
        def hls_ready():
            try:code,body=resource(url)
            except HTTPError as error:
                detail={'status':error.code,'resource':'index.m3u8'}
                try:detail['body']=error.read().decode()[:500]
                except Exception:pass
                summary.setdefault('hls_errors',[]).append(detail)
                if len(summary['hls_errors'])==1:
                    auth='Basic '+base64.b64encode(('qa-platform:'+secret['read']).encode()).decode()
                    request=Request('http://127.0.0.1:8888/qa/'+videos[-1]['stream_id']+'/index.m3u8',headers={'Authorization':auth})
                    try:
                        with build_opener(ProxyHandler({}),NoRedirect()).open(request,timeout=8) as direct:
                            summary['direct_media_redirect']={'status':direct.status}
                    except HTTPError as direct_error:
                        location=urlparse(direct_error.headers.get('Location',''))
                        parameters=parse_qs(location.query)
                        summary['direct_media_redirect']={'status':direct_error.code,'location_path':location.path,
                            'location_origin':location.netloc,'query_names':list(parameters),
                            'session_uuid':bool(re.fullmatch(r'[a-f0-9-]{36}',parameters.get('session',[''])[0]))}
                        direct_error.close()
                    print('HLS redirect diagnostic: '+json.dumps(summary['direct_media_redirect']),flush=True)
                    try:
                        with api.http.open(request,timeout=8) as direct:
                            manifest=direct.read().decode()
                            summary['direct_media_master']={'status':direct.status,
                                'body':re.sub(r'(session=)[0-9a-f-]{36}',r'\1[redacted]',manifest)[:3000]}
                    except HTTPError as direct_error:
                        summary['direct_media_master']={'status':direct_error.code};direct_error.close()
                if error.code not in (404,503):raise
                error.close();return False
            documents.append(body.decode());return True
        pump(hls_ready,20)
        master=documents[-1];assert '#EXTM3U' in master
        variants=[line for line in master.splitlines() if line and not line.startswith('#')]
        assert variants
        variant_url=urljoin(url,variants[0]);code,raw=resource(variant_url);variant=raw.decode();assert '#EXTM3U' in variant
        exposed=urlparse(variant_url)
        copied_url='http://127.0.0.1:8888/qa/'+videos[-1]['stream_id']+'/'+exposed.path.rsplit('/',1)[-1]+('?' + exposed.query if exposed.query else '')
        try:
            with api.http.open(Request(copied_url),timeout=8):raise AssertionError('Browser playlist credentials bypass platform authentication at media origin')
        except HTTPError as denied:
            summary['copied_browser_resource_at_media_origin']=denied.code
            assert denied.code in (401,403,404);denied.close()
        references=re.findall(r'URI="([^"]+)"',variant)+[line for line in variant.splitlines() if line and not line.startswith('#')]
        assert references
        fetched=[]
        for reference in references[:3]:
            part=urljoin(variant_url,reference)
            assert urlparse(part).netloc==urlparse(api.base).netloc and '/video/streams/' in urlparse(part).path
            code,body=resource(part);assert code==200 and len(body)>0
            fetched.append({'resource':urlparse(part).path.rsplit('/',1)[-1],'bytes':len(body)})
        summary['hls_resources']=fetched
        probe=subprocess.run([str(Path(config['ffmpeg']).with_name('ffprobe.exe' if sys.platform=='win32' else 'ffprobe')),
            '-v','error','-headers','Authorization: Bearer '+api.token+'\r\n','-show_entries','stream=codec_type,codec_name',
            '-of','json',url],capture_output=True,timeout=15)
        if probe.returncode:raise AssertionError('Platform HLS codec probe failed')
        streams=json.loads(probe.stdout)['streams'];summary['probe']=streams
        assert streams and all(stream['codec_type']=='video' and stream['codec_name']=='h264' for stream in streams)
        summary['encoder_observed_seconds']=round(time.monotonic()-encoder_observed,2)
        if source_file:
            duration=float(summary['input_probe']['format']['duration'])
            summary['looped_beyond_source']=summary['encoder_observed_seconds']>duration and process.poll() is None
            assert summary['looped_beyond_source']
        try:resource(url,False);raise AssertionError('Anonymous platform HLS unexpectedly allowed')
        except HTTPError as error:summary['anonymous_platform_hls']=error.code;assert error.code==401;error.close()
        summary['commands']=commands.copy();summary['receipts']=receipts.copy()
        assert any(c['event']=='BeginTracking' and c['task_id']==task_id for c in commands)
        assert any(c['event']=='BeginTracking' and c['task_id']==task_id for c in receipts)
        if interrupt_on_file:
            output.mkdir(parents=True,exist_ok=True)
            (output/'eo-platform-ready.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
            print('Platform HLS ready; holding for browser before encoder interruption',flush=True)
            pump(lambda:interrupt_on_file.is_file(),300)
        original_process=process;original_stream=videos[-1]['stream_id'];original_command=videos[-1]['command_id']
        process.terminate();process.wait(5)
        interrupted=[]
        def stream_interrupted():
            value=api.call('GET','/targets/'+target+'/video');interrupted.append(value)
            return value.get('video_status')=='INTERRUPTED'
        pump(stream_interrupted,10)
        assert interrupted[-1]['task_id']==task_id and interrupted[-1]['status']=='TRACKING'
        assert eo.snapshot()['devices'][0]['video']=='FAILED'
        pump(available,30)
        process=eo.active[device]['process']
        assert process is not original_process and process.poll() is None
        assert videos[-1]['task_id']==task_id and videos[-1]['stream_id']==original_stream and videos[-1]['command_id']==original_command
        recovered_master=[]
        def recovered_hls():
            try:
                _,body=resource(url);document=body.decode()
                child=next(line for line in document.splitlines() if line and not line.startswith('#'))
                _,child_body=resource(urljoin(url,child))
                part=next(line for line in child_body.decode().splitlines() if line and not line.startswith('#'))
                _,segment=resource(urljoin(url,part));assert segment
                recovered_master.append(True);return True
            except HTTPError as error:
                if error.code not in (404,503):raise
                error.close();return False
        pump(recovered_hls,20)
        summary['interruption_recovery']={'interrupted_status':interrupted[-1]['video_status'],
            'tracking_status':interrupted[-1]['status'],'recovered_status':videos[-1]['video_status'],
            'same_task':True,'same_stream':True,'same_command':True,'recovered_hls_segment':bool(recovered_master)}
        if hold_until_file:
            output.mkdir(parents=True,exist_ok=True)
            (output/'eo-platform-ready.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
            print('Platform HLS ready; holding for browser evidence',flush=True)
            pump(lambda:hold_until_file.is_file(),300)
        api.call('POST','/eo-tracking-tasks/'+task_id+'/end')
        pump(lambda:not eo.active and api.call('GET','/targets/'+target+'/video').get('status')=='ENDED',30)
        assert process.poll() is not None
        try:resource(url);raise AssertionError('Ended task old HLS URL unexpectedly allowed')
        except HTTPError as error:summary['ended_hls_status']=error.code;assert error.code==404;error.close()
        summary.update(passed=True,final_video=api.call('GET','/targets/'+target+'/video'),commands=commands.copy(),receipts=receipts.copy(),encoder_exit=process.returncode)
        print('real isolated platform video lifecycle passed',flush=True)
    except Exception as error:
        summary['error_type']=type(error).__name__
        if videos:summary['last_video']=videos[-1]
        summary['eo_status']=eo.snapshot()
        raise
    finally:
        if task_id and eo.active:
            try:
                api.call('POST','/eo-tracking-tasks/'+task_id+'/end')
                pump(lambda:not eo.active,10)
            except Exception:pass
        eo.suspend();client.disconnect();client.loop_stop()
        summary['commands']=commands;summary['receipts']=receipts;summary['diagnostics']=logs
        output.mkdir(parents=True,exist_ok=True)
        (output/'eo-platform-smoke.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
        (output/('eo-platform-smoke-'+summary['source']+'.json')).write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    return summary

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-isolated-platform-smoke',action='store_true',required=True)
    parser.add_argument('--fixture-file',type=Path,required=True)
    parser.add_argument('--credentials-file',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--hold-until-file',type=Path,help='Optional browser coordination marker; ends the task when this file exists, maximum 300 seconds')
    parser.add_argument('--source-file',type=Path,help='Optional server-local video to loop; default is dynamic test chart')
    parser.add_argument('--interrupt-on-file',type=Path,help='Wait for browser marker before interrupting encoder; automatic retry remains 15 seconds')
    args=parser.parse_args()
    try:run(args.fixture_file,args.credentials_file,args.output,args.hold_until_file,args.source_file,args.interrupt_on_file)
    except Exception as error:
        import traceback
        print('Isolated platform smoke failed: '+type(error).__name__,file=sys.stderr)
        print([(Path(frame.filename).name,frame.lineno,frame.name) for frame in traceback.extract_tb(error.__traceback__)],file=sys.stderr)
        raise SystemExit(1) from None
