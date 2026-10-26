const riskHelpers = require('./riskCaseTestHelpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(origin) {
  const alarm = { alarm_id: randomUUID(), event_id: randomUUID(), origin_kind: origin };
  const event = { event_id: alarm.event_id, state: 'CONFIRMED', version: 3 };
  const initial = { alarm, event, loading: false, verificationsLoaded: true, chain: { files: [] } };
  const st = { selId: alarm.alarm_id }, requests = [], paints = [];
  const deps = { ...riskHelpers, list: { rows: [] }, st, disposal: {}, initial,
    emptyDetail: () => ({ alarm: null, event: null, loading: false }),
    getAlarm: id => { const request = deferred(); requests.push({ ...request, id }); return request.promise; },
    getUavEvent: async id => ({ ...event, event_id: id }),
    refreshEventDisposals: async () => {}, loadEventDisposals: async () => {},
    paintDetail: () => paints.push('detail'), paintList() {}, focusMap() {}, el: () => null,
    loadTarget: async () => {}, loadMapAirspaces: async () => {}, loadChain: async () => {},
    loadEscalations: async () => {}, loadVerifications: async () => {}, refreshChain: async () => {},
    briefOf: () => null, messageOf: e => e.message, shouldRetryRefresh: e => e.status >= 500
  };
  deps.readRiskAlarm = deps.getAlarm;
  const api = new Function(...Object.keys(deps), 'let authorizationPageActive = true; let cur = initial, detailSeq = 1, disposalSeq = 1;\n'
    + body('selectAlarm') + body('refreshSelected')
    + '\nreturn { selectAlarm, refreshSelected, current: () => cur, sequence: () => detailSeq, leave: () => { authorizationPageActive = false; } };')(...Object.values(deps));
  return { alarm, initial, st, requests, paints, ...api };
}

test('reselecting an open alarm refreshes in place for predicted and observed events', async () => {
  for (const origin of ['PREDICTED_AIRSPACE_ENTRY', 'OBSERVED']) {
    const f = fixture(origin), pending = f.selectAlarm(f.alarm.alarm_id);
    assert.equal(f.current(), f.initial);
    assert.equal(f.current().loading, false);
    assert.equal(f.sequence(), 1, 'same-event reread preserves the detail binding');
    assert.equal(f.current().event.event_id, f.alarm.event_id);
    f.requests[0].resolve({ ...f.alarm, prediction: { prediction_id: randomUUID() } });
    await pending;
    assert.equal(f.current(), f.initial);
    assert.equal(f.current().event.event_id, f.alarm.event_id);
    assert.equal(f.current().chain.files.length, 0, 'existing evidence remains while it is reread');
  }
});

test('repeated selection during first load shares the in-flight selection and ignores late old replies', async () => {
  const f = fixture('OBSERVED'), second = randomUUID(), third = randomUUID();
  const firstRead = f.selectAlarm(second);
  assert.equal(f.current().alarm, null, 'a real selection change removes old actionable content');
  assert.equal(f.current().loading, true);
  await f.selectAlarm(second);
  assert.equal(f.requests.length, 1, 'same loading selection is not restarted');
  const thirdRead = f.selectAlarm(third);
  f.requests[1].resolve({ alarm_id: third, event_id: randomUUID() });
  await thirdRead;
  f.requests[0].resolve({ alarm_id: second, event_id: randomUUID() });
  await firstRead;
  assert.equal(f.current().alarm.alarm_id, third, 'late response cannot restore a previous event');
});

test('refresh preserves temporary outage data but removes revoked or missing event access', async () => {
  for (const status of [503, 403, 404]) {
    const f = fixture('PREDICTED_AIRSPACE_ENTRY'), pending = f.selectAlarm(f.alarm.alarm_id);
    f.requests[0].reject(Object.assign(new Error('read failed'), { status }));
    if (status === 503) {
      await assert.rejects(pending, /read failed/);
      assert.equal(f.current(), f.initial);
    } else {
      await pending;
      assert.equal(f.current().alarm, null, 'revoked data cannot remain actionable');
      assert.equal(f.current().error, 'read failed');
      assert.equal(f.sequence(), 2, 'access loss invalidates previous detail requests');
    }
  }
});


test('离开页面后不再启动选中风险刷新，原在途响应也不更新详情', async () => {
  for (const origin of ['PREDICTED_AIRSPACE_ENTRY', 'OBSERVED']) {
    const f = fixture(origin), pending = f.refreshSelected();
    f.leave(); f.requests[0].resolve({ ...f.alarm, target_id: randomUUID() }); await pending;
    assert.equal(f.current().alarm, f.alarm); assert.equal(f.paints.length, 0);
    await f.refreshSelected(); assert.equal(f.requests.length, 1);
  }
});
