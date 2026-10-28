import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTrackHistory, thinTrackHistory, toTrack } from '../src/services/situationData.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const row = (seq, extra = {}) => ({ point_id: `p-${seq}`, track_id: 'f-1', point_seq: seq, observed_at: 1000 * seq,
  point_kind: 'MEAS', location: { longitude: 118 + seq / 1000, latitude: 37, coordinate_system: 'WGS84' }, ...extra });
const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => row(from + index));

// 地图真正的连线规则（public/assets/js/map.js），断开数 = 相邻点里不连的个数。
const sandbox = { window: {}, document: { addEventListener() {} } };
let continuous;
try {
  runInNewContext(readFileSync(new URL('../public/assets/js/map.js', import.meta.url), 'utf8'), sandbox);
  continuous = (sandbox.window.MapView || sandbox.MapView)?.trackContinuous;
} catch { continuous = null; }
continuous ||= (a, b) => !b.break_before && a.track_id === b.track_id && b.point_seq === a.point_seq + 1 && b.t > a.t;
const breaks = points => points.slice(1).filter((point, index) => !continuous(points[index], point)).length;

test('full history keeps the whole path and joins the 24-point tail without a gap', () => {
  const history = toTrack(rows(1, 300));
  const tail = toTrack(rows(290, 313));
  assert.equal(tail[0].break_before, true);
  const merged = mergeTrackHistory(history, tail);
  assert.equal(merged.length, 313);
  assert.equal(merged[0].point_seq, 1);
  assert.equal(breaks(merged), 0);
  // 尾迹与整条轨迹之间没有重叠、但正好接上时也不断开。
  const joined = mergeTrackHistory(history, toTrack(rows(301, 324)));
  assert.equal(joined.length, 324);
  assert.equal(breaks(joined), 0);
});

test('real gaps stay gaps and locally extended points are replaced by backend points', () => {
  const history = toTrack([...rows(1, 10), row(11, { break_before: true }), ...rows(12, 20)]);
  const local = { lon: 118.03, lat: 37, point_id: null, track_id: 'f-1', point_seq: 21, t: 21_000, kind: 'meas', break_before: false };
  const merged = mergeTrackHistory([...history, local], toTrack(rows(15, 22)));
  assert.equal(merged.length, 22);
  assert.equal(merged.filter(point => !point.point_id).length, 0);
  assert.equal(breaks(merged), 1);
  const newer = mergeTrackHistory(history, [...toTrack(rows(15, 20)), { ...local }]);
  assert.equal(newer.at(-1).point_id, null);
  assert.equal(breaks(newer), 1);
});

test('long flights are thinned in the older part only and still draw as connected lines', () => {
  const long = toTrack([...rows(1, 3000), row(3001, { break_before: true }), ...rows(3002, 5000)]);
  const thin = thinTrackHistory(long, { limit: 3600, recent: 1800 });
  assert.ok(thin.length <= 3600 + 4, `${thin.length}`);
  assert.equal(thin[0].point_id, 'p-1');
  assert.deepEqual(thin.slice(-1800).map(point => point.point_id), long.slice(-1800).map(point => point.point_id));
  assert.equal(breaks(thin), 1);
  // 再接新点、再抽稀，仍只有原来那一处断开。
  let track = thin;
  for (let seq = 5001; seq <= 7000; seq += 20) track = thinTrackHistory(mergeTrackHistory(track, toTrack(rows(seq, seq + 23))));
  assert.ok(track.length <= 3600 + 4);
  assert.equal(track[0].point_id, 'p-1');
  assert.equal(track.at(-1).point_id, 'p-7004');
  assert.equal(breaks(track), 1);
});
