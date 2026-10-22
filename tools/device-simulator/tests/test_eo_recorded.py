"""Recorded pixels and annotations must retain one exact loop/frame identity."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class RecordedVideoTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('eo_recorded'), 'annotated recorded video support is missing')
        import eo_recorded
        return eo_recorded

    def test_default_is_recorded_and_actual_asset_has_moving_boxes(self):
        m = self.module()
        from eo_video import default_video_config
        self.assertEqual(default_video_config()['source_mode'], 'recorded')
        clip = m.recorded_clip()
        self.assertEqual(clip.frame_count, 164)
        self.assertNotEqual(clip.box(0), clip.box(45))
        self.assertEqual(clip.box(0), clip.box(164))
        self.assertEqual(clip.box(17), clip.box(164 * 23 + 17))
        self.assertEqual(clip.box(0, offset=17), clip.box(17))

    def test_rejects_modified_source_wrong_count_and_invalid_geometry(self):
        m = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'video.mp4').write_bytes(b'local-test-video')
            good = {'video': 'video.mp4', 'sha256': hashlib.sha256(b'local-test-video').hexdigest(),
                    'width': 640, 'height': 512, 'fps': 30, 'frame_count': 4,
                    'boxes': [[2, 3, 8, 9], None, [50, 60, 12, 14], None]}
            for updates in ({'sha256': '0' * 64}, {'frame_count': 6}, {'video': '../video.mp4'},
                            {'boxes': [[-1, 3, 8, 9]] * 4}, {'boxes': [[639, 3, 8, 9]] * 4}):
                (root / 'annotations.json').write_text(json.dumps({**good, **updates}))
                with self.subTest(updates=updates), self.assertRaises(ValueError):
                    m.RecordedClip(root / 'annotations.json')
            (root / 'annotations.json').write_text(json.dumps(good))
            clip = m.RecordedClip(root / 'annotations.json')
            self.assertEqual(clip.box(0), (162, 3, 8, 9))
            self.assertEqual(clip.box(1), (210, 60, 12, 14))
            self.assertEqual(clip.box(2), clip.box(0))

    def test_raw_does_not_draw_target_and_ai_matches_frame_and_offset(self):
        clip = self.module().recorded_clip()
        raw = clip.filters('RAW', 0)
        ai = clip.filters('AI', 17)
        self.assertNotIn('color=0x3de3e0', raw)
        self.assertIn('trim=start_frame=17', ai)
        self.assertIn('mod(n+17,164)', ai)
        self.assertIn('color=0x3de3e0', ai)
        self.assertEqual(clip.detection('stream', 0, None, 17)['x'], clip.box(17)[0] / 960)
        self.assertNotIn('observation_id', clip.detection('stream', 0, None))
        self.assertEqual(clip.detection('stream', 0, {'observation_id': 'verified'})['observation_id'], 'verified')

    def test_actual_encoded_raw_and_ai_align_across_loop_and_offset(self):
        from eo_video import video_config, ffmpeg_arguments
        from eo_calibration import decoded_frame_number
        config = video_config({'enabled': True, 'publisher_password': 'test-only'})
        clip = self.module().recorded_clip()
        for offset in (0, 17):
            samples = {}
            for kind in ('RAW', 'AI'):
                with tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    watermark = root/'watermark.txt'
                    watermark.write_text('TEST VIDEO - RECORDED REPLAY')
                    args = ffmpeg_arguments(config, 'qa/'+str(uuid.uuid4()), watermark, kind, offset)
                    args.remove('-re')
                    if '-readrate_initial_burst' in args:
                        i = args.index('-readrate_initial_burst'); del args[i:i+2]
                    graph = root/'video-filter.txt'
                    graph.write_text(graph.read_text()+",select='eq(n,0)+eq(n,30)+eq(n,164)+eq(n,177)'")
                    args = args[:args.index('-c:v')]+['-frames:v','4','-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','pipe:1']
                    result = subprocess.run(args,cwd=root,capture_output=True,timeout=30,check=True)
                    size = 960*540*3
                    self.assertEqual(len(result.stdout),size*4)
                    samples[kind] = [result.stdout[i*size:(i+1)*size] for i in range(4)]
            for i, frame in enumerate((0,30,164,177)):
                raw, ai = samples['RAW'][i], samples['AI'][i]
                self.assertEqual(decoded_frame_number(raw),frame)
                self.assertEqual(decoded_frame_number(ai),frame)
                # Difference must be the actual annotated rectangle, not a fixed central shape.
                changed = [(p//3%960,p//3//960) for p in range(0,960*512*3,3) if raw[p:p+3] != ai[p:p+3]]
                self.assertGreater(len(changed),20)
                x,y,w,h = clip.box(frame,offset)
                self.assertTrue(all(x-3 <= xx <= x+w+3 and y-3 <= yy <= y+h+3 for xx,yy in changed))
            self.assertEqual(samples['RAW'][0][:960*512*3],samples['RAW'][2][:960*512*3])

    def test_recorded_hls_clock_decodes_real_frame_after_source_wrap(self):
        from eo_video import video_config, ffmpeg_arguments
        from eo_media_clock import HlsCalibrationClock
        config = video_config({'enabled': True, 'publisher_password': 'test-only'})
        stream = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); watermark = root/'watermark.txt'; watermark.write_text('RECORDED REPLAY')
            args = ffmpeg_arguments(config,'qa/'+stream,watermark,'AI',17)
            args.remove('-re'); i=args.index('-readrate_initial_burst'); del args[i:i+2]
            args=args[:args.index('-c:v')]+['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
                '-r','15','-frames:v','195','-g','15','-sc_threshold','0','-f','hls','-hls_segment_type','fmp4',
                '-hls_time','1','-hls_list_size','0','-hls_flags','program_date_time',str(root/'index.m3u8')]
            subprocess.run(args,cwd=root,capture_output=True,timeout=30,check=True)
            clock=HlsCalibrationClock(reader=lambda path:(root/path.rsplit('/',1)[-1]).read_bytes())
            try:
                origin=clock.measure('qa/'+stream,config['ffmpeg'])
                self.assertEqual(clock.last_decoded_frame,180)
                self.assertAlmostEqual(origin,clock.last_segment_epoch_ms-12000,places=2)
            finally: clock.executor.shutdown(wait=True)


import test_eo_dual_video as dual


class RecordedMetadataTests(dual.DualVideoTests):
    # Reuse camera/task lifecycle fixtures, but run only this class's specific tests.
    def test_recorded_sends_each_encoded_frame_and_resets_on_new_stream(self):
        from eo_recorded import recorded_clip
        self.eo.config['source_mode']='recorded'; self.eo.recorded=recorded_clip()
        self.begin(); process=self.processes[0]
        observation=str(uuid.uuid4())
        self.api.associations=[{'observation_id':observation,'target_id':self.api.target,'class_code':'drone','observed_at':1002000}]
        self.progress(process); self.now+=3; self.eo.tick()
        frames=self.frames()
        self.assertEqual(len(frames),30)
        self.assertEqual([f['media_time_ms'] for f in frames], [int(n*1000/15) for n in range(30)])
        self.assertNotEqual(frames[0]['detections'][0]['x'],frames[-1]['detections'][0]['x'])
        self.assertTrue(all(f['detections'][0]['observation_id']==observation for f in frames))
        self.progress(process,frame=45,pts=3000000); self.now+=1; self.eo.tick()
        self.assertEqual(len(self.frames()),45)
        self.assertEqual(len({f['media_time_ms'] for f in self.frames()}),45)


# Do not duplicate the inherited calibration suite in unittest discovery.
for _name in list(dual.DualVideoTests.__dict__):
    if _name.startswith('test_'):
        setattr(RecordedMetadataTests,_name,None)


if __name__ == '__main__': unittest.main()
