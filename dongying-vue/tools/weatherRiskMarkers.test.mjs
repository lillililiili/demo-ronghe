import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { computed, createRenderer, nextTick, onUnmounted, ref, watch } from 'vue';
import { weatherAnchor, weatherPolygon, insideWeather, isSimulatedWeatherRisk } from '../src/services/weatherRiskGeometry.js';
import { weatherAreaRelation } from '../src/pages/airspace/airspaceRiskModel.js';

const box = (x, y, width = 2, height = 2) => [[x,y],[x+width,y],[x+width,y+height],[x,y+height],[x,y]];
test('historic weather texture is limited to identified simulated sources', () => {
  const risk = { source_mode:'mock', source_code:'QA_WEATHER_RISK_INPUT', reason_code:'WEATHER_STRONG_WIND' };
  assert.equal(isSimulatedWeatherRisk(risk), true);
  assert.equal(isSimulatedWeatherRisk({ ...risk, source_code:'WEATHER-DEMO' }), true);
  assert.equal(isSimulatedWeatherRisk({ ...risk, source_mode:'live' }), false);
  assert.equal(isSimulatedWeatherRisk({ ...risk, source_code:'unknown' }), false);
  assert.equal(isSimulatedWeatherRisk({ ...risk, reason_code:'UNRECOGNIZED' }), false);
  assert.equal(isSimulatedWeatherRisk({ sourceMode:'mock', sourceCode:'QA_WEATHER_RISK_INPUT', reasonCode:'WEATHER_THUNDERSTORM' }), true);
});
test('missing or invalid geometry never places an icon at a route or origin', () => {
  for (const fact of [null, {}, { polygon: [[1,1],[2,2]] }, { polygon: box(200, 20) },
    { polygon: [[1,1],[2,2],[3,3],[1,1]] }, { polygon: [[null,1],[2,1],[2,2],[null,1]] }]) {
    assert.equal(weatherPolygon(fact), null);
    assert.equal(weatherAnchor(fact), null);
  }
});
test('icon stays inside a concave weather area whose bounds center is outside', () => {
  const ring = [[0,0],[4,0],[4,4],[3,4],[3,1],[1,1],[1,4],[0,4],[0,0]];
  assert.equal(insideWeather([2,2], ring), false);
  const anchor = weatherAnchor({ polygon: ring });
  assert.equal(insideWeather(anchor, ring), true);
});
test('weather scope tests area intersection rather than only its icon anchor', () => {
  const ring = box(0, 0, 6, 2);
  assert.equal(weatherAreaRelation(ring, [[box(5,1)]]), 'INSIDE');
  assert.equal(weatherAreaRelation(ring, [[box(2,-2,1,6)]]), 'INSIDE');
  assert.equal(weatherAreaRelation(ring, [[box(8,8)]]), 'OUTSIDE');
  assert.equal(weatherAreaRelation(null, [[box(0,0)]]), 'UNKNOWN');
  assert.equal(weatherAreaRelation(box(2,2), [[box(0,0,10,10), box(1,1,5,5)]]), 'OUTSIDE');
});

test('weather reads preserve supplied facts, cache versions and discard late responses', async () => {
  const requested = [], pending = new Map();
  const source = (await readFile(new URL('../src/hooks/useWeatherRiskFacts.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gm, '');
  globalThis.__weatherTestDeps = { computed, onUnmounted, ref, watch,
    riskApi: { getWeatherFact: id => { requested.push(id); return new Promise(resolve => pending.set(id, resolve)); } },
    mapPool: async (items, limit, mapper) => { assert.equal(limit, 4); return Promise.all(items.map(mapper)); }
  };
  const module = await import('data:text/javascript;base64,' + Buffer.from(
    'const {computed,onUnmounted,ref,watch,riskApi,mapPool}=globalThis.__weatherTestDeps;\n' + source).toString('base64'));
  delete globalThis.__weatherTestDeps;
  const renderer = createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
  const fact = { polygon: box(118,37), source_mode: 'mock' };
  const rows = ref([{ risk_id:'wind', risk_type:'WEATHER' }, { risk_id:'bird', risk_type:'SPACE_OBJECT' },
    { risk_id:'storm', risk_type:'WEATHER', weather_fact:fact, version:0 }]);
  let result;
  const app = renderer.createApp({ setup() { result = module.useWeatherRiskFacts(rows); return () => null; } });
  app.mount({});
  assert.deepEqual(requested, ['wind']);
  assert.deepEqual(result.value.find(r => r.risk_id === 'storm').weather_fact, fact);
  pending.get('wind')(fact);
  await nextTick(); await nextTick();
  rows.value = rows.value.map(row => ({ ...row }));
  await nextTick();
  assert.deepEqual(requested, ['wind']);
  rows.value = [{ risk_id:'late', risk_type:'WEATHER', version:0 }];
  await nextTick();
  rows.value = [];
  await nextTick();
  pending.get('late')(fact);
  await nextTick(); await nextTick();
  assert.deepEqual(result.value, []);
  app.unmount();
});


test('risk map timestamps match Beijing event time across client time zones', async () => {
  const original = process.env.TZ;
  try {
    for (const name of ['ObjectRiskMapInfo', 'WeatherMapInfo']) {
      const source = await readFile(new URL(`../src/pages/flights/components/${name}.vue`, import.meta.url), 'utf8');
      const line = source.match(/^const time = (.*);$/m);
      assert.ok(line);
      const time = new Function(`return (${line[1]})`)();
      for (const zone of ['America/New_York', 'UTC', 'Asia/Shanghai']) {
        process.env.TZ = zone;
        assert.equal(time(Date.UTC(2026,9,6,8,49,18)), '2026/10/6 16:49:18');
        assert.equal(time(Date.UTC(2026,9,6,20,2,3)), '2026/10/7 04:02:03');
      }
      assert.equal(time(null), name === 'ObjectRiskMapInfo' ? '时间未知' : '未提供');
    }
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});


// 航线异物采用事件事实点；不得把过期风险恢复成实时目标。
import { randomUUID } from 'node:crypto';
import { riskSnapshotMarkers, riskSnapshotTime } from '../src/pages/situation/riskSnapshotMarkers.js';
import { groupRouteRisks } from '../src/pages/situation/routeRiskGroups.js';
import { currentMapSnapshot, toRisks } from '../src/services/situationData.js';
import { planRiskLocation } from '../src/pages/flights/planRiskMap.js';
import { layoutSituationMarkers } from '../src/pages/situation/markerLayout.js';

const snapshotRisk = (overrides = {}) => ({ riskId: randomUUID(), riskType: 'SPACE_OBJECT',
  planId: randomUUID(), routeVersionId: randomUUID(), targetInternalId: randomUUID(),
  sourceMode: 'mock', sourceCode: 'test-observation', ownerOrgId: randomUUID(), districtId: randomUUID(),
  reasonCode: 'SPACE_BALLOON', observedAt: Date.now() - 60000, occurredAt: Date.now() - 60000,
  state: 'PENDING_VERIFICATION', currentStatus: 'CURRENT',
  spaceFact: { longitude: 112.3, latitude: 31.6, subtypeCode: 'BALLOON', subtypeName: '气球', ruleVersionId: randomUUID() },
  ...overrides });

test('expired balloon snapshots match flight coordinates while live counts stay empty', () => {
  for (const sourceMode of ['live', 'mock', 'replay']) {
    const base = snapshotRisk({ sourceMode });
    const risks = Array.from({ length: 4 }, (_, index) => ({ ...base, riskId: randomUUID(),
      observedAt: base.observedAt - index * 1000, occurredAt: base.occurredAt - index * 1000,
      state: index < 2 ? 'ACKNOWLEDGED' : 'PENDING_VERIFICATION',
      spaceFact: { ...base.spaceFact, longitude: 108 + index * .001, latitude: 33 + index * .002 } }));
    const snapshot = currentMapSnapshot({ targets: [], risks }, Date.now());
    assert.equal(snapshot.targets.length, 0);
    assert.ok(snapshot.risks.every(risk => risk.currentStatus === 'UNKNOWN' && risk.mapVisible === false));
    const groups = groupRouteRisks(snapshot.risks);
    const pendingRiskIds = risks.slice(2).map(risk => risk.riskId);
    assert.equal(riskSnapshotMarkers(groups, { pendingRiskIds }).length, 2);
    const markers = riskSnapshotMarkers(groups, { pendingRiskIds, selectedPlan: base });
    assert.equal(markers.length, 4);
    for (const marker of markers) {
      assert.deepEqual(marker.anchor, planRiskLocation({ risk_type: marker.group.riskType, space_fact: marker.group.spaceFact }).anchor);
      assert.equal(marker.sourceMode, sourceMode);
    }
    assert.equal(snapshot.targets.length, 0);
    assert.ok(risks.every(risk => risk.currentStatus === 'CURRENT')); // 输入不被改写。
  }
});

test('snapshot scope keeps plan/version boundaries and distinct observations', () => {
  const base = snapshotRisk();
  const otherVersion = { ...base, riskId: randomUUID(), routeVersionId: randomUUID(), state: 'ACKNOWLEDGED' };
  const otherPlan = { ...base, riskId: randomUUID(), planId: randomUUID(), observedAt: base.observedAt - 1, state: 'ACKNOWLEDGED' };
  const groups = groupRouteRisks([base, otherVersion, otherPlan]);
  assert.equal(riskSnapshotMarkers(groups).length, 0);
  assert.deepEqual(riskSnapshotMarkers(groups, { selectedPlan: base }).map(row => row.group.riskId), [base.riskId]);
  const other = groups.find(group => group.riskId === otherVersion.riskId);
  assert.deepEqual(riskSnapshotMarkers(groups, { selectedGroupId: other.groupId }).map(row => row.group.riskId), [otherVersion.riskId]);
  // 同一次观测影响多个计划只画一个位置，点击仍携带各自的风险 ID。
  const secondPlan = { ...base, riskId: randomUUID(), planId: randomUUID() };
  const rows = riskSnapshotMarkers(groupRouteRisks([base, secondPlan]), { pendingRiskIds: [base.riskId, secondPlan.riskId] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group.members.length, 2);
});

test('missing snapshot coordinates never borrow route or live positions', () => {
  for (const longitude of [null, undefined, '', ' ', false, NaN, Infinity, 181]) {
    const risk = snapshotRisk();
    risk.spaceFact.longitude = longitude;
    assert.deepEqual(riskSnapshotMarkers(groupRouteRisks([risk]), { selectedPlan: risk }), []);
    const mapped = toRisks([{ risk_id: risk.riskId, risk_type: risk.riskType,
      plan_id: risk.planId, route_version_id: risk.routeVersionId,
      state: risk.state, space_fact: { longitude, latitude: risk.spaceFact.latitude } }])[0];
    assert.equal(mapped.spaceFact.longitude, null);
    assert.equal(mapped.spaceFact.latitude, null);
    assert.deepEqual(riskSnapshotMarkers(groupRouteRisks([mapped]), { selectedPlan: mapped }), []);
  }
  const risk = snapshotRisk();
  risk.spaceFact.latitude = 86;
  assert.deepEqual(riskSnapshotMarkers(groupRouteRisks([risk]), { selectedPlan: risk }), []);
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(riskSnapshotTime(Date.UTC(2026, 2, 5, 2, 3, 4)), '2026/3/5 10:03:04');
    assert.equal(riskSnapshotTime(null), '时间未知');
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('snapshot layer follows shared layout across zoom, pan and hiding without alarm glow', async () => {
  const source = (await readFile(new URL('../src/pages/situation/SituationRiskMarkers.vue', import.meta.url), 'utf8'))
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
  const base = snapshotRisk();
  const groups = groupRouteRisks([base, { ...base, riskId: randomUUID(), observedAt: base.observedAt - 1 }]);
  const props = { rows: riskSnapshotMarkers(groups, { selectedPlan: base }), visible: true };
  let exposed;
  const markerRef = { value: [] };
  new Function('ref', 'riskSnapshotTime', 'defineProps', 'defineEmits', 'defineExpose', 'window', source)(
    () => markerRef, riskSnapshotTime, () => props, () => {}, value => { exposed = value; },
    { UI: { targetIcon: target => target.subtypeCode } });
  for (const [zoom, pan] of [[1, 0], [2, 30], [.5, -20]]) {
    const map = { w: 900, h: 600, px: (lon, lat) => [(lon - 112) * 500 * zoom + pan, (lat - 31) * 300 * zoom + pan] };
    const inputs = exposed.getMarkers(map);
    assert.ok(inputs.every(item => item.abnormal === false && item.data.historical === true));
    map._markerLayout = layoutSituationMarkers(inputs.map(item => ({ ...item, x: item.point[0], y: item.point[1] })), { width: map.w, height: map.h });
    exposed.draw(map);
    assert.equal(markerRef.value.length, 2);
    assert.notDeepEqual([markerRef.value[0].x, markerRef.value[0].y], [markerRef.value[1].x, markerRef.value[1].y]);
    assert.deepEqual([markerRef.value[0].anchorX, markerRef.value[0].anchorY], map.px(...props.rows[0].anchor));
    assert.ok(markerRef.value.every(marker => marker.description.includes('发现时位置（非实时）')));
  }
  props.visible = false;
  assert.deepEqual(exposed.getMarkers({ w: 900 }), []);
  exposed.draw({ w: 900 });
  assert.deepEqual(markerRef.value, []);
});
