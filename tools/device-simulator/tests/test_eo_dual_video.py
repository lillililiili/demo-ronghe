"""Controlled EO camera lifecycle and real encoder timeline metadata."""
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import threading
import time
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eo_video import EoSimulator, DEFAULT_VIDEO, ffmpeg_arguments, video_config


class Process:
    returncode = None
    def poll(self): return self.returncode
    def terminate(self): self.returncode = 0
    def wait(self, timeout): return self.returncode
    def kill(self): self.returncode = -9


class Api:
    def __init__(self):
        self.task = None
        self.target = str(uuid.uuid4())
        self.device = str(uuid.uuid4())
        self.raw, self.ai = str(uuid.uuid4()), str(uuid.uuid4())
        self.calls = []
        self.associations = []

    def call(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == 'DELETE':
            if '/video-streams/' in path: self.ai = str(uuid.uuid4())
            else: self.raw = str(uuid.uuid4())
            return {}
        if path.endswith('/protocol-status'):
            return {'details': {'open_task': {'task_id': self.task, 'status': 'OPEN', 'target_id': self.target} if self.task else None}}
        if '/observation-associations?' in path:
            return {'items': self.associations}
        if '/targets/' in path: return {'target_id': self.target}
        if method == 'PUT' and path.endswith('/frames'): return {}
        stream = self.ai if '/video-streams/' in path else self.raw
        return {'device_id': self.device, 'task_id': self.task if stream == self.ai else None,
                'stream_kind': 'AI' if stream == self.ai else 'RAW', 'stream_id': stream, 'stream_path': 'qa/' + stream}


class Observations:
    config = {'enabled': True, 'intervalSeconds': 2}
    def observation(self, detail, binding):
        return {'className': 'drone', 'longitude': 118.5, 'latitude': 37.4, 'detectConfidence': .95, 'trackConfidence': .95}


class DualVideoTests(unittest.TestCase):
    def setUp(self):
        self.now, self.processes = 1000, []
        self.api = Api()
        self.binding = {'kind': 'eo', 'platform_id': self.api.device, 'external_id': 'camera-' + uuid.uuid4().hex,
                        'edge_id': 'edge', 'dispatcher_topic': 'dispatch/camera', 'reporting_topic': 'report/camera'}
        def spawn(args, **kwargs):
            process = Process()
            process.args, process.directory = args, Path(kwargs['cwd'])
            self.processes.append(process)
            return process
        self.eo = EoSimulator(self.api, {'devices': {'camera': self.binding}},
                              {**DEFAULT_VIDEO, 'source_mode': 'calibration', 'enabled': True, 'publisher_password': 'test-only'},
                              lambda *args: None, lambda *args: None, popen=spawn,
                              clock=lambda: self.now, observations=Observations())
        # Unit lifecycle tests use an already verified media anchor. The real
        # encoder/playlist/barcode roundtrip is tested separately below.
        self.eo.media_clock = type('Clock', (), {'anchor': lambda *args: self.eo.active[self.api.device]['started_at'] * 1000})()
        self.addCleanup(self.eo.suspend)

    def begin(self):
        self.api.task = str(uuid.uuid4())
        self.eo.handle(self.binding['dispatcher_topic'], json.dumps({'event': 'BeginTracking', 'edgeId': 'edge',
            'timestamp': int(self.now * 1000), 'metadata': {'deviceId': self.binding['external_id'], 'taskId': self.api.task}}))

    def progress(self, process, frame=30, pts=2000000):
        (process.directory / 'progress.txt').write_text(f'frame={frame}\nout_time_us={pts}\nprogress=continue\n')

    def frames(self): return [body for method, path, body in self.api.calls if path.endswith('/frames')]

    def test_idle_raw_survives_tracking_end_and_video_off_stops_both(self):
        self.eo.tick()
        self.assertEqual(len(self.processes), 1, 'enabled idle camera must publish RAW without creating a task')
        self.assertIsNone(self.api.task)
        raw = self.processes[0]
        self.begin()
        self.assertEqual(len(self.processes), 2)
        ai = self.processes[1]
        self.eo._stop(self.api.device, 'STOPPED')
        self.assertIsNone(raw.poll())
        self.assertEqual(ai.poll(), 0)
        self.eo.configure_video({**self.eo.config, 'enabled': False})
        self.assertEqual(raw.poll(), 0)

    def test_calibration_only_sends_encoded_progress_not_wall_clock_guesses(self):
        self.begin()
        ai = self.processes[0]
        self.now += 2
        self.eo.tick()
        self.assertEqual(self.frames(), [], 'live process alone does not prove any encoded frame')
        self.progress(ai)
        self.now += 1
        self.eo.tick()
        self.assertEqual(len(self.frames()), 1)
        frame = self.frames()[0]
        self.assertEqual(frame['media_time_ms'], 1933)
        self.assertEqual(frame['frame_timestamp'], 1001933)
        self.assertEqual(frame['stream_id'], self.api.ai)
        self.assertEqual(len(frame['detections']), 1)
        self.assertNotIn('target_id', frame['detections'][0])
        self.eo.tick()
        self.assertEqual(len(self.frames()), 1, 'the same encoded frame must never be uploaded twice')

    def test_metadata_association_is_only_verified_matching_task_target(self):
        self.begin()
        self.api.associations = [{'observation_id': str(uuid.uuid4()), 'target_id': str(uuid.uuid4()), 'class_code': 'drone', 'observed_at': 1002000}]
        self.progress(self.processes[0])
        self.now += 3
        self.eo.tick()
        self.assertEqual(len(self.frames()), 1)
        self.assertNotIn('observation_id', self.frames()[0]['detections'][0],
                         'another target observation must never make the calibration shape clickable')

    def test_external_footage_never_gets_synthetic_detection_boxes(self):
        self.eo.config['source'] = 'C:/operator/video.mp4'
        self.begin()
        self.progress(self.processes[0])
        self.now += 3
        self.eo.tick()
        self.assertEqual(self.frames(), [])
        self.assertNotIn('drawbox', self.processes[0].args[self.processes[0].args.index('-vf') + 1])

    def test_missing_or_stale_hls_clock_cannot_upload_clickable_frame(self):
        self.begin()
        self.progress(self.processes[0])
        self.now += 3
        for origin in (None, 900000):
            self.eo.media_clock = type('Clock', (), {'anchor': lambda *args: origin})()
            self.eo.active[self.api.device]['next_frame'] = 0
            self.eo.tick()
            self.assertEqual(self.frames(), [])

    def test_slow_media_clock_probe_never_blocks_tracking_owner(self):
        from eo_media_clock import HlsCalibrationClock
        entered, release = threading.Event(), threading.Event()
        def reader(path):
            entered.set()
            release.wait(3)
            return b'#EXTM3U\n'
        clock = HlsCalibrationClock(reader=reader)
        try:
            started = time.monotonic()
            self.assertIsNone(clock.anchor('qa/' + str(uuid.uuid4()), 'unused-encoder'))
            self.assertLess(time.monotonic() - started, .2)
            self.assertTrue(entered.wait(1))
        finally:
            release.set()
            clock.executor.shutdown(wait=True)

    def test_valid_association_matches_source_verified_target_and_encoded_shape(self):
        from eo_calibration import BBOX, WIDTH, HEIGHT
        self.begin()
        observation = str(uuid.uuid4())
        self.api.associations = [{'observation_id': observation, 'target_id': self.api.target,
                                  'class_code': 'drone', 'observed_at': 1002000}]
        self.progress(self.processes[0])
        self.now += 3
        self.eo.tick()
        detection = self.frames()[0]['detections'][0]
        self.assertEqual(detection['observation_id'], observation)
        self.assertEqual([detection['x'] * WIDTH, detection['y'] * HEIGHT,
                          detection['width'] * WIDTH, detection['height'] * HEIGHT], list(BBOX))
        self.assertIn('drawbox=x=380:y=230', self.processes[0].args[self.processes[0].args.index('-vf') + 1])

    def test_switching_source_stops_encoders_and_keeps_same_tracking_task(self):
        self.eo.tick()
        self.begin()
        task = self.api.task
        self.eo.configure_video({**self.eo.config, 'source_mode': 'test_pattern'})
        self.assertTrue(all(process.poll() == 0 for process in self.processes))
        self.assertEqual(self.eo.active[self.api.device]['task'], task)
        self.assertNotIn(task, self.eo.retired)
        self.eo.tick()
        self.assertEqual(len(self.processes), 4)
        self.assertIn('testsrc2=size=960x540:rate=15', self.processes[-1].args)
        self.progress(self.processes[-1])
        self.now += 3
        self.eo.tick()
        self.assertEqual(self.frames(), [])

    def test_two_cameras_keep_raw_and_ai_identity_separate(self):
        second = {**self.binding, 'platform_id': str(uuid.uuid4()), 'external_id': 'another-camera',
                  'dispatcher_topic': 'dispatch/second'}
        self.eo.bindings[second['dispatcher_topic']] = second
        # A malicious/wrong API stream response must never be published under the other camera.
        self.eo.tick()
        self.assertEqual(len(self.processes), 1)
        second_state = next(item for item in self.eo.snapshot()['devices'] if item['device_id'] == second['platform_id'])
        self.assertEqual(second_state['raw_video'], 'FAILED')
        self.assertIsNone(self.api.task)

    def test_encoder_recovery_gets_new_stream_before_restarting_media_clock(self):
        self.begin()
        first_stream = self.api.ai
        first = self.processes[0]
        first.returncode = 2
        self.eo.tick()
        self.assertEqual(self.api.ai, first_stream, 'retain failed lease until actual retry')
        self.now += 15
        self.eo.tick()
        recovered = self.eo.active[self.api.device]
        self.assertNotEqual(self.api.ai, first_stream)
        self.assertEqual(recovered['stream_id'], self.api.ai)
        self.assertIsNone(recovered['last_frame_pts'])
        self.progress(recovered['process'], frame=15, pts=1000000)
        self.now += 2
        self.eo.tick()
        self.assertEqual(self.frames()[-1]['stream_id'], self.api.ai)
        self.assertEqual(self.frames()[-1]['media_time_ms'], 933)

    def test_pause_stops_both_and_cannot_restart_raw_until_resume(self):
        self.eo.tick()
        self.begin()
        self.eo.suspend()
        self.assertTrue(all(process.poll() == 0 for process in self.processes))
        self.eo.tick()
        self.assertEqual(len(self.processes), 2)
        self.eo.resume()
        self.eo.tick()
        self.assertEqual(len(self.processes), 3)
        self.assertFalse(self.eo.active, 'resume only restores RAW, never reanimates ended task')


class EncoderGeometryTests(unittest.TestCase):
    def test_media_clock_accepts_only_local_resource_and_single_uuid_session(self):
        from eo_media_clock import HlsCalibrationClock
        session = str(uuid.uuid4())
        for resource in ('index.m3u8', 'main.m3u8?session=' + session, 'init.mp4?session=' + session, 'segment_1.mp4'):
            self.assertEqual(HlsCalibrationClock._resource(resource), resource)
        for resource in ('../index.m3u8', '//host/index.m3u8', 'http://host/a', '..',
                         'main.m3u8?cookieCheck=1', 'main.m3u8?session=bad',
                         'main.m3u8?session=' + session + '&x=1', 'main.m3u8#x',
                         'main.m3u8?session=' + session + '&session=' + session, 'a%2fb.mp4'):
            with self.subTest(resource=resource), self.assertRaises(ValueError):
                HlsCalibrationClock._resource(resource)

    def test_private_reader_bootstraps_without_cookie_redirect_and_preserves_scoped_session(self):
        from eo_media_clock import HlsCalibrationClock, NoRedirect
        from unittest.mock import MagicMock
        stream, session = str(uuid.uuid4()), str(uuid.uuid4())
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value = b'#EXTM3U'
        with tempfile.TemporaryDirectory() as directory:
            credentials = Path(directory) / 'credentials.json'
            credentials.write_text(json.dumps({'read': 'test-only-password-for-private-media'}))
            with patch('qa_media.credentials_file', return_value=credentials), patch('eo_media_clock.build_opener', return_value=opener) as builder:
                HlsCalibrationClock._read_local('qa/' + stream + '/index.m3u8')
                self.assertTrue(opener.open.call_args.args[0].full_url.endswith('/index.m3u8?cookieCheck=1'))
                self.assertIsInstance(builder.call_args.args[1], NoRedirect)
                HlsCalibrationClock._read_local('qa/' + stream + '/main.m3u8?session=' + session)
                self.assertTrue(opener.open.call_args.args[0].full_url.endswith('/main.m3u8?session=' + session))
                with self.assertRaises(ValueError):
                    HlsCalibrationClock._read_local('qa/' + stream + '/../index.m3u8')

    def test_real_hls_program_date_time_is_bound_to_encoded_frame_barcode(self):
        from eo_media_clock import HlsCalibrationClock
        try: config = video_config({**DEFAULT_VIDEO, 'source_mode': 'calibration', 'enabled': True, 'publisher_password': 'test-only'})
        except ValueError as error: self.skipTest(str(error))
        stream = str(uuid.uuid4())
        with tempfile.TemporaryDirectory(prefix='eo-hls-clock-test-') as directory:
            root = Path(directory)
            watermark = root / 'watermark.txt'
            watermark.write_text('TEST VIDEO - SIMULATED CALIBRATION\nPTS %{pts} FRAME %{n}', encoding='utf-8')
            arguments = ffmpeg_arguments(config, 'qa/' + stream, watermark)
            arguments = arguments[:arguments.index('-c:v')] + ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                '-pix_fmt', 'yuv420p', '-frames:v', '45', '-g', '15', '-sc_threshold', '0', '-f', 'hls',
                '-hls_segment_type', 'fmp4', '-hls_time', '1', '-hls_list_size', '0', '-hls_flags', 'program_date_time',
                str(root / 'index.m3u8')]
            subprocess.run(arguments, cwd=directory, capture_output=True, timeout=20, check=True)
            clock = HlsCalibrationClock(reader=lambda path: (root / path.rsplit('/', 1)[-1]).read_bytes())
            origin = clock.measure('qa/' + stream, config['ffmpeg'])
            self.assertIsNotNone(origin, 'a complete decoded fragment must supply a trusted HLS clock anchor')
            self.assertEqual(clock.last_decoded_frame, 30, 'latest segment starts at genuine rendered frame 30')
            expected = clock.last_segment_epoch_ms - 30 * 1000 / 15
            self.assertAlmostEqual(origin, expected, places=2)

    def test_real_encoded_scene_pixels_match_detection_geometry(self):
        from eo_calibration import BBOX, WIDTH, HEIGHT, detection
        try: config = video_config({**DEFAULT_VIDEO, 'source_mode': 'calibration', 'enabled': True, 'publisher_password': 'test-only'})
        except ValueError as error: self.skipTest(str(error))
        stream = str(uuid.uuid4())
        with tempfile.TemporaryDirectory(prefix='eo-calibration-test-') as directory:
            watermark = Path(directory) / 'watermark.txt'
            watermark.write_text('TEST VIDEO - SIMULATED CALIBRATION\nPTS %{pts} FRAME %{n}', encoding='utf-8')
            arguments = ffmpeg_arguments(config, 'qa/' + stream, watermark)
            # Keep the actual production input/filter graph, capture locally only.
            arguments = arguments[:arguments.index('-c:v')] + ['-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']
            result = subprocess.run(arguments, cwd=directory, capture_output=True, timeout=20, check=True)
        pixels = result.stdout
        self.assertEqual(len(pixels), WIDTH * HEIGHT * 3)
        coordinates = [(index // 3 % WIDTH, index // 3 // WIDTH) for index in range(0, len(pixels), 3)
                       if pixels[index] < 120 and pixels[index + 1] > 150 and pixels[index + 2] > 150]
        left, top = min(x for x, _ in coordinates), min(y for _, y in coordinates)
        actual = (left, top, max(x for x, _ in coordinates) - left + 1, max(y for _, y in coordinates) - top + 1)
        self.assertEqual(actual, BBOX, 'the detection must enclose pixels really generated by FFmpeg')
        box = detection(stream)
        self.assertEqual(actual, tuple(round(box[key] * size) for key, size in
            (('x', WIDTH), ('y', HEIGHT), ('width', WIDTH), ('height', HEIGHT))))


if __name__ == '__main__': unittest.main()
