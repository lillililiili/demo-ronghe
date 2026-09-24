"""Current system API registration and explicit local replay prerequisite seeding."""
import copy
import datetime as dt
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
import urllib.parse
import uuid
from engine import coordinates

class Platform:
    def __init__(self, base, token=None):
        parsed = urllib.parse.urlparse(base)
        if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.query:
            raise ValueError('本版仅接本机测试系统 API')
        self.base = base.rstrip('/')
        self.token = token
        self.on_unauthorized = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method, path, body=None, key=None):
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if method != 'GET':
            headers['Idempotency-Key'] = key or str(uuid.uuid4())
        req = urllib.request.Request(self.base+path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            with self.http.open(req, timeout=12) as response:
                value = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 401 and self.on_unauthorized:
                self.on_unauthorized()
            try:
                message = json.load(error).get('error', {}).get('message', '')
            except Exception:
                message = ''
            raise ValueError(f'系统接口 {path} 返回 {error.code}：{message}') from None
        except (OSError, ValueError):
            raise ValueError('无法连接系统 API，请检查地址与服务状态') from None
        if not value.get('ok'):
            raise ValueError('系统接口未成功：' + path)
        return value.get('data')

    def login(self, account, password):
        self.token = self.call('POST', '/auth/login', {'account': account, 'password': password})['session_id']
        self.me=self.call('GET', '/auth/me')
        return self.me

    def brokers(self):
        return [b for b in self.call('GET', '/mqtt-brokers') if b.get('source_mode')=='replay' and b.get('enabled')]

    def prepare_devices(self, devices, broker, manifest, checkpoint):
        for index, (device_id, d) in enumerate(devices.items(), 1):
            external = manifest['batch'] + '-' + str(index)
            lon, lat = coordinates([d['x'], d['y']])
            body = dict(protocol_code='EO_EDGE_MQTT_20250826' if d['kind']=='eo' else 'LINGYUN_MQTT_V8_6',
                        broker_id=broker['broker_id'], provider_code=manifest['provider'], external_device_id=external,
                        device_type_abbr=d['kind'], source_mode='replay', owner_org_id=broker['owner_org_id'],
                        district_id=broker['district_id'], device_no=external, name='模拟 '+d['name'],
                        vendor='地图场景模拟器', model='MQTT-SIM', longitude=lon, latitude=lat, altitude_m=0)
            if d['kind'] == 'eo':
                body['edge_id'] = external + '-edge'
            record = self.call('POST', '/devices/onboard', body, 'sim-onboard-'+external)
            manifest['devices'][device_id] = {'external_id': external, 'edge_id': body.get('edge_id'), 'platform_id': record['device']['device_id'], 'kind': d['kind']}
            checkpoint()


def sql(value):
    return "'" + str(value).replace("'", "''") + "'"

class Prerequisites:
    """Only enabled by an explicit CLI database argument; never modifies existing rows."""
    def __init__(self, database, container='deploy-db-1'):
        if database and not re.fullmatch(r'[A-Za-z0-9_]{1,63}', database):
            raise ValueError('数据库名无效')
        self.database, self.container = database, container

    def query(self, statement):
        if not self.database:
            raise ValueError('计划/区域尚未配套：请用 --database 指定当前本机测试库启动模拟器')
        result = subprocess.run(['docker','exec','-i',self.container,'psql','-U','uav','-d',self.database,'-qAt','-v','ON_ERROR_STOP=1'], input=statement, text=True, capture_output=True, timeout=20)
        if result.returncode:
            raise ValueError('测试库配套失败：'+result.stderr.strip()[:600])
        return result.stdout.strip()

    def create(self, scene, targets, broker, manifest, now):
        original=manifest; manifest=copy.deepcopy(manifest)
        risks = [r for r in scene['risks'] if r.get('enabled')]
        plan_ids = {r.get('planId') for r in risks if r['type'] not in ('no-plan','offline','fault','zone')}
        plan_ids |= {t.get('planId') for t in targets.values() if not any(r['type']=='no-plan' and r.get('targetId')==t['id'] for r in risks)}
        plan_ids.discard(''); plan_ids.discard(None)
        zone_ids = {r.get('zoneId') for r in risks if r['type']=='zone' or r['type']=='height' and r.get('basis')!='plan'}
        if not plan_ids and not zone_ids:
            return
        # Prove the chosen API and seed database share the same broker identity before any write.
        if self.query('SELECT count(*) FROM mqtt_broker WHERE broker_id='+sql(broker['broker_id'])+" AND source_mode='replay' AND enabled=TRUE;") != '1':
            raise ValueError('测试库与当前 API 的 MQTT 连接不一致，已阻止写入')
        origin = dt.datetime.fromtimestamp(now/1000, dt.timezone(dt.timedelta(hours=8)))
        def moment(hhmm):
            h,m = map(int, hhmm.split(':'))
            return origin.replace(hour=h, minute=m, second=0, microsecond=0).timestamp()
        owner, district = sql(broker['owner_org_id']), sql(broker['district_id'])
        statements = ['BEGIN;']
        for p in scene['plans']:
            if p['id'] not in plan_ids:
                continue
            rid, vid = str(uuid.uuid4()), str(uuid.uuid4())
            route_no = manifest['batch']+'-r'+str(len(manifest['plans'])+1)
            points = ','.join(f'{x} {y}' for x,y in map(coordinates,p['points']))
            statements += [f"INSERT INTO route(route_id,route_no,name,enabled,source_mode,owner_org_id,district_id,created_at,updated_at,version) VALUES ({sql(rid)},{sql(route_no)},{sql('模拟 '+p['name'])},TRUE,'replay',{owner},{district},now(),now(),0);",
                f"INSERT INTO route_version(route_version_id,route_id,version_no,centerline,corridor_width_m,min_altitude_m,max_altitude_m,altitude_datum,valid_from,change_reason,created_at) VALUES ({sql(vid)},{sql(rid)},1,ST_GeomFromText({sql('LINESTRING('+points+')')},4326),{p['width']},{p['min']},{p['max']},{sql(p.get('altitudeDatum', 'AMSL'))},to_timestamp({now/1000-86400}),'MQTT 地图模拟批次',now());"]
            related = [t for t in targets.values() if t.get('planId')==p['id'] or any(r.get('targetId')==t['id'] and r.get('planId')==p['id'] for r in risks)]
            for t in related or [None]:
                pid = str(uuid.uuid4()); start, end = moment(p['start']), moment(p['end'])
                # Preserve user-specified plan times. Time risks require an actual out-of-window observation.
                for risk in scene['risks']:
                    if risk.get('enabled') and risk['type']=='time' and t and risk.get('targetId')==t['id'] and risk.get('planId')==p['id']:
                        span=end-start
                        if risk.get('mode')=='开始前提前飞行':
                            start=now/1000+float(risk['offset'])*60; end=start+span
                        else:
                            end=now/1000-float(risk['offset'])*60; start=end-span
                plan_no=manifest['batch']+'-p'+str(sum(len(v['ids']) for v in manifest['plans'].values())+1)
                serial = sql(manifest['targets'][t['id']]['uav_sn']) if t and t['kind']=='uav' else 'NULL'
                statements.append(f"INSERT INTO flight_plan(plan_id,plan_no,status_code,source_mode,uav_sn,start_at,end_at,route_version_id,owner_org_id,district_id,created_at,updated_at,version) VALUES ({sql(pid)},{sql(plan_no)},'EXECUTING','replay',{serial},to_timestamp({start}),to_timestamp({end}),{sql(vid)},{owner},{district},now(),now(),0);")
                manifest['plans'].setdefault(p['id'], {'route_id':rid,'route_version_id':vid,'ids':[]})['ids'].append(pid)
        for z in scene['zones']:
            if z['id'] not in zone_ids:
                continue
            zid, vid = str(uuid.uuid4()), str(uuid.uuid4())
            ring = [coordinates(p) for p in z['points']]
            if ring[0] != ring[-1]: ring.append(ring[0])
            points = ','.join(f'{x} {y}' for x,y in ring)
            start, end = moment(z['start']), moment(z['end'])
            statements += [f"INSERT INTO airspace(airspace_id,airspace_no,name,source_mode,owner_org_id,district_id,created_at,updated_at,version) VALUES ({sql(zid)},{sql(manifest['batch']+'-a'+str(len(manifest['zones'])+1))},{sql('模拟 '+z['name'])},'replay',{owner},{district},now(),now(),0);",
                f"INSERT INTO airspace_version(airspace_version_id,airspace_id,version_no,kind_code,boundary,min_altitude_m,max_altitude_m,altitude_datum,valid_from,valid_to,change_reason,created_at) VALUES ({sql(vid)},{sql(zid)},1,'PROHIBITED',ST_GeomFromText({sql('MULTIPOLYGON((('+points+')))')},4326),0,{z['max']},{sql(z.get('altitudeDatum', 'AMSL'))},to_timestamp({start}),to_timestamp({end}),'MQTT 地图模拟批次',now());"]
            manifest['zones'][z['id']] = {'id':zid,'version_id':vid}
        statements.append('COMMIT;')
        self.query('\n'.join(statements))
        original['plans']=manifest['plans']; original['zones']=manifest['zones']
