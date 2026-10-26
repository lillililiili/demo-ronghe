import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import * as Vue from 'vue';
import { parse } from '@vue/compiler-sfc';
import { pointRelation } from '../src/pages/airspace/airspaceGeometry.js';
import { hitMapReference } from '../src/pages/airspace/airspaceReferenceHover.js';

const source = await readFile(new URL('../src/pages/airspace/AirspacePage.vue', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const setup = descriptor.scriptSetup.content.replace(/import[\s\S]*?from ['"][^'"]+['"];?/g, '');

const clientSource = await readFile(new URL('../src/services/apiClient.js', import.meta.url), 'utf8');
const poolSource = clientSource.match(/export async function mapPool[\s\S]*?\n}/)[0].replace('export ', '');
const mapPool = new Function(`${poolSource}; return mapPool;`)();
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

function pageFixture(row, overrides = {}) {
  const calls = [], mounted = [], unmounted = [];
  const versions = [{ airspace_version_id: `${row.airspace_id}-version`, version_no: 1 }];
  let subscription;
  const dependencies = {
    ...Vue, mapPool, onMounted: callback => mounted.push(callback), onUnmounted: callback => unmounted.push(callback),
    usePageChrome() {}, hasPermission: () => true, refreshFailureText: error => error.message,
    useRealtimeRefresh: (topics, callback) => (subscription = { topics, trigger: callback }),
    airspaceApi: {
      list: async query => { calls.push(['airspaces', query]); return { items: [row], total: 1 }; },
      versions: async id => { calls.push(['versions', id]); return { items: versions }; },
      ...overrides
    },
    flightApi: { routes: async () => { calls.push(['routes']); return { items: [] }; } },
    AIRSPACE_KIND_LABEL: {}, AIRSPACE_KIND_TAG: {}, ALTITUDE_DATUM_LABEL: {},
    labelOf: (labels, code, fallback = code) => labels[code] || fallback,
    polygonRings: boundary => boundary?.coordinates || [], toAirspaces: rows => rows,
    airspaceKindMeta: () => ({ color: '#123456' }),
    displayAirspaceNo: value => value, displayRouteNo: value => value
  };
  const scope = Vue.effectScope();
  const page = scope.run(() => new Function('dependencies', `with (dependencies) {
    ${setup}
    return { refreshPage, loadAll, select, clearDetail, all, selected, versions, filters, filtered, canManage, loading, refreshing, error };
  }`)(dependencies));
  return { page, calls, subscription, versions,
    mount: async () => { for (const callback of mounted) await callback(); },
    dispose: () => { for (const callback of unmounted) callback(); scope.stop(); }
  };
}

test('airspace initialization, refresh and updates only read airspace and route data', async () => {
  for (const [index, sourceMode] of ['live', 'replay'].entries()) {
    const row = { airspace_id: `area-${sourceMode}-${index}`, district_id: `district-${index}`,
      name: `空域${index}`, source_mode: sourceMode, editable: true, management_source: 'LOCAL',
      current_version: { kind_code: 'PERMITTED', boundary: { coordinates: [] } } };
    const f = pageFixture(row);
    try {
      await f.mount();
      assert.deepEqual(f.subscription.topics, ['airspace', 'plan']);
      assert.deepEqual(f.calls.map(([name]) => name).sort(), ['airspaces', 'routes']);
      assert.equal(f.page.all.value[0].airspace_id, row.airspace_id);
      assert.equal(f.page.canManage.value, true);

      f.calls.length = 0;
      await f.page.select(row);
      assert.deepEqual(f.calls, [['versions', row.airspace_id]]);
      assert.deepEqual(f.page.versions.value, f.versions);
      f.page.filters.district = row.district_id;
      await Vue.nextTick();
      assert.equal(f.page.filtered.value.length, 1);

      f.calls.length = 0;
      await f.page.refreshPage();
      assert.deepEqual(f.calls.map(([name]) => name).sort(), ['airspaces', 'routes']);
      assert.equal(f.page.selected.value.airspace_id, row.airspace_id);

      f.calls.length = 0;
      await f.subscription.trigger(['risk', 'target']);
      assert.deepEqual(f.calls, [], 'removed risk and target updates must not trigger background reads');
      await f.subscription.trigger(['airspace']);
      assert.deepEqual(f.calls.map(([name]) => name).sort(), ['airspaces', 'versions']);
      f.page.clearDetail();
      assert.equal(f.page.selected.value, null);
    } finally { f.dispose(); }
  }
});

test('airspace view exposes its retained list, volume editor and history without risk controls', () => {
  assert.doesNotMatch(source, /useAirspaceRisks|useAirspaceRiskList|useAirspaceMonitor|riskApi|targetApi/);
  assert.doesNotMatch(descriptor.template.content, /空域监测|范围内风险|AirspaceRisk|WeatherRiskMarkers|AirspaceObjectMarkers/);
  for (const text of ['空域列表', '新增空域', '三维编辑', '删除空域', '版本历史', '任务航线']) {
    assert.ok(descriptor.template.content.includes(text), `retained control: ${text}`);
  }
});

test('reference geometry retains holes, boundaries and line priority at different locations', () => {
  for (const [x, y] of [[0, 0], [150, 80]]) {
    const box = (left, top, width) => [[left, top], [left + width, top],
      [left + width, top + width], [left, top + width], [left, top]];
    const outer = box(x, y, 100), hole = box(x + 20, y + 20, 30);
    assert.equal(pointRelation([x + 10, y + 10], [[outer, hole]]), 'INSIDE');
    assert.equal(pointRelation([x + 30, y + 30], [[outer, hole]]), 'OUTSIDE');
    assert.equal(pointRelation([x, y + 10], [[outer, hole]]), 'BOUNDARY');
    assert.equal(pointRelation(null, [[outer]]), 'UNKNOWN');
    const region = { id: 'area', polygon: true, points: outer };
    const route = { id: 'route', points: [[x + 5, y + 10], [x + 90, y + 10]] };
    assert.equal(hitMapReference([x + 50, y + 10], [route, region]).id, 'route');
    assert.equal(hitMapReference([x + 50, y + 60], [route, region]).id, 'area');
    assert.equal(hitMapReference([x + 140, y + 140], [route, region]), null);
  }
});


test('list becomes usable before slow future-version reads finish, and newer refresh wins', async () => {
  for (const source_mode of ['live', 'replay']) {
    const row = { airspace_id: `future-${source_mode}`, version: 1, source_mode, current_version: null };
    const history = deferred();
    let current = row;
    const f = pageFixture(row, {
      list: async () => ({ items: [current], total: 1 }),
      versions: () => history.promise
    });
    try {
      const first = f.page.loadAll();
      await turn();
      assert.equal(f.page.loading.value, false, 'list is usable without waiting for history');
      assert.equal(f.page.refreshing.value, true, 'automatic refresh still shares the ongoing read');
      assert.equal(f.page.all.value[0].version, 1);
      current = { ...row, version: 2, current_version: { kind_code: 'PERMITTED' } };
      await f.page.loadAll();
      history.resolve({ items: [{ valid_from: Date.now() + 60000 }] });
      await first;
      assert.equal(f.page.all.value[0].version, 2, 'late old history cannot replace current data');
      assert.equal(f.page.refreshing.value, false);
    } finally { f.dispose(); }
  }
});

test('paginated airspaces use bounded concurrency and retain server page ordering', async () => {
  const requests = [], results = new Map();
  const row = { airspace_id: 'page-1', current_version: {} };
  const f = pageFixture(row, { list: query => {
    requests.push(query.page);
    if (query.page === 1) return Promise.resolve({ items: [row], total: 500 });
    const pending = deferred(); results.set(query.page, pending); return pending.promise;
  } });
  try {
    const reading = f.page.loadAll();
    await turn();
    assert.deepEqual(requests, [1, 2, 3, 4], 'at most three remaining pages are in flight');
    results.get(3).resolve({ items: [{ ...row, airspace_id: 'page-3' }] });
    await turn();
    assert.deepEqual(requests, [1, 2, 3, 4, 5]);
    for (const page of [5, 4, 2]) results.get(page).resolve({ items: [{ ...row, airspace_id: `page-${page}` }] });
    await reading;
    assert.deepEqual(f.page.all.value.map(item => item.airspace_id), [1, 2, 3, 4, 5].map(page => `page-${page}`));
  } finally { f.dispose(); }
});

test('superseded failures and unmounted requests cannot clear or restore the current list', async () => {
  const row = { airspace_id: 'latest-area', current_version: {} };
  const requests = [];
  const f = pageFixture(row, { list: () => { const next = deferred(); requests.push(next); return next.promise; } });
  const oldRead = f.page.loadAll();
  const newRead = f.page.loadAll();
  requests[1].resolve({ items: [row], total: 1 }); await newRead;
  requests[0].reject(new Error('old request failed')); await oldRead;
  assert.equal(f.page.all.value[0].airspace_id, row.airspace_id);
  assert.equal(f.page.error.value, '');
  const late = f.page.loadAll(); f.dispose();
  requests[2].resolve({ items: [{ ...row, airspace_id: 'stale-area' }], total: 1 }); await late;
  assert.equal(f.page.all.value[0].airspace_id, row.airspace_id);
});
