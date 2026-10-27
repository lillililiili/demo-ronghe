import assert from 'node:assert/strict';
import test from 'node:test';
import { hlsFrameTimestamp } from './hlsFrameTimestamp.js';

test('maps compositor time through the HLS fragment that contains that frame', () => {
  const fragments = [
    { start: 30, duration: 1, programDateTime: 10000 },
    { start: 31, duration: 1, programDateTime: 12000 }
  ];

  assert.equal(hlsFrameTimestamp(10000, 30, 31.5, fragments), 12500);
});

test('falls back to the current HLS date when fragment timing is unavailable', () => {
  assert.equal(hlsFrameTimestamp(10000, 30, 30.5), 10500);
});

test('withholds a timestamp when media time is outside available fragments', () => {
  const fragments = [{ start: 30, duration: 1, programDateTime: 10000 }];
  assert.equal(hlsFrameTimestamp(10000, 30, 32, fragments), null);
});
