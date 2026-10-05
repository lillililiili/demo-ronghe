"""Opt-in actual localhost I/O acceptance; requires the user's simulator login."""
import argparse
import json
import time
import urllib.request
from pathlib import Path


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True)
    parser.add_argument('--seconds',type=int,default=305)
    parser.add_argument('--scene',help='Optional complete scene JSON including existing filing references')
    args=parser.parse_args()
    if args.seconds<300:parser.error('Actual acceptance must run at least 300 seconds')
    http=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def api(path,body=None):
        req=urllib.request.Request('http://127.0.0.1:8766/api/'+path,
            data=None if body is None else json.dumps(body).encode(),
            headers={'Content-Type':'application/json'})
        with http.open(req,timeout=90) as response:return json.load(response)
    state=api('status')
    if not state.get('connected'):raise SystemExit('请先在8766登录系统；不读取或绕过会话')
    if state.get('phase') in ('PREPARING','RUNNING','PAUSED','STOPPING'):
        raise SystemExit('已有批次运行，未启动或停止它')
    scene=json.loads(Path(args.scene).read_text(encoding='utf-8')) if args.scene else api('full-scene')
    output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
    evidence={'started_at':int(time.time()*1000),'samples':[],'complete':False}
    def save():output.write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
    try:
        state=api('start',scene);evidence['batch']=state['batch'];save()
        deadline=time.monotonic()+90
        while state['phase']=='PREPARING' and time.monotonic()<deadline:
            time.sleep(1);state=api('status')
        if state['phase']!='RUNNING':raise RuntimeError(state.get('error') or '场景未进入RUNNING')
        begin=time.monotonic();next_sample=0
        while True:
            elapsed=time.monotonic()-begin;state=api('status')
            if state['phase']!='RUNNING':raise RuntimeError(state.get('error') or state['phase'])
            if elapsed>=next_sample or elapsed>=args.seconds:
                readback=api('verify',{});rt=state.get('realtime',{})
                sample={'elapsed_seconds':round(elapsed,1),'at':int(time.time()*1000),
                    'mqtt_puback':state['sent'],'last_published_at':state.get('last_published_at'),
                    'tcp':rt.get('countermeasure'),'notifications':rt.get('notifications'),
                    'coverage':state.get('coverage'),'readback':readback}
                evidence['samples'].append(sample);save()
                print(json.dumps({'elapsed':sample['elapsed_seconds'],'puback':state['sent'],
                    'targets':len(readback.get('targets',[])),'points':readback.get('track_point_count'),
                    'observations':readback.get('category_observations'),'weather':readback.get('weather_count'),
                    'read_errors':readback.get('read_errors')},ensure_ascii=False),flush=True)
                next_sample+=60
            if elapsed>=args.seconds:break
            time.sleep(1)
        evidence['complete']=True
    except Exception as error:
        evidence['error']=str(error);raise
    finally:
        # Stop only the batch this collector actually started.
        if evidence.get('batch') and api('status').get('batch')==evidence['batch']:
            evidence['stop_result']=api('realtime/control',{'action':'stop_all'})
        evidence['finished_at']=int(time.time()*1000);save()


if __name__=='__main__':main()
