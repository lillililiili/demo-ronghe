"""Current system API registration and explicit local replay prerequisite seeding."""
import copy
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid
from engine import coordinates


def stable_device_identity(device_id, kind):
    """Return the simulator's long-lived external identity for one logical device.

    Batch IDs belong to scenarios and are intentionally used for targets, plans and
    evidence. Device registrations are different: the same logical simulator
    device must resolve to the same platform binding after a restart. The EO API
    limits external IDs to 32 characters, so the readable prefix is shortened with
    a deterministic hash when necessary.
    """
    raw_kind = re.sub(r'[^A-Za-z0-9_-]', '-', str(kind)).strip('-_') or 'device'
    raw_id = re.sub(r'[^A-Za-z0-9_-]', '-', str(device_id)).strip('-_') or 'device'
    candidate = f'map-sim-{raw_kind}-{raw_id}'
    limit = 32 if raw_kind == 'eo' else 56
    if len(candidate) <= limit:
        return candidate
    digest = hashlib.sha256(f'{kind}:{device_id}'.encode('utf-8')).hexdigest()[:8]
    return candidate[:limit - 9] + '-' + digest

class Platform:
    def __init__(self, base, token=None):
        parsed = urllib.parse.urlparse(base)
        if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.query:
            raise ValueError('本版仅接本机测试系统 API')
        self.base = base.rstrip('/')
        self.token = token
        self.on_unauthorized = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(self, method, path, body=None, key=None, *, timeout=12):
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        if method != 'GET':
            headers['Idempotency-Key'] = key or str(uuid.uuid4())
        req = urllib.request.Request(self.base+path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
        try:
            with self.http.open(req, timeout=timeout) as response:
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

    def _existing_device(self, body):
        """Find and validate a previously registered stable simulator device."""
        query = urllib.parse.urlencode({'page': 1, 'size': 100, 'keyword': body['device_no'], 'sort': 'device_no_asc'})
        page = self.call('GET', '/devices?' + query)
        matches = [item for item in page.get('items', []) if item.get('device_no') == body['device_no']]
        if not matches:
            return None
        if len(matches) > 1:
            raise ValueError('稳定设备编号出现重复记录：' + body['device_no'])
        device_id = matches[0].get('device_id')
        if not device_id:
            raise ValueError('稳定设备记录缺少平台设备 ID：' + body['device_no'])
        detail = self.call('GET', '/devices/' + urllib.parse.quote(str(device_id), safe=''))
        device = detail.get('device') or {}
        mismatches = []
        if detail.get('external_device_id') != body['external_device_id']:
            mismatches.append('external_device_id')
        if device.get('source_mode') != body['source_mode']:
            mismatches.append('source_mode')
        if detail.get('protocol_code') != body['protocol_code']:
            mismatches.append('protocol_code')
        if device.get('enabled') is False:
            mismatches.append('设备已停用')
        status = self.call('GET', '/devices/' + urllib.parse.quote(str(device_id), safe='') + '/protocol-status')
        details = status.get('details') or {}
        for key in ('broker_id', 'provider_code', 'external_device_id', 'edge_id', 'device_type_abbr'):
            expected = body.get(key)
            actual = details.get(key)
            if expected is not None and actual is not None and expected != actual:
                mismatches.append(key)
        if mismatches:
            raise ValueError('稳定设备身份冲突（' + body['device_no'] + '）：' + '、'.join(dict.fromkeys(mismatches)))
        mutable = ('name', 'vendor', 'model', 'longitude', 'latitude', 'altitude_m')
        changed = [key for key in mutable if device.get(key) is not None and device.get(key) != body.get(key)]
        if changed:
            version = device.get('version')
            if version is None:
                raise ValueError('稳定设备缺少版本，无法同步位置：' + body['device_no'])
            update = dict(body, version=version)
            sync_key = 'sim-sync-' + hashlib.sha256((body['external_device_id'] + ':' + str(version)).encode('utf-8')).hexdigest()[:24]
            detail = self.call('PUT', '/devices/' + urllib.parse.quote(str(device_id), safe=''), update, sync_key)
        detail['_reused'] = True
        return detail

    def _onboard_or_reuse(self, body, key):
        existing = self._existing_device(body)
        if existing is not None:
            return existing
        return self.call('POST', '/devices/onboard', body, key)

    def login(self, account, password):
        self.token = self.call('POST', '/auth/login', {'account': account, 'password': password})['session_id']
        self.me=self.call('GET', '/auth/me')
        return self.me

    def brokers(self):
        return [b for b in self.call('GET', '/mqtt-brokers') if b.get('source_mode')=='replay' and b.get('enabled')]

    def prepare_devices(self, devices, broker, manifest, checkpoint):
        for device_id, d in devices.items():
            external = stable_device_identity(device_id, d['kind'])
            lon, lat = coordinates([d['x'], d['y']])
            body = dict(protocol_code='EO_EDGE_MQTT_20250826' if d['kind']=='eo' else 'LINGYUN_MQTT_V8_6',
                        broker_id=broker['broker_id'], provider_code=manifest['provider'], external_device_id=external,
                        device_type_abbr=d['kind'], source_mode='replay', owner_org_id=broker['owner_org_id'],
                        district_id=broker['district_id'], device_no=external, name='模拟 '+d['name'],
                        vendor='地图场景模拟器', model='MQTT-SIM', longitude=lon, latitude=lat, altitude_m=0)
            if d['kind'] == 'eo':
                body['edge_id'] = external + '-edge'
            record = self._onboard_or_reuse(body, 'sim-onboard-'+external)
            manifest['devices'][device_id] = {'external_id': external, 'edge_id': body.get('edge_id'), 'platform_id': record['device']['device_id'], 'kind': d['kind']}
            if d['kind'] == 'eo':
                binding = self.call('GET', '/devices/' + record['device']['device_id'] + '/protocol-status')['details']
                if binding.get('edge_id') != body['edge_id'] or binding.get('external_device_id') != external:
                    raise ValueError('系统光电绑定身份不一致')
                for key in ('dispatcher_topic', 'reporting_topic'):
                    value = binding.get(key)
                    if not isinstance(value, str) or not value or any(c in value for c in ('+', '#', '\x00')):
                        raise ValueError('系统未提供有效光电主题')
                    manifest['devices'][device_id][key] = value
            checkpoint()

    def wait_for_subscriptions(self, manifest, broker, cancel, timeout=30):
        """Wait for the backend's SUBACK facts, before publishing even a heartbeat."""
        deadline = time.monotonic() + timeout
        pending = [d['external_id'] for d in manifest['devices'].values()]
        while not cancel.is_set():
            pending = []
            # Recheck every device each round: an earlier ready session may disconnect.
            for device in manifest['devices'].values():
                if cancel.is_set():
                    return False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError('后台 MQTT 订阅等待超时，未开始发送')
                status = self.call('GET', '/devices/' + device['platform_id'] + '/protocol-status',
                                   timeout=min(12, remaining))
                details = status.get('details') or {}
                if (status.get('device_id') != device['platform_id']
                        or status.get('source_mode') != 'replay'
                        or details.get('broker_id') != broker['broker_id']
                        or details.get('external_device_id') != device['external_id']):
                    raise ValueError('后台 MQTT 设备绑定不一致，未开始发送：' + device['external_id'])
                if not (details.get('connection_state') == 'CONNECTED'
                        and details.get('broker_enabled') is True
                        and details.get('subscribed') is True):
                    pending.append(device['external_id'])
            if cancel.is_set():
                return False
            if not pending and time.monotonic() < deadline:
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('后台 MQTT 订阅等待超时，未开始发送：' + '、'.join(pending))
            cancel.wait(min(.25, remaining))
        return False


def sql(value):
    return "'" + str(value).replace("'", "''") + "'"

class Prerequisites:
    """Only enabled by an explicit CLI database argument; never modifies existing rows."""
    def __init__(self, database, container='deploy-db-1', schema=None):
        if database and not re.fullmatch(r'[A-Za-z0-9_]{1,63}', database):
            raise ValueError('数据库名无效')
        if schema is not None:
            if not isinstance(schema, str) or not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', schema):
                raise ValueError('schema 名无效：仅支持小写字母或下划线开头的 1–63 位小写字母、数字、下划线')
            if not database:
                raise ValueError('--schema 必须同时指定 --database')
        self.database, self.container = database, container
        self.schema = schema

    def query(self, statement):
        if not self.database:
            raise ValueError('计划/区域尚未配套：请用 --database 指定当前本机测试库启动模拟器')
        command = ['docker', 'exec', '-i']
        if self.schema is not None:
            # Per-process only: never fall back to public business tables or load a psqlrc override.
            command += ['-e', 'PGOPTIONS=-c search_path=' + self.schema]
        command += [self.container, 'psql', '-U', 'uav', '-d', self.database, '-qAt', '-v', 'ON_ERROR_STOP=1']
        if self.schema is not None:
            command += ['-X']
        result = subprocess.run(command, input=statement, text=True, capture_output=True, timeout=20)
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
        # A drawn boundary alone does not establish a prohibited area.
        for zone in scene['zones']:
            if zone['id'] in zone_ids and zone.get('kindCode') not in (
                    'PROHIBITED', 'RESTRICTED', 'ALTITUDE_LIMIT', 'PERMITTED', 'TEMPORARY_CONTROL'):
                raise ValueError(zone['name']+'尚未选择空域类型，请在空域下发中选择后再模拟')
        # Prove the chosen API and seed database share the same broker identity before any write.
        if self.query('SELECT count(*) FROM mqtt_broker WHERE broker_id='+sql(broker['broker_id'])+" AND source_mode='replay' AND enabled=TRUE;") != '1':
            raise ValueError('测试库与当前 API 的 MQTT 连接不一致，已阻止写入')
        origin = dt.datetime.fromtimestamp(now/1000, dt.timezone(dt.timedelta(hours=8)))
        def moment(hhmm):
            h,m = map(int, hhmm.split(':'))
            return origin.replace(hour=h, minute=m, second=0, microsecond=0).timestamp()
        owner, district = sql(broker['owner_org_id']), sql(broker['district_id'])
        geometry_function = 'public.ST_GeomFromText' if self.schema is not None else 'ST_GeomFromText'
        statements = ['BEGIN;']
        for p in scene['plans']:
            if p['id'] not in plan_ids:
                continue
            rid, vid = str(uuid.uuid4()), str(uuid.uuid4())
            route_no = manifest['batch']+'-r'+str(len(manifest['plans'])+1)
            points = ','.join(f'{x} {y}' for x,y in map(coordinates,p['points']))
            statements += [f"INSERT INTO route(route_id,route_no,name,enabled,source_mode,owner_org_id,district_id,created_at,updated_at,version) VALUES ({sql(rid)},{sql(route_no)},{sql('模拟 '+p['name'])},TRUE,'replay',{owner},{district},now(),now(),0);",
                f"INSERT INTO route_version(route_version_id,route_id,version_no,centerline,corridor_width_m,min_altitude_m,max_altitude_m,altitude_datum,valid_from,change_reason,created_at) VALUES ({sql(vid)},{sql(rid)},1,{geometry_function}({sql('LINESTRING('+points+')')},4326),{p['width']},{p['min']},{p['max']},{sql(p.get('altitudeDatum', 'AMSL'))},to_timestamp({now/1000-86400}),'MQTT 地图模拟批次',now());"]
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
                f"INSERT INTO airspace_version(airspace_version_id,airspace_id,version_no,kind_code,boundary,min_altitude_m,max_altitude_m,altitude_datum,valid_from,valid_to,change_reason,created_at) VALUES ({sql(vid)},{sql(zid)},1,{sql(z['kindCode'])},{geometry_function}({sql('MULTIPOLYGON((('+points+')))')},4326),0,{z['max']},{sql(z.get('altitudeDatum', 'AMSL'))},to_timestamp({start}),to_timestamp({end}),'MQTT 地图模拟批次',now());"]
            manifest['zones'][z['id']] = {'id':zid,'version_id':vid}
        statements.append('COMMIT;')
        self.query('\n'.join(statements))
        original['plans']=manifest['plans']; original['zones']=manifest['zones']
