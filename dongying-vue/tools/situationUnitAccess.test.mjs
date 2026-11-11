import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('a renewed account clears old-unit map data immediately, including during an old request', { timeout: 5000 }, async () => {
  const events = new EventTarget();
  const add = globalThis.addEventListener, remove = globalThis.removeEventListener;
  globalThis.addEventListener = events.addEventListener.bind(events);
  globalThis.removeEventListener = events.removeEventListener.bind(events);
  let oldRequest, hold = false;
  const deps = {
    deviceApi: { eoSituation: async () => ({ items: [], total: 0 }), list: async () => hold ? new Promise(resolve => { oldRequest = resolve; }) : { items: [{ device_id: 'unit-a-device', enabled: true }], total: 1 } },
    authUser: { value: { user_type: 'FRONTEND' } }, hasPermission: code => code === 'devices.read',
    onDataChange: () => () => {}, toDevices: rows => rows, attachEoCameraStates: rows => rows,
    attachDeviceEvents: rows => rows, attachBearing: rows => rows, planIsCurrent: () => false,
    bearingOrigins: () => [], mapPool: async (rows, count, fn) => Promise.all(rows.map(fn)),
    toAirspaces: rows => rows, toFlightPlans: rows => rows, toAlarms: rows => rows, toRisks: rows => rows,
    toTargets: rows => rows, attachRecentTracks: rows => rows, extendRecentTracks: rows => rows
  };
  globalThis.__unitAccessDeps = deps;
  const source = readFileSync(new URL('../src/pages/situation/situationApiSource.js', import.meta.url), 'utf8')
    .replace(/import[\s\S]*?from ['"][^'"]+['"];\r?\n/g, '');
  const module = await import(`data:text/javascript;base64,${Buffer.from(`const { ${Object.keys(deps).join(',')} } = globalThis.__unitAccessDeps;\n${source}`).toString('base64')}`);
  const api = module.createSituationApiSource({ now: () => Date.now() });
  try {
    api.start(() => {});
    await api.refresh();
    assert.equal(api.current().devices[0].device_id, 'unit-a-device');
    hold = true;
    const pending = api.refresh();
    while (!oldRequest) await new Promise(resolve => setImmediate(resolve));
    events.dispatchEvent(new Event('auth-access-change'));
    assert.deepEqual(api.current().devices, []);
    assert.equal(api.current().deviceUpdatedAt, 0);
    hold = false;
    deps.deviceApi.list = async () => ({ items: [{ device_id: 'unit-b-device', enabled: true }], total: 1 });
    oldRequest({ items: [{ device_id: 'unit-a-device', enabled: true }], total: 1 });
    await pending;
    await api.refresh();
    assert.deepEqual(api.current().devices.map(d => d.device_id), ['unit-b-device']);
  } finally {
    api.stop(); delete globalThis.__unitAccessDeps;
    if (add) globalThis.addEventListener = add; else delete globalThis.addEventListener;
    if (remove) globalThis.removeEventListener = remove; else delete globalThis.removeEventListener;
  }
});
