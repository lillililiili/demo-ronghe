import socket
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from countermeasure_tcp import CountermeasureSimulator


def frame(function, data, address=1):
    value = bytes((0x55, address, function, 0, 0, 0, data))
    return value + bytes((sum(value) & 0xFF,))


def reply(function, mask, address=1):
    value = bytes((0x22, address, function, 0, 0, 0, mask))
    return value + bytes((sum(value) & 0xFF,))


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class CountermeasureTcpTests(unittest.TestCase):
    def setUp(self):
        self.sim = CountermeasureSimulator(port=free_port())
        self.sim.start()
        self.addCleanup(self.sim.stop)

    def exchange(self, wire, chunks=None):
        with socket.create_connection(('127.0.0.1', self.sim.port), timeout=1) as conn:
            conn.settimeout(0.4)
            if chunks:
                for piece in chunks:
                    conn.sendall(piece)
                    time.sleep(0.01)
            else:
                conn.sendall(wire)
            try:
                return conn.recv(256)
            except (socket.timeout, ConnectionResetError):
                return b''

    def test_binary_query_on_off_set_and_duplicate(self):
        self.assertEqual(reply(0x10, 0), self.exchange(frame(0x10, 1)))
        self.assertEqual(reply(0x12, 1), self.exchange(frame(0x12, 1)))
        self.assertEqual(reply(0x12, 1), self.exchange(frame(0x12, 1)))
        self.assertEqual(reply(0x13, 0x0D), self.exchange(frame(0x13, 0x0D)))
        self.assertEqual(reply(0x11, 0x0C), self.exchange(frame(0x11, 1)))
        self.assertEqual(reply(0x10, 0x0C), self.exchange(frame(0x10, 1)))
        state = self.sim.snapshot()
        self.assertEqual(0x0C, state['relay_mask'])
        self.assertEqual(6, state['received'])
        self.assertIsNotNone(state['last_received_at'])

    def test_ascii_spaced_and_compact_preserve_encoding_and_partial_frame(self):
        on = frame(0x12, 2)
        spaced = (' '.join(f'{b:02X}' for b in on) + '\r\n').encode('ascii')
        expected = (' '.join(f'{b:02X}' for b in reply(0x12, 2)) + '\r\n').encode('ascii')
        self.assertEqual(expected, self.exchange(spaced, [spaced[:5], spaced[5:]]))
        query = frame(0x10, 1).hex().upper().encode('ascii') + b'\r\n'
        self.assertEqual(reply(0x10, 2).hex().upper().encode('ascii') + b'\r\n', self.exchange(query))
        raw = frame(0x11, 2)
        self.assertEqual(reply(0x11, 0), self.exchange(raw, [raw[:3], raw[3:]]))

    def test_malformed_frames_never_mutate_or_reply(self):
        bad = [
            bytes((0x55, 1, 0x12, 0, 0, 0, 1, 0)),
            frame(0x12, 1, address=245),
            frame(0x12, 1, address=0),
            frame(0x12, 3),
            frame(0x13, 3),
            frame(0x10, 0),
            frame(0x14, 1),
            bytes((0x55, 1, 0x12, 1, 0, 0, 1, 0x69)),
            frame(0x12, 1) + b'\x00',
            frame(0x12, 1).hex().upper().encode('ascii') + b'\r\n00',
            b'55 01 12 ZZ 00 00 01 69\r\n',
            frame(0x12, 1)[:4],
        ]
        for wire in bad:
            with self.subTest(wire=wire):
                self.assertEqual(b'', self.exchange(wire))
                self.assertEqual(0, self.sim.snapshot()['relay_mask'])
        self.assertEqual(reply(0x10, 0), self.exchange(frame(0x10, 1)))

    def test_no_receipt_does_not_execute_and_unchanged_replies_without_action(self):
        self.sim.stop()
        self.sim = CountermeasureSimulator(port=self.sim.port, command_mode='no_receipt')
        self.sim.start()
        self.assertEqual(b'', self.exchange(frame(0x12, 1)))
        self.assertEqual(reply(0x10, 0), self.exchange(frame(0x10, 1)))
        self.assertEqual(0, self.sim.snapshot()['relay_mask'])
        self.sim.stop()
        self.sim = CountermeasureSimulator(port=self.sim.port, command_mode='unchanged')
        self.sim.start()
        self.assertEqual(reply(0x13, 0), self.exchange(frame(0x13, 0x0F)))
        self.assertEqual(0, self.sim.snapshot()['relay_mask'])

    def test_stop_releases_port_restart_starts_safe_and_conflict_is_error(self):
        port = self.sim.port
        self.exchange(frame(0x12, 1))
        self.sim.stop()
        self.assertFalse(self.sim.snapshot()['listening'])
        self.sim.start()
        self.assertEqual(reply(0x10, 0), self.exchange(frame(0x10, 1)))
        other = CountermeasureSimulator(port=port)
        with self.assertRaises(OSError):
            other.start()
        self.assertFalse(other.snapshot()['listening'])


if __name__ == '__main__':
    unittest.main()
