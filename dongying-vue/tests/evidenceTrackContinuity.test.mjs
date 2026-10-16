import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareEvidenceTrack } from '../src/services/evidenceTrackData.js';
import * as evidenceTrack from '../src/services/evidenceTrackData.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

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

test('record metadata supplies RAW continuity even when the opener only has a track id', () => {
  const page = { items: [point(1000, 1000), point(2100, 2100)], total: 2 };
  const detail = { entry: { source_kind: 'TRACK', source_id: 'raw-a', layer: 'RAW', source_mode: 'replay' } };
  const snapshot = evidenceTrack.evidenceTrackSnapshot('raw-a', detail, page);
  assert.equal(snapshot.layer, 'RAW');
  assert.equal(snapshot.source_mode, 'replay');
  const model = prepareEvidenceTrack(snapshot.points.items, { layer: snapshot.layer });
  assert.equal(model.breaks, 0);
  assert.equal(model.stationary, true);
  assert.equal(prepareEvidenceTrack([point(1, 1), point(2, 2, { location: {
    longitude: 118.41, latitude: 37.2, coordinate_system: 'WGS84' } })]).stationary, false);
  assert.throws(() => evidenceTrack.evidenceTrackSnapshot('another', detail, page), /不一致/);
});

function historyFixture(shift = 0, mode = 'replay') {
  const targetId = `target-${shift}`;
  const through = 4000 + shift;
  const track = (id, extra = {}) => ({ track_id: id, target_id: targetId, layer: 'RAW',
    link_id: 'same-session-link', source_id: 'source-a', device_id: 'device-a', source_mode: mode, started_at: shift + 500, ...extra });
  const tracks = [track('recent'), track('other-device', { device_id: 'device-b' }),
    track('old'), track('other-session', { link_id: 'other-link' }), track('other-mode', { source_mode: mode === 'live' ? 'replay' : 'live' }),
    track('other-target', { target_id: 'elsewhere' }), track('fused', { layer: 'FUSED' }), track('future', { started_at: through + 1 })];
  const rows = (id, times) => times.map((time, i) => ({ ...point(time + shift, time + shift), track_id: id,
    point_id: `${id}-${i}`, received_at: time + shift,
    location: { longitude: 118 + time / 100000, latitude: 37, coordinate_system: 'WGS84' } }));
  const calls = [];
  const api = {
    tracks: async (target, params) => {
      assert.equal(target, targetId); assert.equal(params.started_to, through);
      return { items: params.page === 1 ? tracks.slice(0, 3) : tracks.slice(3), total: tracks.length };
    },
    points: async (id, params) => {
      calls.push(id); assert.equal(params.time_to, through);
      const items = id === 'old' ? rows(id, [1000, 2000]) : rows(id, [3000, 4000, 5000]);
      return { items, total: items.length };
    }
  };
  return { api, calls, context: { targetId, trackId: 'recent', through, recordedThrough: through } };
}

test('history reads every page and same-source segment through the selected assessment, preserving real gaps', async () => {
  for (const shift of [0, 1800000000000]) for (const mode of ['live', 'replay']) {
    const { api, calls, context } = historyFixture(shift, mode);
    const snapshot = await evidenceTrack.loadEvidenceTrackHistory(api, context);
    assert.deepEqual(snapshot.points.items.map(p => p.observed_at), [1000, 2000, 3000, 4000].map(t => t + shift));
    assert.deepEqual(calls.sort(), ['old', 'recent']);
    assert.equal(snapshot.segment_count, 2);
    const model = prepareEvidenceTrack(snapshot.points.items, { layer: snapshot.layer });
    assert.equal(model.breaks, 1);
    assert.equal(model.stationary, false);
    assert.deepEqual(model.points.map(p => p.break_before), [true, false, true, false]);
  }
});

test('history fails closed on missing reference, incomplete pagination, denied segments or missing source identity', async () => {
  let f = historyFixture();
  await assert.rejects(evidenceTrack.loadEvidenceTrackHistory(f.api, { ...f.context, trackId: 'missing' }), /引用/);
  f = historyFixture(); f.api.tracks = async () => ({ items: [], total: 5 });
  await assert.rejects(evidenceTrack.loadEvidenceTrackHistory(f.api, f.context), /完整/);
  f = historyFixture(); f.api.points = async () => { throw new Error('forbidden'); };
  await assert.rejects(evidenceTrack.loadEvidenceTrackHistory(f.api, f.context), /forbidden/);
  f = historyFixture(); f.api.tracks = async () => ({ items: [{ track_id: 'recent', target_id: f.context.targetId, layer: 'RAW' }], total: 1 });
  await assert.rejects(evidenceTrack.loadEvidenceTrackHistory(f.api, f.context), /来源/);
});

test('cancelled history stops pagination and never returns a partial snapshot', async () => {
  const f = historyFixture(); let current = true;
  const read = f.api.tracks;
  f.api.tracks = async (...args) => { const result = await read(...args); current = false; return result; };
  assert.equal(await evidenceTrack.loadEvidenceTrackHistory(f.api, { ...f.context, isCurrent: () => current }), null);
  assert.deepEqual(f.calls, []);
});

test('actual map renderer connects sparse RAW observations and keeps fused gaps and real boundaries', () => {
  const context = { window: {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  runInNewContext(readFileSync(new URL('../public/assets/js/map.js', import.meta.url), 'utf8'), context);
  const continuous = context.window.MapView.trackContinuous;
  const raw = prepareEvidenceTrack([point(1000, 1000), point(2100, 2100)], { layer: 'RAW' }).points;
  assert.equal(continuous(raw[0], raw[1]), true);
  assert.equal(continuous(raw[0], { ...raw[1], break_before: true }), false);
  assert.equal(continuous(raw[0], { ...raw[1], track_id: 'other' }), false);
  assert.equal(continuous(raw[0], { ...raw[1], track_layer: 'FUSED' }), false);
  const fused = prepareEvidenceTrack([point(3, 1000), point(5, 2100)], { layer: 'FUSED' }).points;
  assert.equal(continuous(fused[0], fused[1]), false);
});

test('FUSED history preserves its layer, rejects late received observations and never adds RAW points', async () => {
  const tracks = ['old', 'new'].map(track_id => ({ track_id, target_id: 'fused-target', layer: 'FUSED' }));
  const api = {
    tracks: async () => ({ items: [...tracks, { track_id: 'raw', target_id: 'fused-target', layer: 'RAW' }], total: 3 }),
    points: async id => ({ items: [0, 1, 2].map(i => ({ ...point(i, 1000 + (id === 'new' ? 1000 : 0) + i * 100),
      point_id: `${id}-${i}`, track_id: id, received_at: i === 2 ? 9000 : 3000 })), total: 3 })
  };
  const snapshot = await evidenceTrack.loadEvidenceTrackHistory(api, { targetId: 'fused-target', trackId: 'new', through: 4000 });
  assert.equal(snapshot.layer, 'FUSED');
  assert.equal(snapshot.points.total, 4);
  assert.equal(prepareEvidenceTrack(snapshot.points.items, { layer: snapshot.layer }).breaks, 1);
});
