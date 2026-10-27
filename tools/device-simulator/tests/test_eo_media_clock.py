"""Only decoded, timestamped complete HLS segments prove QA overlay frames."""
import datetime as dt
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from eo_media_clock import HlsCalibrationClock


class MediaClockSegmentTests(unittest.TestCase):
    def setUp(self):
        self.stream='qa/'+str(uuid.uuid4())
        self.clock=HlsCalibrationClock(reader=lambda path:self.playlist.encode() if path.endswith('index.m3u8') else b'fragment')
        self.addCleanup(lambda:self.clock.executor.shutdown(wait=True))
        self.playlist=''

    def playlist_for(self, segments):
        lines=['#EXTM3U']
        for name,epoch,duration in segments:
            if epoch is not None:lines.append('#EXT-X-PROGRAM-DATE-TIME:'+dt.datetime.fromtimestamp(epoch/1000,dt.timezone.utc).isoformat())
            lines.extend(['#EXTINF:'+str(duration)+',',name])
        return '\n'.join(lines)

    def measured(self, segments, numbers, pts=None, pixel_count=None):
        self.playlist=self.playlist_for(segments)
        count=len(numbers) if pixel_count is None else pixel_count
        times=pts if pts is not None else [i/15 for i in range(count)]
        commands=[]
        def run(command,**kwargs):
            commands.append(command)
            if '-show_entries' in command:
                return SimpleNamespace(stdout=json.dumps({'frames':[{'best_effort_timestamp_time':str(t)} for t in times]}).encode())
            return SimpleNamespace(stdout=b'\0'*(960*540*3*count))
        with patch('eo_media_clock.subprocess.run',side_effect=run),patch('eo_media_clock.decoded_frame_number',side_effect=numbers):
            result=self.clock.measure_segment(self.stream,'ffmpeg')
        return result,commands

    def test_all_actual_barcodes_and_packet_timestamps_are_verified_without_frame_synthesis(self):
        result,commands=self.measured([('one.mp4',1000000,1)],list(range(30,45)),[2+i/15 for i in range(15)])
        self.assertEqual([f['number'] for f in result['frames']],list(range(30,45)))
        self.assertEqual(result['frames'][0]['frame_timestamp'],1000000)
        self.assertAlmostEqual(result['frames'][-1]['frame_timestamp'],1000933,delta=1)
        decoder=next(command for command in commands if '-fps_mode' in command)
        self.assertEqual(decoder[decoder.index('-fps_mode')+1],'passthrough')
        self.assertEqual(result['segments'][0]['packet_pts_ms'][0],2000)

    def test_each_new_segment_uses_its_own_proved_pdt_without_rewriting_history(self):
        first,_=self.measured([('one.mp4',1000000,1)],list(range(15)))
        frozen=[dict(frame) for frame in first['frames']]
        second,_=self.measured([('two.mp4',1001080,1)],list(range(15,30)))
        self.assertEqual(second['frames'][0]['frame_timestamp'],1001080)
        third,_=self.measured([('three.mp4',1001950,1)],list(range(30,45)))
        self.assertEqual(third['frames'][0]['frame_timestamp'],1001950)
        self.assertEqual(first['frames'],frozen)
        self.assertEqual(third['rejected_segments'],[])

    def test_missing_or_noncontiguous_pixels_reject_only_that_segment(self):
        result,_=self.measured([('bad.mp4',1000000,1)],list(range(14))+[16])
        self.assertEqual(result['frames'],[])
        self.assertEqual(result['rejected_segments'][0]['segment_id'],'bad.mp4')
        result,_=self.measured([('good.mp4',1001000,1)],list(range(15,30)))
        self.assertEqual(len(result['frames']),15)
        self.assertEqual(result['rejected_segments'],[])
        result,_=self.measured([('truncated.mp4',1002000,1)],list(range(14)),pixel_count=14)
        self.assertEqual(result['frames'],[])

    def test_nonuniform_encoded_timestamps_are_not_interpolated_as_fifteen_fps(self):
        times=[i/15 for i in range(15)];times[8]+=.01
        result,_=self.measured([('irregular.mp4',1000000,1)],list(range(15)),times)
        self.assertEqual(result['frames'],[])

    def test_discontinuity_requires_a_new_explicit_program_date_time(self):
        self.playlist=self.playlist_for([('old.mp4',1000000,1)])+'\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\nunknown.mp4'
        with patch('eo_media_clock.subprocess.run') as run,patch('eo_media_clock.decoded_frame_number',side_effect=range(15)):
            run.side_effect=lambda command,**kwargs:SimpleNamespace(stdout=(json.dumps({'frames':[{'best_effort_timestamp_time':str(i/15)} for i in range(15)]}).encode() if '-show_entries' in command else b'\0'*(960*540*3*15)))
            result=self.clock.measure_segment(self.stream,'ffmpeg')
        self.assertEqual({frame['segment_id'] for frame in result['frames']},{'old.mp4'})
        result,_=self.measured([('after.mp4',1005000,1)],list(range(30,45)))
        self.assertEqual(result['frames'][0]['frame_timestamp'],1005000)

    def test_more_than_thirty_frames_or_no_pdt_cannot_produce_a_window(self):
        result,_=self.measured([('oversized.mp4',1000000,3)],[])
        self.assertIsNone(result)
        result,_=self.measured([('unknown.mp4',None,1)],[])
        self.assertIsNone(result)


if __name__=='__main__':unittest.main()
