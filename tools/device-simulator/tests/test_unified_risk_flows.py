import copy
from pathlib import Path
import sys
import time
import unittest
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from acceptance_flows import read_acceptance_flows, _read_legacy_flows
from engine import compile_scene, position, metres
from notification_response import NotificationResponse
from server import ExternalBridge
from test_k03_warning_flow import inside
from unified_risk_flows import prediction_scene


class UnifiedRiskScenesTest(unittest.TestCase):
    def test_daily_flows_integrate_prediction_and_keep_old_scene_imports(self):
        legacy = _read_legacy_flows(ROOT)['flows']
        before = copy.deepcopy(legacy)
        result = read_acceptance_flows(ROOT)
        self.assertEqual([1, 2, 3, 4, 5, 6, 7, 8, 10], [row['flow'] for row in result['flows']])
        self.assertEqual([legacy[-1]], result['compatibility_flows'])
        for number in (1, 2, 3):
            row = result['flows'][number - 1]
            self.assertEqual('prediction', row['default_variant'])
            self.assertEqual(['prediction', 'inside'], [item['id'] for item in row['variants']])
            self.assertTrue(row['guide']['prediction_only'])
            self.assertTrue(row['guide']['includes_observed_stage'])
            self.assertTrue(row['variants'][1]['supplemental'])
            self.assertNotIn('supplemental', row['variants'][0])
            self.assertIn('预警阶段人工核实', row['guide']['before'][0])
            self.assertIn('后台启用的核实条件全部满足', row['guide']['before'][0])
            self.assertIn('已核实不重复办理', str(row['guide']['sees']))
            for variant in row['variants']:
                scene, _, targets, _ = compile_scene(variant['scene'])
                target = next(iter(targets.values()))
                self.assertEqual(variant['id'] == 'inside', inside(position(target, 0), scene['zones'][0]['points']))
        self.assertEqual(['observed_false_alarm', 'prediction'], [v['id'] for v in result['flows'][3]['variants']])
        self.assertFalse(result['flows'][3]['variants'][0]['guide']['auto_verify'])
        self.assertIsNone(result['flows'][3]['variants'][1]['guide']['auto_verify'])
        self.assertFalse(result['flows'][3]['variants'][1]['guide']['includes_observed_stage'])
        self.assertFalse(result['flows'][3]['variants'][0]['supplemental'])
        self.assertEqual(legacy[4]['scene'], result['flows'][4]['scene'])
        self.assertEqual(before, _read_legacy_flows(ROOT)['flows'])

    def test_portable_geometry_has_real_approach_and_entry_without_preset_outcomes(self):
        for params in [{}, dict(identity='alternate-input', longitude=118.69, latitude=37.51,
                               start_distance=1600, speed=32, zone_width=1000)]:
            for number in (1, 2, 3, 4):
                with self.subTest(params=params, number=number):
                    raw = prediction_scene(number, **params)
                    scene, devices, targets, _ = compile_scene(raw)
                    target = next(iter(targets.values()))
                    zone = scene['zones'][0]['points']
                    self.assertFalse(inside(position(target, 0), zone))
                    self.assertGreater(position(target, 15)[0], position(target, 0)[0])
                    self.assertEqual(number != 4, inside(position(target, 100), zone))
                    self.assertEqual([], scene['risks'])
                    self.assertNotIn('verification', scene)
                    self.assertNotIn('_notification_motion', target)
                    self.assertNotIn('silence', str(scene['fullchain']))
                    self.assertTrue(any(d['kind'] == 'eo' for d in devices.values()))
                    self.assertEqual(number, scene['fullchain']['acceptanceFlow'])
                    if number == 3:
                        self.assertEqual('', target['planId'])
                        self.assertNotIn('pilotPoint', target)
                        self.assertEqual([], scene['plans'])

    def test_sms_branch_does_not_turn_by_clock_and_receipt_changes_only_future_observations(self):
        for params in [{}, dict(identity='other-sms', longitude=118.69, latitude=37.51, speed=25)]:
            scene, devices, targets, _ = compile_scene(prediction_scene(2, **params))
            key, target = next(iter(targets.items()))
            original = copy.deepcopy(target)
            response = NotificationResponse(None, {'created_at': 100000}, targets)
            response.apply(targets, 35, 135000)
            self.assertNotIn('_notification_motion', targets[key])
            self.assertGreater(position(targets[key], 35)[0], position(targets[key], 30)[0])
            response.views[key].update(updated_at=135000, trigger={'record_id': 'delivered-1', 'created_at': 135000})
            origin = position(original, 35)
            response.apply(targets, 35, 135000)
            self.assertEqual(origin, position(targets[key], 35))
            self.assertLess(position(targets[key], 45)[0], origin[0])
            self.assertFalse(inside(position(targets[key], 90), scene['zones'][0]['points']))
            first_motion = copy.deepcopy(targets[key]['_notification_motion'])
            response.apply(targets, 45, 145000)
            self.assertEqual(first_motion, targets[key]['_notification_motion'])
            site = scene['sites'][0]
            camera = next(d for d in site['devices'] if d['kind'] == 'eo')
            for point in target['path'] + target['departurePath']:
                self.assertLess(metres([site['x'], site['y']], point), camera['coverage']['rangeM'])


class CasePlatform:
    def __init__(self, suffix):
        self.now = int(time.time() * 1000)
        self.started = self.now - 1000
        self.target_id = 'target-' + suffix
        self.case_id = 'case-' + suffix
        self.event_id = 'prediction-event-' + suffix
        self.observed_id = 'observed-event-' + suffix
        self.serial = 'serial-' + suffix
        self.source = 'source-' + suffix
        self.device = 'device-' + suffix
        self.external = 'external-' + suffix
        self.target = dict(target_id=self.target_id, source_mode='replay', uav_sn=self.serial,
            source_links=[dict(source_id=self.source, device_id=self.device, external_target_id=self.external, source_mode='replay')])
        self.alarm = dict(target_id=self.target_id, source_mode='replay')
        self.case = dict(risk_case_id=self.case_id, source_mode='replay',
            created_at=self.started, verification_status='CONFIRMED', related_event_ids=[self.event_id, self.observed_id],
            notification_event_id=self.event_id)
        self.event = dict(target_id=self.target_id, event_id=self.event_id, created_at=self.started, state='CONFIRMED')
        self.advisory = dict(event_id=self.event_id, records=[dict(record_id='sms-' + suffix, kind='SMS_SIMULATED',
            delivery_status='SIMULATED_DELIVERED', simulated=True, created_at=self.now)])
        self.extra_case = False
        self.calls = []

    def call(self, method, path):
        self.calls.append((method, path))
        url = urlsplit(path)
        if url.path == '/targets': return dict(items=[self.target], total=1)
        if url.path.endswith('/observations'):
            return dict(items=[dict(source_type='SIM_NORMALIZED', source_mode='replay', device_id=self.device,
                identity_clue=self.serial, external_target_id=self.external, observed_at=self.now)], total=1)
        if url.path == '/targets/' + self.target_id: return self.target
        if url.path == '/alarms':
            if parse_qs(url.query).get('view') != ['risk_case']: raise AssertionError('raw query')
            row = dict(target_id=self.target_id, source_mode='replay', received_at=self.started,
                       event_id=self.event['event_id'], risk_case=dict(risk_case_id=self.case_id))
            rows = [row, dict(row)]  # duplicate projections still have one stable case ID
            if self.extra_case: rows.append(dict(row, risk_case=dict(risk_case_id='another-area')))
            return dict(items=rows, total=len(rows))
        if url.path == '/uav-risk-cases/' + self.case_id:
            return dict(risk_case=self.case, alarm=self.alarm, event=self.event, advisory=self.advisory)
        if url.path.endswith('/advisory/observation'): return dict(event_id=self.event_id)
        raise AssertionError(path)

    def response(self):
        return NotificationResponse(self, dict(created_at=self.started, devices={},
            targets={'t': dict(uav_sn=self.serial, external_id=self.external)},
            normalized_sources={'source': dict(source_id=self.source, device_id=self.device)}),
            {'t': dict(transport='normalized', notificationBehavior='after_sms')})


class UnifiedRiskReceiptTest(unittest.TestCase):
    def test_prediction_to_observed_keeps_original_receipt_and_case_verification(self):
        for suffix in ('one', 'different-identities'):
            platform = CasePlatform(suffix)
            response = platform.response()
            first = response.read('t')
            self.assertIsNotNone(first['trigger'])
            platform.event.update(event_id=platform.observed_id, state='NEW')
            platform.case['action_event_id'] = platform.observed_id
            platform.advisory['event_id'] = platform.observed_id
            second = response.read('t')
            self.assertEqual(first['trigger'], second['trigger'])
            self.assertEqual(platform.case_id, second['risk_case_id'])
            self.assertEqual(platform.event_id, second['event_id'])
            self.assertTrue(all(method == 'GET' for method, _ in platform.calls))

    def test_missing_delivery_failed_unknown_live_and_unverified_never_trigger(self):
        for change in [dict(delivery_status='FAILED'), dict(delivery_status='UNKNOWN'),
                       dict(delivery_status='SENDING'), dict(simulated=False), dict(kind='SMS_REAL')]:
            platform = CasePlatform('receipt')
            platform.advisory['records'][0].update(change)
            self.assertIsNone(platform.response().read('t')['trigger'])
        for state in ('PENDING_VERIFICATION', 'FALSE_POSITIVE', None):
            platform = CasePlatform('verification')
            platform.case['verification_status'] = state
            self.assertIsNone(platform.response().read('t')['trigger'])

    def test_cross_scope_source_batch_or_unrelated_notification_fails_closed(self):
        for change in [dict(source_mode='live'), dict(risk_case_id='another'),
                       dict(created_at=1), dict(related_event_ids=['another']), dict(notification_event_id='another')]:
            platform = CasePlatform('isolated')
            platform.case.update(change)
            with self.assertRaises(ValueError): platform.response().read('t')
        for target_id in ('another', None):
            platform = CasePlatform('target-read-scope')
            platform.alarm['target_id'] = target_id
            with self.assertRaises(ValueError): platform.response().read('t')
        platform = CasePlatform('target-read-permission')
        platform.alarm.pop('target_id')
        with self.assertRaisesRegex(ValueError, '读取权限'): platform.response().read('t')
        platform = CasePlatform('multiple-areas')
        platform.extra_case = True
        with self.assertRaisesRegex(ValueError, '多个独立风险'): platform.response().read('t')


class ResponseOrderReadTest(unittest.TestCase):
    def test_order_read_is_independent_readonly_and_never_changes_rules(self):
        for policy in [dict(enabled=False), dict(enabled=True, minimum_risk='HIGH', max_wait_seconds=75),
                       ValueError('返回 403 forbidden'), ValueError('offline'), dict(enabled='true')]:
            class Platform:
                calls = []
                def call(self, method, path):
                    self.calls.append((method, path))
                    if path.startswith('/automation-rule-groups/'): return dict(rules=[])
                    if path == '/response-order-policy':
                        if isinstance(policy, Exception): raise policy
                        return policy
                    raise AssertionError(path)
            bridge = ExternalBridge()
            bridge.platform = Platform()
            result = bridge.automation_rules()
            self.assertTrue(result['verify']['ok'])
            self.assertEqual(isinstance(policy, dict) and isinstance(policy.get('enabled'), bool), result['response_order']['ok'])
            self.assertTrue(all(method == 'GET' for method, _ in bridge.platform.calls))
            self.assertFalse(bridge.allowed('POST', '/response-order-policy'))
            self.assertFalse(bridge.allowed('GET', '/response-order-policy'))


if __name__ == '__main__': unittest.main()
