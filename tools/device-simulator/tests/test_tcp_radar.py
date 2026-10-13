import socket
import struct
import time
import unittest
from types import SimpleNamespace
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tcp_radar import TcpRadar, Decoder, frame, track_payload, LOGIN, HEARTBEAT, GETREG, RTK_REQUEST, RTK, TRACK

class PlatformStub:
    def __init__(self):
        self.writes = []
        self.fail_auth = False
    def call(self, method, path, body=None, key=None, **kwargs):
        if self.fail_auth: raise ValueError('session expired')
        if method == 'POST':
            self.writes.append((path, body))
            return {'device': {'device_id':'test-device','name':'Test TCP','latitude':36.25,'longitude':115.5}}
        return {}

class TcpRadarTest(unittest.TestCase):
    def setUp(self):
        self.platform = PlatformStub()
        self.radar = TcpRadar(SimpleNamespace(platform=self.platform), port=0)
    def tearDown(self):
        self.radar.stop()
    def start(self):
        self.radar.start({'owner_org_id':'random-scope','district_id':'different-district','longitude':115.5,'latitude':36.25})
        return self.radar.listener.getsockname()[1]
    def collect(self, client, commands, timeout=3):
        decoder, found = Decoder(), {}
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not commands.issubset(found):
            try: chunk = client.recv(4096)
            except socket.timeout: continue
            if not chunk: break
            for command, seq, payload in decoder.feed(chunk): found[command] = (seq, payload)
        self.assertTrue(commands.issubset(found), found.keys())
        return found
    def test_real_socket_login_registers_rtk_tracks_and_independent_stop(self):
        port = self.start()
        with socket.create_connection(('127.0.0.1',port), timeout=.4) as client:
            login = frame(LOGIN, 3, struct.pack('>II',5,0))
            # Deliberately fragmented native frame followed by two coalesced requests.
            client.sendall(login[:5]); client.sendall(login[5:] + frame(GETREG,4,struct.pack('>III',2,0x440,0x401)) + frame(RTK_REQUEST,5,b'\x01\x00'))
            result = self.collect(client,{LOGIN,GETREG,RTK,TRACK})
            self.assertEqual(result[LOGIN], (3,struct.pack('>IH',5,0)))
            self.assertEqual(len(result[TRACK][1]),104)
            lat,lon,heading,sats,alt = struct.unpack('>qqqii',result[RTK][1])
            self.assertEqual((lat,lon),(36250000000,115500000000))
            self.assertTrue(self.radar.snapshot()['connected'])
            client.sendall(frame(HEARTBEAT,6,bytes(8)))
            self.assertEqual(self.collect(client,{HEARTBEAT})[HEARTBEAT],(6,bytes(8)))
            self.radar.stop()
            self.assertFalse(self.radar.snapshot()['connected'])
        self.assertEqual(self.platform.writes[0][0],'/local-interface-simulator/radar-device')
    def test_invalid_crc_and_bounds(self):
        raw = bytearray(frame(HEARTBEAT,1,bytes(8))); raw[-1] ^= 1
        with self.assertRaises(ValueError): Decoder().feed(raw)
        with self.assertRaises(ValueError): Decoder().feed(struct.pack('>II',0x55aa55aa,4097))
    def test_invalid_login_does_not_send_observations(self):
        port = self.start()
        with socket.create_connection(('127.0.0.1',port),timeout=.4) as client:
            client.sendall(frame(LOGIN,1,struct.pack('>II',5,999)))
            data = self.collect(client,{LOGIN})
            self.assertEqual(struct.unpack('>IH',data[LOGIN][1])[1],1)
            self.assertEqual(self.radar.snapshot()['frames_sent'],0)
    def test_repeated_start_reuses_listener_and_registration(self):
        port = self.start(); self.start()
        self.assertEqual(self.radar.listener.getsockname()[1],port)
        self.assertEqual(len(self.platform.writes),1)
    def test_occupied_port_does_not_register_anything(self):
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1',0)); occupied.listen(1)
            self.radar.port = occupied.getsockname()[1]
            with self.assertRaises(OSError): self.start()
        self.assertEqual(self.platform.writes,[])
    def test_expired_session_stops_publishing(self):
        self.start(); self.platform.fail_auth=True; self.radar.next_auth=0
        deadline=time.monotonic()+2
        while self.radar.snapshot()['state']=='RUNNING' and time.monotonic()<deadline: time.sleep(.02)
        self.assertEqual(self.radar.snapshot()['state'],'FAILED')
        self.assertIn('session expired',self.radar.snapshot()['error'])
    def test_restart_uses_new_boot_session_and_advancing_payload(self):
        self.start(); before=self.radar.boot; self.radar.stop(); self.start()
        self.assertNotEqual(before,self.radar.boot)
        a,b=track_payload(before,1,1000,0),track_payload(before,2,2000,2)
        self.assertNotEqual(a[40:52],b[40:52])
        self.assertEqual(struct.unpack('>Q',b[8:16])[0],2)
    def test_disconnected_client_can_reconnect(self):
        port=self.start()
        for seq in (1,23):
            with socket.create_connection(('127.0.0.1',port),timeout=.4) as client:
                client.sendall(frame(LOGIN,seq,struct.pack('>II',5,0)))
                self.collect(client,{LOGIN,TRACK})
if __name__=='__main__': unittest.main()
