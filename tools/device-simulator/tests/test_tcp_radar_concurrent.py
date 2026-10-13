import contextlib
import socket
import struct
import time
import unittest
from types import SimpleNamespace

from test_tcp_radar import PlatformStub
import test_tcp_radar
from tcp_radar import TcpRadar, frame, LOGIN, HEARTBEAT, GETREG, RTK_REQUEST, RTK, TRACK, MAX_CLIENTS


class ConcurrentTcpRadarTest(unittest.TestCase):
    collect = test_tcp_radar.TcpRadarTest.collect

    def start(self, manual=True):
        platform = PlatformStub()
        session = SimpleNamespace(platform=platform)
        radar = TcpRadar(session, port=0, manual=manual)
        body = {'longitude': 113.17, 'latitude': 32.49}
        if not manual:
            body.update(owner_org_id='concurrent-org', district_id='concurrent-area')
        status = radar.start(body)
        self.addCleanup(radar.stop)
        return radar, session, platform, status['port']

    def client(self, port):
        client = socket.create_connection(('127.0.0.1', port), timeout=.3)
        self.addCleanup(client.close)
        return client

    def login(self, client, seq):
        client.sendall(frame(LOGIN, seq, struct.pack('>II', 5, 0)))
        data = self.collect(client, {LOGIN, TRACK}, timeout=2)
        self.assertEqual(data[LOGIN], (seq, struct.pack('>IH', 5, 0)))
        wire, payload = data[TRACK]
        self.assertEqual(wire, struct.unpack('>Q', payload[8:16])[0])
        return wire

    def wait_until(self, predicate):
        deadline = time.monotonic() + 3
        while not predicate() and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertTrue(predicate())

    def assert_closed(self, client):
        client.settimeout(.4)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                if not client.recv(4096):
                    return
            except (ConnectionResetError, ConnectionAbortedError):
                return
            except socket.timeout:
                pass
        self.fail('Client remained open after listener shutdown')

    def test_monitor_probe_and_commission_share_listener_in_both_modes(self):
        for manual in (True, False):
            with self.subTest(manual=manual):
                radar, _, platform, port = self.start(manual)
                monitor = self.client(port)
                first_id = self.login(monitor, 7)
                monitor.sendall(frame(RTK_REQUEST, 8, b'\x01\x00'))
                self.collect(monitor, {RTK})
                # Commission connect only probes the port then closes it; it must not
                # sit behind the persistent monitor and exhaust the accept backlog.
                for _ in range(4):
                    with contextlib.closing(self.client(port)):
                        pass
                diagnostic = self.client(port)
                second_id = self.login(diagnostic, 41)
                self.assertNotEqual(first_id, second_id)
                diagnostic.sendall(frame(HEARTBEAT, 42, bytes(8)) +
                                   frame(GETREG, 43, struct.pack('>III', 2, 0x440, 0x401)))
                received = self.collect(diagnostic, {HEARTBEAT, GETREG, TRACK})
                self.assertNotIn(RTK, received)  # RTK subscription is per connection.
                diagnostic.sendall(frame(RTK_REQUEST, 44, b'\x01\x00'))
                self.collect(diagnostic, {RTK, TRACK})
                diagnostic.close()
                monitor.sendall(frame(HEARTBEAT, 99, bytes(8)))
                self.assertEqual(self.collect(monitor, {HEARTBEAT})[HEARTBEAT][0], 99)
                self.assertTrue(radar.snapshot()['connected'])
                self.assertEqual(len(platform.writes), 0 if manual else 1)
                radar.stop()

    def test_invalid_client_does_not_interrupt_existing_monitor(self):
        radar, _, _, port = self.start()
        monitor = self.client(port)
        self.login(monitor, 1)
        invalid = self.client(port)
        invalid.sendall(frame(LOGIN, 55, struct.pack('>II', 5, 999)))
        data = self.collect(invalid, {LOGIN}, timeout=2)
        self.assertNotIn(TRACK, data)
        self.assertEqual(struct.unpack('>IH', data[LOGIN][1])[1], 1)
        self.assert_closed(invalid)
        monitor.sendall(frame(HEARTBEAT, 56, bytes(8)))
        self.collect(monitor, {HEARTBEAT, TRACK})
        self.assertTrue(radar.snapshot()['connected'])

    def test_stop_closes_logged_in_and_idle_clients_then_restarts(self):
        radar, _, platform, port = self.start()
        clients = [self.client(port) for _ in range(3)]
        self.login(clients[0], 1)
        self.login(clients[1], 2)
        before = radar.boot
        radar.stop()
        for client in clients:
            self.assert_closed(client)
        self.assertFalse(radar.snapshot()['connected'])
        self.wait_until(lambda: not radar.thread.is_alive())
        status = radar.start({'longitude': -73.6, 'latitude': -23.1})
        self.assertNotEqual(before, radar.boot)
        self.login(self.client(status['port']), 3)
        self.assertEqual(platform.writes, [])

    def test_expired_or_replaced_session_closes_all_connections(self):
        for replace in (False, True):
            with self.subTest(replace=replace):
                radar, session, platform, port = self.start()
                clients = [self.client(port) for _ in range(2)]
                for seq, client in enumerate(clients, start=20):
                    self.login(client, seq)
                if replace:
                    session.platform = PlatformStub()
                else:
                    platform.fail_auth = True
                radar.next_auth = 0
                self.wait_until(lambda: radar.snapshot()['state'] == 'FAILED')
                for client in clients:
                    self.assert_closed(client)
                self.assertFalse(radar.snapshot()['connected'])

    def test_connection_limit_rejects_only_new_client(self):
        radar, _, _, port = self.start()
        monitor = self.client(port)
        self.login(monitor, 60)
        for _ in range(MAX_CLIENTS - 1):
            self.client(port)
        self.wait_until(lambda: len(radar.clients) == MAX_CLIENTS)
        self.assert_closed(self.client(port))
        monitor.sendall(frame(HEARTBEAT, 61, bytes(8)))
        self.collect(monitor, {HEARTBEAT, TRACK})
        self.assertTrue(radar.snapshot()['connected'])


if __name__ == '__main__':
    unittest.main()
