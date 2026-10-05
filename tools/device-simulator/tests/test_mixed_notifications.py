import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from realtime_notification_receiver import Receiver
from test_realtime_notification_receiver import FakeProxy, message


class MixedNotificationTests(unittest.TestCase):
    def test_policy_is_chosen_per_new_message_and_frozen(self):
        with tempfile.TemporaryDirectory() as folder:
            r=Receiver(FakeProxy(message()),folder,clock=lambda:100)
            records=[]
            for i in range(5):
                row=message('ADVISORY_VOICE');row['message_id']='simn-mixed-'+str(i)
                records.append(r.receive(row,'mixed'))
            self.assertEqual([v['mode'] for v in records],['success','failed','delayed','no_receipt','answered_only'])
            self.assertEqual(r.receive(records[2]['original'],'success')['mode'],'delayed')

    def test_delay_uses_real_elapsed_then_voice_play_time(self):
        now=[100.0]
        with tempfile.TemporaryDirectory() as folder:
            r=Receiver(FakeProxy(message()),folder,clock=lambda:now[0])
            row=message('ADVISORY_VOICE');row['created_at']=100000
            record=r.receive(row,'delayed')
            self.assertIsNone(r.next_outcome(row,record,'delayed'))
            now[0]=108
            self.assertEqual('ANSWERED',r.next_outcome(row,record,'delayed'))
            record['answered_at']=108;row['state']='ANSWERED'
            now[0]=110
            self.assertIsNone(r.next_outcome(row,record,'delayed'))
            now[0]=111
            self.assertEqual('PLAYED',r.next_outcome(row,record,'delayed'))


if __name__=='__main__':unittest.main()
