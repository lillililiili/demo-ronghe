import assert from 'node:assert/strict';
import test from 'node:test';
import { matchingVideoFrame } from './deviceVideoState.js';

const video = { device_id: 'device-a', stream_id: 'stream-a', task_id: 'task-a', status: 'AI', stream_kind: 'AI' };

test('uses the HLS fragment mapped UTC frame and ignores local media time', () => {
  const stale = { frame_timestamp: 1000, media_time_ms: 100000, detections: [{ detection_id: 'stale' }] };
  const current = { frame_timestamp: 8000, media_time_ms: 100066, detections: [{ detection_id: 'current' }] };
  const metadata = { device_id: 'device-a', stream_id: 'stream-a', task_id: 'task-a', frames: [stale, current] };

  assert.equal(matchingVideoFrame(video, metadata, 8000), current);
});

test('uses UTC frame timestamps when playback has no media time', () => {
  const earlier = { frame_timestamp: 1000, detections: [{ detection_id: 'earlier' }] };
  const current = { frame_timestamp: 8000, detections: [{ detection_id: 'current' }] };
  const metadata = { device_id: 'device-a', stream_id: 'stream-a', task_id: 'task-a', frames: [earlier, current] };

  assert.equal(matchingVideoFrame(video, metadata, 8000), current);
});
