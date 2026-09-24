#!/usr/bin/env python3
"""Local UI and MQTT publisher for the existing Dongying replay system."""
import argparse
import copy
import json
import re
import os
from pathlib import Path
import threading
import time
import uuid
import subprocess
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, unquote, parse_qs
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from engine import compile_scene, messages, position
from notification_inbox import read_inbox
from notification_response import NotificationResponse
from platform_client import Platform, Prerequisites

ROOT = Path(__file__).resolve().parent

class ExternalAuthenticationRequired(ValueError):
    """The external interface session is absent and the browser must log in again."""

class ExternalBridge:
    """Shared in-memory system login and allowlisted external interface calls."""
    PREFIX = '/local-interface-simulator'
    READ = {PREFIX + '/context'}
    WRITE = {PREFIX + '/plans', PREFIX + '/weather', PREFIX + '/bindings'}
    RECEIPT = re.compile(r'^/local-interface-simulator/messages/[A-Za-z0-9_-]{1,64}/receipt$')

    def __init__(self):
        self.lock = threading.RLock()
        self.platform = None
        self.user = None
        self.runtime = None
        self.version = uuid.uuid4().hex

    @classmethod
    def allowed(cls, method, path):
        return method == 'GET' and path in cls.READ or method == 'POST' and (path in cls.WRITE or bool(cls.RECEIPT.fullmatch(path)))

    def status(self):
        with self.lock:
            return {'connected': self.platform is not None, 'session_version': self.version, 'api': self.platform.base if self.platform else None, **({'user': dict(self.user)} if self.user else {})}

    def connect(self, config):
        if not isinstance(config, dict) or not config.get('account') or not config.get('password'):
            raise ValueError('请输入系统账号和密码')
        with self.lock:
            if self.runtime and self.runtime.phase in ('PREPARING','RUNNING','PAUSED','STOPPING'):
                raise ValueError('请先停止当前任务，再重新登录或切换账号')
            platform = Platform(config.get('api', 'http://127.0.0.1:8081/api/v1'))
            me = platform.login(config['account'], config['password'])
            user = {key: me[key] for key in ('account', 'name', 'role_code', 'user_id') if key in me}
            platform.on_unauthorized = lambda: self.invalidate(platform)
            self.platform, self.user = platform, user
            self.version = uuid.uuid4().hex
            if self.runtime:
                self.runtime.brokers, self.runtime.broker = [], None
                self.runtime.mqtt_username = self.runtime.mqtt_password = ''
            return self.status()

    def invalidate(self, platform):
        with self.lock:
            if self.platform is not platform: return
            self.platform, self.user = None, None
            self.version = uuid.uuid4().hex
            if self.runtime:
                self.runtime.cancel.set()
                if self.runtime.phase in ('PREPARING','RUNNING','PAUSED','STOPPING'):
                    self.runtime.error = '系统登录已失效，模拟发送已请求停止，请重新登录'

    def inbox(self, kind, page):
        with self.lock:
            platform = self.platform
        if platform is None: raise ExternalAuthenticationRequired('请先登录现有系统')
        try:
            return read_inbox(platform, kind, page)
        except ValueError as error:
            if '返回 401' in str(error):
                self.invalidate(platform)
            raise

    def request(self, command):
        if not isinstance(command, dict): raise ValueError('请求格式无效')
        method, path = command.get('method'), command.get('path')
        if not isinstance(path, str) or not self.allowed(method, path):
            raise ValueError('不允许访问该系统接口')
        body, key = command.get('body'), command.get('key')
        if method == 'POST':
            if not isinstance(body, dict): raise ValueError('提交内容必须是对象')
            if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', key):
                raise ValueError('幂等键无效')
        elif body is not None or key is not None:
            raise ValueError('读取请求不接受提交内容')
        with self.lock:
            platform = self.platform
        if platform is None: raise ExternalAuthenticationRequired('请先登录现有系统')
        try:
            return platform.call(method, path, body, key)
        except ValueError as error:
            if '返回 401' in str(error):
                self.invalidate(platform)
            raise

external_bridge = ExternalBridge()

class NoMapRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None

MAP_HTTP = build_opener(ProxyHandler({}), NoMapRedirect())

class Runtime:
    def __init__(self, data_dir, database=None, container='deploy-db-1', session=None):
        self.data_dir = Path(data_dir); self.data_dir.mkdir(parents=True, exist_ok=True)
        self.seed = Prerequisites(database, container)
        self.session = session or ExternalBridge()
        self.session.runtime = self
        self.lock = self.session.lock
        self.brokers = []; self.broker = None
        self.mqtt_password = ''; self.mqtt_username = ''
        self.phase = 'IDLE'; self.error = ''; self.batch = None; self.elapsed = 0
        self.sent = 0; self.logs = []; self.manifest = {}; self.targets = {}; self.scene = {}
        self.cancel = threading.Event(); self.thread = None
        self.snapshot = {}; self.skipped = []; self.response = None
        saved=sorted(self.data_dir.glob('sim-*/manifest.json'),key=lambda p:p.stat().st_mtime)
        if saved:
            try:
                self.manifest=json.loads(saved[-1].read_text()); self.batch=self.manifest['batch']
                self.scene=json.loads((saved[-1].parent/'scene.json').read_text())
                _,_,self.targets,self.skipped=compile_scene(self.scene)
                for key,motion in self.manifest.get('notification_motion', {}).items():
                    if key in self.targets: self.targets[key]['_notification_motion'] = motion
                self.phase=self.manifest.get('phase','STOPPED')
                if self.phase in ('PREPARING','RUNNING','PAUSED','STOPPING'): self.phase='STOPPED'; self.error='服务重启，上次发送已中断，未自动续发'
                self.elapsed=self.manifest.get('elapsed',0); self.sent=self.manifest.get('sent',0)
                readback=saved[-1].parent/'system-readback.json'
                if readback.exists(): self.snapshot=json.loads(readback.read_text())
                log_path=saved[-1].parent/'events.ndjson'
                if log_path.exists():
                    from collections import deque
                    self.logs=[json.loads(line) for line in deque(log_path.open(),maxlen=200)]
            except (ValueError,KeyError,OSError): self.phase='IDLE'; self.batch=None; self.manifest={}; self.scene={}; self.targets={}

    @property
    def platform(self):
        return self.session.platform

    def status(self):
        with self.lock:
            return {'phase':self.phase, 'error':self.error, 'batch':self.batch, 'elapsed':round(self.elapsed,1),
                    'duration':self.scene.get('duration',0)*60, 'sent':self.sent, 'logs':copy.deepcopy(self.logs[-80:]),
                    'positions':{k:position(t,self.elapsed) for k,t in self.targets.items()},
                    'notification_observation':self.response.snapshot() if self.response else self.manifest.get('notification_observation', {}),
                    'skipped':self.skipped, **self.session.status(), 'mqtt_ready':self.platform is not None and self.broker is not None,
                    'broker':{'name':self.broker['name'],'host':self.broker['host'],'port':self.broker['port']} if self.broker else None,
                    'scene':copy.deepcopy(self.scene), 'manifest':copy.deepcopy(self.manifest), 'snapshot':copy.deepcopy(self.snapshot)}

    def log(self, kind, message, **extra):
        record = {'at':int(time.time()*1000),'kind':kind,'message':message,**extra}
        with self.lock:
            self.logs.append(record); self.logs = self.logs[-200:]
            if self.batch:
                with (self.data_dir/self.batch/'events.ndjson').open('a') as f:
                    f.write(json.dumps(record,ensure_ascii=False)+'\n')

    def checkpoint(self):
        self.manifest.update(phase=self.phase,elapsed=self.elapsed,sent=self.sent)
        if self.response:
            self.manifest['notification_observation'] = self.response.snapshot()
            self.manifest['notification_motion'] = {key: copy.deepcopy(t['_notification_motion']) for key,t in self.targets.items() if t.get('_notification_motion')}
        path = self.data_dir/self.batch/'manifest.json'
        temp = path.with_suffix('.tmp'); temp.write_text(json.dumps(self.manifest,ensure_ascii=False,indent=2)); temp.replace(path)

    def connect(self, config):
        with self.lock:
            if self.phase in ('PREPARING','RUNNING','PAUSED','STOPPING'):
                raise ValueError('请先停止当前任务')
            if config.get('account') or config.get('password'):
                self.session.connect(config)
            api = self.platform
            if api is None: raise ExternalAuthenticationRequired('请先登录系统')
            brokers = api.brokers()
            selected = config.get('broker_id')
            broker = next((b for b in brokers if b['broker_id']==selected),None) if selected else next((b for b in brokers if b['name']=='local-lingyun-replay'), None)
            if not broker:
                raise ValueError('未找到启用的回放 MQTT 连接，请在后台配置 local-lingyun-replay')
            if broker['host'] not in ('127.0.0.1','localhost'):
                raise ValueError('当前版本仅连接本机 replay MQTT，避免误发现场环境')
            self.brokers, self.broker = brokers, broker
            self.mqtt_username, self.mqtt_password = config.get('mqtt_user',''),config.get('mqtt_password','')
            return {'name':broker['name'],'host':broker['host'],'port':broker['port']}

    def start(self, raw):
        scene, devices, targets, skipped = compile_scene(raw)
        with self.lock:
            if self.phase in ('PREPARING','RUNNING','PAUSED','STOPPING') or self.thread and self.thread.is_alive():
                raise ValueError('已有任务运行中')
            if not self.platform:
                raise ExternalAuthenticationRequired('请先登录系统')
            if not self.broker:
                self.connect({})
            self.batch='sim-'+time.strftime('%m%d%H%M%S')+'-'+uuid.uuid4().hex[:4]
            (self.data_dir/self.batch).mkdir()
            self.scene, self.targets, self.skipped = scene, targets, skipped
            self.elapsed=0; self.sent=0; self.logs=[]; self.snapshot={}; self.error=''; self.response=None
            self.manifest={'batch':self.batch,'source_mode':'replay','provider':'map-sim', 'created_at':int(time.time()*1000),
                           'broker_id':self.broker['broker_id'],'devices':{},'plans':{},'zones':{},
                           'targets':{k:{'uav_sn':self.batch+'-u'+str(i)} for i,k in enumerate(targets,1)}}
            self.phase='PREPARING'
            self.checkpoint()
            (self.data_dir/self.batch/'scene.json').write_text(json.dumps(scene,ensure_ascii=False,indent=2))
            self.phase='PREPARING'; self.cancel.clear()
            self.thread=threading.Thread(target=self.run,args=(devices,),daemon=True); self.thread.start()
            return self.status()

    def run(self, devices):
        client=None
        try:
            self.log('PREPARE','正在为本批次注册模拟设备与配套资料')
            if self.seed.database and self.platform.me.get('role_code') != 'ROLE-ADMIN':
                raise ValueError('本机计划/区域 seed 仅允许测试系统管理员运行')
            self.seed.create(self.scene,self.targets,self.broker,self.manifest,self.manifest['created_at'])
            self.checkpoint()
            if self.cancel.is_set(): return
            self.platform.prepare_devices(devices,self.broker,self.manifest,self.checkpoint)
            if self.cancel.is_set(): return
            from paho.mqtt import client as mqtt
            connected=threading.Event(); result=[]
            client=mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,client_id=self.batch,protocol=mqtt.MQTTv311,reconnect_on_failure=False)
            def on_connect(c,u,f,code,p):
                result.append(not code.is_failure); connected.set()
            client.on_connect=on_connect
            if self.mqtt_username:
                client.username_pw_set(self.mqtt_username,self.mqtt_password)
            if self.broker.get('tls'): client.tls_set()
            client.connect_timeout=5
            client.connect(self.broker['host'],int(self.broker['port']),30); client.loop_start()
            if not connected.wait(6) or not result or not result[0]:
                raise ValueError('MQTT 连接或认证失败')
            with self.lock:
                if self.cancel.is_set(): return
                self.phase='RUNNING'
            self.log('START','MQTT 已连接，开始发送；平台是否接收请查看系统回读')
            if self.skipped: self.log('SKIP','本次未发送：'+'、'.join(self.skipped))
            self.response = NotificationResponse(self.platform, self.manifest, self.targets)
            self.response.start()
            last_sent={}; sequence=0; previous=time.monotonic(); next_frame=0
            while not self.cancel.is_set():
                current=time.monotonic()
                with self.lock:
                    if self.phase=='RUNNING': self.elapsed+=current-previous
                    elapsed=self.elapsed; phase=self.phase
                previous=current
                if elapsed >= self.scene['duration']*60: break
                if phase=='RUNNING' and elapsed >= next_frame:
                    sequence+=1; next_frame=elapsed+1
                    with self.lock:
                        self.response.apply(self.targets, elapsed, int(time.time()*1000))
                    for topic,payload in messages(self.scene,devices,self.targets,self.manifest,elapsed,int(time.time()*1000),last_sent,sequence):
                        if self.cancel.is_set(): break
                        if not client.is_connected(): raise ValueError('MQTT 连接已断开，任务停止')
                        info=client.publish(topic,json.dumps(payload,ensure_ascii=False),qos=1,retain=False)
                        info.wait_for_publish(timeout=5)
                        if not info.is_published(): raise ValueError('MQTT 确认超时：当前发送结果未知，任务停止')
                        with self.lock: self.sent+=1
                        self.log('PUBACK','Broker 已确认',topic=topic,payload=payload)
                self.cancel.wait(.1)
            with self.lock:
                self.phase='STOPPED' if self.cancel.is_set() else 'COMPLETED'
            self.log('STOP','发送已停止；已有业务记录保留，设备时效由系统判定')
        except Exception as error:
            with self.lock:
                self.phase='FAILED'; self.error=str(error)[:600]
            self.log('ERROR',self.error)
        finally:
            if self.response: self.response.stop.set()
            if client:
                client.disconnect(); client.loop_stop()
            with self.lock:
                if self.phase in ('STOPPING','PREPARING'): self.phase='STOPPED'
            self.checkpoint()

    def control(self, action):
        with self.lock:
            if action=='stop':
                if self.phase in ('PREPARING','RUNNING','PAUSED'):
                    self.phase='STOPPING'; self.cancel.set()
            elif action=='pause' and self.phase=='RUNNING': self.phase='PAUSED'
            elif action=='resume' and self.phase=='PAUSED': self.phase='RUNNING'
            else: raise ValueError('当前状态不支持该操作')
        return self.status()

    def verify(self):
        with self.lock:
            manifest=copy.deepcopy(self.manifest); api=self.platform
        if not api or not manifest.get('devices'):
            raise ValueError('还没有已注册的模拟设备')
        result={'at':int(time.time()*1000),'devices':[],'plans':[],'zones':[]}
        for d in manifest['devices'].values():
            data=api.call('GET','/devices/'+d['platform_id'])
            result['devices'].append(data)
        for p in manifest['plans'].values():
            for pid in p['ids']: result['plans'].append(api.call('GET','/flight-plans/'+pid))
        for z in manifest['zones'].values(): result['zones'].append(api.call('GET','/airspaces/'+z['id']))
        # Restrict target results to this run's unique serials or source device links.
        candidates=api.call('GET',f"/targets?page=1&size=100&seen_from={manifest['created_at']}&seen_to={int(time.time()*1000)+1}")
        external={d['external_id'] for d in manifest['devices'].values()}
        serials={t['uav_sn'] for t in manifest['targets'].values()}
        platform_ids={d['platform_id'] for d in manifest['devices'].values()}
        platform_ids.update(d.get('device',{}).get('fusion_device_id') for d in result['devices'])
        platform_ids.discard(None)
        result['targets']=[]
        for item in candidates.get('items',[]):
            detail=api.call('GET','/targets/'+item['target_id'])
            text=json.dumps(detail)
            if any(link.get('device_id') in platform_ids for link in detail.get('source_links',[])): result['targets'].append(detail)
        result['evaluations']=[]; result['alarms']=[]; result['read_errors']=[]
        for target in result['targets']:
            target_id=target.get('target_id') or target.get('target',{}).get('target_id')
            if not target_id: continue
            for kind,path in [('evaluations','/legality-evaluations'),('alarms','/alarms')]:
                try: result[kind].extend(api.call('GET',path+'?page=1&size=100&target_id='+target_id).get('items',[]))
                except ValueError as error: result['read_errors'].append(str(error))
        result['target_scan_limit']=100
        result['target_candidates_total']=candidates.get('total',0)
        with self.lock:
            if self.batch!=manifest['batch']: raise ValueError('运行批次已变化，请重新回读')
            self.snapshot=result
        (self.data_dir/self.batch/'system-readback.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
        return result

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT/'web'),**kwargs)
    def log_message(self,*args): pass
    def safe(self):
        expected={'127.0.0.1:'+str(self.server.server_port),'localhost:'+str(self.server.server_port)}
        host=self.headers.get('Host','')
        origin=self.headers.get('Origin')
        return host in expected and (not origin or origin in {'http://'+h for h in expected})
    def respond(self,value,status=200):
        raw=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def map_resource(self):
        path = unquote(urlparse(self.path).path)
        if any(part in ('.', '..') for part in path.split('/')) or '\\' in path:
            return self.respond({'error':'地图资源路径无效'},400)
        headers = {key:self.headers[key] for key in ('Range','If-Range','If-None-Match','If-Modified-Since') if self.headers.get(key)}
        if path.endswith('.pmtiles') and 'Range' not in headers:
            return self.respond({'error':'地图包须分段读取'},416)
        started = False
        try:
            with MAP_HTTP.open(Request(self.server.map_origin + self.path, headers=headers), timeout=20) as response:
                self.send_response(response.status)
                for key in ('Content-Type','Content-Length','Content-Range','Accept-Ranges','ETag','Last-Modified','Cache-Control'):
                    if response.headers.get(key): self.send_header(key,response.headers[key])
                self.end_headers()
                started = True
                while True:
                    chunk=response.read(65536)
                    if not chunk: break
                    self.wfile.write(chunk)
        except HTTPError as error:
            self.send_response(error.code); self.send_header('Content-Length','0'); self.end_headers()
        except (BrokenPipeError, ConnectionResetError): pass
        except (URLError, TimeoutError, OSError):
            if started: self.close_connection = True
            else: self.respond({'error':'系统地图服务不可用，请检查业务前台地图服务'},502)
    def do_GET(self):
        if not self.safe(): return self.respond({'error':'只允许本机同源访问'},403)
        if self.path=='/api/external/status': return self.respond(external_bridge.status())
        if urlparse(self.path).path == '/api/external/inbox':
            params = parse_qs(urlparse(self.path).query)
            try:
                if set(params) - {'kind', 'page'}: raise ValueError('通知查询参数无效')
                return self.respond(external_bridge.inbox(params.get('kind', ['risk'])[0], int(params.get('page', ['1'])[0])))
            except ValueError as error:
                return self.respond({'error': str(error)}, 401 if isinstance(error, ExternalAuthenticationRequired) or '返回 401' in str(error) else 400)

        if self.path=='/api/status': return self.respond(runtime.status())
        if self.path=='/api/export':
            data={**runtime.status(),'scene':runtime.scene}
            return self.respond(data)
        if self.path.startswith('/api/'): return self.respond({'error':'接口不存在'},404)
        if urlparse(self.path).path == '/map-config.json' or self.path.startswith('/map-data/'):
            return self.map_resource()
        super().do_GET()
    def do_POST(self):
        if not self.safe() or self.headers.get('Content-Type','').split(';')[0]!='application/json':
            return self.respond({'error':'请求来源或格式无效'},403)
        try:
            size=int(self.headers.get('Content-Length',0))
            limit=128_000 if self.path.startswith('/api/external/') else 2_000_000
            if not 0<size<=limit: raise ValueError('请求大小无效')
            body=json.loads(self.rfile.read(size))
            if self.path=='/api/external/connect': result=external_bridge.connect(body)
            elif self.path=='/api/external/request': result=external_bridge.request(body)
            elif self.path=='/api/connect': result=runtime.connect(body)
            elif self.path=='/api/start': result=runtime.start(body)
            elif self.path=='/api/control': result=runtime.control(body['action'])
            elif self.path=='/api/verify': result=runtime.verify()
            else: return self.respond({'error':'接口不存在'},404)
            self.respond(result)
        except (ValueError,KeyError,TypeError) as error:
            self.respond({'error':str(error)},401 if self.path.startswith('/api/external/') and (isinstance(error, ExternalAuthenticationRequired) or '返回 401' in str(error)) else 400)
        except Exception:
            self.respond({'error':'操作失败，请检查模拟器服务配置'},500)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8766)
    parser.add_argument('--database',help='显式启用本机测试库的计划/区域配套；只新增 replay 批次')
    parser.add_argument('--container',default='deploy-db-1')
    parser.add_argument('--data-dir',default=str(ROOT/'.data'))
    parser.add_argument('--map-origin',default='http://localhost:5173',help='当前业务前台地图服务，只允许本机地址')
    args=parser.parse_args()
    origin=urlparse(args.map_origin)
    if origin.scheme not in ('http','https') or origin.hostname not in ('localhost','127.0.0.1','::1') or origin.username or origin.password or origin.path not in ('','/') or origin.query or origin.fragment:
        parser.error('地图服务必须是本机 HTTP/HTTPS origin')
    subprocess.run(['node',str(ROOT/'build-map.mjs')],cwd=ROOT.parents[1]/'dongying-vue',check=True)
    runtime=Runtime(args.data_dir,args.database,args.container,session=external_bridge)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    server.map_origin=args.map_origin.rstrip('/')
    print(f'设备 MQTT 模拟器 http://127.0.0.1:{args.port}/',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        runtime.cancel.set()
        if runtime.thread: runtime.thread.join(timeout=15)
        server.server_close()
