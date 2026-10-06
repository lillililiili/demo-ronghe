"""Prepare related facts through authorized APIs and publish normalized observations."""
import copy
import datetime as dt
import hashlib
import json
import math
import re
import time
from engine import coordinates

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


def payload_fingerprint(value):
    """Return a short deterministic suffix for a changed simulator payload."""
    return hashlib.sha256(canonical_payload(value).encode('utf-8')).hexdigest()[:12]


def payload_without_message_id(body):
    return {key: value for key, value in body.items() if key != 'message_id'}


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
    return not isinstance(payload, dict) or canonical_payload(payload) == canonical_payload(body)


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
        raise ValueError('计划时间格式须为 HH:mm') from error
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
                if message.get('kind') != 'FLIGHT_PLAN' or not message.get('message_id'):
                    continue
                if message['message_id'] in plans:
                    raise ValueError('模拟计划消息编号出现重复记录：' + message['message_id'])
                plans[message['message_id']] = message
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

    def prepare(self):
        now=self.manifest['created_at']; end=now+24*3600000
        # Existing configured contacts may be selected; this never asserts a new human verification.
        filing=copy.deepcopy(self.scene.get('fullchain',{}).get('filing',{}))
        filing.setdefault('source_id','local-flight-plan-simulator')
        options=self.api.call('GET',PREFIX+'/plan-options')
        inputs=self.existing_inputs()
        if not filing.get('pilot_contact_id'):
            self.state['warnings']=['未选择执行飞手；短信/电话仍按平台资格阻断，可在全量资料设置选择现有飞手']
        if filing.get('pilot_contact_id') and filing['pilot_contact_id'] not in {p['contact_id'] for p in options.get('pilots',[])}:
            raise ValueError('选择的飞手不在当前可用范围，请重新选择')
        for index, plan in enumerate(self.scene['plans'],1):
            start, finish = plan_window(plan, now)
            base_route_message = stable_simulator_id('sim-map-route-', plan['id'])
            base_route = self.route_record(base_route_message)
            route_message = base_route_message
            # A past-time scene intentionally replays its historical route even
            # after the validity window has elapsed.  Current/future plans
            # must instead bind to a version that covers their new window.
            existing_route = base_route if plan.get('timeMode') == 'past' or route_covers_window(base_route, start, finish) else None
            if base_route is not None and existing_route is None:
                route_message = stable_simulator_id('sim-map-route-',
                                                    f"{plan['id']}-{start}-{finish}")
                existing_route = self.reusable_route(route_message, start, finish)
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
            related=[t for t in self.scene['targets'] if t['kind']=='uav' and t.get('planId')==plan['id']]
            ids=[]
            for number,target in enumerate(related or [None],1):
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
                           'start_at':start,'end_at':finish,'source_mode':'replay',
                           'status_code':plan_status(start, finish, now),'filing':item_filing}
                existing_plan = inputs['plans'].get(plan_message)
                if existing_plan is None:
                    # Older context responses may omit payloads while exposing
                    # only the content-fingerprint message from a prior run.
                    # Reuse that sole candidate for backward compatibility;
                    # an absent or ambiguous candidate still gets a fresh key.
                    candidates = [(mid, row) for mid, row in inputs['plans'].items()
                                  if mid.startswith(legacy_plan_message + '-')]
                    if len(candidates) == 1 and message_matches_payload(candidates[0][1], plan_body):
                        plan_message, existing_plan = candidates[0]
                        plan_body['message_id'] = plan_message
                if not existing_plan or not message_matches_payload(existing_plan, plan_body):
                    plan_message = stable_simulator_id(
                        'sim-map-plan-',
                        f"{plan['id']}-{number}-{payload_fingerprint(payload_without_message_id(plan_body))}")
                    plan_body['message_id'] = plan_message
                    existing_plan = inputs['plans'].get(plan_message)
                if existing_plan:
                    pid = existing_plan.get('subject_id')
                    if not pid:
                        raise ValueError('稳定模拟计划缺少平台编号：' + plan_message)
                else:
                    result=self.request('plan-'+plan['id']+'-'+str(number)+'-'+
                                        payload_fingerprint(payload_without_message_id(plan_body)),
                                        PREFIX+'/plans',plan_body)
                    pid=result.get('subject_id') or result.get('result',{}).get('plan_id') or result.get('plan_id')
                if not pid: raise ValueError('平台未返回模拟计划编号')
                ids.append(pid)
                if target:self.manifest['targets'][target['id']]['plan_id']=pid
            self.manifest['plans'][plan['id']]={**route,'ids':ids}
            self.manifest.setdefault('realtime_plan_id',ids[0]);self.checkpoint()
        for index,zone in enumerate(self.scene['zones'],1):
            ring=[coordinates(p) for p in zone['points']]
            if ring[0]!=ring[-1]:ring.append(ring[0])
            airspace_no = stable_airspace_no(zone['id'])
            previous = self.existing_airspaces().get(airspace_no)
            revision = int(previous.get('revision') or 0) + 1 if previous else 1
            result=self.request('zone-'+zone['id'],PREFIX+'/airspaces',dict(self.scope,
                message_id=self.message('z'+str(index)+'-r'+str(revision)),revision=revision,action='UPSERT',airspace_no=airspace_no,
                name=zone['name'],kind_code=zone['kindCode'],boundary={'type':'Polygon','coordinates':[ring]},
                min_altitude_m=zone.get('min',0),max_altitude_m=zone['max'],altitude_datum=zone.get('altitudeDatum','AMSL'),
                valid_from=now,valid_to=end,change_reason='全量模拟批次 '+self.manifest['batch']))
            self.manifest['zones'][zone['id']]={'id':result.get('airspace_id'),'revision':int(result.get('revision') or revision),'receipt':result};self.checkpoint()
        if any(t.get('transport')=='normalized' for t in self.scene['targets']):
            source=self.request('normalized-source',PREFIX+'/observation-devices',dict(self.scope,
                message_id=self.message('source'),name=self.message('完整观测'),longitude=118.61,latitude=37.464))
            self.manifest['normalized_source']=source
            self.manifest['devices']['normalized-source']={'platform_id':source['device_id'],'kind':'normalized',
                                                         'external_id':source['source_id']}
        if 'weather' in self.scene.get('fullchain',{}).get('categories',[]):
            sensor=self.request('weather-device',PREFIX+'/weather-devices',dict(self.scope,
                message_id=self.message('weather-device'),device_no=self.message('weather'),name='模拟气象站 '+self.manifest['batch'],
                longitude=self.weather.get('longitude',118.61),latitude=self.weather.get('latitude',37.464)))
            self.manifest['weather_device']=sensor
            pid=self.manifest['realtime_plan_id']
            self.request('weather-forecast',PREFIX+'/weather',{'message_id':self.message('forecast'),
                'plan_id':pid,'area_name':self.weather.get('area_name','东营全量模拟区域'),'published_at':now,
                'periods':self.weather.get('periods') or [{'from':now,'to':end,'summary':self.weather.get('summary','多云'),
                    'temperature_c':self.weather.get('temperature_c',22),'wind_speed_ms':self.weather.get('wind_speed_ms',6),
                    'gust_ms':self.weather.get('gust_ms',11),'wind_direction_deg':int(self.weather.get('wind_from_degrees',90)),
                    'precipitation_probability_pct':40,'humidity_pct':int(self.weather.get('humidity_percent',65))}]})
            for i,reason in enumerate(('WEATHER_STRONG_WIND','WEATHER_THUNDERSTORM','WEATHER_LOW_VISIBILITY')):
                self.request('weather-risk-'+str(i),PREFIX+'/weather-risks',{
                    'message_id':self.message('wr'+str(i)),'plan_id':pid,'reason_code':reason,
                    'severity':'HIGH','reason_text':'模拟上游气象预警 '+reason,
                    'published_at':now,'valid_from':now,'valid_to':end,
                    'polygon':[[118.56,37.42],[118.67,37.42],[118.67,37.50],[118.56,37.50],[118.56,37.42]],
                    'wind_speed_mps':18 if i==0 else 5,'wind_from_degrees':90,'visibility_m':300 if i==2 else 10000})
        if not self.manifest.get('realtime_plan_id'):
            self.state['warnings'].append('当前分类没有计划，四通道反制接收端本批次不启用；其它收发继续')
        self.checkpoint()

    def tick(self, targets, elapsed, sequence):
        from engine import target_sample, target_reporting
        if self.cancelled():return
        now=self.clock(); source=self.manifest.get('normalized_source')
        items=[]
        for key,target in targets.items():
            if target.get('transport')!='normalized' or not target_reporting(target,elapsed):continue
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
            items.append(item)
        if items and source:
            self.publish('normalized',PREFIX+'/target-observations',{'message_id':self.message('o'+str(sequence)),
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
            if original and elapsed>=120:
                revision=int(zone_state.get('revision') or original['body'].get('revision') or 1) + 1
                body=copy.deepcopy(original['body']);body.update(message_id=self.message('zone-update-r'+str(revision)),revision=revision,
                    valid_from=now,name='模拟临时管制区更新',change_reason='本批次空域版本更新')
                result=self.request('zone-update',PREFIX+'/airspaces',body)
                zone_state['revision']=int(result.get('revision') or revision)
                zone_state['receipt']=result
            if original and elapsed>=180:
                revision=int(zone_state.get('revision') or original['body'].get('revision') or 1) + 1
                result=self.request('zone-withdraw',PREFIX+'/airspaces',{'message_id':self.message('zone-withdraw-r'+str(revision)),
                    'revision':revision,'action':'WITHDRAW','airspace_no':original['body']['airspace_no'],
                    'effective_at':now,'change_reason':'本批次模拟临时管制结束'})
                zone_state['revision']=int(result.get('revision') or revision)
                zone_state['receipt']=result

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
