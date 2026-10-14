import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog_reconciliation as catalog
from platform_client import Platform as Client, PlatformError


class Platform:
    def __init__(self):
        self.rows = {}
        self.calls = []
        self.fail_page = False
        self.old_backend = False

    def add(self, identity, **changes):
        row = dict(device_id=identity, device_no='external-' + identity, enabled=True,
                   version=2, source_mode='replay', simulated=True, owner_org_id='org',
                   district_id='district', vendor='地图场景模拟器', model='MQTT-SIM')
        row.update(changes)
        self.rows[identity] = row
        return row

    def call(self, method, path, body=None, key=None):
        self.calls.append((method, path, copy.deepcopy(body), key))
        if path.startswith('/devices?'):
            rows = list(self.rows.values())
            return dict(items=copy.deepcopy(rows[:1] if self.fail_page else rows), total=len(rows))
        identity = path.split('/')[2]
        row = self.rows[identity]
        if path.endswith('/catalog-blockers'):
            if self.old_backend:
                raise PlatformError('系统接口 ' + path + ' 返回 404：资源不存在', 404, 'NOT_FOUND', '资源不存在')
            return dict(device_id=identity, device_no=row['device_no'], reasons=list(row.get('reasons') or []))
        if path.endswith('/protocol-status'):
            return dict(details=dict(broker_id=row.get('broker', 'broker'),
                                     provider_code=None if row.get('eo') else 'map-sim',
                                     edge_id=row['device_no'] + '-edge', external_device_id=row['device_no']))
        if method == 'GET':
            return dict(device=copy.deepcopy(row), external_device_id=row['device_no'],
                        protocol_code='EO_EDGE_MQTT_20250826' if row.get('eo') else 'LINGYUN_MQTT_V8_6')
        if row['version'] != body['version']:
            raise PlatformError('409 version', 409, 'VERSION_CONFLICT', '设备已被更新，请刷新后重试')
        if method == 'PATCH':
            row.update(enabled=body['enabled'], version=row['version'] + 1)
            return dict(device=copy.deepcopy(row))
        if row.get('busy'):
            # A busy delete rolls back: the record stays exactly as it was before the call.
            raise PlatformError('409 busy', 409, 'DEVICE_BUSY', '设备 ' + row['device_no'] + ' 还有没结束的工作：'
                                + '、'.join(row['busy']) + '。请处理完再删除')
        del self.rows[identity]
        return dict(device_id=identity)


class CatalogReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.api = Platform()
        self.api.add('current')
        self.api.add('old')
        self.broker = dict(broker_id='broker', owner_org_id='org', district_id='district', source_mode='replay')
        self.current = {'logical': {'platform_id': 'current', 'external_id': 'external-current'}}

    def plan(self):
        return catalog.plan(self.api, self.broker, self.current)

    def test_stale_scene_removed_with_disable_delete_and_current_kept(self):
        plan = self.plan()
        self.assertEqual([r['device_id'] for r in plan['retire']], ['old'])
        self.assertFalse(any(c[0] != 'GET' for c in self.api.calls))
        result = catalog.apply(self.api, plan)
        self.assertEqual(result['retired'], ['old'])
        self.assertEqual(result['retired_devices'], [dict(device_id='old', device_no='external-old', name=None)])
        self.assertEqual(result['skipped'], [])
        writes = [c for c in self.api.calls if c[0] != 'GET']
        self.assertEqual([c[0] for c in writes], ['PATCH', 'DELETE'])
        self.assertEqual([c[2]['version'] for c in writes], [2, 3])
        self.assertEqual(set(self.api.rows), {'current'})
        self.assertEqual(catalog.apply(self.api, self.plan())['retired'], [])

    def test_real_other_broker_other_scope_and_unknown_provenance_untouched(self):
        for identity, changes in [('live', dict(source_mode='live', simulated=False)),
                                  ('other-broker', dict(broker='other')),
                                  ('other-scope', dict(owner_org_id='other')),
                                  ('unknown', dict(vendor='manufacturer')),
                                  ('seed', dict(source_mode='mock'))]:
            self.api.add(identity, **changes)
        self.assertEqual([r['device_id'] for r in self.plan()['retire']], ['old'])

    def test_wrong_database_current_ids_abort_before_mutation(self):
        self.current['logical']['platform_id'] = 'foreign-id'
        with self.assertRaises(ValueError): self.plan()
        self.assertTrue(all(c[0] == 'GET' for c in self.api.calls))

    def test_current_identity_change_aborts(self):
        self.current['logical']['external_id'] = 'different'
        with self.assertRaises(ValueError): self.plan()

    def test_empty_or_non_replay_scope_cannot_remove_devices(self):
        self.current.clear()
        with self.assertRaises(ValueError): self.plan()
        self.broker['source_mode'] = 'live'
        with self.assertRaises(ValueError): self.plan()

    def test_incomplete_or_duplicate_pagination_aborts_before_writes(self):
        self.api.fail_page = True
        with self.assertRaises(ValueError): self.plan()
        self.assertTrue(all(c[0] == 'GET' for c in self.api.calls))

    def test_version_changed_since_preview_is_not_disabled(self):
        plan = self.plan()
        self.api.rows['old']['version'] += 1
        with self.assertRaisesRegex(ValueError, 'external-old'): catalog.apply(self.api, plan)
        self.assertTrue(self.api.rows['old']['enabled'])

    def test_busy_device_is_left_switched_on_reported_and_the_start_goes_on(self):
        # 2026-10-14 用户确认方案 A：正忙的设备不停用、不退役、不让启动失败，说清是哪台、为什么。
        self.api.add('busy', name='模拟 光电 01', reasons=['光电跟踪任务还没结束'])
        result = catalog.apply(self.api, self.plan())
        self.assertEqual(result['retired'], ['old'])
        self.assertEqual(result['skipped'], [dict(device_id='busy', device_no='external-busy', name='模拟 光电 01',
                                                  reasons=['光电跟踪任务还没结束'])])
        self.assertTrue(self.api.rows['busy']['enabled'])
        self.assertEqual(self.api.rows['busy']['version'], 2)
        self.assertFalse(any(c[0] != 'GET' and '/busy' in c[1] for c in self.api.calls))

    def test_device_turning_busy_after_the_check_is_switched_back_on_and_reported(self):
        self.api.rows['old'].update(busy=['反制正在执行'], name='模拟 反制 01')
        result = catalog.apply(self.api, self.plan())
        writes = [(c[0], c[2]['enabled'] if c[0] == 'PATCH' else None) for c in self.api.calls if c[0] != 'GET']
        self.assertEqual(writes, [('PATCH', False), ('DELETE', None), ('PATCH', True)])
        self.assertEqual(result['retired'], [])
        self.assertEqual(result['skipped'][0]['device_no'], 'external-old')
        self.assertTrue(result['skipped'][0]['reasons'])
        self.assertTrue(self.api.rows['old']['enabled'])

    def test_already_switched_off_busy_device_is_not_switched_on(self):
        self.api.rows['old'].update(enabled=False, busy=['有未完成的设备指令'])
        result = catalog.apply(self.api, self.plan())
        self.assertEqual([c[0] for c in self.api.calls if c[0] != 'GET'], ['DELETE'])
        self.assertFalse(self.api.rows['old']['enabled'])
        self.assertEqual(result['skipped'][0]['device_id'], 'old')

    def test_older_platform_without_busy_check_still_retires(self):
        self.api.old_backend = True
        self.assertEqual(catalog.apply(self.api, self.plan())['retired'], ['old'])

    def test_older_platform_busy_delete_is_reported_with_its_message(self):
        self.api.old_backend = True
        self.api.rows['old']['busy'] = ['有进行中的调测任务']
        result = catalog.apply(self.api, self.plan())
        self.assertIn('有进行中的调测任务', result['skipped'][0]['reasons'][0])
        self.assertTrue(self.api.rows['old']['enabled'])

    def test_other_delete_failure_names_the_device(self):
        self.api.rows['old']['name'] = '模拟 雷达 02'
        original = self.api.call

        def refuse_delete(method, path, body=None, key=None):
            if method == 'DELETE':
                raise PlatformError('409', 409, 'VERSION_CONFLICT', '设备已被更新，请刷新后重试')
            return original(method, path, body, key)
        self.api.call = refuse_delete
        with self.assertRaisesRegex(ValueError, 'external-old（模拟 雷达 02）.*设备已被更新.*已被停用'):
            catalog.apply(self.api, self.plan())

    def test_renamed_devices_are_managed_by_identity_not_display_name(self):
        self.api.rows['old']['name'] = '现场验收设备 X'
        self.assertEqual([r['device_id'] for r in self.plan()['retire']], ['old'])

    def test_eo_protocol_uses_edge_identity_not_lingyun_provider(self):
        self.api.rows['current']['eo'] = True
        self.api.rows['old']['eo'] = True
        self.assertEqual([r['device_id'] for r in self.plan()['retire']], ['old'])

    def test_prepare_synchronizes_only_after_every_registration_succeeds(self):
        client = Client('http://127.0.0.1:8081/api/v1')
        client._onboard_or_reuse = Mock(return_value={'device': {'device_id': 'new'}})
        client._sync_sensing_profile = Mock(side_effect=lambda record, *_: record)
        devices = {'a': dict(kind='radar', x=1, y=1, name='A')}
        manifest = {'provider': 'map-sim', 'devices': {}}
        with patch.object(catalog, 'plan', return_value={'retire': []}) as prepare, \
                patch.object(catalog, 'apply', return_value={'retired': []}) as execute:
            client.prepare_devices(devices, self.broker, manifest, lambda: None)
            prepare.assert_called_once_with(client, self.broker, manifest['devices'])
            execute.assert_called_once()
        client._onboard_or_reuse.side_effect = ValueError('registration failed')
        with patch.object(catalog, 'plan') as prepare:
            with self.assertRaises(ValueError):
                client.prepare_devices(devices, self.broker, {'provider': 'map-sim', 'devices': {}}, lambda: None)
            prepare.assert_not_called()

    def test_prepare_keeps_normalized_fusion_sources_out_of_ops_catalog(self):
        client = Client('http://127.0.0.1:8081/api/v1')
        client._onboard_or_reuse = Mock(return_value={'device': {'device_id': 'current'}})
        client._sync_sensing_profile = Mock(side_effect=lambda record, *_: record)
        devices = {'a': dict(kind='radar', x=1, y=1, name='A')}
        source = {'kind': 'normalized', 'platform_id': 'fusion-only', 'external_id': 'source-only'}
        manifest = {'provider': 'map-sim', 'devices': {'normalized-a': source}}
        with patch.object(catalog, 'plan', return_value={'retire': []}) as prepare, \
                patch.object(catalog, 'apply', return_value={'retired': []}):
            client.prepare_devices(devices, self.broker, manifest, lambda: None)
        self.assertEqual(set(prepare.call_args.args[2]), {'a'})
        self.assertEqual(manifest['devices']['normalized-a'], source)


if __name__ == '__main__': unittest.main()
