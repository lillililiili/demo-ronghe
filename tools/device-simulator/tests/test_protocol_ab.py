import copy
import json
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import compile_scene, messages
from full_scenario import allocate_identities
from protocol_b import COMMANDS, ProtocolBResponder, validate_config
from test_engine import scene


def wait_for(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        time.sleep(.01)
    if not predicate():
        raise AssertionError('response deadline exceeded')


class ProtocolATests(unittest.TestCase):
    def packets(self, kind, configure=lambda s: None, elapsed=0, sequence=1):
        raw = scene()
        raw['sites'][0]['devices'][0]['kind'] = kind
        raw['targets'][0]['path'] = [[460, 300], [470, 300]]
        raw['targets'][0]['uavSn'] = 'SIM-SN-ONE'
        raw['targets'][0]['pilotPoint'] = [450, 305]
        configure(raw)
        compiled, devices, targets, _ = compile_scene(raw)
        manifest = {'provider': 'test', 'batch': 'sim-test', 'devices': {'d1': {'external_id': 'dev-1'}},
                    'targets': allocate_identities(compiled, 'sim-test')}
        return messages(compiled, devices, targets, manifest, elapsed, 1000000, {}, sequence)

    def test_six_families_have_distinct_contracts(self):
        for kind, code in [('radar', 1), ('5ga', 0), ('tdoa', 10), ('aoa', 9), ('dcd', 11), ('rid', 102)]:
            with self.subTest(kind=kind):
                packets = self.packets(kind)
                self.assertEqual(packets[0][1]['deviceType'], code)
                ext = packets[1][1]['objects'][0]['extension']
                self.assertEqual(ext.get('uavSN'), 'SIM-SN-ONE' if kind in ('tdoa', 'dcd', 'rid') else None)
                self.assertEqual('uavModel' in ext, kind in ('tdoa', 'aoa', 'dcd', 'rid'))
                self.assertEqual('channel' in ext, kind in ('tdoa', 'aoa', 'dcd'))
                self.assertEqual('pilotLon' in ext, kind in ('tdoa', 'aoa', 'dcd', 'rid'))
                self.assertEqual('speedX' in ext, kind in ('radar', '5ga'))
                self.assertEqual('taskId' in ext, kind == '5ga')
                if kind == 'aoa': self.assertAlmostEqual(ext['direction'], 90)

    def test_tdoa_model_without_serial_and_required_serial_for_dcd_rid(self):
        for kind in ('tdoa', 'dcd', 'rid'):
            packets = self.packets(kind, lambda s: s['targets'][0].update(protocolA={'uavModel': 'SAME', 'reportSn': False}))
            ext = packets[1][1]['objects'][0]['extension']
            self.assertEqual(ext['uavModel'], 'SAME')
            self.assertEqual('uavSN' in ext, kind != 'tdoa')

    def test_idle_frames_and_silence_do_not_stop_heartbeats(self):
        def empty(s):
            s['targets'] = []; s['risks'] = []
            s['sites'][0]['devices'][0]['emitEmpty'] = True
        self.assertEqual(self.packets('radar', empty)[1][1]['objects'], [])
        packets = self.packets('tdoa', lambda s: s['targets'][0].update(silenceWindows=[{'at': 0, 'seconds': 10}]))
        self.assertEqual(len(packets), 1)
        self.assertIn('/device/', packets[0][0])

    def test_counter_wrap_and_source_task_is_shared_by_frame(self):
        packets = self.packets('5ga', lambda s: s['targets'].append({**copy.deepcopy(s['targets'][0]), 'id': 't2'}), sequence=2147483648)
        self.assertEqual(packets[1][1]['msgCnt'], 0)
        self.assertEqual(len({o['extension']['taskId'] for o in packets[1][1]['objects']}), 1)

    def test_unsupported_primary_type_and_invalid_protocol_fields_reject(self):
        for configure in (lambda s: s['targets'][0].update(kind='bird'),
                          lambda s: s['targets'][0].update(protocolA={'reportSn': 'false'}),
                          lambda s: s['targets'][0].update(protocolA={'uavModel': ''})):
            with self.assertRaises(ValueError): self.packets('rid', configure)


class ProtocolBTests(unittest.TestCase):
    def setup_responder(self, kind='ifr', cfg=None):
        self.active = True
        self.output, self.logs = [], []
        manifest = {'source_mode': 'replay', 'provider': 'test', 'devices': {'d': {'kind': kind, 'external_id': 'ext'}}}
        responder = ProtocolBResponder(manifest, {'d': {'kind': kind, 'protocolB': cfg or {}}},
            lambda topic, payload: self.output.append((topic, copy.deepcopy(payload))),
            lambda *args, **kwargs: self.logs.append((args, kwargs)), lambda: self.active)
        self.addCleanup(responder.suspend)
        return responder, next(iter(responder.bindings))

    def command(self, cmd=60003, msg='LY-current', operation=1):
        return json.dumps({'head': {'msgNo': msg, 'deviceId': 'ext', 'time': 1},
            'data': {'operationType': operation, 'operationCmd': cmd,
                     **({'operationParams': {'targetId': 'target'}} if cmd in (30002, 50005) and operation != 0 else {})}}).encode()

    def test_all_seventeen_whitelisted_commands_echo_identity_and_operation(self):
        for cmd, kind in COMMANDS.items():
            with self.subTest(cmd=cmd):
                worker, topic = self.setup_responder(kind)
                for operation in (0, 1, 2):
                    worker.enqueue(topic, self.command(cmd, 'LY-' + str(operation), operation))
                wait_for(lambda: len(self.output) == 3)
                self.assertEqual([v[1]['data']['operationType'] for v in self.output], [0, 1, 2])
                self.assertTrue(all(v[1]['data']['operationCmd'] == cmd and v[1]['data']['code'] == 0 for v in self.output))
                self.assertTrue(all('/device_control_resp/' in v[0] for v in self.output))
                worker.suspend()

    def test_failed_and_silent_outcomes(self):
        worker, topic = self.setup_responder(cfg={'response': 'failure'})
        worker.enqueue(topic, self.command())
        wait_for(lambda: len(self.output) == 1)
        self.assertEqual(self.output[0][1]['data']['code'], 1)
        self.assertTrue(self.output[0][1]['data']['msg'])
        worker.suspend()
        worker, topic = self.setup_responder(cfg={'response': 'no_receipt'})
        worker.enqueue(topic, self.command()); worker.enqueue(topic, self.command())
        time.sleep(.15)
        self.assertEqual(self.output, [])
        self.assertEqual(worker.snapshot()['commands'], 1)

    def test_delayed_pause_resume_and_stop(self):
        worker, topic = self.setup_responder(cfg={'delayMs': 80})
        worker.enqueue(topic, self.command()); self.active = False
        time.sleep(.15)
        self.assertEqual(self.output, [])
        self.active = True
        wait_for(lambda: len(self.output) == 1)
        worker.enqueue(topic, self.command(msg='LY-stopped')); worker.suspend()
        time.sleep(.1)
        self.assertEqual(len(self.output), 1)
        self.assertFalse(worker.thread.is_alive())

    def test_duplicates_reuse_first_result_and_conflicts_never_execute(self):
        worker, topic = self.setup_responder(cfg={'delayMs': 50, 'duplicateCount': 1})
        worker.enqueue(topic, self.command()); worker.enqueue(topic, self.command())
        self.assertFalse(worker.enqueue(topic, self.command(operation=0)))
        wait_for(lambda: len(self.output) == 2)
        self.assertEqual(worker.snapshot()['commands'], 1)
        original = copy.deepcopy(self.output[0])
        worker.enqueue(topic, self.command())
        wait_for(lambda: len(self.output) == 4)
        self.assertEqual(self.output[2], original)

    def test_pause_at_network_gate_preserves_unsent_response_and_new_run_has_no_old_work(self):
        worker, topic = self.setup_responder()
        gate = []
        publish = worker.publish
        def pause_before_send(t, payload):
            gate.append(True)
            self.active = False
            return False
        worker.publish = pause_before_send
        worker.enqueue(topic, self.command())
        wait_for(lambda: bool(gate))
        self.assertEqual(self.output, [])
        worker.publish = publish
        self.active = True
        wait_for(lambda: len(self.output) == 1)
        worker.suspend()
        fresh, _ = self.setup_responder()
        time.sleep(.15)
        self.assertEqual(fresh.snapshot()['commands'], 0)
        self.assertEqual(self.output, [])

    def test_invalid_sources_wire_types_and_excluded_commands(self):
        worker, topic = self.setup_responder()
        for args in [(topic, self.command(), True, 1), (topic, self.command(), False, 0),
                     (topic.replace('/test/', '/other/'), self.command(), False, 1),
                     (topic, self.command(50000), False, 1), (topic, self.command(50002), False, 1),
                     (topic, self.command(msg=1), False, 1), (topic, b'{"head":{},"head":{}}', False, 1)]:
            self.assertFalse(worker.enqueue(*args))
        self.assertEqual(worker.snapshot()['commands'], 0)

    def test_invalid_config_and_live_bindings_cannot_start(self):
        for cfg in ({'delayMs': -1}, {'duplicateCount': True}, {'response': 'fake'}, {'enabled': 'yes'}):
            with self.assertRaises(ValueError): validate_config(cfg, 'ifr')
        with self.assertRaises(ValueError):
            ProtocolBResponder({'source_mode': 'live'}, {}, None, None, None)


if __name__ == '__main__': unittest.main()
