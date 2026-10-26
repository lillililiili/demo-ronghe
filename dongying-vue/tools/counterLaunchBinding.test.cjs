const riskHelpers = require('./riskCaseTestHelpers.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vue = require('vue');

const source = readFileSync(path.join(__dirname, '../src/pages/alarms/CounterLaunch.vue'), 'utf8')
  .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
function fixture(direct = false) {
  const eventId = randomUUID();
  const summary = { event_id: eventId, counter_launch_visible: true,
    can_request_counter: !direct, can_direct_counter: direct };
  const props = vue.reactive({ eventId, eventLabel: 'test-' + randomUUID(), active: true,
    confirmed: true, showLaunch: true, counterStopped: false, summary });
  const state = { token: randomUUID(), form: null, reads: [], unmounts: [], events: [] };
  const deps = { ...riskHelpers, ...vue, defineProps: () => props, defineEmits: () => (...args) => state.events.push(args),
    onUnmounted: cb => state.unmounts.push(cb), openModal: () => ({ close() {} }), window: { UI: {} },
    readSessionToken: () => state.token, hasPermission: () => true,
    counterLaunchLabel: () => '', counterPermissionHint: () => '', noCounterEntryVisible: () => true,
    uavAdvisoryApi: { get: async id => { state.reads.push(id); return { ...props.summary }; } },
    disposalApi: { policies: async () => ({}) }, getUavEvent: async () => ({ target_id: randomUUID() }),
    targetApi: { detail: async () => ({ latest_state: null }) },
    openDisposalRequest: async options => { state.form = { ...options, direct: false }; },
    openDisposalDirect: async options => { state.form = { ...options, direct: true }; }
  };
  const scope = vue.effectScope();
  const api = scope.run(() => new Function(...Object.keys(deps), source + '\nreturn { launch };')(...Object.values(deps)));
  return { props, state, ...api, close() { state.unmounts.forEach(cb => cb()); scope.stop(); } };
}

test('same-event qualification refresh keeps the request bound while current eligibility remains required', async () => {
  for (const direct of [false, true]) {
    const f = fixture(direct);
    try {
      await f.launch();
      const form = f.state.form;
      assert.equal(form.direct, direct);
      assert.equal(form.subjectId, f.props.eventId);
      assert.deepEqual(f.state.reads, [f.props.eventId]);
      for (let version = 2; version <= 6; version++) {
        f.props.summary = { ...f.props.summary, event_version: version, prediction_id: randomUUID() };
        await vue.nextTick();
        assert.equal(form.isCurrent(), true, 'fresh snapshots of the same event do not switch the form');
      }
      f.props.showLaunch = false;
      assert.equal(form.isCurrent(), false, 'unavailable qualification still blocks submission');
      f.props.showLaunch = true;
      assert.equal(form.isCurrent(), true, 'fresh eligibility for the unchanged event restores its existing form');
      assert.equal(form.subjectId, f.props.eventId, 'refresh never retargets an open request');
    } finally { f.close(); }
  }
});

test('real event, page, stop and session changes still invalidate an open request', async () => {
  for (const change of ['eventId', 'active', 'counterStopped', 'session', 'unmount']) {
    const f = fixture();
    try {
      await f.launch();
      const form = f.state.form, original = f.props[change];
      if (change === 'session') f.state.token = randomUUID();
      else if (change === 'unmount') f.state.unmounts.forEach(cb => cb());
      else f.props[change] = change === 'eventId' ? randomUUID() : !original;
      assert.equal(form.isCurrent(), false, change);
      if (['eventId', 'active', 'counterStopped'].includes(change)) {
        f.props[change] = original;
        assert.equal(form.isCurrent(), false, 'returning to previous state cannot revive a switched form');
      }
    } finally { f.close(); }
  }
});


test('同事件多区反制表单绑定当前风险，并把办理记录导航保留在该风险', async () => {
  const f = fixture();
  try {
    const risk = { risk_case_id: randomUUID(), version: 11 };
    f.props.riskCase = risk; f.props.summary = { ...f.props.summary, risk_case: risk };
    await f.launch();
    assert.deepEqual(f.state.form.riskContext, { risk_case_id: risk.risk_case_id, expected_case_version: risk.version });
    const authorization_id = randomUUID(); f.state.form.onDone({ authorization_id });
    assert.deepEqual(f.state.events.find(row => row[0] === 'records')[1], { eventId: f.props.eventId, riskCaseId: risk.risk_case_id, authorizationId: authorization_id });
    f.props.riskCase = { risk_case_id: randomUUID(), version: 11 };
    assert.equal(f.state.form.isCurrent(), false);
  } finally { f.close(); }
});
