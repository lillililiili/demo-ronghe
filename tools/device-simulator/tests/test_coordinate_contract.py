import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from coordinate_contract import simulator_wgs84
from engine import compile_scene, messages
from plan_weather import plan_forecast
from test_engine import scene
from test_eo_observations import ObservationsTest

class CoordinateContractTests(unittest.TestCase):
    def test_normalized_registration_and_publishing_carry_declarations(self):
        from full_scenario import full_scene, allocate_identities
        from fullchain import FullChain
        from test_fullchain import FakePlatform, prepared_manifest, TEST_NOW
        for source_count in (None, 2):
            scenario = full_scene(['uav', 'bird', 'weather'])
            if source_count is not None:
                scenario['fullchain']['observationSourceCount'] = source_count
            scenario, _, targets, _ = compile_scene(scenario)
            manifest = {'batch': 'coordinate-check-' + str(source_count), 'created_at': TEST_NOW,
                        'devices': {}, 'plans': {}, 'zones': {},
                        'targets': allocate_identities(scenario, 'coordinate-check')}
            api = FakePlatform()
            chain = FullChain(api, scenario, prepared_manifest(scenario, manifest),
                              {'owner_org_id': 'org', 'district_id': 'district'}, lambda: None)
            chain.prepare()
            chain.tick(targets, 0, 1)
            checked = set()
            for method, path, body, _ in api.calls:
                if method != 'POST':
                    continue
                kind = path.rsplit('/', 1)[-1]
                if kind in ('observation-devices', 'weather-devices', 'weather-observations', 'target-observations'):
                    self.assertEqual(body.get('coordinate_system'), 'WGS84', path)
                    checked.add(kind)
                if kind == 'plans':
                    self.assertEqual(body['filing'].get('coordinate_system'), 'WGS84')
            self.assertTrue({'observation-devices', 'weather-devices', 'weather-observations', 'target-observations'} <= checked)

    def test_airport_and_protected_target_are_explicit_wgs84(self):
        import mock_airport
        from test_mock_airport import AirportPlatform, SCOPE
        api = AirportPlatform()
        mock_airport.ensure(api, SCOPE)
        for path, body in api.posts():
            if path == '/airports' or path.endswith('/protected-targets'):
                self.assertEqual(body['coordinate_system'], 'WGS84')

    def test_explicit_wrong_scene_and_manual_radar_are_rejected_before_side_effects(self):
        from types import SimpleNamespace
        from tcp_radar import TcpRadar
        for declaration in ('GCJ02', 'BD09', 'CGCS2000', '', None):
            scenario = scene()
            scenario['coordinate_system'] = declaration
            with self.assertRaises(ValueError):
                compile_scene(scenario)
            radar = TcpRadar(SimpleNamespace(platform=None), port=0, manual=True)
            with self.assertRaises(ValueError):
                radar.start({'longitude': 110, 'latitude': 25, 'coordinate_system': declaration})
            self.assertIsNone(radar.listener)

    def test_documented_scene_defaults_and_explicit_aliases(self):
        self.assertEqual(simulator_wgs84({}), 'WGS84')
        for alias in ('WGS84', 'WGS-84', 'wgs84'):
            self.assertEqual(simulator_wgs84({'coordinate_system': alias}), 'WGS84')

    def test_explicit_foreign_blank_and_conflicting_declarations_are_not_relabelled(self):
        for value in ('GCJ02', 'BD09', 'CGCS2000', '', ' ', None, 4326, 'prefixWGS84'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                simulator_wgs84({'coordinate_system': 'WGS84'}, {'coordinateSystem': value})

    def test_current_mqtt_generator_declares_work_parameters_targets_and_pilot_basis(self):
        for point in ([450, 300], [510, 280]):
            source = scene()
            source['sites'][0].update(x=point[0], y=point[1])
            source['targets'][0]['pilotPoint'] = point
            compiled, devices, targets, _ = compile_scene(source)
            manifest = {'provider': 'test', 'devices': {'d1': {'external_id': 'external'}},
                        'targets': {'t1': {'uav_sn': 'TEST'}}}
            packets = messages(compiled, devices, targets, manifest, .01, 1700000000000, {}, 1)
            self.assertTrue(packets)
            for _, payload in packets:
                self.assertEqual(payload['coordinate_system'], 'WGS84')
                for target in payload.get('objects', []):
                    self.assertEqual(target['coordinate_system'], 'WGS84')
            targets['t1']['coordinate_system'] = 'GCJ02'
            with self.assertRaises(ValueError):
                messages(compiled, devices, targets, manifest, .01, 1700000000001, {}, 2)

    def test_optical_generator_declares_its_own_measurement(self):
        fixture = ObservationsTest()
        fixture.setUp()
        value = fixture.generator.observation({'source_links': fixture.links}, {})
        self.assertEqual(value['coordinate_system'], 'WGS84')
        fixture.target['coordinate_system'] = 'BD09'
        with self.assertRaises(ValueError):
            fixture.generator.observation({'source_links': fixture.links}, {})

    def test_forecast_preserves_polygon_and_rejects_explicit_foreign_source(self):
        start = 1800000000000
        plan = {'start_at': start, 'end_at': start + 60000, 'source_mode': 'replay'}
        weather = {'polygon': [[110, 25], [111, 25], [111, 26], [110, 25]]}
        before = copy.deepcopy(weather)
        payload = plan_forecast('new-batch', 'new-plan', plan, weather, start)
        self.assertEqual(payload['coordinate_system'], 'WGS84')
        self.assertEqual(payload['polygon'], before['polygon'])
        self.assertEqual(weather, before)
        weather['coordinate_system'] = 'CGCS2000'
        with self.assertRaises(ValueError):
            plan_forecast('new-batch', 'new-plan', plan, weather, start)
