import copy
import datetime as dt
import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from full_scenario import full_scene, allocate_identities

TEST_NOW = int(dt.datetime(2026, 10, 5, 12, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp() * 1000)


def prepared_manifest(scene, manifest):
    """Supply the current device-registration receipts for an isolated FullChain fixture."""
    for site in scene.get('sites', []):
        for device in site['devices']:
            if device.get('send') is not False:
                manifest.setdefault('devices', {}).setdefault(device['id'], {
                    'platform_id': 'registered-' + device['id'], 'kind': device['kind']})
    return manifest


class FakePlatform:
    def __init__(self, airspace_items=None, input_context=None, route_versions=None):
        self.calls=[]
        self.airspace_items = airspace_items or []
        self.input_context = input_context or {'routes': [], 'messages': []}
        # Route versions the platform holds, as GET /route-versions/{id} returns them.
        self.route_versions = {} if route_versions is None else route_versions
    def call(self, method, path, body=None, key=None):
        self.calls.append((method,path,copy.deepcopy(body),key))
        if method == 'GET' and path.startswith('/route-versions/'):
            return copy.deepcopy(self.route_versions.get(path.split('/')[2], {}))
        if path.endswith('/routes'):
            self.route_versions['v'+body['message_id']] = {
                'corridor_width_m': body['corridor_width_m'], 'min_altitude_m': body['min_altitude_m'],
                'max_altitude_m': body['max_altitude_m'], 'altitude_datum': body['altitude_datum'],
                'centerline': {'coordinates': copy.deepcopy(body['geometry']['coordinates'])},
                'valid_from': body['valid_from'], 'valid_to': body['valid_to']}
        if path.endswith('/plan-options'): return {'pilots':[], 'organizations':[], 'source_bindings':[]}
        if path.endswith('/airspaces/context'): return {'items':copy.deepcopy(self.airspace_items)}
        if path.endswith('/context'): return copy.deepcopy(self.input_context)
        if path.endswith('/routes'): return {'route_id':'r'+body['message_id'], 'route_version_id':'v'+body['message_id']}
        if path.endswith('/plans'): return {'subject_id':'p'+body['message_id'], 'result':{'plan_id':'p'+body['message_id']}}
        if path.endswith('/airspaces'): return {'airspace_id':'a'+body['airspace_no'], 'airspace_version_id':'av', 'revision':body['revision']}
        if path.endswith('/observation-devices'): return {'device_id':'device-'+body['message_id'],'source_id':'source-'+body['message_id']}
        if path.endswith('/weather-devices'): return {'device_id':'weather-dev'}
        return {'state':'ACCEPTED'}


class FullChainTests(unittest.TestCase):
    def test_batch_activation_reads_mixed_history_encodings_without_rewriting(self):
        from fullchain import FullChain
        for encoding in ('utf-8', 'utf-8-sig', 'cp936'):
            with self.subTest(encoding=encoding), tempfile.TemporaryDirectory() as directory:
                broker, org, district = (uuid.uuid4().hex for _ in range(3))
                scope = {'owner_org_id': org, 'district_id': district}
                now = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
                current, old, foreign, future, outside = (uuid.uuid4().hex for _ in range(5))
                manifest = {'batch': uuid.uuid4().hex, 'created_at': now, 'broker_id': broker,
                            'plans': {'current': {'ids': [current]}}}
                snapshots = {}
                for plan_id, row_broker, created_at, row_scope in (
                        (old, broker, now - 1000, scope),
                        (foreign, uuid.uuid4().hex, now - 1000, scope),
                        (future, broker, now + 1000, scope),
                        (outside, broker, now - 1000, dict(scope, district_id=uuid.uuid4().hex))):
                    folder = Path(directory) / ('sim-' + uuid.uuid4().hex)
                    folder.mkdir()
                    path = folder / 'manifest.json'
                    saved = {'batch': folder.name, 'name': '东营中文历史记录',
                             'created_at': created_at, 'broker_id': row_broker, 'scope': row_scope,
                             'provider': 'map-sim', 'source_mode': 'replay',
                             'plans': {'logical': {'ids': [plan_id]}},
                             'plan_expectations': {plan_id: {'source_mode': 'replay', 'message_id': uuid.uuid4().hex}}}
                    path.write_text(json.dumps(saved, ensure_ascii=False), encoding=encoding)
                    snapshots[path] = path.read_bytes()

                class VisibleHistory(FakePlatform):
                    def call(self, method, path, body=None, key=None):
                        if path.startswith('/flight-plans?'):
                            return {'items': [{'plan_id': pid} for pid in (old, foreign, future, outside)], 'total': 4}
                        return super().call(method, path, body, key)

                api = VisibleHistory()
                chain = FullChain(api, full_scene(['uav']), manifest, scope, lambda: None)
                chain.activate_plan_batch(directory)
                self.assertEqual(api.calls[-1][2]['plan_ids'], [current])
                self.assertEqual(api.calls[-1][2]['historical_plan_ids'], [old])
                for path, original in snapshots.items():
                    self.assertEqual(path.read_bytes(), original)

    def test_unreadable_history_names_the_file_and_does_not_activate_partial_batch(self):
        from fullchain import FullChain
        for content in (b'\x00' * 32, b'{"plans":', b'\xff', b'[]'):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                folder = Path(directory) / ('sim-' + uuid.uuid4().hex)
                folder.mkdir()
                path = folder / 'manifest.json'
                path.write_bytes(content)
                api = FakePlatform()
                manifest = {'batch': uuid.uuid4().hex, 'created_at': TEST_NOW, 'plans': {}}
                chain = FullChain(api, full_scene(['uav']), manifest,
                                  {'owner_org_id': 'org', 'district_id': 'district'}, lambda: None)
                with self.assertRaisesRegex(ValueError, folder.name + '/manifest.json'):
                    chain.activate_plan_batch(directory)
                self.assertEqual(api.calls, [])
                self.assertNotIn('plan_batch_registration', manifest)
                self.assertEqual(path.read_bytes(), content)

    def test_batch_activation_uses_manifest_ids_and_preserves_history(self):
        import tempfile
        import json
        from fullchain import FullChain
        from pathlib import Path
        scene = full_scene(['uav'])
        manifest = {'batch':'current','created_at':TEST_NOW,'broker_id':'broker',
                    'provider':'map-sim','source_mode':'replay','devices':{},'zones':{},
                    'plans':{'logical':{'ids':['new','shared']}},'targets':{}}
        with tempfile.TemporaryDirectory() as directory:
            for batch, broker, ids in [('old','broker',['old','shared']), ('foreign','other',['foreign']),
                                       ('legacy','broker',['seeded-without-receipt']),
                                       ('other-database','broker',['missing-in-this-platform'])]:
                path=Path(directory)/('sim-'+batch);path.mkdir()
                (path/'manifest.json').write_text(json.dumps({'batch':batch,'created_at':TEST_NOW-1000,
                    'broker_id':broker,'provider':'map-sim','source_mode':'replay',
                    'plans':{'logical':{'ids':ids}},
                    'plan_expectations':{} if batch == 'legacy' else {pid:{'source_mode':'replay',
                        'message_id':'message-'+pid} for pid in ids}}))
            class BatchPlatform(FakePlatform):
                def call(self, method, path, body=None, key=None):
                    if path.startswith('/flight-plans?'):
                        self.calls.append((method,path,body,key))
                        # The required old task is beyond the first page.
                        return {'items':[{'plan_id':'shared' if 'page=1&' in path else 'old'}], 'total':2}
                    return super().call(method,path,body,key)
            api=BatchPlatform()
            chain=FullChain(api,scene,prepared_manifest(scene, manifest),{'owner_org_id':'o','district_id':'d'},lambda:None)
            chain.activate_plan_batch(Path(directory))
            body=api.calls[-1][2]
            self.assertEqual(body['plan_ids'], ['new','shared'])
            self.assertEqual(body['historical_plan_ids'], ['old'])
            self.assertEqual(body['started_at'], TEST_NOW)
            self.assertEqual(manifest['plans']['logical']['ids'], ['new','shared'])
            # Retrying a fixed batch uses the identical registration even if another run appears.
            chain.activate_plan_batch(Path(directory))
            self.assertEqual(api.calls[-1][2], body)
            # An incomplete history read must never activate a partial batch.
            for response in ({'items':[], 'total':1}, {'state':'unavailable'}):
                class IncompletePlatform(FakePlatform):
                    def call(self, method, path, body=None, key=None):
                        if path.startswith('/flight-plans?'):
                            return response
                        return super().call(method,path,body,key)
                failed_api=IncompletePlatform()
                failed_manifest=copy.deepcopy(manifest)
                failed_manifest.pop('plan_batch_registration')
                failed_manifest.pop('plan_batch_activation')
                with self.assertRaises(ValueError):
                    FullChain(failed_api,scene,prepared_manifest(scene, failed_manifest),{'owner_org_id':'o','district_id':'d'},lambda:None).activate_plan_batch(Path(directory))
                self.assertFalse(any(p.endswith('/plan-batches/activate') for _,p,_,_ in failed_api.calls))

    def test_tasks_carry_a_simulated_pilot_and_reporting_unit_unless_archives_are_chosen(self):
        from fullchain import FullChain

        class ArchivePlatform(FakePlatform):
            def call(self, method, path, body=None, key=None):
                if path.endswith('/plan-options'):
                    self.calls.append((method, path, copy.deepcopy(body), key))
                    return {'pilots':[{'contact_id':'c1','org_id':'o2','name':'档案飞手'}],
                            'organizations':[], 'source_bindings':[]}
                return super().call(method, path, body, key)

        scene = full_scene(['uav'])
        scene['plans'] = scene['plans'][:1]
        scene['targets'] = [t for t in scene['targets'] if t.get('planId') == scene['plans'][0]['id']]
        manifest = {'batch':'b', 'created_at':TEST_NOW, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene, 'b'),
                    'fullchain':{'requests':{}, 'coverage':{}, 'warnings':['旧提示']}}
        api = FakePlatform()
        FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None).prepare()
        filing = next(b for _,p,b,_ in api.calls if p.endswith('/plans'))['filing']
        self.assertEqual({k: filing.get(k) for k in ('operator_org_id','pilot_name','pilot_phone','reporting_org_code','reporting_org_name','source_id')},
                         {'operator_org_id':'o','pilot_name':'模拟飞手','pilot_phone':'13800000000',
                          'reporting_org_code':'SIM-REPORTING-UNIT','reporting_org_name':'模拟报送单位',
                          'source_id':'local-flight-plan-simulator'})
        self.assertNotIn('pilot_contact_id', filing)
        self.assertEqual(manifest['fullchain']['warnings'], [])

        chosen = copy.deepcopy(scene)
        chosen['fullchain']['filing'] = {'pilot_contact_id':'c1','pilot_name':'档案飞手','operator_org_id':'o2',
                                         'source_binding_id':'b1','source_id':'src'}
        manifest = {'batch':'c', 'created_at':TEST_NOW, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(chosen, 'c')}
        api = ArchivePlatform()
        FullChain(api, chosen, prepared_manifest(chosen, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None).prepare()
        filing = next(b for _,p,b,_ in api.calls if p.endswith('/plans'))['filing']
        self.assertEqual((filing['pilot_contact_id'], filing['pilot_name'], filing['operator_org_id'], filing['source_binding_id']),
                         ('c1', '档案飞手', 'o2', 'b1'))
        for key in ('pilot_phone', 'reporting_org_code', 'reporting_org_name'):
            self.assertNotIn(key, filing)

    def test_same_batch_retry_reuses_original_plan_across_lifecycle_and_duplicates(self):
        from fullchain import FullChain
        for hour in (12, 15):
            with self.subTest(hour=hour):
                scene = full_scene(['uav'])
                scene['plans'] = scene['plans'][:1]
                scene['targets'] = [t for t in scene['targets'] if t.get('planId') == scene['plans'][0]['id']]
                scene['plans'][0].update(start='11:00', end='14:00')
                before = int(dt.datetime(2027, 3, 8, 10, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp()*1000)
                after = before + (hour-10)*3600000
                first = {'batch':'before', 'created_at':before, 'devices':{}, 'plans':{}, 'zones':{},
                         'targets':allocate_identities(scene,'before')}
                api = FakePlatform()
                FullChain(api, scene, prepared_manifest(scene, first), {'owner_org_id':'o','district_id':'d'}, lambda:None).prepare()
                route = next(b for _,p,b,_ in api.calls if p.endswith('/routes'))
                body = next(b for _,p,b,_ in api.calls if p.endswith('/plans'))
                old = dict(body, message_id=body['message_id']+'-old', status_code='COMPLETED')
                context = {'routes':[dict(route, route_no=route['message_id'], route_id='r'+route['message_id'],
                                          route_version_id='v'+route['message_id'])],
                           'messages':[
                               {'kind':'FLIGHT_PLAN','message_id':old['message_id'],'subject_id':'duplicate','payload':old,'created_at':before+1},
                               {'kind':'FLIGHT_PLAN','message_id':body['message_id'],'subject_id':'original','payload':body,'created_at':before}]}
                restarted = {'batch':'before','created_at':after,'devices':{},'plans':{},'zones':{},
                             'targets':allocate_identities(scene,'before')}
                api = FakePlatform(input_context=context, route_versions=api.route_versions)
                FullChain(api, scene, prepared_manifest(scene, restarted), {'owner_org_id':'o','district_id':'d'}, lambda:None).prepare()
                self.assertEqual([p for method,p,_,_ in api.calls if method=='POST' and p.endswith('/plans')], [])
                self.assertEqual(restarted['plans'][scene['plans'][0]['id']]['ids'], ['original'])

    def test_plan_message_is_stable_when_context_receipts_are_outside_latest_page(self):
        from fullchain import FullChain
        messages = []
        for hour in (10, 12, 16):
            scene = full_scene(['uav'])
            scene['plans'] = scene['plans'][:1]
            scene['plans'][0].update(start='11:00', end='14:00')
            now = int(dt.datetime(2027, 3, 9, hour, tzinfo=dt.timezone(dt.timedelta(hours=8))).timestamp()*1000)
            manifest = {'batch':'same-run','created_at':now,'devices':{},'plans':{},'zones':{},
                        'targets':allocate_identities(scene,'same-run')}
            api = FakePlatform()
            FullChain(api,scene,prepared_manifest(scene, manifest),{'owner_org_id':'o','district_id':'d'},lambda:None).prepare()
            messages.append(next(b['message_id'] for _,p,b,_ in api.calls if p.endswith('/plans')))
        self.assertEqual(len(set(messages)), 1)

    def setup_chain(self):
        from fullchain import FullChain
        scene=full_scene()
        manifest={'batch':'sim-unit','created_at':TEST_NOW,'devices':{},'plans':{},'zones':{},
                  'targets':allocate_identities(scene,'sim-unit')}
        platform=FakePlatform()
        chain=FullChain(platform,scene,prepared_manifest(scene, manifest),{'owner_org_id':'o','district_id':'d'},lambda:None,
                        clock=lambda:TEST_NOW)
        return chain,platform,manifest,scene

    def test_preparation_links_plan_identity_without_seed_or_fake_verification(self):
        chain,p,m,s=self.setup_chain(); chain.prepare()
        calls=p.calls
        plans=[b for _,path,b,_ in calls if path.endswith('/plans')]
        for target in s['targets']:
            if target['kind']=='uav' and target.get('planId'):
                self.assertIn(m['targets'][target['id']]['uav_sn'],[b['uav_sn'] for b in plans])
        self.assertTrue(m['realtime_plan_id'])
        self.assertTrue(m['normalized_sources'])
        self.assertTrue(all(row['source_id'] for row in m['normalized_sources'].values()))
        self.assertEqual(m['weather_device']['device_id'],'weather-dev')
        self.assertFalse(any('verifications' in path or '/contacts' in path for _,path,_,_ in calls))

    def test_non_uav_routes_use_separate_support_plan_identity(self):
        chain,p,m,s=self.setup_chain();chain.prepare()
        plans={row['route_version_id']:row for _,path,row,_ in p.calls if path.endswith('/plans')}
        self.assertTrue(all('uav_sn' not in m['targets'][t['id']] for t in s['targets'] if t['kind']!='uav'))
        for target in s['targets']:
            if target['kind']!='uav' and target.get('planId'):
                self.assertNotIn('plan_id',m['targets'][target['id']])
        support=[row['uav_sn'] for row in plans.values() if 'support-uav-p' in row['uav_sn']]
        self.assertTrue(support)
        self.assertTrue(all(serial not in {v.get('uav_sn') for v in m['targets'].values()} for serial in support))

    def test_weather_covers_every_accepted_plan_including_past_and_support_tasks(self):
        chain, platform, manifest, scene = self.setup_chain()
        chain.prepare()
        forecasts = [body for _, path, body, _ in platform.calls if path.endswith('/weather')]
        self.assertEqual({row['plan_id'] for row in forecasts}, set(manifest['plan_expectations']))
        for body in forecasts:
            expected = manifest['plan_expectations'][body['plan_id']]
            self.assertEqual(body['periods'][0]['from'], expected['start_at'])
            self.assertEqual(body['periods'][-1]['to'], expected['end_at'])
        platform.calls.clear()
        chain.prepare()
        self.assertFalse(any(path.endswith('/weather') for _, path, _, _ in platform.calls))

    def test_weather_inputs_never_submit_preset_risk_conclusions(self):
        for wind, visibility in [(3, 12000), (21, 250)]:
            with self.subTest(wind=wind, visibility=visibility):
                chain, platform, manifest, scene = self.setup_chain()
                chain.weather.update(wind_speed_ms=wind, visibility_m=visibility,
                                     longitude=119.12, latitude=36.83)
                chain.prepare()
                chain.tick({}, 0, 1)
                paths = [path for _, path, _, _ in platform.calls]
                self.assertTrue(any(path.endswith('/weather') for path in paths))
                observation = next(body for _, path, body, _ in platform.calls
                                   if path.endswith('/weather-observations'))
                self.assertEqual(observation['wind_speed_ms'], wind)
                self.assertEqual(observation['visibility_m'], visibility)
                self.assertEqual(observation['longitude'], 119.12)
                self.assertFalse(any(path.endswith('/weather-risks') for path in paths),
                                 'Weather inputs must be evaluated by the platform, not preset as risks')

    def test_normalized_observation_uses_batch_external_identity(self):
        chain,p,m,s=self.setup_chain();chain.prepare()
        targets={t['id']:t for t in s['targets']}
        chain.tick(targets,0,1)
        frame=next(body for _,path,body,_ in p.calls if path.endswith('/target-observations'))
        for item in frame['items']:
            key=next(key for key,value in m['targets'].items() if value['external_id']==item['external_target_id'])
            self.assertEqual(item['external_track_id'],item['external_target_id'])
            self.assertEqual('uav_sn' in item,targets[key]['kind']=='uav')

    def test_auxiliary_device_reports_each_target_once(self):
        # 新-17：辅助上报设备（雷达）已经用自己的协议发 MQTT 目标报文，不再从规范化入口重复报同一架无人机；
        # 否则平台把一台设备算成两个数据源，两台设备看到记成 3 个。
        chain,p,m,s=self.setup_chain();chain.prepare()
        targets={t['id']:t for t in s['targets']}
        uavs={m['targets'][t['id']]['external_id'] for t in targets.values()
              if t['kind']=='uav' and t.get('transport')=='normalized' and t.get('secondaryDeviceId')=='radar'}
        self.assertTrue(uavs)
        chain.tick(targets,0,1)
        frames={body['source_id']:{row['external_target_id'] for row in body['items']}
                for _,path,body,_ in p.calls if path.endswith('/target-observations')}
        sources={row['scene_device_id']:row['external_id'] for row in m['devices'].values() if row.get('kind')=='normalized'}
        self.assertTrue(uavs <= frames[sources['tdoa']])
        self.assertFalse(uavs & frames.get(sources.get('radar'), set()))

    def test_auxiliary_device_that_cannot_report_the_kind_keeps_the_normalized_entry(self):
        from fullchain import FullChain
        devices={'r':{'id':'r','kind':'radar'},'t':{'id':'t','kind':'tdoa'}}
        uav={'kind':'uav','transport':'normalized','deviceId':'t','secondaryDeviceId':'r'}
        balloon={'kind':'balloon','transport':'normalized','deviceId':'t','secondaryDeviceId':'r'}
        self.assertEqual(FullChain.normalized_device_ids(uav,devices),['t'])
        # 雷达协议里没有气球类别，辅助设备不发 MQTT，气球照常经规范化入口由两台设备上报。
        self.assertEqual(FullChain.normalized_device_ids(balloon,devices),['t','r'])

    def test_airspace_version_update_keeps_name_and_owner(self):
        # 平台要求空域版本更新保持原名称和归属；改名会被拒（409），整批模拟在第 2 分钟停下。
        chain,p,m,s=self.setup_chain();chain.prepare()
        targets={t['id']:t for t in s['targets']}
        no='sim-map-airspace-zone-temporary_control'
        original=next(body for _,path,body,_ in p.calls if path.endswith('/airspaces') and body.get('airspace_no')==no)
        chain.tick(targets,120,2)
        update=[body for _,path,body,_ in p.calls if path.endswith('/airspaces') and body.get('airspace_no')==no][-1]
        self.assertEqual(update['revision'],original['revision']+1)
        self.assertEqual(update['action'],'UPSERT')
        for key in ('name','owner_org_id','district_id','kind_code','boundary','valid_to'):
            self.assertEqual(update[key],original[key],key)
        # 新-16：新版本须晚于上一版生效，否则平台拒收（409），整批在第 2 分钟停下。
        self.assertEqual(update['valid_from'],TEST_NOW)
        self.assertGreater(update['valid_from'],original['valid_from'])

    def test_notification_stop_suppresses_every_normalized_source_without_stopping_peers(self):
        chain, platform, manifest, scene = self.setup_chain()
        chain.prepare()
        targets = {t['id']: t for t in scene['targets']}
        normalized = [t for t in targets.values() if t.get('transport') == 'normalized']
        self.assertGreater(len(normalized), 1)
        manifest['normalized_sources'] = [dict(manifest['normalized_source'], source_id='stop-source-'+str(i)) for i in range(3)]
        stopped = normalized[0]
        stopped['_notification_motion'] = {'suppress': True, 'origin': stopped['path'][0], 'at_elapsed': 1}
        platform.calls.clear()
        chain.tick(targets, 2, 2)
        frames = [body for _, path, body, _ in platform.calls if path.endswith('/target-observations')]
        self.assertEqual(3, len(frames))
        expected = {manifest['targets'][t['id']]['external_id'] for t in normalized[1:]}
        for frame in frames:
            self.assertEqual(expected, {row['external_target_id'] for row in frame['items']})
        for target in normalized[1:]:
            target['_notification_motion'] = {'suppress': True, 'origin': target['path'][0], 'at_elapsed': 2}
        platform.calls.clear()
        chain.tick(targets, 3, 3)
        self.assertFalse(any(path.endswith('/target-observations') for _, path, _, _ in platform.calls))

    def test_checkpoint_reprepare_does_not_create_other_objects(self):
        chain,p,m,s=self.setup_chain(); chain.prepare(); n=len(p.calls)
        chain.prepare()
        writes=[c for c in p.calls[n:] if c[0]=='POST']
        self.assertEqual(writes,[])

    def test_repeated_batch_reuses_airspace_identity_and_advances_revision(self):
        first_chain, first_platform, first_manifest, scene = self.setup_chain()
        first_chain.prepare()
        first_rows = [body for _, path, body, _ in first_platform.calls if path.endswith('/airspaces')]
        self.assertEqual({row['airspace_no'] for row in first_rows},
                         {'sim-map-airspace-' + zone['id'] for zone in scene['zones']})

        existing = [{'airspace_no': row['airspace_no'], 'revision': row['revision'],
                     'payload': row} for row in first_rows]
        second_scene = copy.deepcopy(scene)
        second_manifest = {'batch':'sim-next', 'created_at':TEST_NOW + 1000, 'devices':{}, 'plans':{}, 'zones':{},
                          'targets':allocate_identities(second_scene,'sim-next')}
        from fullchain import FullChain
        second_platform = FakePlatform(existing)
        second_chain = FullChain(second_platform, second_scene, prepared_manifest(second_scene, second_manifest),
                                 {'owner_org_id':'o','district_id':'d'}, lambda:None,
                                 clock=lambda:TEST_NOW + 1000)
        second_chain.prepare()
        second_rows = [body for _, path, body, _ in second_platform.calls if path.endswith('/airspaces')]
        self.assertEqual([row['airspace_no'] for row in second_rows], [row['airspace_no'] for row in first_rows])
        self.assertEqual({row['revision'] for row in second_rows}, {2})

    def test_new_batch_reuses_routes_but_creates_independent_plans(self):
        first_chain, first_platform, first_manifest, scene = self.setup_chain()
        first_chain.prepare()
        route_posts = [(body, {'route_id':'r'+body['message_id'], 'route_version_id':'v'+body['message_id']})
                       for _, path, body, _ in first_platform.calls if path.endswith('/routes')]
        plan_posts = [body for _, path, body, _ in first_platform.calls if path.endswith('/plans')]
        self.assertTrue(route_posts and plan_posts)
        self.assertTrue(all(body['message_id'].startswith('sim-map-route-') for body, _ in route_posts))
        self.assertTrue(all(body['message_id'].startswith('sim-map-plan-') for body in plan_posts))
        self.assertTrue(all(body['uav_sn'].startswith('map-sim-uav-') or body['uav_sn'].startswith('map-sim-support-uav-')
                            for body in plan_posts))
        context = {
            'routes': [{'route_id': result['route_id'], 'route_version_id': result['route_version_id'],
                        'route_no': body['message_id'], 'name': body['name'], 'valid_from': body['valid_from'],
                        'valid_to': body['valid_to']} for body, result in route_posts],
            'messages': [{'message_id': body['message_id'], 'kind': 'FLIGHT_PLAN',
                          'subject_id': 'p'+body['message_id'], 'payload':copy.deepcopy(body)} for body in plan_posts]
        }
        existing_airspaces = [{'airspace_no': body['airspace_no'], 'revision': body['revision'], 'payload': body}
                              for _, path, body, _ in first_platform.calls if path.endswith('/airspaces')]
        second_scene = copy.deepcopy(scene)
        second_manifest = {'batch':'sim-next', 'created_at':TEST_NOW, 'devices':{}, 'plans':{}, 'zones':{},
                          'targets':allocate_identities(second_scene,'sim-next')}
        from fullchain import FullChain
        second_platform = FakePlatform(existing_airspaces, context, first_platform.route_versions)
        second_chain = FullChain(second_platform, second_scene, prepared_manifest(second_scene, second_manifest),
                                 {'owner_org_id':'o','district_id':'d'}, lambda:None,
                                 clock=lambda:TEST_NOW)
        second_chain.prepare()
        self.assertFalse([row for _, path, row, _ in second_platform.calls if path.endswith('/routes')])
        posted = [row for _, path, row, _ in second_platform.calls if path.endswith('/plans')]
        self.assertEqual(len(posted), len(plan_posts))
        self.assertEqual({row['simulation_batch_id'] for row in posted}, {'sim-next'})
        self.assertTrue({row['message_id'] for row in posted}.isdisjoint(row['message_id'] for row in plan_posts))

    def test_same_task_id_with_another_corridor_gets_its_own_route(self):
        # 新-26：用过的库里已有同一任务编号、走廊不同的模拟航线（例如先跑过别的场景），不能借来用，
        # 否则准备阶段回读航线宽度或高度不一致直接失败；换一条按内容编号的航线，下次同样内容再复用它。
        from fullchain import FullChain
        from prerequisite_check import route_version_mismatch
        first_chain, first_platform, _, scene = self.setup_chain()
        first_chain.prepare()
        context = {'routes': [{'route_id':'r'+body['message_id'], 'route_version_id':'v'+body['message_id'],
                               'route_no':body['message_id'], 'name':body['name'], 'valid_from':body['valid_from'],
                               'valid_to':body['valid_to']}
                              for _, path, body, _ in first_platform.calls if path.endswith('/routes')], 'messages': []}
        changed = copy.deepcopy(scene)
        changed['plans'][0].update(width=changed['plans'][0]['width'] + 30, max=changed['plans'][0]['max'] + 50)
        manifest = {'batch':'sim-changed', 'created_at':TEST_NOW, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(changed,'sim-changed')}
        platform = FakePlatform(input_context=context, route_versions=first_platform.route_versions)
        FullChain(platform, changed, prepared_manifest(changed, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:TEST_NOW).prepare()
        posted = [body for _, path, body, _ in platform.calls if path.endswith('/routes')]
        base = 'sim-map-route-' + changed['plans'][0]['id']
        self.assertEqual(len(posted), 1, '只有走廊变了的那条任务换新航线，其余照旧复用')
        self.assertTrue(posted[0]['message_id'].startswith(base + '-'))
        self.assertEqual(posted[0]['corridor_width_m'], changed['plans'][0]['width'])
        version = manifest['plans'][changed['plans'][0]['id']]['route_version_id']
        self.assertEqual(version, 'v' + posted[0]['message_id'])
        self.assertIsNone(route_version_mismatch(platform.route_versions[version], changed['plans'][0]))

        # 再跑一次同样内容：复用按内容编号的那条，不再新建。
        context['routes'].append({'route_id':'r'+posted[0]['message_id'], 'route_version_id':version,
                                  'route_no':posted[0]['message_id'], 'name':posted[0]['name'],
                                  'valid_from':posted[0]['valid_from'], 'valid_to':posted[0]['valid_to']})
        again = FakePlatform(input_context=context, route_versions=platform.route_versions)
        FullChain(again, changed, prepared_manifest(changed, {'batch':'sim-again', 'created_at':TEST_NOW, 'devices':{}, 'plans':{}, 'zones':{},
                                   'targets':allocate_identities(changed,'sim-again')}),
                  {'owner_org_id':'o','district_id':'d'}, lambda:None, clock=lambda:TEST_NOW).prepare()
        self.assertFalse([body for _, path, body, _ in again.calls if path.endswith('/routes')])

    def test_changed_current_window_gets_new_route_and_plan_message(self):
        from fullchain import FullChain, stable_simulator_id
        scene = full_scene(['uav'])
        scene['plans'][0].update(start='13:00', end='14:32')
        shanghai = dt.timezone(dt.timedelta(hours=8))
        first_now = int(dt.datetime(2026, 10, 4, 17, 7, tzinfo=shanghai).timestamp() * 1000)
        first_manifest = {'batch':'sim-old', 'created_at':first_now, 'devices':{}, 'plans':{}, 'zones':{},
                          'targets':allocate_identities(scene,'sim-old')}
        first_platform = FakePlatform()
        FullChain(first_platform, scene, prepared_manifest(scene, first_manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:first_now).prepare()
        old_route = next(body for _, path, body, _ in first_platform.calls if path.endswith('/routes'))
        old_plan = next(body for _, path, body, _ in first_platform.calls if path.endswith('/plans') and body['uav_sn'] == 'map-sim-uav-normal')
        context = {
            'routes': [{'route_id':'old-route', 'route_version_id':'old-version', 'route_no':old_route['message_id'],
                        'name':old_route['name'], 'valid_from':old_route['valid_from'], 'valid_to':old_route['valid_to']}],
            'messages': [{'message_id':old_plan['message_id'], 'kind':'FLIGHT_PLAN', 'subject_id':'old-plan',
                          'payload':old_plan}]
        }
        second_now = int(dt.datetime(2026, 10, 5, 9, 0, tzinfo=shanghai).timestamp() * 1000)
        second_manifest = {'batch':'sim-new', 'created_at':second_now, 'devices':{}, 'plans':{}, 'zones':{},
                           'targets':allocate_identities(scene,'sim-new')}
        second_platform = FakePlatform(input_context=context, route_versions={
            'old-version': first_platform.route_versions['v' + old_route['message_id']]})
        FullChain(second_platform, scene, prepared_manifest(scene, second_manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:second_now).prepare()
        new_route = next(body for _, path, body, _ in second_platform.calls if path.endswith('/routes'))
        new_plan = next(body for _, path, body, _ in second_platform.calls
                        if path.endswith('/plans') and body['uav_sn'] == 'map-sim-uav-normal')
        self.assertNotEqual(new_route['message_id'], old_route['message_id'])
        # Same corridor, new day: the route is numbered by the task and its new window.
        self.assertEqual(new_route['message_id'], stable_simulator_id(
            'sim-map-route-', f"{scene['plans'][0]['id']}-{new_route['valid_from']}-{new_route['valid_to']}"))
        self.assertNotEqual(new_plan['message_id'], old_plan['message_id'])
        self.assertEqual(new_plan['route_version_id'], 'v' + new_route['message_id'])

    def test_window_route_left_by_another_corridor_is_not_borrowed(self):
        # 新-26：换了一天按时段另建的航线，也可能是别的场景（同一任务编号、走廊不同）先建的，同样不借用。
        from fullchain import FullChain, stable_simulator_id
        scene = full_scene(['uav'])
        scene['plans'][0].update(start='13:00', end='14:32')
        plan_id = scene['plans'][0]['id']
        shanghai = dt.timezone(dt.timedelta(hours=8))
        first_now = int(dt.datetime(2026, 10, 4, 17, 7, tzinfo=shanghai).timestamp() * 1000)
        second_now = int(dt.datetime(2026, 10, 5, 9, 0, tzinfo=shanghai).timestamp() * 1000)

        def run(now, batch, context=None, versions=None):
            platform = FakePlatform(input_context=context, route_versions=versions)
            manifest = {'batch':batch, 'created_at':now, 'devices':{}, 'plans':{}, 'zones':{},
                        'targets':allocate_identities(scene, batch)}
            FullChain(platform, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                      clock=lambda:now).prepare()
            return platform, manifest, next(body for _, path, body, _ in platform.calls if path.endswith('/routes'))

        def saved(body, version):
            return {'route_id':'r' + version, 'route_version_id':version, 'route_no':body['message_id'],
                    'name':body['name'], 'valid_from':body['valid_from'], 'valid_to':body['valid_to']}

        first, _, base = run(first_now, 'sim-old')
        versions = {'base-version': first.route_versions['v' + base['message_id']]}
        context = {'routes': [saved(base, 'base-version')], 'messages': []}
        _, _, window = run(second_now, 'sim-probe', context, copy.deepcopy(versions))
        self.assertEqual(window['message_id'], stable_simulator_id(
            'sim-map-route-', f"{plan_id}-{window['valid_from']}-{window['valid_to']}"))
        versions['window-version'] = dict(versions['base-version'], corridor_width_m=scene['plans'][0]['width'] + 30,
                                          valid_from=window['valid_from'], valid_to=window['valid_to'])
        context['routes'].append(saved(window, 'window-version'))
        _, manifest, created = run(second_now, 'sim-new', context, versions)
        self.assertNotIn(created['message_id'], (base['message_id'], window['message_id']))
        self.assertTrue(created['message_id'].startswith('sim-map-route-' + plan_id + '-'))
        self.assertEqual(created['corridor_width_m'], scene['plans'][0]['width'])
        self.assertEqual(manifest['plans'][plan_id]['route_version_id'], 'v' + created['message_id'])

    def test_plan_retry_uses_payload_key_when_legacy_message_is_not_in_context(self):
        from fullchain import FullChain

        class LegacyMessageCollisionPlatform(FakePlatform):
            def call(self, method, path, body=None, key=None):
                if path.endswith('/plans') and body['message_id'] == 'sim-map-plan-normal-plan-1':
                    raise ValueError('同一消息编号的内容已变化，请使用新编号')
                return super().call(method, path, body, key)

        scene = full_scene(['uav'])
        # Use a valid modern date so timezone/plan offsets cannot cross epoch 0.
        now = 1900000000000
        manifest = {'batch':'sim-retry', 'created_at':now, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene,'sim-retry')}
        platform = LegacyMessageCollisionPlatform()

        FullChain(platform, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:now).prepare()

        plan = next(body for _, path, body, _ in platform.calls if path.endswith('/plans'))
        legacy = 'sim-map-plan-' + scene['plans'][0]['id'] + '-1'
        self.assertNotEqual(plan['message_id'], legacy)
        self.assertTrue(plan['message_id'].startswith(legacy + '-'))
        self.assertRegex(plan['message_id'], r'-[0-9a-f]{12}$')

    def test_route_lookup_preserves_version_window(self):
        from fullchain import FullChain

        class RouteLookupPlatform(FakePlatform):
            def call(self, method, path, body=None, key=None):
                if path.startswith('/routes?'):
                    return {'items': [{'route_id': 'old-route', 'route_no': 'route-old'}]}
                if path.startswith('/routes/old-route/versions'):
                    return {'items': [{'route_version_id': 'old-version', 'valid_from': 1, 'valid_to': 100}]}
                return super().call(method, path, body, key)

        scene = full_scene(['uav'])
        manifest = {'batch':'sim-route', 'created_at':1000, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene,'sim-route')}
        chain = FullChain(RouteLookupPlatform(), scene, prepared_manifest(scene, manifest),
                          {'owner_org_id':'o','district_id':'d'}, lambda:None)
        route = chain.route_record('route-old')
        self.assertEqual(route['valid_to'], 100)
        self.assertIsNone(chain.reusable_route('route-old', 101, 200))

    def test_plan_upload_uses_scene_local_time_window(self):
        from fullchain import FullChain
        scene = full_scene(['uav'])
        scene['plans'][0].update(start='13:00', end='14:32')
        shanghai = dt.timezone(dt.timedelta(hours=8))
        now = int(dt.datetime(2026, 10, 4, 17, 7, tzinfo=shanghai).timestamp() * 1000)
        manifest = {'batch':'sim-time', 'created_at':now, 'devices':{}, 'plans':{}, 'zones':{},
                    'targets':allocate_identities(scene,'sim-time')}
        platform = FakePlatform()
        chain = FullChain(platform, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                          clock=lambda:now)
        chain.prepare()
        body = next(body for _, path, body, _ in platform.calls
                    if path.endswith('/plans') and body['uav_sn'] == 'map-sim-uav-normal')
        expected_start = int(dt.datetime(2026, 10, 4, 13, 0, tzinfo=shanghai).timestamp() * 1000)
        expected_end = int(dt.datetime(2026, 10, 4, 14, 32, tzinfo=shanghai).timestamp() * 1000)
        self.assertEqual(body['start_at'], expected_start)
        self.assertEqual(body['end_at'], expected_end)
        self.assertEqual(body['status_code'], 'COMPLETED')
        route = next(body for _, path, body, _ in platform.calls
                     if path.endswith('/routes') and body['message_id'] == 'sim-map-route-normal-plan')
        self.assertEqual(route['valid_from'], expected_start)
        self.assertEqual(route['valid_to'], expected_end)

    def test_partial_failure_keeps_successful_ids_and_retry_payload(self):
        chain,p,m,s=self.setup_chain()
        original=p.call; once=[True]
        def fail(method,path,body=None,key=None):
            if path.endswith('/plans') and once[0]: once[0]=False; raise ValueError('unavailable')
            return original(method,path,body,key)
        p.call=fail
        with self.assertRaises(ValueError): chain.prepare()
        self.assertTrue(m['fullchain']['requests'])
        with self.assertRaisesRegex(ValueError,'结果未知'): chain.prepare()
        unknown=next(row for row in m['fullchain']['requests'].values() if row['state']=='UNKNOWN')
        p.input_context['messages'].append({'kind':'FLIGHT_PLAN','message_id':'platform-generated-receipt-id',
            'payload':copy.deepcopy(unknown['body']),'state':'ACCEPTED','subject_id':'recovered-plan'})
        chain.prepare()
        self.assertTrue(unknown['recovered_by_readback'])
        route_calls=[c for c in p.calls if c[1].endswith('/routes')]
        self.assertEqual(len(route_calls), len(s['plans']))

    def test_existing_plan_uses_external_id_in_payload_not_receipt_id(self):
        from fullchain import FullChain
        chain,p,m,s=self.setup_chain()
        chain.prepare()
        plans=[body for method,path,body,key in p.calls if path.endswith('/plans')]
        p.input_context['messages']=[{'kind':'FLIGHT_PLAN','message_id':'receipt-'+str(i),
            'subject_id':'saved-'+str(i),'state':'ACCEPTED','payload':copy.deepcopy(body)}
            for i,body in enumerate(plans)]
        second=copy.deepcopy(m)
        second['fullchain']={'requests':{},'coverage':{},'warnings':[]}
        p.calls.clear()
        FullChain(p,s,prepared_manifest(s, second),{'owner_org_id':'o','district_id':'d'},lambda:None).prepare()
        self.assertFalse(any(path.endswith('/plans') for _,path,_,_ in p.calls))
        self.assertTrue(all(pid.startswith('saved-') for entry in second['plans'].values() for pid in entry['ids']))

    def test_time_risks_shift_only_selected_targets_and_route_covers_all_windows(self):
        from engine import compile_scene
        from fullchain import FullChain, SHANGHAI
        scene = full_scene(['uav'])
        plan = scene['plans'][0]
        plan.update(start='11:00', end='13:00')
        target = scene['targets'][0]
        scene.update(plans=[plan], zones=[], risks=[], targets=[
            dict(copy.deepcopy(target), id=key) for key in ('normal', 'early', 'late', 'disabled')])
        for key, mode, enabled in [('early', '开始前提前飞行', True),
                                   ('late', '结束后继续飞行', True),
                                   ('disabled', '结束后继续飞行', False)]:
            scene['risks'].append(dict(id='r-' + key, name=key, type='time', enabled=enabled,
                targetId=key, deviceId=target['deviceId'], planId=plan['id'], mode=mode, offset=5))
        scene, _, _, _ = compile_scene(scene)
        original = copy.deepcopy(scene)
        manifest = dict(batch='sim-shift', created_at=TEST_NOW, devices={}, plans={}, zones={},
                        targets=allocate_identities(scene, 'sim-shift'))
        api = FakePlatform()
        FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None).prepare()
        plans = {b['uav_sn']:b for _, path, b, _ in api.calls if path.endswith('/plans')}
        for key, begin, end, status in [('normal', '11:00', '13:00', 'EXECUTING'),
                                       ('early', '12:05', '14:05', 'PENDING'),
                                       ('late', '09:55', '11:55', 'COMPLETED'),
                                       ('disabled', '11:00', '13:00', 'EXECUTING')]:
            row = plans['map-sim-uav-' + key]
            self.assertEqual(begin, dt.datetime.fromtimestamp(row['start_at']/1000, SHANGHAI).strftime('%H:%M'))
            self.assertEqual(end, dt.datetime.fromtimestamp(row['end_at']/1000, SHANGHAI).strftime('%H:%M'))
            self.assertEqual(status, row['status_code'])
            self.assertEqual(7200000, row['end_at'] - row['start_at'])
        route = next(b for _, path, b, _ in api.calls if path.endswith('/routes'))
        self.assertEqual(plans['map-sim-uav-late']['start_at'], route['valid_from'])
        self.assertEqual(plans['map-sim-uav-early']['end_at'], route['valid_to'])
        self.assertEqual(scene, original)

    def test_time_shift_crosses_midnight_and_rejects_conflicting_offsets(self):
        from fullchain import flight_window, SHANGHAI
        now = int(dt.datetime(2026, 10, 5, 0, 2, tzinfo=SHANGHAI).timestamp() * 1000)
        plan = {'id':'p', 'start':'11:00', 'end':'12:00'}
        target = {'id':'u'}
        risk = dict(enabled=True, type='time', targetId='u', planId='p',
                    mode='结束后继续飞行', offset=5)
        start, end = flight_window(plan, target, [risk], now)
        self.assertEqual('2026-10-04 22:57', dt.datetime.fromtimestamp(start/1000, SHANGHAI).strftime('%Y-%m-%d %H:%M'))
        self.assertEqual('2026-10-04 23:57', dt.datetime.fromtimestamp(end/1000, SHANGHAI).strftime('%Y-%m-%d %H:%M'))
        with self.assertRaisesRegex(ValueError, '冲突'):
            flight_window(plan, target, [risk, dict(risk, mode='开始前提前飞行')], now)
        for offset in (True, 0, 1441, float('nan')):
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                flight_window(plan, target, [dict(risk, offset=offset)], now)

    def test_every_zone_is_delivered_for_the_whole_beijing_day_whatever_the_scene_carries(self):
        from fullchain import FullChain, SHANGHAI
        from engine import compile_scene
        scene = full_scene(['airspaces'])
        # 旧草稿、旧场景文件里区域自带的时分（含手画区域原来的 08:00–18:00 默认）不再生效。
        for zone in scene['zones']:
            zone.update(start='08:00', end='10:00')
        scene['zones'][0].update(start='13:00', end='14:00')
        scene, _, _, _ = compile_scene(scene)
        manifest = dict(batch='sim-zones', created_at=TEST_NOW, devices={}, plans={}, zones={},
                        targets=allocate_identities(scene, 'sim-zones'))
        api = FakePlatform()
        chain = FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                          clock=lambda:TEST_NOW + 130000)
        chain.prepare()
        rows = [b for _, path, b, _ in api.calls if path.endswith('/airspaces')]
        self.assertEqual(len(scene['zones']), len(rows))
        for row in rows:
            self.assertEqual(('2026-10-05 00:00', '2026-10-05 23:59'),
                             tuple(dt.datetime.fromtimestamp(row[field]/1000, SHANGHAI).strftime('%Y-%m-%d %H:%M')
                                   for field in ('valid_from', 'valid_to')))

    def test_a_zone_that_has_run_out_at_the_day_end_skips_the_lifecycle_with_a_note(self):
        from fullchain import FullChain, SHANGHAI
        from engine import compile_scene
        late = int(dt.datetime(2026, 10, 5, 23, 57, tzinfo=SHANGHAI).timestamp() * 1000)
        scene, _, _, _ = compile_scene(full_scene(['airspaces']))
        manifest = dict(batch='sim-late', created_at=late, devices={}, plans={}, zones={},
                        targets=allocate_identities(scene, 'sim-late'))
        api = FakePlatform()
        chain = FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                          clock=lambda:late + 130000)
        chain.prepare()
        rows = [b for _, path, b, _ in api.calls if path.endswith('/airspaces')]
        # 临时管制区 23:59 失效，现在 23:59:10：平台不收已过期的新版本和撤销，跳过并在页面提示，不让整批停下。
        for elapsed in (130, 190, 200):
            chain.tick({}, elapsed, elapsed)
        self.assertEqual(rows, [b for _, path, b, _ in api.calls if path.endswith('/airspaces')])
        self.assertEqual(manifest['fullchain']['warnings'], ['临时管制区已到失效时间，跳过本批次的空域版本更新',
                                                             '临时管制区已到失效时间，跳过本批次的空域撤销'])

    def test_full_scene_airspace_lifecycle_and_a_same_day_rerun_pass_the_platform_order(self):
        # 新-16：空库上一键全量场景第 2 分钟的空域更新曾被拒（409，生效时间必须晚于上次下发），整批停下；
        # 同一天再启动时，已撤销的临时管制区重新下发同样被拒。
        from fullchain import FullChain
        api, clock = AirspaceRulePlatform(), {'now': TEST_NOW}
        no = 'sim-map-airspace-zone-temporary_control'
        for run, start in enumerate((TEST_NOW, TEST_NOW + 3600000), 1):
            scene = full_scene(['airspaces'])
            batch = 'sim-run-' + str(run)
            manifest = {'batch':batch, 'created_at':start, 'devices':{}, 'plans':{}, 'zones':{},
                        'targets':allocate_identities(scene, batch)}
            chain = FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                              clock=lambda:clock['now'])
            clock['now'] = start
            before = len(api.calls)
            chain.prepare()
            published = [b for _, path, b, _ in api.calls[before:] if path.endswith('/airspaces')]
            if run == 1:
                self.assertEqual(5, len(published))
            else:
                # 其他空域原样复用；临时管制区上次已撤销，从现在起重新生效，结束时间不变。
                self.assertEqual([no], [b['airspace_no'] for b in published])
                self.assertEqual((4, start), (published[0]['revision'], published[0]['valid_from']))
            original = api.latest[no]['payload'] if run == 2 else next(b for b in published if b['airspace_no'] == no)
            for elapsed in (119, 120, 150, 180, 181):
                clock['now'] = start + elapsed * 1000
                chain.tick({}, elapsed, elapsed)
            lifecycle = [b for _, path, b, _ in api.calls if path.endswith('/airspaces') and b['airspace_no'] == no][-2:]
            self.assertEqual([('UPSERT', start + 120000, original['valid_to']), ('WITHDRAW', start + 180000, None)],
                             [(b['action'], b.get('valid_from', b.get('effective_at')), b.get('valid_to')) for b in lifecycle])
            self.assertEqual([], manifest['fullchain']['warnings'])

    def test_changed_zone_follows_the_last_delivery_and_a_delivery_at_the_day_end_says_why_not(self):
        from fullchain import FullChain, SHANGHAI
        from engine import compile_scene
        scene, _, _, _ = compile_scene(full_scene(['airspaces']))
        zone = scene['zones'][-1]
        no = 'sim-map-airspace-' + zone['id']
        eight = TEST_NOW - 4 * 3600000
        day_end = int(dt.datetime(2026, 10, 5, 23, 59, tzinfo=SHANGHAI).timestamp() * 1000)

        def prepare(last):
            api = AirspaceRulePlatform()
            api.latest[no] = dict(last, airspace_no=no)
            api.version_from[no], api.valid_to[no] = eight, day_end
            manifest = dict(batch='sim-edit', created_at=TEST_NOW, devices={}, plans={}, zones={},
                            targets=allocate_identities(scene, 'sim-edit'))
            FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                      clock=lambda:TEST_NOW).prepare()
            return next(b for _, path, b, _ in api.calls if path.endswith('/airspaces') and b['airspace_no'] == no)

        # 改过区域、上次下发在早上 8 点：从现在起生效，当天 23:59 止，平台照收。
        changed = {'action':'UPSERT', 'revision':1, 'state':'ACCEPTED', 'airspace_id':'a', 'airspace_version_id':'v',
                   'payload':{'valid_from':eight, 'valid_to':day_end, 'boundary':'旧区域'}}
        body = prepare(changed)
        self.assertEqual((2, TEST_NOW, day_end), (body['revision'], body['valid_from'], body['valid_to']))
        # 上次的下发或撤销已到当天末尾或更晚（含手动排到了明天）：说清楚是哪一条、怎么办，不发请求。
        for action, key, effective, shown in (('WITHDRAW', 'effective_at', day_end - 500, '10月05日 23:58'),
                                              ('UPSERT', 'valid_from', day_end + 8 * 3600000 + 60000, '10月06日 08:00')):
            last = {'action':action, 'revision':2, 'state':'ACCEPTED', 'airspace_id':'a', 'airspace_version_id':'v',
                    'payload':{key:effective}}
            with self.subTest(shown=shown), self.assertRaisesRegex(
                    ValueError, '临时管制区」已经有一条生效时间排在 ' + shown + ' 的下发、撤销或平台上的修改.*空域下发.*次日零点'):
                prepare(last)

    def test_starting_in_the_evening_after_a_manual_delivery_is_not_blocked(self):
        # 现场：北京时间傍晚开始模拟，之前在「空域下发」手动发过一条（生效 18:16），场景里区域还带着老默认 08:00–18:00。
        # 以前会被「今天已下发到结束时间」挡住，或者发出去一个已过期的区域；现在全天有效，从现在起生效。
        from fullchain import FullChain, SHANGHAI
        from engine import compile_scene
        raw = full_scene(['airspaces'])
        for zone in raw['zones']:
            zone.update(start='08:00', end='18:00')
        scene, _, _, _ = compile_scene(raw)
        no = 'sim-map-airspace-' + scene['zones'][0]['id']
        at = lambda hour, minute, second=0: int(dt.datetime(2026, 10, 5, hour, minute, second, tzinfo=SHANGHAI).timestamp() * 1000)
        api = AirspaceRulePlatform()
        manual = {'action':'UPSERT', 'revision':1, 'state':'ACCEPTED', 'airspace_id':'a', 'airspace_version_id':'v',
                  'payload':{'valid_from':at(18, 16, 9), 'valid_to':None, 'boundary':'手动下发的边界'}}
        api.latest[no] = dict(manual, airspace_no=no)
        api.version_from[no], api.valid_to[no] = at(18, 16, 9), None
        manifest = dict(batch='sim-evening', created_at=at(18, 30), devices={}, plans={}, zones={},
                        targets=allocate_identities(scene, 'sim-evening'))
        FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:at(18, 30)).prepare()
        rows = [b for _, path, b, _ in api.calls if path.endswith('/airspaces')]
        self.assertEqual(len(scene['zones']), len(rows))
        for row in rows:
            if row['airspace_no'] == no:
                self.assertEqual((2, at(18, 30), at(23, 59)), (row['revision'], row['valid_from'], row['valid_to']))
            else:
                # 第一次下发的区域不是已过期的：当天 00:00 起、23:59 止，晚上开始也在生效期内。
                self.assertEqual((at(0, 0), at(23, 59)), (row['valid_from'], row['valid_to']))
                self.assertGreater(row['valid_to'], at(18, 30))

    def test_a_version_saved_in_the_platform_after_the_last_delivery_does_not_block_the_start(self):
        # 现场 10-29：流程 1 的禁飞区 10-27 已撤销；之后有人在平台「空域管理」里保存过一个新版本（生效时间在今天 0 点之后）。
        # 模拟器只看自己的回执，按今天 0 点下发，被平台以「新版本生效时间必须晚于上一版本」拒收（409），流程起不来。
        # 现在先读平台上最新版本的生效时间，下发从现在起生效。
        from fullchain import FullChain, SHANGHAI
        from engine import compile_scene
        scene, _, _, _ = compile_scene(full_scene(['airspaces']))
        no = 'sim-map-airspace-' + scene['zones'][0]['id']
        at = lambda day, hour, minute: int(dt.datetime(2026, 10, day, hour, minute, tzinfo=SHANGHAI).timestamp() * 1000)
        api = AirspaceRulePlatform()
        api.latest[no] = {'action':'WITHDRAW', 'revision':4, 'state':'ACCEPTED', 'airspace_id':'a', 'airspace_version_id':'v',
                          'airspace_no':no, 'payload':{'effective_at':at(3, 15, 43)}}
        saved_in_platform = TEST_NOW - 10 * 60000
        api.version_from[no], api.valid_to[no] = saved_in_platform, None
        manifest = dict(batch='sim-platform-edit', created_at=TEST_NOW, devices={}, plans={}, zones={},
                        targets=allocate_identities(scene, 'sim-platform-edit'))
        FullChain(api, scene, prepared_manifest(scene, manifest), {'owner_org_id':'o','district_id':'d'}, lambda:None,
                  clock=lambda:TEST_NOW).prepare()
        body = next(b for _, path, b, _ in api.calls if path.endswith('/airspaces') and b and b['airspace_no'] == no)
        self.assertEqual((5, TEST_NOW), (body['revision'], body['valid_from']))
        self.assertIn(('GET', '/airspaces/a/versions?page=1&size=1', None, None), api.calls)


class AirspaceRulePlatform(FakePlatform):
    """Accept airspace deliveries only in the order UpstreamAirspaceService does."""
    def __init__(self):
        super().__init__()
        self.latest, self.version_from, self.valid_to = {}, {}, {}

    def call(self, method, path, body=None, key=None):
        from fullchain import airspace_effective_at
        if path.endswith('/airspaces/context'):
            self.calls.append((method, path, copy.deepcopy(body), key))
            return {'items': copy.deepcopy(list(self.latest.values()))}
        if method == 'GET' and path.startswith('/airspaces/') and '/versions' in path:
            self.calls.append((method, path, copy.deepcopy(body), key))
            airspace_id = path.split('/')[2]
            no = next((n for n, row in self.latest.items() if row.get('airspace_id') == airspace_id), None)
            return {'items': [{'valid_from': self.version_from[no]}] if no in self.version_from else []}
        if method == 'POST' and path.endswith('/airspaces'):
            no, last = body['airspace_no'], self.latest.get(body['airspace_no'])
            if last and body['revision'] <= last['revision']:
                raise AssertionError('409 UPSTREAM_REVISION_CONFLICT')
            if body['action'] == 'UPSERT':
                if body.get('valid_to') is not None and body['valid_from'] >= body['valid_to']:
                    raise AssertionError('400 INVALID_VALIDITY')
                if last and (body['valid_from'] <= airspace_effective_at(last) or body['valid_from'] <= self.version_from[no]):
                    raise AssertionError('409 VERSION_OVERLAP 生效时间必须晚于上次下发的生效/撤销时间')
                self.version_from[no], self.valid_to[no] = body['valid_from'], body.get('valid_to')
            else:
                if not last or last['action'] == 'WITHDRAW':
                    raise AssertionError('409 INVALID_TRANSITION')
                if body['effective_at'] <= self.version_from[no] or body['effective_at'] <= airspace_effective_at(last):
                    raise AssertionError('409 VERSION_OVERLAP 撤销时间必须晚于最新版本生效时间')
                if self.valid_to[no] is not None and body['effective_at'] >= self.valid_to[no]:
                    raise AssertionError('409 INVALID_TRANSITION 撤销时间必须早于原失效时间')
            self.latest[no] = {'message_id':'receipt-'+body['message_id'], 'airspace_id':'a'+no, 'airspace_no':no,
                               'airspace_version_id':'av'+str(body['revision']), 'revision':body['revision'],
                               'action':body['action'], 'state':'ACCEPTED', 'source_mode':'replay',
                               'received_at':0, 'payload':copy.deepcopy(body)}
        return super().call(method, path, body, key)


if __name__=='__main__': unittest.main()
