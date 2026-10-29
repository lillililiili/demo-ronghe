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
from engine import coordinates, device_altitude, zone_polygon_rings
from coverage_defaults import default_coverage
from engine import normalize_coverage_config

# 本机回放 MQTT 连接的名称；旧库里仍可能叫旧名，两者都认。
REPLAY_BROKER_NAMES = ('local-sim-replay', 'local-lingyun-replay')


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


SIMULATOR_VENDOR = '地图场景模拟器'
SIMULATOR_MODEL = 'MQTT-SIM'
# 2026-10-05 以前每批按“批次号-序号”登记一套设备，例如 sim-1004093015-a1b2-3。
LEGACY_BATCH_DEVICE_NO = re.compile(r'sim-\d{10}-[0-9a-f]{4}-\d{1,4}')
LEGACY_RETIRE_REASON = '清理旧版模拟器按批次登记的设备'


def legacy_batch_device(item):
    """Tell whether a device list row is an old per-batch simulator registration.

    Only rows that match every simulator registration fact qualify: the batch
    numbered device_no, the simulator vendor/model and replay source. Stable
    map-sim-* devices and anything entered by people never match.
    """
    return (isinstance(item, dict)
            and bool(LEGACY_BATCH_DEVICE_NO.fullmatch(str(item.get('device_no') or '')))
            and item.get('vendor') == SIMULATOR_VENDOR and item.get('model') == SIMULATOR_MODEL
            and item.get('source_mode') == 'replay' and item.get('simulated') is True
            and bool(item.get('device_id')))

# 2026-10-14 用户确认方案 A：启动时把本场景要用、但以前被退役或停用的模拟设备恢复成同一条记录。
RESTORE_REASON = '设备模拟器启动：恢复本场景要用的模拟设备（同一条设备记录，历史保留）'


class PlatformError(ValueError):
    """A refused API call that keeps the platform's HTTP status and error code.

    It stays a ValueError with the same text as before, so existing callers and
    the operator-facing message are unchanged; only callers that must branch on
    the platform's answer (restore, busy devices) read ``status`` and ``code``.
    """
    def __init__(self, text, status=None, code=None, detail=''):
        super().__init__(text)
        self.status, self.code, self.detail = status, code, detail


class Platform:
    def __init__(self, base, token=None):
        parsed = urllib.parse.urlparse(base)
        if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.query:
            raise ValueError('本版仅接本机测试系统 API')
        self.base = base.rstrip('/')
        self.token = token
        self.on_unauthorized = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def binary(self, path):
        # Only fixed evidence preview paths from validated frozen membership reach this method.
        if not re.fullmatch(r'/evidence-files/[A-Za-z0-9_-]{1,100}/preview', path):
            raise ValueError('证据路径无效')
        req = urllib.request.Request(self.base + path, headers={'Authorization': 'Bearer ' + (self.token or '')})
        try:
            with self.http.open(req, timeout=20) as response:
                content = response.read(32 * 1024 * 1024 + 1)
                if len(content) > 32 * 1024 * 1024: raise ValueError('证据超过预览容量')
                return content, response.headers.get('Content-Type', 'application/octet-stream')
        except urllib.error.HTTPError as error:
            if error.code == 401 and self.on_unauthorized: self.on_unauthorized()
            raise ValueError(f'证据原件返回 {error.code}，请在平台核对权限、留存和文件状态') from None
        except OSError:
            raise ValueError('证据原件暂时无法读取') from None

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
                problem = json.load(error).get('error') or {}
            except Exception:
                problem = {}
            message = str(problem.get('message') or '') if isinstance(problem, dict) else ''
            code = problem.get('code') if isinstance(problem, dict) else None
            raise PlatformError(f'系统接口 {path} 返回 {error.code}：{message}', error.code, code, message) from None
        except urllib.error.URLError as error:
            category = '请求超时' if isinstance(error.reason, TimeoutError) else '连接失败'
            raise ValueError(f'系统接口 {path} {category}，请检查服务状态') from None
        except TimeoutError:
            raise ValueError(f'系统接口 {path} 请求超时（{timeout}秒），请检查服务状态') from None
        except OSError:
            raise ValueError(f'系统接口 {path} 连接中断，请检查服务状态') from None
        except ValueError:
            raise ValueError(f'系统接口 {path} 返回无效 JSON，请检查服务状态') from None
        if not value.get('ok'):
            raise ValueError('系统接口未成功：' + path)
        return value.get('data')

    def _restore(self, body):
        """Ask the platform to bring back this simulator's own retired or switched-off device.

        The platform restores only replay devices it recorded as simulated, and only
        when every identity field below matches the existing binding; real devices
        are refused. Returns None when the platform has no device with this number
        (a new registration follows) or is an older version without restore.
        """
        request = {key: body.get(key) for key in ('device_no', 'broker_id', 'protocol_code',
                                                  'external_device_id', 'source_mode')}
        if body.get('protocol_code') == 'EO_EDGE_MQTT_20250826':
            request['edge_id'] = body.get('edge_id')
        else:
            request.update(provider_code=body.get('provider_code'), device_type_abbr=body.get('device_type_abbr'))
        request['reason'] = RESTORE_REASON
        try:
            return self.call('POST', '/devices/restore-simulated', request)
        except PlatformError as error:
            if error.status in (404, 405):
                return None
            raise ValueError('模拟设备 ' + body['device_no'] + ' 没能恢复：' + (error.detail or str(error))) from None

    def _existing_device(self, body, restored=None):
        """Find and validate a previously registered stable simulator device.

        A device this simulator registered earlier and the platform later retired
        or switched off is restored first (same record, history kept), then
        validated like any other existing registration.
        """
        query = urllib.parse.urlencode({'page': 1, 'size': 100, 'keyword': body['device_no'], 'sort': 'device_no_asc'})
        page = self.call('GET', '/devices?' + query)
        matches = [item for item in page.get('items', []) if item.get('device_no') == body['device_no']]
        if not matches:
            if restored is None and self._restore(body) is not None:
                return self._existing_device(body, 'retired')
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
        for scope_key in ('owner_org_id', 'district_id'):
            if device.get(scope_key) != body.get(scope_key):
                mismatches.append(scope_key)
        if detail.get('protocol_code') != body['protocol_code']:
            mismatches.append('protocol_code')
        status = self.call('GET', '/devices/' + urllib.parse.quote(str(device_id), safe='') + '/protocol-status')
        details = status.get('details') or {}
        for key in ('broker_id', 'provider_code', 'external_device_id', 'edge_id', 'device_type_abbr'):
            expected = body.get(key)
            actual = details.get(key)
            if expected is not None and actual is not None and expected != actual:
                mismatches.append(key)
        if device.get('enabled') is False:
            # Only an identity that already matches is switched back on.
            if not mismatches and restored is None and self._restore(body) is not None:
                return self._existing_device(body, 'disabled')
            mismatches.append('设备已停用')
        if mismatches:
            raise ValueError('稳定设备身份冲突（' + body['device_no'] + '）：' + '、'.join(dict.fromkeys(mismatches)))
        mutable = ('name', 'vendor', 'model', 'longitude', 'latitude')
        changed = [key for key in mutable if device.get(key) is not None and device.get(key) != body.get(key)]
        if changed:
            version = device.get('version')
            if version is None:
                raise ValueError('稳定设备缺少版本，无法同步位置：' + body['device_no'])
            update = dict(body, version=version)
            sync_key = 'sim-sync-' + hashlib.sha256((body['external_device_id'] + ':' + str(version)).encode('utf-8')).hexdigest()[:24]
            detail = self.call('PUT', '/devices/' + urllib.parse.quote(str(device_id), safe=''), update, sync_key)
        detail['_reused'] = True
        if restored:
            detail['_restored'] = restored
        return detail

    def _onboard_or_reuse(self, body, key):
        existing = self._existing_device(body)
        if existing is not None:
            return existing
        return self.call('POST', '/devices/onboard', body, key)

    @staticmethod
    def _sensing_profile_payload(coverage):
        config = normalize_coverage_config(coverage)
        if config is None:
            return None
        if config['kind'] == 'circle':
            return {'coverage_kind': 'CIRCLE', 'radius_m': config['radiusM'],
                    'range_m': None, 'azimuth_deg': None, 'fov_deg': None,
                    'source_label': config['sourceLabel']}
        return {'coverage_kind': 'SECTOR', 'radius_m': None,
                'range_m': config['rangeM'], 'azimuth_deg': config['azimuthDeg'],
                'fov_deg': config['fovDeg'], 'source_label': config['sourceLabel']}

    @staticmethod
    def _sensing_profile_matches(current, desired):
        current = current or {}
        return all(current.get(key) == value for key, value in desired.items())

    def _sync_sensing_profile(self, record, coverage, external):
        """Reconcile an explicitly declared static profile; omitted profiles stay untouched."""
        desired = self._sensing_profile_payload(coverage)
        if desired is None:
            return record
        device = record.get('device') or {}
        current = device.get('coverage') or {}
        current_values = {
            'coverage_kind': str(current.get('kind') or current.get('coverage_kind') or '').upper() or None,
            'radius_m': current.get('radius_m', current.get('radiusM')),
            'range_m': current.get('range_m', current.get('rangeM')),
            'azimuth_deg': current.get('azimuth_deg', current.get('azimuthDeg')),
            'fov_deg': current.get('fov_deg', current.get('fovDeg')),
            'source_label': current.get('source_label', current.get('sourceLabel')),
        }
        if self._sensing_profile_matches(current_values, desired):
            return record
        version = current.get('version')
        expected_version = 0 if version is None else int(version)
        payload = dict(desired, expected_version=expected_version)
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()[:24]
        return self.call('PUT', '/devices/' + urllib.parse.quote(str(device['device_id']), safe='') + '/sensing-profile',
                         payload, 'sim-sensing-' + external + '-' + digest)

    def sync_simulated_range(self, device_id, kind, coverage=None):
        """Independent native simulators use the same persisted range as scene devices."""
        explicit = coverage is not None
        desired = normalize_coverage_config(coverage) if explicit else default_coverage(kind)
        if desired is None:
            raise ValueError('模拟设备类型没有默认范围')
        record = self.call('GET', '/devices/' + urllib.parse.quote(str(device_id), safe=''))
        device = record.get('device') or {}
        expected = {'countermeasure': 'COUNTERMEASURE', 'radar': 'RADAR'}
        if (device.get('device_id') != device_id or device.get('simulated') is not True
                or device.get('source_mode') not in ('live', 'replay')
                or str(device.get('device_type_code') or '').upper() != expected.get(kind)):
            raise ValueError('设备身份或模拟来源不一致，不能同步模拟范围')
        # A scene declaration wins for verified simulated devices; defaults only fill missing profiles.
        current = device.get('coverage') or {}
        if not explicit and current.get('kind'):
            return record
        return self._sync_sensing_profile(record, desired, str(device_id))

    def login(self, account, password):
        self.token = self.call('POST', '/auth/login', {'account': account, 'password': password})['session_id']
        self.me=self.call('GET', '/auth/me')
        return self.me

    def brokers(self):
        return [b for b in self.call('GET', '/mqtt-brokers') if b.get('source_mode')=='replay' and b.get('enabled')]

    def legacy_batch_devices(self):
        """Read every old per-batch simulator device still in the device catalog."""
        found, page = [], 1
        while True:
            query = urllib.parse.urlencode({'page': page, 'size': 100, 'keyword': 'sim-', 'vendor': SIMULATOR_VENDOR,
                                            'sort': 'device_no_asc'})
            data = self.call('GET', '/devices?' + query) or {}
            items = data.get('items') or []
            found.extend(item for item in items if legacy_batch_device(item))
            if not items or page * 100 >= int(data.get('total') or 0):
                return found
            page += 1

    def retire_legacy_batch_devices(self, apply=False):
        """Disable and then delete old per-batch simulator devices through the device API.

        Without ``apply`` nothing is changed and only the matching rows are listed.
        Each device goes through the normal disable and delete endpoints, so the
        platform keeps its own authorization, version checks and audit records.
        One failed device is reported and the rest continue.
        """
        devices = self.legacy_batch_devices()
        result = {'found': [{'device_id': d['device_id'], 'device_no': d['device_no'], 'name': d.get('name'),
                             'enabled': d.get('enabled'), 'connectivity': d.get('connectivity')} for d in devices],
                  'retired': [], 'failed': []}
        if not apply:
            return result
        for item in devices:
            path = '/devices/' + urllib.parse.quote(str(item['device_id']), safe='')
            try:
                version = item.get('version')
                if item.get('enabled'):
                    detail = self.call('PATCH', path + '/enabled',
                                       {'enabled': False, 'version': version, 'reason': LEGACY_RETIRE_REASON},
                                       'sim-retire-off-' + str(item['device_id']) + '-' + str(version))
                    version = ((detail or {}).get('device') or {}).get('version')
                    if version is None:
                        raise ValueError('停用后未取得设备版本')
                self.call('DELETE', path, {'version': version, 'reason': LEGACY_RETIRE_REASON},
                          'sim-retire-del-' + str(item['device_id']) + '-' + str(version))
                result['retired'].append(item['device_no'])
            except ValueError as error:
                result['failed'].append({'device_no': item['device_no'], 'error': str(error)})
        return result

    def sync_elevation(self, device_id, d):
        """像接入人员一样填地面海拔和架设高度；架设高度没填就两项都不填，平台显示「未填写」。"""
        body = {} if d.get('mountHeightM') is None else {
            'ground_elevation_m': d['groundElevationM'], 'mount_height_m': d['mountHeightM']}
        self.call('PUT', '/devices/' + urllib.parse.quote(str(device_id), safe='') + '/elevation', body)

    def prepare_devices(self, devices, broker, manifest, checkpoint):
        from coordinate_contract import simulator_wgs84
        for device_id, d in devices.items():
            external = stable_device_identity(device_id, d['kind'])
            lon, lat = coordinates([d['x'], d['y']])
            body = dict(protocol_code='EO_EDGE_MQTT_20250826' if d['kind']=='eo' else 'LINGYUN_MQTT_V8_6',
                        broker_id=broker['broker_id'], provider_code=manifest['provider'], external_device_id=external,
                        device_type_abbr=d['kind'], source_mode='replay', owner_org_id=broker['owner_org_id'],
                        district_id=broker['district_id'], device_no=external, name='模拟 '+d['name'],
                        vendor=SIMULATOR_VENDOR, model=SIMULATOR_MODEL, longitude=lon, latitude=lat, coordinate_system=simulator_wgs84(d))
            if d['kind'] == 'eo':
                body['edge_id'] = external + '-edge'
            record = self._onboard_or_reuse(body, 'sim-onboard-'+external)
            if record.get('_restored'):
                manifest.setdefault('devices_restored', []).append(
                    {'device_no': external, 'name': body['name'], 'before': record['_restored']})
            record = self._sync_sensing_profile(record, d.get('coverage'), external)
            self.sync_elevation(record['device']['device_id'], d)
            # source_id 供设备开始、恢复上报时报健康状态用（device_health.py）。
            manifest['devices'][device_id] = {'external_id': external, 'edge_id': body.get('edge_id'), 'platform_id': record['device']['device_id'],
                                              'kind': d['kind'], 'source_id': record.get('source_id'),
                                              'longitude': lon, 'latitude': lat, 'altitude_m': device_altitude(d), 'altitude_datum': 'AMSL',
                                              'coverage': copy.deepcopy(d.get('coverage') or default_coverage(d['kind'])),
                                              'fusion_device_id': record['device'].get('fusion_device_id')}
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

        if devices and broker.get('source_mode') == 'replay':
            # Registration must finish before retiring anything. The new IDs are
            # from this API, never recovered from a previous database's manifest.
            from catalog_reconciliation import plan, apply
            # Normalized sources belong to fusion ingestion, not the ops/MQTT
            # catalog. Keep them in the manifest for observation and readback.
            current_catalog = {key: member for key, member in manifest['devices'].items()
                               if member.get('kind') != 'normalized'}
            preview = plan(self, broker, current_catalog)
            manifest['device_catalog_reconciliation'] = apply(self, preview)
            checkpoint()

    def wait_for_subscriptions(self, manifest, broker, cancel, timeout=30):
        """Wait for the backend's SUBACK facts, before publishing even a heartbeat."""
        deadline = time.monotonic() + timeout
        # Normalized fusion sources are stage-2 source/device IDs, not ops_device
        # MQTT registrations, so they have no protocol-status or subscription.
        pending = [d['external_id'] for d in manifest['devices'].values()
                   if d.get('kind') != 'normalized']
        while not cancel.is_set():
            pending = []
            # Recheck every device each round: an earlier ready session may disconnect.
            for device in manifest['devices'].values():
                if device.get('kind') == 'normalized':
                    continue
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
            raise ValueError('任务/区域尚未配套：请用 --database 指定当前本机测试库启动模拟器')
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
        zone_rings = {zone['id']: zone_polygon_rings(zone) for zone in scene['zones']
                      if zone['id'] in zone_ids}
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
                if end <= start: end += 86400  # 跨夜的任务：结束落在次日
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
            rings = ','.join('(' + ','.join(f'{x} {y}' for x, y in map(coordinates, ring)) + ')'
                             for ring in zone_rings[z['id']])
            start, end = moment(z['start']), moment(z['end'])
            statements += [f"INSERT INTO airspace(airspace_id,airspace_no,name,source_mode,owner_org_id,district_id,created_at,updated_at,version) VALUES ({sql(zid)},{sql(manifest['batch']+'-a'+str(len(manifest['zones'])+1))},{sql('模拟 '+z['name'])},'replay',{owner},{district},now(),now(),0);",
                f"INSERT INTO airspace_version(airspace_version_id,airspace_id,version_no,kind_code,boundary,min_altitude_m,max_altitude_m,altitude_datum,valid_from,valid_to,change_reason,created_at) VALUES ({sql(vid)},{sql(zid)},1,{sql(z['kindCode'])},{geometry_function}({sql('MULTIPOLYGON(('+rings+'))')},4326),0,{z['max']},{sql(z.get('altitudeDatum', 'AMSL'))},to_timestamp({start}),to_timestamp({end}),'MQTT 地图模拟批次',now());"]
            manifest['zones'][z['id']] = {'id':zid,'version_id':vid}
        statements.append('COMMIT;')
        self.query('\n'.join(statements))
        original['plans']=manifest['plans']; original['zones']=manifest['zones']
