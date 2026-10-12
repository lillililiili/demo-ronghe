import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { parse, compileScript } from '@vue/compiler-sfc';
import * as Vue from 'vue';

const source = await readFile(new URL('../src/pages/airspace/AirspaceRiskEventDetail.vue', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/pages/airspace/AirspacePage.vue', import.meta.url), 'utf8');
const compiled = compileScript(parse(source).descriptor, { id: 'risk-detail-sync' }).content;
const imports = [...compiled.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g)];
const bindings = imports.flatMap(match => match[1].startsWith('{')
  ? match[1].slice(1, -1).split(',').map(name => name.trim().replace(/\s+as\s+/, ':'))
  : [match[1].trim()]);
const setupCode = compiled.replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '')
  .replace('export default', 'return');
const makeComponent = new Function('deps', `const {${bindings.join(',')}} = deps;\n${setupCode}`);
const updateSource = page.match(/function updateRiskRecord\(record\) \{[\s\S]*?\n\}/)[0];
const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
const empty = () => Promise.resolve({ items: [], total: 0 });
const fact = (id, current_status) => ({ risk_id: id, current_status, state: 'ACKNOWLEDGED', version: 2 });

async function flush() {
  for (let i = 0; i < 8; i++) await Vue.nextTick();
}

function fixture() {
  const requests = [], updates = [], selected = Vue.ref('risk-a');
  const risks = Vue.reactive({ rows: [fact('risk-a', 'CURRENT'), fact('risk-b', 'UNKNOWN')] });
  const updateRiskRecord = new Function('risks', `${updateSource}; return updateRiskRecord;`)(risks);
  const deps = Object.fromEntries(bindings.map(name => [name, {}]));
  Object.assign(deps, Vue, {
    riskApi: { getRisk: id => new Promise(resolve => requests.push({ id, resolve })), listRiskVerifications: empty },
    handoffApi: { listHandoffs: empty }, hasPermission: () => false,
  });
  const component = makeComponent(deps);
  component.render = () => null;
  const app = renderer.createApp({ setup: () => () => {
    const row = risks.rows.find(item => item.risk_id === selected.value);
    return Vue.h(component, { riskId: row.risk_id, onUpdated: record => {
      updates.push(record); updateRiskRecord(record);
    } });
  } });
  app.mount({});
  return { app, requests, updates, selected, risks, detail: app._instance.subTree.component.setupState };
}

test('fresh CLEARED detail updates the actual parent row callback once without reloading itself', async () => {
  const f = fixture();
  try {
    const cleared = fact('risk-a', 'CLEARED');
    f.requests[0].resolve(cleared);
    await flush();
    assert.deepEqual(f.updates, [cleared]);
    assert.equal(f.risks.rows[0].current_status, 'CLEARED');
    assert.equal(f.risks.rows[1].current_status, 'UNKNOWN');
    assert.equal(f.detail.risk.current_status, 'CLEARED');
    assert.equal(f.requests.length, 1, 'parent row replacement must not trigger another detail load');
  } finally { f.app.unmount(); }
});

test('a late request for the same risk cannot replace the newest accepted facts', async () => {
  const f = fixture();
  try {
    const retry = f.detail.load();
    f.requests[1].resolve(fact('risk-a', 'CLEARED'));
    await retry;
    f.requests[0].resolve(fact('risk-a', 'CURRENT'));
    await flush();
    assert.equal(f.updates.length, 1);
    assert.equal(f.risks.rows[0].current_status, 'CLEARED');
    assert.equal(f.detail.risk.current_status, 'CLEARED');
  } finally { f.app.unmount(); }
});

test('switching IDs discards the old detail response and publishes only the current risk', async () => {
  const f = fixture();
  try {
    f.selected.value = 'risk-b';
    await flush();
    assert.deepEqual(f.requests.map(request => request.id), ['risk-a', 'risk-b']);
    f.requests[0].resolve(fact('risk-a', 'CLEARED'));
    await flush();
    assert.equal(f.updates.length, 0);
    assert.equal(f.risks.rows[0].current_status, 'CURRENT');
    f.requests[1].resolve(fact('risk-b', 'CLEARED'));
    await flush();
    assert.equal(f.updates.length, 1);
    assert.equal(f.updates[0].risk_id, 'risk-b');
    assert.equal(f.risks.rows[1].current_status, 'CLEARED');
  } finally { f.app.unmount(); }
});

test('unmounting prevents a pending detail response from updating parent rows', async () => {
  const f = fixture();
  f.app.unmount();
  f.requests[0].resolve(fact('risk-a', 'CLEARED'));
  await flush();
  assert.equal(f.updates.length, 0);
  assert.equal(f.risks.rows[0].current_status, 'CURRENT');
});

test('action refresh publishes once and also discards obsolete responses', async () => {
  const f = fixture();
  try {
    f.requests[0].resolve(fact('risk-a', 'CURRENT'));
    await flush();
    const older = f.detail.refreshAfterAction('risk-a');
    const newer = f.detail.refreshAfterAction('risk-a');
    f.requests[2].resolve(fact('risk-a', 'CLEARED'));
    await newer;
    f.requests[1].resolve(fact('risk-a', 'CURRENT'));
    await older;
    await flush();
    assert.deepEqual(f.updates.map(item => item.current_status), ['CURRENT', 'CLEARED']);
    assert.equal(f.risks.rows[0].current_status, 'CLEARED');
    f.selected.value = 'risk-b';
    await flush();
    const count = f.requests.length;
    assert.equal(await f.detail.refreshAfterAction('risk-a'), null);
    assert.equal(f.requests.length, count, 'old action callback must not request the newly selected detail');
  } finally { f.app.unmount(); }
});


test('monitor cards keep first-discovery order and selection while live observations update', async () => {
  const { useAirspaceRiskList } = await import('../src/pages/airspace/useAirspaceRiskList.js');
  const previousWindow = globalThis.window;
  globalThis.window = { UI: { abnormalActive: () => false } };
  const scope = Vue.effectScope();
  try {
    for (const base of [100000, 900000]) {
      const id = `object-${base}`;
      const monitor = Vue.reactive({ canRead: true, recent: [
        { target_id: id, first_seen_at: base, last_seen_at: base + 900 },
        { target_id: `${id}-new`, first_seen_at: base + 100, last_seen_at: base + 500 }
      ], activeId: id, minutes: 5 });
      const risks = Vue.reactive({ canRead: true, locatedRows: [], activeId: '' });
      const list = scope.run(() => useAirspaceRiskList(monitor, risks, Vue.ref(null)));
      const keys = list.rows.value.map(row => row.key);
      assert.deepEqual(keys, [`target:${id}-new`, `target:${id}`]);
      for (let tick = 1; tick <= 5; tick++) {
        monitor.recent = [...monitor.recent].reverse().map((row, index) => ({ ...row,
          last_seen_at: base + 1000 * tick + index, point: [118 + tick / 1000, 37] }));
        await Vue.nextTick();
        assert.deepEqual(list.rows.value.map(row => row.key), keys);
        assert.equal(list.active.value.at, base);
        assert.equal(list.active.value.target.last_seen_at >= base + 1000 * tick, true);
      }
      risks.locatedRows = [{ risk_id: `${id}-risk`, occurred_at: base + 2000, risk_type: 'FOREIGN_OBJECT' }];
      monitor.recent[0].risk_summary = { risk_id: `${id}-risk` };
      await Vue.nextTick();
      assert.equal(list.rows.value[0].at, base + 2000, 'new risk facts still move into event order');
      monitor.recent.push({ target_id: `${id}-unknown`, last_seen_at: base + 9000 });
      await Vue.nextTick();
      assert.equal(list.rows.value.at(-1).at, undefined, 'missing discovery time never falls back to moving observation time');
    }
  } finally { scope.stop(); globalThis.window = previousWindow; }
});
