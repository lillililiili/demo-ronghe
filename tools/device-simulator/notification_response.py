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
        self.batch_device_ids = None

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
            self.stop.wait(.2)

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

    def matches_identity(self, target, serial, external=None, normalized=False):
        if target.get('source_mode') != 'replay': return False
        if target.get('uav_sn') and target['uav_sn'] != serial: return False
        # A selected SN is not proof of batch ownership. Verify the public source
        # link and current observation without changing platform identity rules.
        sources = self.manifest.get('normalized_sources') or [self.manifest.get('normalized_source') or {}]
        source_rows = list(sources.values()) if isinstance(sources, dict) else sources
        registered = {(s.get('source_id'), s.get('device_id')) for s in source_rows
                      if s.get('source_id') and s.get('device_id')}
        source_devices = set()
        if normalized:
            if not external or not registered: return False
            if 'source_links' not in target:
                target = self.platform.call('GET', '/targets/'+target['target_id'])
            source_devices = {link.get('device_id') for link in target.get('source_links', [])
                              if (link.get('source_id'), link.get('device_id')) in registered
                              and link.get('external_target_id') == external
                              and link.get('source_mode') == 'replay'}
            if not source_devices: return False
        if self.batch_device_ids is None:
            device_ids = set()
            for device in self.manifest.get('devices', {}).values():
                # 规范化观测源不在设备台账里（按设备查会 404，撤离观察每秒失败一次），它的观测也不算射频身份证据。
                if device.get('kind') == 'normalized': continue
                detail = self.platform.call('GET', '/devices/'+device['platform_id'])
                fusion_id = (detail.get('device') or {}).get('fusion_device_id')
                if fusion_id: device_ids.add(fusion_id)
            self.batch_device_ids = device_ids
        now = int(time.time()*1000)
        cutoff = max(self.manifest['created_at'], now-5000)
        observations = self.pages('/targets/'+target['target_id']+'/observations',
                                  {'time_from': cutoff, 'time_to': now})
        current = [row for row in observations
                   if row.get('source_type') in ('TDOA', '5G_A', 'SIM_NORMALIZED')
                   and row.get('source_mode') == 'replay'
                   and cutoff <= (row.get('observed_at') or 0) <= now]
        clues = {row['identity_clue'] for row in current if row.get('identity_clue')}
        own = any(row.get('identity_clue') == serial
                  and (not external or row.get('external_target_id') == external)
                  and ((normalized and row.get('source_type') == 'SIM_NORMALIZED'
                        and row.get('device_id') in source_devices)
                       or (not normalized and row.get('source_type') in ('TDOA', '5G_A')
                           and row.get('device_id') in self.batch_device_ids)) for row in current)
        return own and clues == {serial}

    def read(self, key):
        serial = self.manifest['targets'][key]['uav_sn']
        normalized = self.targets[key].get('transport') == 'normalized'
        external = self.manifest['targets'][key].get('external_id' if normalized else 'mqtt_object_id')
        started = self.manifest['created_at']
        link = self.links.setdefault(key, {})
        if not link.get('target_id'):
            rows = self.pages('/targets', {'seen_from': started, 'seen_to': int(time.time()*1000)+1})
            matches = [row for row in rows if self.matches_identity(row, serial, external, normalized)]
            if not matches: return {'reason': '等待本批次目标进入系统'}
            if len(matches) != 1: raise ValueError('本批次序列号关联多个目标，暂不触发飞行行为')
            link['target_id'] = matches[0]['target_id']
        target = self.platform.call('GET', '/targets/'+link['target_id'])
        if not self.matches_identity(target, serial, external, normalized):
            raise ValueError('目标身份或来源已变化，暂不触发飞行行为')
        latest = target.get('latest_state') or {}
        facts = {'target_id': link['target_id'], 'observed_at': latest.get('observed_at'),
                 'location': latest.get('location'), 'reason': '等待本批次目标产生告警'}
        if not link.get('risk_case_id') and not link.get('event_id'):
            alarms = self.pages('/alarms', {'target_id': link['target_id'], 'source_mode': 'replay', 'view': 'risk_case'})
            matches = {}
            for row in alarms:
                if (row.get('target_id') != link['target_id'] or row.get('source_mode') != 'replay'
                        or (row.get('received_at') or 0) < started):
                    continue
                case = row.get('risk_case') or {}
                case_id = case.get('risk_case_id')
                identity = ('risk', case_id) if case_id else ('event', row.get('event_id'))
                if identity[1]: matches[identity] = row
            if not matches: return facts
            if len(matches) != 1: raise ValueError('本批次目标关联多个独立风险，暂不触发飞行行为')
            (kind, identifier), alarm = next(iter(matches.items()))
            link['risk_case_id' if kind == 'risk' else 'event_id'] = identifier
            link['alarm_no'] = alarm.get('alarm_no')
        if link.get('risk_case_id'):
            detail = self.platform.call('GET', '/uav-risk-cases/' + link['risk_case_id'])
            case = detail.get('risk_case') or {}
            alarm = detail.get('alarm') or {}
            if not alarm.get('target_id'):
                raise ValueError('风险详情未提供目标关联，可能缺少目标读取权限，暂不能确认本批次目标')
            if (case.get('risk_case_id') != link['risk_case_id'] or alarm.get('target_id') != link['target_id']
                    or case.get('source_mode') != 'replay' or (case.get('created_at') or 0) < started):
                raise ValueError('风险不属于本批次目标或模拟来源，暂不触发飞行行为')
            event, overview = detail.get('event') or {}, detail.get('advisory') or {}
            if event.get('target_id') != link['target_id']:
                raise ValueError('风险办理事件与当前目标不一致')
            related = set(case.get('related_event_ids') or [])
            notification_event = case.get('notification_event_id')
            if (not notification_event or notification_event not in related or overview.get('event_id') not in related
                    or overview.get('event_id') not in (notification_event, case.get('action_event_id'))):
                raise ValueError('风险通知与原渠道任务关联不一致')
            link['event_id'] = notification_event
            confirmed = case.get('verification_status') == 'CONFIRMED'
            facts['risk_case_id'] = link['risk_case_id']
        else:
            # Original platforms/raw historical alarms remain compatible, but
            # multiple raw events are never guessed to be the same risk.
            event = self.platform.call('GET', '/uav-events/'+link['event_id'])
            if event.get('target_id') != link['target_id'] or (event.get('created_at') or 0) < started:
                raise ValueError('告警不属于本次目标，暂不触发飞行行为')
            overview = self.platform.call('GET', '/uav-events/'+link['event_id']+'/advisory')
            if overview.get('event_id') != link['event_id']: raise ValueError('通知与当前告警关联不一致')
            confirmed = event.get('state') == 'CONFIRMED'
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
        facts['trigger'] = trigger if confirmed else None
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
                # The simulated pilot reacts to the confirmed receipt, not to the
                # observer's next poll. Sample only the next current observation;
                # never rewrite already published positions or their timestamps.
                reaction_elapsed = elapsed
                receipt_at = view['trigger'].get('created_at')
                if (behavior in ('after_sms', 'after_voice') and isinstance(receipt_at, (int, float))
                        and self.manifest['created_at'] <= receipt_at <= now
                        and now-receipt_at <= 5000):
                    reaction_elapsed = max(0.0, elapsed-(now-receipt_at)/1000)
                origin = position(target, reaction_elapsed)
                motion = {'at_elapsed': reaction_elapsed, 'origin': origin}
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
