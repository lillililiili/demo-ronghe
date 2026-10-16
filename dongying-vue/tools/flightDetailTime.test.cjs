const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const components = [
  ['PlanFilingDetails.vue', 'time', '未提供'],
  ['PlanDeviceCheck.vue', 'date', '未记录'],
  ['PlanVerificationPanel.vue', 'date', '未记录'],
  ['DeviceAbnormalNoticeButton.vue', 'date', '未记录']
];

for (const [file, name, empty] of components) {
  const source = readFileSync(path.join(__dirname, '../src/pages/flights/components', file), 'utf8');
  const formatter = source.match(new RegExp(`function ${name}\\([^\\n]+`))[0];
  test(`${file}: plan/check/notice times remain Beijing time across client timezones`, () => {
    const timestamps = ['2026-10-06T16:00:00Z', '2026-10-07T15:59:00Z', '2026-01-01T00:00:00Z'].map(Date.parse);
    for (const timezone of ['America/New_York', 'UTC', 'Asia/Shanghai']) {
      const actual = execFileSync(process.execPath, ['-e', `${formatter}\nconsole.log(JSON.stringify(${JSON.stringify(timestamps)}.map(${name})));`],
        { encoding: 'utf8', env: { ...process.env, TZ: timezone } });
      assert.deepEqual(JSON.parse(actual), ['2026/10/7 00:00:00', '2026/10/7 23:59:00', '2026/1/1 08:00:00'], timezone);
    }
  });
  test(`${file}: missing time stays explicitly missing`, () => {
    const format = new Function(`${formatter}\nreturn ${name};`)();
    assert.equal(format(null), empty);
    assert.equal(format(undefined), empty);
  });
}


// Current device health and task-window incidents are different facts, even after a case is closed.
const deviceCheckSource = readFileSync(path.join(__dirname, '../src/pages/flights/planDeviceCheck.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '');
const deviceCheckModule = import(`data:text/javascript;base64,${Buffer.from(deviceCheckSource).toString('base64')}`);
for (const closed of [false, true]) {
  for (const [connectivity, health_code, abnormal, complete, expected, label] of [
    ['ONLINE', 'GOOD', false, true, 'NORMAL', '正常'],
    ['ONLINE', 'BAD', true, true, 'ABNORMAL', '设备故障'],
    ['OFFLINE', 'UNKNOWN', true, true, 'ABNORMAL', '离线'],
    ['ONLINE', 'GOOD', false, false, 'UNKNOWN', '在线 · 状态待核查'],
  ]) {
    test(`device current ${expected} remains distinct from ${closed ? 'closed' : 'open'} task-window incident`, async () => {
      const { deviceCheckCategory, deviceCheckStatus, deviceCheckHistory, deviceCheckCounts } = await deviceCheckModule;
      const row = { device_id: `sensor-${connectivity}-${closed}`, connectivity, health_code, abnormal, complete,
        incidents: [{ incident_id: `incident-${health_code}-${closed}`, closed_at: closed ? 1711111000000 : null }] };
      assert.equal(deviceCheckCategory(row), expected);
      assert.equal(deviceCheckStatus(row), label);
      assert.equal(deviceCheckCounts([row])[expected], 1);
      assert.equal(deviceCheckCounts([row]).withHistory, 1);
      assert.match(deviceCheckHistory(row), closed ? /均已关闭/ : /未关闭 1 条/);
    });
  }
}
test('mixed device counts separate current unknown from historical completed recovery', async () => {
  const { deviceCheckCounts, deviceCheckStatus, deviceCheckHistory } = await deviceCheckModule;
  const normal = { abnormal: false, complete: true, connectivity: 'ONLINE', health_code: 'GOOD' };
  const unknown = { ...normal, complete: false, task: { workflow_state: 'COMPLETED', recovery: { result: 'PASS' } } };
  const rows = [normal, { ...normal, incidents: [{ closed_at: 123 }] },
    { abnormal: true, connectivity: 'OFFLINE', incidents: [{ closed_at: null }] }, unknown, {}];
  assert.deepEqual(deviceCheckCounts(rows), { NORMAL: 2, ABNORMAL: 1, UNKNOWN: 2, withHistory: 2 });
  assert.equal(deviceCheckStatus(unknown), '在线 · 状态待核查');
  assert.equal(deviceCheckHistory(normal), '');
  assert.equal(deviceCheckHistory({ incidents: [{ closed_at: 0 }] }), '历史告警 1 条 · 均已关闭');
});

for (const prefix of ['replay-sensor', 'live-sensor']) {
  test(`${prefix}: fault, recovery and server priority changes preserve positions and current facts`, async () => {
    const { retainDeviceOrder, deviceCheckCounts } = await deviceCheckModule;
    const normal = { abnormal: false, complete: true, connectivity: 'ONLINE', health_code: 'GOOD' };
    const initial = Array.from({ length: 5 }, (_, n) => ({ ...normal, device_id: `${prefix}-${n}` }));
    const fault = { ...initial[3], abnormal: true, health_code: 'BAD' };
    const unknown = { ...initial[1], complete: false, health_code: 'UNKNOWN' };
    const update = retainDeviceOrder([fault, unknown, initial[4], initial[0], initial[2]], initial);
    assert.deepEqual(update.map(row => row.device_id), initial.map(row => row.device_id));
    assert.equal(update[3], fault);
    assert.equal(update[1], unknown);
    assert.deepEqual(deviceCheckCounts(update), { NORMAL: 3, ABNORMAL: 1, UNKNOWN: 1, withHistory: 0 });
    assert.deepEqual(retainDeviceOrder([...initial].reverse(), update), initial);
    assert.equal(initial[3].health_code, 'GOOD');
  });
}
test('removed devices leave immediately, new devices append, changing task resets order', async () => {
  const { retainDeviceOrder } = await deviceCheckModule;
  const a = { device_id: 'a' }, b = { device_id: 'b' }, c = { device_id: 'c' };
  assert.deepEqual(retainDeviceOrder([c, b], [a, b]), [b, c]);
  assert.deepEqual(retainDeviceOrder([c, b], []), [c, b]);
  assert.deepEqual(retainDeviceOrder([], [a, b]), []);
});
test('heartbeat without health stays unknown and separate from a real fault', async () => {
  const { deviceCheckStatus, deviceCheckExplanation, deviceCheckCounts } = await deviceCheckModule;
  const row = { device_id: 'optical-new', abnormal: false, complete: false, connectivity: 'ONLINE',
    health_code: 'UNKNOWN', incidents: [{ closed_at: null }], last_heartbeat_at: Date.now() };
  assert.equal(deviceCheckStatus(row), '在线 · 健康待确认');
  assert.match(deviceCheckExplanation(row), /尚缺有效的健康正常依据/);
  assert.deepEqual(deviceCheckCounts([row]), { NORMAL: 0, ABNORMAL: 0, UNKNOWN: 1, withHistory: 1 });
  assert.equal(deviceCheckStatus({}), '状态待确认');
  assert.equal(deviceCheckExplanation({ abnormal: true, connectivity: 'OFFLINE' }), '');
});


// The POST association receipt survives read-only refreshes, whose reused flag is false.
function maintenanceHarness() {
  // 处置单状态说法 2026-10-16 拆到 maintenanceState.js（列表“需要处理”提示也用），这里一并装入。
  const source = ['maintenanceState.js', 'deviceMaintenance.js']
    .map(file => readFileSync(path.join(__dirname, '../src/pages/flights', file), 'utf8'))
    .join('\n').replace(/^import .*;\r?\n/gm, '').replace(/^export \{[^}]*\};\r?\n/gm, '').replace(/^export /gm, '');
  const actor = { value: { user_id: 'operator-a' } };
  let nextReply;
  const service = new Function('reactive', 'apiRequestTimed', 'authUser', 'newHandoffIdempotencyKey', 'isUncertainOutcome', 'sessionStorage',
    `${source}\nreturn { deviceNoticeState, loadDeviceMaintenanceNotice, notifyDeviceAbnormal, retryDeviceNoticeSubmission, maintenanceReportResult, maintenanceStateLabel };`)(
    value => value, async () => { if (nextReply instanceof Error) throw nextReply; return structuredClone(nextReply); }, actor,
    () => 'request-test', error => error.status >= 500, { getItem: () => null, setItem() {}, removeItem() {} });
  return { ...service, actor, reply: value => { nextReply = value; } };
}
for (const prefix of ['live-radar', 'simulated-other']) {
  test(`${prefix}: shared case receipt persists through polling and remains isolated by task and account`, async () => {
    const h = maintenanceHarness(), plan = `${prefix}-plan-a`, device = `${prefix}-device`;
    h.reply({ items: [] }); await h.loadDeviceMaintenanceNotice(plan, device);
    const original = { task_id: `${prefix}-case`, reused: true, workflow_version: 2, workflow_state: 'PROCESSING', notification_delivery_status: 'DELIVERED' };
    h.reply(original); await h.notifyDeviceAbnormal(plan, device);
    const state = h.deviceNoticeState(plan, device);
    assert.match(state.reportResult.title, /已关联原处置单/);
    assert.match(state.reportResult.description, /后台不会新增一条待办/);
    h.reply({ items: [{ ...original, reused: false, workflow_state: 'READY_TO_COMPLETE' }] });
    await h.loadDeviceMaintenanceNotice(plan, device);
    assert.match(state.reportResult.title, /已关联原处置单/);
    assert.equal(h.maintenanceStateLabel(state.task), '待确认办结');
    assert.equal(h.deviceNoticeState(`${prefix}-plan-b`, device).reportResult, null);
    h.actor.value = { user_id: 'operator-b' };
    assert.equal(h.deviceNoticeState(plan, device).reportResult, null);
    h.actor.value = { user_id: 'operator-a' };
    h.reply({ items: [{ ...original, task_id: `${prefix}-next-case` }] });
    await h.loadDeviceMaintenanceNotice(plan, device);
    assert.equal(state.reportResult, null);
  });
}
test('report confirmation separates a new case, unknown association, failed notification and uncertain submission', async () => {
  const h = maintenanceHarness();
  assert.equal(h.maintenanceReportResult(null), null);
  assert.match(h.maintenanceReportResult({ task_id: 'new-case', reused: false }).title, /已新建处置单/);
  assert.equal(h.maintenanceReportResult({ task_id: 'old-contract' }).title, '上报已保存');
  h.reply({ items: [] }); await h.loadDeviceMaintenanceNotice('plan-c', 'device-c');
  h.reply(Object.assign(new Error('response lost'), { status: 503 }));
  await assert.rejects(h.notifyDeviceAbnormal('plan-c', 'device-c'), /response lost/);
  assert.equal(h.deviceNoticeState('plan-c', 'device-c').reportResult, null);
  assert.equal(h.deviceNoticeState('plan-c', 'device-c').uncertain, true);
  h.reply({ items: [] }); await h.loadDeviceMaintenanceNotice('plan-d', 'device-d');
  h.reply({ task_id: 'saved-case', reused: true, notification_blocked_reason: 'channel unavailable', notification_delivery_status: 'FAILED' });
  await h.notifyDeviceAbnormal('plan-d', 'device-d');
  assert.match(h.deviceNoticeState('plan-d', 'device-d').reportResult.title, /上报已保存/);
  assert.equal(h.deviceNoticeState('plan-d', 'device-d').task.notification_delivery_status, 'FAILED');
  h.reply(Object.assign(new Error('forbidden'), { status: 403 }));
  await h.loadDeviceMaintenanceNotice('plan-d', 'device-d');
  assert.equal(h.deviceNoticeState('plan-d', 'device-d').reportResult, null);
});

test('only confirmed attachment to an existing case can show the original-case hint', async () => {
  const h = maintenanceHarness();
  for (const reused of [true, false, undefined]) {
    assert.equal(h.maintenanceReportResult({ task_id: 'a', reused }).linkedExisting, reused === true);
    const replay = h.maintenanceReportResult({ task_id: 'a', reused }, true);
    assert.equal(replay.linkedExisting, false);
    assert.equal(replay.title, '上报已保存');
  }
  h.reply({ items: [{ task_id: 'existing', workflow_version: 2, reused: false }] });
  await h.loadDeviceMaintenanceNotice('new-plan', 'sensor');
  assert.equal(h.deviceNoticeState('new-plan', 'sensor').reportResult, null);
  h.reply(Object.assign(new Error('response lost'), { status: 503 }));
  await assert.rejects(h.notifyDeviceAbnormal('new-plan', 'sensor'));
  h.reply({ task_id: 'existing', workflow_version: 2, reused: true });
  await h.retryDeviceNoticeSubmission('new-plan', 'sensor');
  assert.equal(h.deviceNoticeState('new-plan', 'sensor').reportResult.linkedExisting, false);
  assert.equal(h.deviceNoticeState('new-plan', 'sensor').reportResult.title, '上报已保存');
});
