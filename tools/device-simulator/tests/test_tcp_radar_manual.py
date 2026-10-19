import socket
import struct
import time
import unittest
from types import SimpleNamespace
from test_tcp_radar import PlatformStub
import test_tcp_radar
from tcp_radar import TcpRadar, LOGIN, RTK_REQUEST, RTK, TRACK, frame

class ManualTcpRadarTest(unittest.TestCase):
    collect = test_tcp_radar.TcpRadarTest.collect
    def setUp(self):
        self.platform = PlatformStub()
        self.session = SimpleNamespace(platform=self.platform)
        self.manual = TcpRadar(self.session, port=0, manual=True)
        self.original = TcpRadar(self.session, port=0)
    def tearDown(self):
        self.manual.stop(); self.original.stop()
    def test_manual_listener_makes_no_registration_and_sends_entered_position(self):
        for lon, lat in [(118.72,37.52),(-75.37,-32.68)]:
            with self.subTest(longitude=lon):
                status=self.manual.start({'longitude':lon,'latitude':lat})
                self.assertEqual(self.platform.writes,[])
                self.assertEqual(self.platform.ranges,[])
                self.assertIsNone(status['device_id']); self.assertIsNone(status['device_no'])
                self.assertFalse(status['connected']); self.assertEqual(status['frames_sent'],0)
                self.assertEqual(status['mode'],'manual')
                with socket.create_connection(('127.0.0.1',status['port']),timeout=.4) as client:
                    client.sendall(frame(LOGIN,1,struct.pack('>II',5,0))+frame(RTK_REQUEST,2,b'\x01\x00'))
                    data=self.collect(client,{LOGIN,RTK,TRACK})
                    self.assertEqual(struct.unpack('>qqqii',data[RTK][1])[:2],(round(lat*1e9),round(lon*1e9)))
                self.manual.stop()
    def test_start_and_stop_do_not_change_original_listener_or_registration(self):
        old=self.original.start({'owner_org_id':'scope','district_id':'area','longitude':116.7,'latitude':34.2})
        with socket.create_connection(('127.0.0.1',old['port']),timeout=.4) as client:
            client.sendall(frame(LOGIN,1,struct.pack('>II',5,0))); self.collect(client,{LOGIN,TRACK})
            before=self.original.boot
            test=self.manual.start({'longitude':111.8,'latitude':31.3})
            self.assertNotEqual(old['port'],test['port'])
            self.manual.stop()
            self.assertEqual(self.original.boot,before)
            self.assertTrue(self.original.snapshot()['connected'])
            self.collect(client,{TRACK})
        self.assertEqual(len(self.platform.writes),1)
    def test_invalid_or_registration_fields_are_rejected_without_binding(self):
        for body in [{'longitude':181,'latitude':0},{'longitude':0,'latitude':float('nan')},
                     {'longitude':True,'latitude':1},{'longitude':0},
                     {'longitude':1,'latitude':2,'owner_org_id':'scope'}]:
            with self.subTest(body=body), self.assertRaises(ValueError): self.manual.start(body)
        self.assertIsNone(self.manual.listener); self.assertEqual(self.platform.writes,[])
    def test_expired_login_and_occupied_port_never_register(self):
        self.platform.fail_auth=True
        with self.assertRaises(ValueError): self.manual.start({'longitude':0,'latitude':0})
        self.platform.fail_auth=False
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1',0));occupied.listen()
            self.manual.port=occupied.getsockname()[1]
            with self.assertRaises(OSError): self.manual.start({'longitude':0,'latitude':0})
        self.assertEqual(self.platform.writes,[])
    def test_repeated_start_and_stop_are_independent_and_session_loss_stops_manual(self):
        first=self.manual.start({'longitude':110,'latitude':30})
        again=self.manual.start({'longitude':112,'latitude':32})
        self.assertEqual(first['port'],again['port']); self.assertEqual(again['longitude'],110)
        self.platform.fail_auth=True; self.manual.next_auth=0
        deadline=time.monotonic()+2
        while self.manual.snapshot()['state']=='RUNNING' and time.monotonic()<deadline: time.sleep(.02)
        self.assertEqual(self.manual.snapshot()['state'],'FAILED')
        self.manual.stop();self.manual.stop()
        self.assertEqual(self.platform.writes,[])

if __name__=='__main__': unittest.main()
