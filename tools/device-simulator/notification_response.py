"""Observe this run's platform facts; change simulated movement, never business state."""
import copy
import threading
import time
from urllib.parse import urlencode
from engine import position


class NotificationResponse:
    def __init__(self, platform, manifest, targets):
        self.platform = platform
        self.manifest = copy.deepcopy(manifest)
        self.targets = {key: copy.deepcopy(t) for key, t in targets.items()
                        if t.get('notificationBehavior', 'none') != 'none'}
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = None
        self.views = {key: {'action': 'WAITING', 'reason': '等待本批次目标与告警', 'updated_at': None} for key in self.targets}
        self.links = {}
        self.motion = {}

    def start(self):
        if self.targets:
            self.thread = threading.Thread(target=self.run, daemon=True)
            self.thread.start()

    def run(self):
        while not self.stop.is_set():
            for key in self.targets:
                if self.stop.is_set(): return
                try:
                    facts = self.read(key)
                    if self.stop.is_set(): return
                    with self.lock:
                        self.views[key].update(facts, error=None, updated_at=int(time.time()*1000))
                except Exception as error:
                    with self.lock:
                        self.views[key].update(error=str(error), updated_at=int(time.time()*1000))
            self.stop.wait(1)

    def pages(self, path, params):
        rows = []
        for page in range(1, 51):
            if self.stop.is_set(): raise ValueError('观察已停止')
            result = self.platform.call('GET', path+'?'+urlencode(dict(params, page=page, size=100)))
            items = result.get('items', [])
            rows.extend(items)
            if len(rows) >= result.get('total', len(rows)): return rows
            if not items: break
        raise ValueError('关联查询未完整返回，暂不触发飞行行为')

    def read(self, key):
        serial = self.manifest['targets'][key]['uav_sn']
        started = self.manifest['created_at']
        link = self.links.setdefault(key, {})
        if not link.get('target_id'):
            rows = self.pages('/targets', {'seen_from': started, 'seen_to': int(time.time()*1000)+1})
            matches = [row for row in rows if row.get('uav_sn') == serial and row.get('source_mode') == 'replay']
            if not matches: return {'reason': '等待本批次目标进入系统'}
            if len(matches) != 1: raise ValueError('本批次序列号关联多个目标，暂不触发飞行行为')
            link['target_id'] = matches[0]['target_id']
        target = self.platform.call('GET', '/targets/'+link['target_id'])
        if target.get('uav_sn') != serial or target.get('source_mode') != 'replay':
            raise ValueError('目标身份或来源已变化，暂不触发飞行行为')
        latest = target.get('latest_state') or {}
        facts = {'target_id': link['target_id'], 'observed_at': latest.get('observed_at'),
                 'location': latest.get('location'), 'reason': '等待本批次目标产生告警'}
        if not link.get('event_id'):
            alarms = self.pages('/alarms', {'target_id': link['target_id'], 'source_mode': 'replay'})
            matches = {r['event_id']: r for r in alarms if r.get('event_id') and r.get('target_id') == link['target_id']
                       and r.get('source_mode') == 'replay' and (r.get('received_at') or 0) >= started}
            if not matches: return facts
            if len(matches) != 1: raise ValueError('本批次目标关联多个告警，暂不触发飞行行为')
            link['event_id'], alarm = next(iter(matches.items()))
            link['alarm_no'] = alarm.get('alarm_no')
        event = self.platform.call('GET', '/uav-events/'+link['event_id'])
        if event.get('target_id') != link['target_id'] or (event.get('created_at') or 0) < started:
            raise ValueError('告警不属于本次目标，暂不触发飞行行为')
        overview = self.platform.call('GET', '/uav-events/'+link['event_id']+'/advisory')
        if overview.get('event_id') != link['event_id']: raise ValueError('通知与当前告警关联不一致')
        records = [r for r in overview.get('records', []) if r.get('simulated') is True
                   and started <= (r.get('created_at') or 0) <= int(time.time()*1000)]
        sms = next((r for r in records if r.get('kind') == 'SMS_SIMULATED' and r.get('delivery_status') == 'SIMULATED_DELIVERED'), None)
        voice = next((r for r in records if r.get('kind') == 'VOICE_SIMULATED' and r.get('delivery_status') == 'SIMULATED_PLAYED'), None)
        auto_sms, auto_voice = overview.get('auto_sms') or {}, overview.get('auto_voice') or {}
        try:
            observation = self.platform.call('GET', '/uav-events/'+link['event_id']+'/advisory/observation')
            if observation.get('event_id') != link['event_id']: raise ValueError('观察结果与当前告警不一致')
        except ValueError as error:
            observation = {'status': 'UNAVAILABLE', 'presence': 'UNKNOWN', 'error': str(error)}
        facts.update(event_id=link['event_id'], alarm_no=link.get('alarm_no'), event_state=event.get('state'),
                     notify_phase=overview.get('notify_phase'), sms_at=sms.get('created_at') if sms else None,
                     voice_at=voice.get('created_at') if voice else None,
                     reason=auto_voice.get('reason') if sms else auto_sms.get('reason'),
                     sms_status=auto_sms.get('status'), voice_status=auto_voice.get('status'), observation=observation)
        trigger = voice if self.targets[key]['notificationBehavior'] == 'after_voice' else sms
        facts['trigger'] = trigger if event.get('state') == 'CONFIRMED' else None
        return facts

    def apply(self, targets, elapsed, now):
        """Called by the publisher, so a delayed read never rewinds a moving target."""
        with self.lock:
            for key, view in self.views.items():
                if key in self.motion or view.get('error') or not view.get('trigger'): continue
                # Do not act on a stale poll after pause, failure or an API stall.
                if now-(view.get('updated_at') or 0) > 5000: continue
                target = targets[key]
                behavior = target['notificationBehavior']
                origin = position(target, elapsed)
                motion = {'at_elapsed': elapsed, 'origin': origin}
                if behavior in ('after_sms', 'after_voice'):
                    motion.update(path=[origin]+copy.deepcopy(target['departurePath']), speed=target['departureSpeed'])
                    view['action'] = 'DEPARTING'
                elif behavior == 'drop_sms':
                    motion['suppress'] = True
                    view['action'] = 'REPORTS_STOPPED'
                else:
                    view['action'] = 'CONTINUING'
                target['_notification_motion'] = motion
                self.motion[key] = copy.deepcopy(motion)
                view.update(triggered_at=now, trigger_record_id=view['trigger']['record_id'])

    def snapshot(self):
        with self.lock:
            return copy.deepcopy({key: {k: v for k, v in view.items() if k != 'trigger'} for key, view in self.views.items()})
