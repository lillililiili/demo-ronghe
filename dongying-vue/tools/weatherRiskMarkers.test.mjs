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
