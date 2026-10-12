import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareEvidenceTrack } from '../src/services/evidenceTrackData.js';

const point = (seq, time, extra = {}) => ({ point_id: `p-${seq}`, track_id: 'raw-a', point_seq: seq,
  observed_at: time, point_kind: 'MEAS', location: { longitude: 118.4, latitude: 37.2, coordinate_system: 'WGS84' }, ...extra });

test('RAW source sequences may be timestamp-based or sparse without declaring every observation interrupted', () => {
  for (const base of [1700000000000, 1800000000000]) {
    const rows = [point(base, base), point(base + 1031, base + 1031), point(base + 2150, base + 2150)];
    const before = JSON.stringify(rows);
    const model = prepareEvidenceTrack(rows, { layer: 'RAW' });
    assert.equal(model.breaks, 0);
    assert.equal(model.canReplay, true);
    assert.equal(JSON.stringify(rows), before);
    assert.deepEqual(model.points.map(p => p.point_seq), rows.map(p => p.point_seq));
  }
  assert.equal(prepareEvidenceTrack([point(20, 1000), point(40, 2000)], { layer: 'RAW' }).breaks, 0);
});

test('RAW keeps explicit breaks, invalid positions, identity changes and non-forward source sequence boundaries', () => {
  for (const boundary of [{ break_before: true }, { track_id: 'another' }, { point_seq: 9 }, { point_kind: 'PRED' }]) {
    assert.equal(prepareEvidenceTrack([point(10, 1000), point(30, 2000, boundary)], { layer: 'RAW' }).breaks, 1);
  }
  const bad = point(20, 1500, { location: { longitude: 999, latitude: 37.2, coordinate_system: 'WGS84' } });
  const model = prepareEvidenceTrack([point(10, 1000), bad, point(30, 2000)], { layer: 'RAW' });
  assert.equal(model.breaks, 1);
  assert.equal(model.rejected, 1);
  assert.equal(prepareEvidenceTrack([point(10, 2000), point(30, 1000)], { layer: 'RAW' }).timingIncomplete, true);
});

test('FUSED and unknown layer retain consecutive sequence checks and same-time fused observations', () => {
  for (const layer of ['FUSED', undefined]) {
    assert.equal(prepareEvidenceTrack([point(10, 1000), point(12, 2000)], { layer }).breaks, 1);
    assert.equal(prepareEvidenceTrack([point(10, 1000), point(11, 1000), point(12, 2000)], { layer }).breaks, 0);
  }
});
