"""Prepare related facts through authorized APIs and publish normalized observations."""
import copy
import datetime as dt
import hashlib
import json
import math
import re
import time
from engine import coordinates, TARGET_REPORT_KINDS
from prerequisite_check import route_version_mismatch

PREFIX = '/local-interface-simulator'
CLASSES = {'uav':'UAV','bird':'BIRD','unknown':'UNKNOWN','identifying':None,'balloon':'UNKNOWN',
           'person':'PERSON','vehicle':'VEHICLE','ship':'SHIP','remote_controller':'REMOTE_CONTROLLER'}
SHANGHAI = dt.timezone(dt.timedelta(hours=8), name='Asia/Shanghai')


def stable_airspace_no(zone_id):
    """Return the simulator's logical identity for one editable zone.

    Batch IDs identify a run and are intentionally used for targets and plans.
    An airspace is a reusable business object, though, so putting the batch ID
    into its number made every run create another identical card.  Keep the
    number readable for normal scene IDs and hash only the overlong tail.
    """
    raw = re.sub(r'[^A-Za-z0-9_-]', '-', str(zone_id)).strip('-_') or 'zone'
    prefix = 'sim-map-airspace-'
    value = prefix + raw
    if len(value) <= 64:
        return value
    digest = hashlib.sha256(str(zone_id).encode('utf-8')).hexdigest()[:10]
    return value[:64 - len(digest) - 1] + '-' + digest


def airspace_effective_at(delivery):
    """Return the time the platform orders a source's airspace deliveries by.

    An UPSERT counts from its valid_from, a WITHDRAW from its effective_at.  The
    next delivery for the same airspace must take effect strictly later, or the
    platform rejects it with 409 VERSION_OVERLAP.
    """
    delivery = delivery or {}
    payload = delivery.get('payload') or {}
    value = payload.get('effective_at' if delivery.get('action') == 'WITHDRAW' else 'valid_from')
    return int(value) if type(value) in (int, float) else None


def stable_simulator_id(prefix, value):
    """Build a readable, bounded identity for reusable simulator facts."""
    raw = re.sub(r'[^A-Za-z0-9_-]', '-', str(value)).strip('-_') or 'item'
    candidate = prefix + raw
    if len(candidate) <= 64:
        return candidate
    digest = hashlib.sha256(str(value).encode('utf-8')).hexdigest()[:10]
    return candidate[:64 - len(digest) - 1] + '-' + digest


def canonical_payload(value):
    """Return the stable JSON form used to compare replay request bodies."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


# Same values as the simulator's task form sample (web/external-contract.js).
SIMULATED_PILOT = {'pilot_name': '模拟飞手', 'pilot_phone': '13800000000'}
SIMULATED_REPORTING_UNIT = {'reporting_org_code': 'SIM-REPORTING-UNIT', 'reporting_org_name': '模拟报送单位'}


def payload_fingerprint(value):
    """Return a short deterministic suffix for a changed simulator payload."""
    return hashlib.sha256(canonical_payload(value).encode('utf-8')).hexdigest()[:12]


def payload_without_message_id(body):
    return {key: value for key, value in body.items() if key != 'message_id'}


def plan_identity(body):
    """Submission identity excludes transport IDs and derived lifecycle state."""
    identity = payload_without_message_id(body)
    if identity.get('status_code', 'PENDING') in ('PENDING', 'EXECUTING', 'COMPLETED'):
        identity.pop('status_code', None)
    return identity


def route_covers_window(route, start, finish):
    """Tell whether an existing route version is valid for the new plan window."""
    if not isinstance(route, dict):
        return False
    try:
        valid_from = route.get('valid_from')
        valid_to = route.get('valid_to')
        if valid_from is not None and int(valid_from) > int(start):
            return False
        if valid_to is not None and int(valid_to) < int(finish):
            return False
    except (TypeError, ValueError):
        return False
    return True


def message_matches_payload(message, body):
    """Compare an existing input when the API returned its original payload."""
    payload = message.get('payload') if isinstance(message, dict) else None
    # Older test doubles and older platform responses did not expose payload;
    # keep their established reuse behavior while using strict comparison for
    # the current API response.
    return not isinstance(payload, dict) or canonical_payload(plan_identity(payload)) == canonical_payload(plan_identity(body))


def input_message_id(message):
    # The API's outer message_id is its receipt ID. The caller's stable
    # submission identity remains inside the saved payload.
    payload = message.get('payload')
    return payload.get('message_id') if isinstance(payload, dict) else message.get('message_id')


def stable_uav_sn(target_id, declared=None):
    """Keep a logical UAV serial stable while target observations stay batch-scoped."""
    if declared:
        return str(declared)
    return stable_simulator_id('map-sim-uav-', target_id)


def plan_window(plan, now):
    """Convert a scene's Asia/Shanghai HH:mm window to epoch milliseconds."""
    try:
        start_time = dt.time.fromisoformat(str(plan['start']) + ':00')
        end_time = dt.time.fromisoformat(str(plan['end']) + ':00')
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError('任务时间格式须为 HH:mm') from error
    local = dt.datetime.fromtimestamp(now / 1000, tz=SHANGHAI)
    start = dt.datetime.combine(local.date(), start_time, SHANGHAI)
    end = dt.datetime.combine(local.date(), end_time, SHANGHAI)
    if end <= start:
        end += dt.timedelta(days=1)
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)
    duration = end_ms - start_ms
    if plan.get('timeMode') == 'past':
        while end_ms >= now:
            start_ms -= 86400000
            end_ms -= 86400000
        # Unit fixtures can use a 1970 epoch, before a positive API timestamp.
        if end_ms <= 1:
            end_ms = max(2, now - 60000)
            start_ms = max(1, end_ms - max(duration, 60000))
    start_ms = max(1, start_ms)
    if end_ms <= start_ms:
        end_ms = start_ms + max(duration, 60000)
    return start_ms, end_ms


def plan_status(start, end, now):
    if end <= now:
        return 'COMPLETED'
    if start > now:
        return 'PENDING'
    return 'EXECUTING'


def flight_window(plan, target, risks, now):
    """Shift only the selected UAV's window, preserving the planned duration."""
    start, finish = plan_window(plan, now)
    matches = [risk for risk in risks if risk.get('enabled') and risk.get('type') == 'time'
               and target is not None and risk.get('targetId') == target['id']
               and risk.get('planId') == plan['id']]
    windows = set()
    for risk in matches:
        offset = risk.get('offset')
        if type(offset) not in (int, float) or not math.isfinite(offset) or not 1 <= offset <= 1440:
            raise ValueError('超出时长须为 1 至 1440 分钟')
        delta = round(offset * 60000)
        duration = finish - start
        if risk.get('mode') == '开始前提前飞行':
            shifted_start = now + delta
            windows.add((shifted_start, shifted_start + duration))
        elif risk.get('mode') == '结束后继续飞行':
            shifted_finish = now - delta
            windows.add((shifted_finish - duration, shifted_finish))
        else:
            raise ValueError('时间场景无效')
    if len(windows) > 1:
        raise ValueError('同一目标与任务存在冲突的时间场景，请保留一种时间设置')
    result = next(iter(windows)) if windows else (start, finish)
    if result[0] <= 0:
        raise ValueError('偏移后的任务时间无效，请检查场景时间')
    return result


class FullChain:
    def __init__(self, platform, scene, manifest, broker, checkpoint, clock=None, cancelled=None):
        self.api, self.scene, self.manifest = platform, scene, manifest
        self.scope = {k:broker[k] for k in ('owner_org_id','district_id')}
        self.checkpoint = checkpoint
        self.clock = clock or (lambda: int(time.time()*1000))
        self.cancelled = cancelled or (lambda: False)
        self.state = manifest.setdefault('fullchain', {'requests':{},'coverage':{},'warnings':[]})
        self.next_weather = 0
        self.pending = {}
        self._airspaces = None
        self._inputs = None
        self._route_records = {}
        self.weather = copy.deepcopy(scene.get('fullchain',{}).get('weather',{}))
        self.observation_source_count = scene.get('fullchain',{}).get('observationSourceCount',1)
        if type(self.observation_source_count) is not int or not 1 <= self.observation_source_count <= 3:
            raise ValueError('标准化模拟观测来源数量须为 1 至 3 的整数')

    def existing_airspaces(self):
        """Read the source's latest receipts once so repeated runs can reuse IDs."""
        if self._airspaces is None:
            context = self.api.call('GET', PREFIX + '/airspaces/context') or {}
            items = context.get('items') or []
            found = {}
            for item in items:
                number = item.get('airspace_no')
                if not number:
                    continue
                if number in found:
                    raise ValueError('模拟空域编号出现重复记录：' + number)
                found[number] = item
            self._airspaces = found
        return self._airspaces

    def existing_inputs(self):
        """Read reusable routes and plan messages once for this preparation."""
        if self._inputs is None:
            context = self.api.call('GET', PREFIX + '/context') or {}
            routes = {}
            for route in context.get('routes') or []:
                number = route.get('route_no')
                if number:
                    if number in routes:
                        raise ValueError('模拟航线编号出现重复记录：' + number)
                    routes[number] = route
            plans = {}
            for message in context.get('messages') or []:
                identity = input_message_id(message)
                if message.get('kind') != 'FLIGHT_PLAN' or not identity:
                    continue
                if identity in plans:
                    raise ValueError('模拟任务消息编号出现重复记录：' + message['message_id'])
                plans[identity] = message
            self._inputs = {'routes': routes, 'plans': plans}
        return self._inputs

    def route_record(self, route_message):
        """Read one reusable route and cache the lookup for this preparation."""
        if route_message in self._route_records:
            return self._route_records[route_message]
        existing = self.existing_inputs()['routes'].get(route_message)
        if existing:
            self._route_records[route_message] = existing
            return existing
        page = self.api.call('GET', '/routes?source_mode=replay&keyword=' + route_message + '&page=1&size=100') or {}
        matches = [row for row in page.get('items') or [] if row.get('route_no') == route_message]
        if len(matches) > 1:
            raise ValueError('稳定模拟航线编号出现重复记录：' + route_message)
        if not matches:
            return None
        route = dict(matches[0])
        versions = self.api.call('GET', '/routes/' + str(route['route_id']) + '/versions?page=1&size=100') or {}
        version_items = versions.get('items') or []
        if not version_items or not version_items[0].get('route_version_id'):
            raise ValueError('稳定模拟航线缺少版本编号：' + route_message)
        version = version_items[0]
        route['route_version_id'] = version['route_version_id']
        # The route list is not validity-aware; carry the selected version's
        # window so an expired route cannot be reused for a current plan.
        for field in ('valid_from', 'valid_to'):
            if field in version:
                route[field] = version[field]
        self.existing_inputs()['routes'][route_message] = route
        self._route_records[route_message] = route
        return route

    def route_matches(self, route, plan):
        """Tell whether a reusable route still carries this scene task's own corridor."""
        version = self.api.call('GET', '/route-versions/' + str(route.get('route_version_id'))) or {}
        return route_version_mismatch(version, plan) is None

    def stable_route(self, plan, start, finish):
        """Pick this task's stable route message and the route to reuse, or None to create it.

        Different scenes may use the same task ID with different corridors (新-26). A saved route is reused
        only when its version carries this task's own corridor; otherwise readback would reject it, so the
        corridor gets a stable route of its own, numbered by its content and reused by later runs.
        """
        corridor = payload_fingerprint({
            'points': [coordinates(p) for p in plan['points']], 'width': plan['width'],
            'min': plan['min'], 'max': plan['max'], 'datum': plan.get('altitudeDatum', 'AMSL')})
        for route_key in (plan['id'], plan['id'] + '-' + corridor):
            base_message = stable_simulator_id('sim-map-route-', route_key)
            base = self.route_record(base_message)
            if base is None:
                return base_message, None
            if not self.route_matches(base, plan):
                continue
            if route_covers_window(base, start, finish):
                return base_message, base
            window_message = stable_simulator_id('sim-map-route-', f"{route_key}-{start}-{finish}")
            window = self.reusable_route(window_message, start, finish)
            if window is None or self.route_matches(window, plan):
                return window_message, window
        raise ValueError('稳定模拟航线内容与场景不一致：' + plan['id'])

    def reusable_route(self, route_message, start=None, finish=None):
        """Find a route version whose validity covers the new plan window."""
        route = self.route_record(route_message)
        if route is None or (start is not None and not route_covers_window(route, start, finish)):
            return None
        return route

    def request(self, key, path, body):
        if self.cancelled(): raise ValueError('全量准备已停止，已提交资料保留')
        rows=self.state['requests']
        if key not in rows:
            rows[key]={'path':path,'body':copy.deepcopy(body),'state':'PENDING'}
            self.checkpoint()  # Freeze message identity and payload before network writes.
        row=rows[key]
        if row['state']=='ACCEPTED': return copy.deepcopy(row['result'])
        if row['state']=='UNKNOWN':
            context=self.api.call('GET',PREFIX+'/context') or {}
            matches=[m for m in context.get('messages',[]) if input_message_id(m)==row['body']['message_id']
                     and isinstance(m.get('payload'),dict) and canonical_payload(m['payload'])==canonical_payload(row['body'])
                     and m.get('state')=='ACCEPTED']
            if len(matches)!=1:
                raise ValueError('上次资料提交结果未知，回读未确认；已阻止重复提交，请核对消息 '+row['body']['message_id'])
            row.update(state='ACCEPTED',result=copy.deepcopy(matches[0]),recovered_by_readback=True)
            row.pop('error',None);self.checkpoint()
            return copy.deepcopy(row['result'])
        try:
            result=self.api.call('POST',row['path'],row['body'],row['body']['message_id'])
        except Exception as error:
            row.update(state='UNKNOWN',error=str(error));self.checkpoint();raise
        row.update(state='ACCEPTED',result=copy.deepcopy(result));row.pop('error',None)
        self.state['coverage'][key]={'label':body.get('name') or body.get('reason_text') or key,
                                    'submitted':1,'accepted':1,'processed':None,'last_at':self.clock(),
                                    'related':{k:v for k,v in (result or {}).items() if k.endswith('_id')}}
        self.checkpoint()
        return result

    def message(self, key):
        return self.manifest['batch']+'-'+key

    def observation_devices(self):
        return {device['id']: dict(device, x=site['x'], y=site['y'])
                for site in self.scene['sites'] for device in site['devices']
                if device.get('send') is not False and device['kind'] in TARGET_REPORT_KINDS}

    @staticmethod
    def target_device_ids(target, devices):
        # Only the explicitly selected observation devices can contribute.
        return [key for key in dict.fromkeys((target.get('deviceId'), target.get('secondaryDeviceId')))
                if key in devices]

    @staticmethod
    def normalized_device_ids(target, devices):
        # 每台设备对一个目标只报一遍（新-17）：辅助上报设备能用自己的协议报这个目标时，engine 已经让它发 MQTT 目标报文，
        # 这里不再替它从规范化入口重复报——否则平台把同一台设备算成两个数据源，两台设备看到记成 3 个。
        # 主上报设备、以及协议报不了这类目标的辅助设备（如气球）照常走规范化入口。
        from engine import secondary_reports_over_mqtt
        return [key for key in FullChain.target_device_ids(target, devices)
                if key == target.get('deviceId') or not secondary_reports_over_mqtt(target, devices[key])]

    def observation_device_reporting(self, device, elapsed):
        return device['heartbeat'] != '停止心跳' and not any(
            risk.get('enabled') and risk['type'] == 'offline' and risk['deviceId'] == device['id']
            and risk['at'] <= elapsed < risk['at'] + risk['seconds'] for risk in self.scene['risks'])

    def prepare(self):
        now=self.manifest['created_at']; end=now+24*3600000
        # A pilot or reporting-unit binding chosen in the scene wins. Otherwise each simulated
        # upstream task carries its own pilot and reporting unit (D-2, 2026-10-08); the platform
        # finds or creates those records by phone and code, and links them to the task.
        filing=copy.deepcopy(self.scene.get('fullchain',{}).get('filing',{}))
        filing.setdefault('source_id','local-flight-plan-simulator')
        if not filing.get('pilot_contact_id'):
            for key, value in SIMULATED_PILOT.items():
                filing.setdefault(key, value)
        if not filing.get('source_binding_id'):
            for key, value in SIMULATED_REPORTING_UNIT.items():
                filing.setdefault(key, value)
        options=self.api.call('GET',PREFIX+'/plan-options')
        inputs=self.existing_inputs()
        self.state['warnings']=[]
        if filing.get('pilot_contact_id') and filing['pilot_contact_id'] not in {p['contact_id'] for p in options.get('pilots',[])}:
            raise ValueError('选择的飞手不在当前可用范围，请重新选择')
        for index, plan in enumerate(self.scene['plans'],1):
            related = [t for t in self.scene['targets'] if t['kind'] == 'uav'
                       and (t.get('planId') == plan['id'] or any(
                           r.get('enabled') and r.get('type') == 'time'
                           and r.get('planId') == plan['id'] and r.get('targetId') == t['id']
                           for r in self.scene['risks']))]
            windows = [(target, *flight_window(plan, target, self.scene['risks'], now))
                       for target in related or [None]]
            # Shared routes must cover every selected UAV's own flight window.
            start = min(row[1] for row in windows)
            finish = max(row[2] for row in windows)
            route_message, existing_route = self.stable_route(plan, start, finish)
            if existing_route:
                route = {'route_id': existing_route.get('route_id'),
                         'route_version_id': existing_route.get('route_version_id'),
                         'route_no': existing_route.get('route_no'),
                         'source_mode': existing_route.get('source_mode', 'replay')}
                if not route['route_id'] or not route['route_version_id']:
                    raise ValueError('稳定模拟航线缺少平台编号：' + route_message)
            else:
                route_body=dict(self.scope,
                    message_id=route_message,name=plan['name'],valid_from=start,valid_to=finish,
                    geometry={'type':'LineString','coordinates':[coordinates(p) for p in plan['points']]},
                    corridor_width_m=plan['width'],min_altitude_m=plan['min'],max_altitude_m=plan['max'],
                    altitude_datum=plan.get('altitudeDatum','AMSL'))
                route=self.request('route-'+plan['id']+'-'+route_message,
                                   PREFIX+'/routes',route_body)
            # Local interface inputs return an accepted message envelope; keep
            # compatibility with older test doubles that returned the result
            # object directly.
            route_data=route
            while isinstance(route_data,dict) and 'route_version_id' not in route_data and isinstance(route_data.get('result'),dict):
                route_data=route_data['result']
            ids=[]
            for number,(target, plan_start, plan_finish) in enumerate(windows,1):
                serial=stable_uav_sn(target['id'], target.get('uavSn')) if target else stable_simulator_id('map-sim-support-uav-', 'p'+str(index))
                if target:
                    self.manifest['targets'][target['id']]['uav_sn']=serial
                item_filing=dict(filing,operator_org_id=filing.get('operator_org_id') or self.scope['owner_org_id'],
                    takeoff_site_name=plan['name']+'起点',landing_site_name=plan['name']+'终点',
                    takeoff_longitude=coordinates(plan['points'][0])[0],takeoff_latitude=coordinates(plan['points'][0])[1],
                    landing_longitude=coordinates(plan['points'][-1])[0],landing_latitude=coordinates(plan['points'][-1])[1])
                legacy_plan_message = stable_simulator_id('sim-map-plan-', plan['id']+'-'+str(number))
                plan_message = legacy_plan_message
                plan_body={'message_id':plan_message,
                           'route_version_id':route_data['route_version_id'],'uav_sn':serial,
                           'start_at':plan_start,'end_at':plan_finish,'source_mode':'replay',
                           'status_code':plan_status(plan_start, plan_finish, now),'filing':item_filing}
                candidates = [(mid, row) for mid, row in inputs['plans'].items()
                              if (mid == legacy_plan_message or mid.startswith(legacy_plan_message + '-'))
                              and message_matches_payload(row, plan_body)]
                if len(candidates) > 1:
                    candidates = [(mid, row) for mid, row in candidates if isinstance(row.get('payload'), dict)]
                # Prefer the earliest receipt; list order and the current state
                # must not select a later duplicate from an older simulator run.
                candidates.sort(key=lambda item: (item[1].get('created_at', 0), item[0]))
                existing_plan = None
                if candidates:
                    plan_message, existing_plan = candidates[0]
                    plan_body['message_id'] = plan_message
                if not existing_plan or not message_matches_payload(existing_plan, plan_body):
                    plan_message = stable_simulator_id(
                        'sim-map-plan-',
                        f"{plan['id']}-{number}-{payload_fingerprint(plan_identity(plan_body))}")
                    plan_body['message_id'] = plan_message
                    existing_plan = inputs['plans'].get(plan_message)
                if existing_plan:
                    pid = existing_plan.get('subject_id')
                    if not pid:
                        raise ValueError('稳定模拟任务缺少平台编号：' + plan_message)
                else:
                    result=self.request('plan-'+plan['id']+'-'+str(number)+'-'+
                                        payload_fingerprint(plan_identity(plan_body)),
                                        PREFIX+'/plans',plan_body)
                    pid=result.get('subject_id') or result.get('result',{}).get('plan_id') or result.get('plan_id')
                if not pid: raise ValueError('平台未返回模拟任务编号')
                self.manifest.setdefault('plan_expectations',{})[pid]=copy.deepcopy(plan_body)
                ids.append(pid)
                if target:self.manifest['targets'][target['id']]['plan_id']=pid
            self.manifest['plans'][plan['id']]={**route,'ids':ids}
            self.manifest.setdefault('realtime_plan_id',ids[0]);self.checkpoint()
        for index,zone in enumerate(self.scene['zones'],1):
            zone_start, zone_finish = plan_window(zone, now)
            ring=[coordinates(p) for p in zone['points']]
            if ring[0]!=ring[-1]:ring.append(ring[0])
            airspace_no = stable_airspace_no(zone['id'])
            previous = self.existing_airspaces().get(airspace_no)
            revision = int(previous.get('revision') or 0) + 1 if previous else 1
            body=dict(self.scope,
                message_id=self.message('z'+str(index)+'-r'+str(revision)),revision=revision,action='UPSERT',airspace_no=airspace_no,
                name=zone['name'],kind_code=zone['kindCode'],boundary={'type':'Polygon','coordinates':[ring]},
                min_altitude_m=zone.get('min',0),max_altitude_m=zone['max'],altitude_datum=zone.get('altitudeDatum','AMSL'),
                valid_from=zone_start,valid_to=zone_finish,change_reason='全量模拟批次 '+self.manifest['batch'])
            saved=(previous or {}).get('payload') or {}
            same_definition=all(field in saved and saved[field]==value for field,value in body.items()
                                if field not in ('message_id','revision','change_reason'))
            if (previous and previous.get('state')=='ACCEPTED' and previous.get('action')=='UPSERT'
                    and previous.get('airspace_id') and previous.get('airspace_version_id') and same_definition):
                result={key:copy.deepcopy(value) for key,value in previous.items() if key!='payload'}
                self.state['requests']['zone-'+zone['id']]={'path':PREFIX+'/airspaces', 'body':copy.deepcopy(saved),
                    'state':'ACCEPTED','result':copy.deepcopy(result),'reused_by_readback':True}
            else:
                # 同一天重跑（上次已撤销或已更新）或改了区域时，新下发须晚于上次的生效/撤销时间，否则平台拒收（409）；
                # 这时从现在起生效，时段已过就紧接上次之后，结束时间不变。
                last=airspace_effective_at(previous)
                if last is not None and body['valid_from']<=last:
                    body['valid_from']=max(now,last+1000)
                    if body['valid_from']>=zone_finish:
                        body['valid_from']=last+1000
                    if body['valid_from']>=zone_finish:
                        raise ValueError('空域「'+zone['name']+'」今天已下发到结束时间，请把它的结束时间改晚或明天再启动')
                result=self.request('zone-'+zone['id'],PREFIX+'/airspaces',body)
            self.manifest['zones'][zone['id']]={'id':result.get('airspace_id'),'revision':int(result.get('revision') or revision),'receipt':result};self.checkpoint()
        if 'observationSourceCount' in self.scene.get('fullchain', {}) and any(t.get('transport')=='normalized' for t in self.scene['targets']):
            sources=[]
            for index in range(self.observation_source_count):
                suffix='' if index==0 else '-'+str(index+1)
                source=self.request('normalized-source'+suffix,PREFIX+'/observation-devices',dict(self.scope,
                    message_id=self.message('source'+suffix),name=self.message('完整模拟观测'+suffix),longitude=118.61,latitude=37.464))
                sources.append(source)
                self.manifest['devices']['normalized-source'+suffix]={'platform_id':source['device_id'],'kind':'normalized',
                                                                    'external_id':source['source_id']}
            self.manifest['normalized_sources']=sources
            self.manifest['normalized_source']=sources[0]
        else:
            # 观测源和气象站是长期设备：按登记内容（单位区域、名称、位置）复用同一条，不随批次新建（OBS-01）。
            # 每台走规范化入口上报的场景设备各有一个观测源（辅助设备能用自己协议报的不走这里，新-17）；身份按场景设备和登记内容生成，同样不带批次号。
            devices = self.observation_devices()
            selected = {key for target in self.scene['targets'] if target.get('transport') == 'normalized'
                        for key in self.normalized_device_ids(target, devices)}
            sources = self.manifest.setdefault('normalized_sources', {})
            for key in sorted(selected):
                device = devices[key]
                source_key = stable_simulator_id('normalized-', key)
                longitude, latitude = coordinates([device['x'], device['y']])
                source_body = dict(self.scope, name=(device['name']+' · 模拟观测')[:128],
                    longitude=longitude, latitude=latitude)
                source = self.request(source_key, PREFIX+'/observation-devices', dict(source_body,
                    message_id=stable_simulator_id('map-sim-source-', payload_fingerprint(dict(source_body, scene_device_id=key)))))
                sources[key] = source
                self.manifest['devices'][source_key] = {'platform_id': source['device_id'], 'kind': 'normalized',
                    'external_id': source['source_id'], 'scene_device_id': key, 'scene_device_kind': device['kind']}
            if sources:
                self.manifest['normalized_source'] = next(iter(sources.values()))
        if 'weather' in self.scene.get('fullchain',{}).get('categories',[]):
            station=dict(self.scope,name='模拟气象站',
                longitude=self.weather.get('longitude',118.61),latitude=self.weather.get('latitude',37.464))
            station_key=payload_fingerprint(station)
            sensor=self.request('weather-device',PREFIX+'/weather-devices',dict(station,
                message_id=stable_simulator_id('map-sim-weather-device-',station_key),
                device_no=stable_simulator_id('map-sim-weather-',station_key)))
            self.manifest['weather_device']=sensor
            pid=self.manifest['realtime_plan_id']
            self.request('weather-forecast',PREFIX+'/weather',{'message_id':self.message('forecast'),
                'plan_id':pid,'area_name':self.weather.get('area_name','东营全量模拟区域'),'published_at':now,
                'periods':self.weather.get('periods') or [{'from':now,'to':end,'summary':self.weather.get('summary','多云'),
                    'temperature_c':self.weather.get('temperature_c',22),'wind_speed_ms':self.weather.get('wind_speed_ms',6),
                    'gust_ms':self.weather.get('gust_ms',11),'wind_direction_deg':int(self.weather.get('wind_from_degrees',90)),
                    'precipitation_probability_pct':40,'humidity_pct':int(self.weather.get('humidity_percent',65))}]})
            # Only submit configured inputs. Risk conclusions belong to the platform's
            # forecast rules; selecting weather must not inject three preset warnings.
        self.checkpoint()

    def tick(self, targets, elapsed, sequence):
        from engine import target_sample, target_reporting
        if self.cancelled():return
        now=self.clock()
        devices = self.observation_devices()
        sources = self.manifest.get('normalized_sources', {})
        items_by_device = {}
        for key,target in targets.items():
            if target.get('transport')!='normalized' or not target_reporting(target,elapsed):continue
            if (target.get('_notification_motion') or {}).get('suppress'):continue
            sample=target_sample(target,elapsed)
            external=self.manifest['targets'][key]['external_id']
            item={'external_target_id':external,'external_track_id':external,'longitude':sample['longitude'],
                  'latitude':sample['latitude'],'speed_mps':sample['speed'],'heading_deg':sample['heading'],
                  'class_code':CLASSES[target['kind']],'class_confidence':target.get('probability')}
            if target.get('altitudeDatum','AMSL')=='AMSL':item['altitude_amsl_m']=sample['altitude']
            item['height_agl_m']=sample.get('height_agl')
            if target['kind']=='uav':
                item['uav_sn']=self.manifest['targets'][key]['uav_sn']
                if target.get('pilotPoint'):item['pilot_longitude'],item['pilot_latitude']=coordinates(target['pilotPoint'])
            if target['kind']=='balloon':item['subtype']='BALLOON'
            if isinstance(sources, list):
                if any(self.observation_device_reporting(devices[d], elapsed)
                       for d in self.target_device_ids(target, devices)):
                    items_by_device.setdefault('explicit', []).append(item)
            else:
                for device_id in self.normalized_device_ids(target, devices):
                    if self.observation_device_reporting(devices[device_id], elapsed):
                        items_by_device.setdefault(device_id, []).append(item)
        if isinstance(sources, list):
            items = items_by_device.get('explicit', [])
            if items:
                for index, current in enumerate(sources):
                    self.publish('normalized', PREFIX+'/target-observations', {
                        'message_id': self.message('o'+str(sequence)+'-s'+str(index+1)),
                        'source_id': current['source_id'], 'observed_at': now, 'items': items}, len(items))
        else:
            for device_id, items in items_by_device.items():
                source = sources.get(device_id)
                if not source:
                    raise ValueError('模拟观测设备尚未登记，请重新启动场景：'+devices[device_id]['name'])
                self.publish('normalized',PREFIX+'/target-observations',{
                    'message_id':stable_simulator_id(self.message('o'+str(sequence)+'-'), device_id),
                    'source_id':source['source_id'],'observed_at':now,'items':items},len(items))
        sensor=self.manifest.get('weather_device')
        if sensor and elapsed>=self.next_weather:
            self.publish('weather-observations',PREFIX+'/weather-observations',{
                'message_id':self.message('w'+str(sequence)),'device_id':sensor['device_id'],'observed_at':now,
                'longitude':self.weather.get('longitude',118.61),'latitude':self.weather.get('latitude',37.464),
                'temperature_c':round(self.weather.get('temperature_c',22)+math.sin(elapsed/60),2),
                'wind_speed_ms':round(max(0,self.weather.get('wind_speed_ms',6)+2*math.sin(elapsed/20)),2),
                'gust_ms':self.weather.get('gust_ms',11),'wind_from_degrees':self.weather.get('wind_from_degrees',90),
                'humidity_percent':self.weather.get('humidity_percent',65),'pressure_hpa':self.weather.get('pressure_hpa',1013),
                'precipitation_mm':self.weather.get('precipitation_mm',0),'visibility_m':self.weather.get('visibility_m',8000)},1)
            self.next_weather=elapsed+5
        if self.scene.get('fullchain',{}).get('airspaceLifecycle'):
            # Only this batch's separate temporary zone changes; never edits previous/user airspaces.
            key='zone-zone-temporary_control'
            original=self.state['requests'].get(key)
            zone_state = self.manifest.get('zones', {}).get('zone-temporary_control', {})
            valid_to=(original or {}).get('body',{}).get('valid_to')
            if original and elapsed>=120:
                revision=int(zone_state.get('revision') or original['body'].get('revision') or 1) + 1
                # 平台要求版本更新保持原空域名称和归属（改名会被拒 409，整批停下），
                # 并且新版本晚于上一版生效（同一生效时间同样被拒 409）：这里只出新版本、新生效时间，结束时间不变。
                valid_from=max(now,int(original['body']['valid_from'])+1000)
                if 'zone-update' in self.state['requests'] or valid_to is None or valid_from<valid_to:
                    body=copy.deepcopy(original['body']);body.update(message_id=self.message('zone-update-r'+str(revision)),revision=revision,
                        valid_from=valid_from,change_reason='本批次空域版本更新')
                    result=self.request('zone-update',PREFIX+'/airspaces',body)
                    zone_state['revision']=int(result.get('revision') or revision)
                    zone_state['receipt']=result
                else:
                    self.warn(original['body'].get('name','临时管制区')+'已到失效时间，跳过本批次的空域版本更新')
            if original and elapsed>=180:
                revision=int(zone_state.get('revision') or original['body'].get('revision') or 1) + 1
                # 撤销时间须晚于最新版本的生效时间、早于原失效时间，否则平台拒收。
                latest=self.state['requests'].get('zone-update',original)['body']
                effective_at=max(now,int(latest['valid_from'])+1000)
                if 'zone-withdraw' in self.state['requests'] or valid_to is None or effective_at<valid_to:
                    result=self.request('zone-withdraw',PREFIX+'/airspaces',{'message_id':self.message('zone-withdraw-r'+str(revision)),
                        'revision':revision,'action':'WITHDRAW','airspace_no':original['body']['airspace_no'],
                        'effective_at':effective_at,'change_reason':'本批次模拟临时管制结束'})
                    zone_state['revision']=int(result.get('revision') or revision)
                    zone_state['receipt']=result
                else:
                    self.warn(original['body'].get('name','临时管制区')+'已到失效时间，跳过本批次的空域撤销')

    def warn(self, text):
        """Show one page note per problem instead of stopping the whole batch."""
        warnings=self.state.setdefault('warnings',[])
        if text not in warnings:
            warnings.append(text);self.checkpoint()

    def publish(self, category, path, body, count):
        if self.cancelled():return
        # One uncertain request stops the run; do not produce new identities for blind retries.
        entry=self.state['coverage'].setdefault(category,{'submitted':0,'accepted':0,'processed':None,'last_at':None})
        entry['submitted']+=count
        self.state['pending_input']={'path':path,'body':body};self.checkpoint()
        try:self.api.call('POST',path,body,body['message_id'])
        except Exception as error:
            entry['error']=str(error);self.checkpoint();raise
        self.state.pop('pending_input',None)
        entry['accepted']+=count;entry['last_at']=self.clock();entry.pop('error',None)
        self.checkpoint()

    def record_mqtt(self, payload):
        codes={0:'unknown',3:'person',7:'vehicle',30:'uav',40:'bird',50:'ship',100:'remote_controller',255:'identifying'}
        for obj in payload.get('objects',[]):
            kind=codes.get(obj.get('extension',{}).get('objectType'),'unknown')
            row=self.state['coverage'].setdefault('mqtt-'+kind,{'label':'MQTT '+kind,
                'submitted':0,'accepted':0,'processed':None,'last_at':None})
            row['submitted']+=1;row['accepted']+=1;row['last_at']=self.clock()
