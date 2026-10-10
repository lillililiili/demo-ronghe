const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { computed, ref } = require('vue');

function fixtures(allowed) {
  const hasPermission = code => allowed && code === 'handoff:create';
  const flight = readFileSync(path.join(__dirname, '../src/pages/FlightsPage.vue'), 'utf8');
  const itemFunction = flight.match(/function canNotifyItem\(item\) \{[^\n]+\}/)[0];
  const canNotifyItem = new Function('hasPermission', itemFunction + '; return canNotifyItem;')(hasPermission);
  const source = readFileSync(path.join(__dirname, '../src/pages/airspace/AirspaceRiskEventDetail.vue'), 'utf8');
  const expression = source.slice(source.indexOf('const canNotify = computed('), source.indexOf('const notifyReason = computed('));
  const risk = ref(null), submitted = ref(null);
  const canNotify = new Function('computed', 'hasPermission', 'loading', 'noticesLoading', 'noticesError', 'submitted', 'risk', expression + '; return canNotify;')(
    computed, hasPermission, ref(false), ref(false), ref(''), submitted, risk);
  return { canNotifyItem, canNotify, risk, submitted };
}

test('read-only users cannot notify from either risk entry, including a stale NOTIFY action', () => {
  const f = fixtures(false);
  for (const actions of [[], ['NOTIFY']]) {
    const risk = { state: 'PENDING_NOTIFICATION', allowed_actions: actions };
    assert.equal(f.canNotifyItem(risk), false);
    f.risk.value = risk;
    assert.equal(f.canNotify.value, false);
  }
});

test('authorized users can notify a pending risk and cannot resubmit an existing notice', () => {
  const f = fixtures(true);
  const risk = { state: 'PENDING_NOTIFICATION', allowed_actions: [] };
  assert.equal(f.canNotifyItem(risk), true);
  f.risk.value = risk;
  assert.equal(f.canNotify.value, true);
  f.submitted.value = { delivery_status: 'SUBMITTED' };
  assert.equal(f.canNotify.value, false);
  assert.equal(f.canNotifyItem({ state: 'PENDING_VERIFICATION', allowed_actions: [] }), false);
});


function notificationFixture(allowed = true) {
  const file = readFileSync(path.join(__dirname, '../src/ui/riskNotificationModal.js'), 'utf8');
  const source = file.replace(/import[\s\S]*?from ['"][^'"]+['"];?/g, '').replace('export function', 'function');
  const f = { dialogs: [], submissions: [], refreshed: 0, done: [], existing: 0, sequence: 0, failure: null };
  const deps = { hasPermission: () => allowed, openFormModal: opts => f.dialogs.push(opts), closeModal() {}, toast() {},
    newHandoffIdempotencyKey: () => `submission-${++f.sequence}`,
    isUncertainOutcome: error => error.code === 'TIMEOUT',
    handoffApi: { createHandoff: async (body, key) => { f.submissions.push({ body, key }); if (f.failure) throw f.failure; return { source_id: body.source_id, delivery_status: 'SUBMITTED' }; } } };
  f.open = new Function(...Object.keys(deps), `${source}; return openRiskNotification;`)(...Object.values(deps));
  f.options = risk => ({ risk, refresh: async () => { f.refreshed++; }, onDone: created => f.done.push(created), onExisting: () => f.existing++ });
  return f;
}

test('shared notification requires verification and permission; opening never writes', async () => {
  for (const allowed of [true, false]) {
    const f = notificationFixture(allowed);
    for (const state of ['PENDING_VERIFICATION', 'EXCLUDED', 'NOTIFIED', 'ACKNOWLEDGED']) {
      assert.equal(f.open(f.options({ risk_id: `event-${state}`, state, allowed_actions: ['NOTIFY'], version: 3 })), false);
    }
    for (const [id, version] of [['event-one', 4], ['another-event', 19]]) {
      const before = f.submissions.length;
      assert.equal(f.open(f.options({ risk_id: id, state: 'PENDING_NOTIFICATION', version })), allowed);
      assert.equal(f.submissions.length, before, 'opening must not send');
      if (allowed) {
        await f.dialogs.at(-1).onSubmit();
        assert.deepEqual(f.submissions.at(-1).body, { source_kind: 'RISK', source_id: id, handoff_type: 'RISK_NOTICE', expected_version: version });
      }
    }
  }
});

test('uncertain notifications reuse the submission key and do not claim success', async () => {
  const f = notificationFixture();
  const risk = { risk_id: 'uncertain-risk', state: 'PENDING_NOTIFICATION', version: 10 };
  f.open(f.options(risk));
  f.failure = { code: 'TIMEOUT', message: 'timeout' };
  await assert.rejects(f.dialogs.at(-1).onSubmit(), /结果未确认/);
  assert.equal(f.refreshed, 1); assert.equal(f.done.length, 0);
  f.open(f.options(risk)); f.failure = null;
  await f.dialogs.at(-1).onSubmit();
  assert.equal(f.submissions[0].key, f.submissions[1].key);
  assert.equal(f.done.length, 1);
});

test('version conflicts refresh before a new submission; duplicate notices open records', async () => {
  const f = notificationFixture();
  const risk = { risk_id: 'conflict-risk', state: 'PENDING_NOTIFICATION', version: 2 };
  f.open(f.options(risk)); f.failure = { code: 'VERSION_CONFLICT' };
  await assert.rejects(f.dialogs.at(-1).onSubmit(), /提交被拒绝/);
  f.open(f.options({ ...risk, version: 3 })); f.failure = { code: 'HANDOFF_ALREADY_EXISTS' };
  await f.dialogs.at(-1).onSubmit();
  assert.notEqual(f.submissions[0].key, f.submissions[1].key);
  assert.equal(f.submissions[1].body.expected_version, 3);
  assert.equal(f.existing, 1); assert.equal(f.done.length, 0);
});

test('a successful notification stays successful if subsequent refresh fails', async () => {
  const f = notificationFixture();
  f.open({ ...f.options({ risk_id: 'saved-risk', state: 'PENDING_NOTIFICATION', version: 7 }), refresh: async () => { throw new Error('offline'); } });
  await f.dialogs.at(-1).onSubmit();
  assert.equal(f.submissions.length, 1); assert.equal(f.done.length, 1);
});

const Vue = require('vue');
const { parse, compileScript } = require('@vue/compiler-sfc');
const processSource = readFileSync(path.join(__dirname, '../src/pages/situation/SituationRiskProcess.vue'), 'utf8');
const compiledProcess = compileScript(parse(processSource).descriptor, { id: 'situation-risk-process' }).content;
const processImports = [...compiledProcess.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/g)];
const processBindings = processImports.flatMap(match => match[1].slice(1, -1).split(',').map(name => name.trim().replace(/\s+as\s+/, ':')));
const processCode = compiledProcess.replace(/import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '').replace('export default', 'return');
const makeProcess = new Function('deps', `const {${processBindings.join(',')}} = deps;\n${processCode}`);
const renderer = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode() {}, nextSibling() {} });
async function settle() { for (let i = 0; i < 12; i++) await Vue.nextTick(); }
function processFixture({ allowed = true, deferred = false } = {}) {
  const f = { id: Vue.ref('first-risk'), version: Vue.ref(1), writes: [], requests: [], notices: [],
    record: { risk_id: 'first-risk', state: 'PENDING_VERIFICATION', version: 1, current_status: 'UNKNOWN', allowed_actions: allowed ? ['VERIFY'] : [] } };
  const deps = { ...Vue, useRealtimeRefresh() {}, hasPermission: permission => permission.endsWith(':read') || allowed,
    riskApi: { getRisk: id => deferred ? new Promise(resolve => f.requests.push({ id, resolve })) : Promise.resolve({ ...f.record }), listRiskVerifications: async () => ({ items: [], total: 0 }) },
    handoffApi: { listHandoffs: async () => ({ items: f.notices, total: f.notices.length }) },
    openRiskVerification: options => f.writes.push({ type: 'verify', options }), openRiskNotification: options => f.writes.push({ type: 'notify', options }),
    toast() {}, notificationSubmissionMessage: () => ({ message: 'submitted' }), notificationBlockedReason: () => '', RECEIPT_RESULT_LABEL: {}, RISK_STATE_LABEL: {}, labelOf: (_, value) => value };
  const component = makeProcess(deps); component.render = () => null;
  f.app = renderer.createApp({ setup: () => () => Vue.h(component, { riskId: f.id.value, revision: f.version.value }) });
  f.app.mount({}); f.state = f.app._instance.subTree.component.setupState;
  return f;
}

test('stale-position risk still offers permitted verification, then separate notification with exact ID', async () => {
  const oldWindow = global.window; global.window = { addEventListener() {}, removeEventListener() {} };
  try {
    for (const allowed of [true, false]) {
      const f = processFixture({ allowed });
      try {
        await settle(); assert.equal(f.writes.length, 0);
        assert.equal(Boolean(f.state.canVerify), allowed); assert.equal(f.state.canNotify, false);
        f.state.verify(); f.state.notify();
        assert.equal(f.writes.length, allowed ? 1 : 0);
        if (allowed) {
          const verify = f.writes[0].options;
          assert.equal(verify.risk.risk_id, 'first-risk');
          f.record = { ...f.record, state: 'PENDING_NOTIFICATION', version: 2 };
          await verify.refresh();
          assert.equal(f.writes.length, 1, 'verification never automatically notifies');
          assert.equal(f.state.canNotify, true); f.state.notify();
          assert.equal(f.writes[1].options.risk.version, 2);
          f.notices = [{ handoff_id: 'sent', delivery_status: 'SUBMITTED' }];
          await f.state.load(); assert.equal(f.state.canNotify, false);
          f.state.notify(); assert.equal(f.writes.length, 2, 'submitted notice cannot repeat');
        }
      } finally { f.app.unmount(); }
    }
  } finally { global.window = oldWindow; }
});

test('switching risk or unmounting rejects late detail responses', async () => {
  const oldWindow = global.window; global.window = { addEventListener() {}, removeEventListener() {} };
  const f = processFixture({ deferred: true });
  try {
    f.id.value = 'second-risk'; await settle();
    f.requests[1].resolve({ ...f.record, risk_id: 'second-risk', version: 9 }); await settle();
    f.requests[0].resolve(f.record); await settle();
    assert.equal(f.state.risk.risk_id, 'second-risk');
    const pending = f.state.load(); f.app.unmount();
    f.requests[2].resolve({ ...f.record, risk_id: 'second-risk', version: 10 }); await pending;
    assert.equal(f.state.risk.version, 9);
  } finally { global.window = oldWindow; }
});


test('notifying one grouped risk keeps its open card and does not process its neighboring task', async () => {
  const { pathToFileURL } = require('node:url');
  const { groupRouteRisks } = await import(pathToFileURL(path.join(__dirname, '../src/pages/situation/routeRiskGroups.js')).href);
  const page = readFileSync(path.join(__dirname, '../src/pages/SituationPage.vue'), 'utf8');
  const declarations = page.slice(page.indexOf('const allRiskGroups = computed('), page.indexOf('const airspaces = computed('));
  const rows = Vue.ref(['one', 'two'].map((id, index) => ({ riskId: `risk-${id}`, planId: `plan-${id}`,
    routeVersionId: 'route-shared', targetInternalId: 'target-shared', sourceMode: 'mock', sourceCode: 'sensor',
    ownerOrgId: 'org', districtId: 'district', riskType: 'SPACE_OBJECT', reasonCode: 'NEAR_ROUTE',
    observedAt: 888000, occurredAt: 888000, spaceFact: { ruleVersionId: 'rules-v3', subtypeCode: 'BIRD' },
    state: 'PENDING_NOTIFICATION', version: index + 4 })));
  const selection = Vue.ref({ kind: 'risk-group', id: groupRouteRisks(rows.value)[0].groupId });
  const state = new Function('computed', 'groupRouteRisks', 'risks', 'selection', 'situationRouteRiskVisible',
    declarations + '; return { riskGroups, selectedRiskGroup };')(Vue.computed, groupRouteRisks, rows, selection,
    risk => ['PENDING_VERIFICATION', 'PENDING_NOTIFICATION'].includes(risk.state));
  rows.value[0] = { ...rows.value[0], state: 'NOTIFIED', version: 9 };
  assert.equal(state.riskGroups.value[0].members.length, 1);
  assert.equal(state.selectedRiskGroup.value.members.length, 2);
  assert.equal(rows.value[1].state, 'PENDING_NOTIFICATION');
  rows.value[1] = { ...rows.value[1], state: 'NOTIFIED', version: 10 };
  assert.equal(state.riskGroups.value.length, 0);
  assert.equal(state.selectedRiskGroup.value.members.length, 2, 'the open card remains available for notification receipts');
  rows.value = [];
  assert.equal(state.selectedRiskGroup.value, undefined, 'removed or unauthorized data is not retained as a cached card');
});
