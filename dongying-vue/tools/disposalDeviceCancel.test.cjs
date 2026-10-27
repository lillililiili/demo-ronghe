const flightHelpers = require('./flightCheckTestHelpers.cjs')();
/* 反制设备可用性、撤销授权与“为什么不能反制”的提示（BUG-03 / ZT-18）：node tools/disposalDeviceCancel.test.cjs */
const { test, before } = require('node:test');
const riskHelpers = require('./riskCaseTestHelpers.cjs');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const DEVICES = [
  { device_id: 'ok', device_no: 'CM-1', name: '一号', device_type_code: 'countermeasure', device_type_name: '四通道反制', enabled: true, connectivity: 'ONLINE', health_code: 'GOOD' },
  { device_id: 'off', device_no: 'CM-2', name: '二号', device_type_code: 'countermeasure', enabled: true, connectivity: 'OFFLINE' },
  { device_id: 'abn', device_no: 'CM-3', device_type_code: 'countermeasure', enabled: true, connectivity: 'ABNORMAL' },
  { device_id: 'unk', device_no: 'CM-4', device_type_code: 'countermeasure', enabled: true, connectivity: null },
  { device_id: 'bad', device_no: 'CM-5', device_type_code: 'countermeasure', enabled: true, connectivity: 'ONLINE', health_code: 'BAD' },
  { device_id: 'ifr-off', device_no: 'IFR-1', device_type_code: 'ifr', enabled: true, connectivity: 'OFFLINE' }
];

let reach;
before(async () => {
  reach = await import('../src/ui/deviceReach.js');
});

/** 去掉 import/export 后在隔离上下文里跑弹窗模块，表单、提示和接口调用都记下来。 */
function load({ devices = DEVICES, create, cancel, listError } = {}) {
  const state = { forms: [], toasts: [], closed: 0, cancels: [], refreshed: [], reads: 0 };
  const source = readFileSync(path.join(__dirname, '../src/ui/disposalAuthModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  let sequence = 0;
  const context = vm.createContext({ ...riskHelpers, ...flightHelpers,
    openFormModal: form => state.forms.push(form), closeModal: () => { state.closed++; },
    toast: (message, kind) => state.toasts.push([message, kind]),
    deviceApi: { listTimed: async () => { state.reads++; if (listError) throw listError; return { items: devices }; } },
    disposalApi: {
      create: create || (async () => ({ authorization_no: 'DSP-NEW' })),
      directExecute: create || (async () => ({ authorization_no: 'DSP-NEW' })),
      cancel: cancel || (async (id, body, key) => { state.cancels.push([id, body, key]); return { authorization_id: id, status: 'CANCELLED' }; })
    },
    newDisposalIdempotencyKey: () => `key-${++sequence}`,
    isDisposalUnavailable: () => false, isUncertainOutcome: () => false,
    DISPOSAL_ACTION_LABEL: {}, DISPOSAL_BLOCK_REASON_LABEL: {}, DISPOSAL_CHANNEL_LABEL: {},
    COUNTERMEASURE_MODE_LABEL: { FORCE_LAND: '迫降', DRIVE_AWAY: '驱离' },
    DISPOSAL_STATUS_LABEL: {}, disposalStatusText: value => value?.status,
    labelOf: (_labels, value) => value,
    deviceReach: reach.deviceReach, distanceText: reach.distanceText, validPoint: reach.validPoint
  });
  vm.runInContext(readFileSync(path.join(__dirname, '../src/ui/deviceNumber.js'), 'utf8').replace(/\bexport /g, ''), context);
  vm.runInContext(source, context);
  return { context, state };
}

async function requestForm(options) {
  const loaded = load(options);
  await loaded.context.openDisposalRequest({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: 'event-1' });
  assert.equal(loaded.state.forms.length, 1);
  return { ...loaded, form: loaded.state.forms[0] };
}

for (const direct of [false, true]) {
  for (const mode of ['FORCE_LAND', 'DRIVE_AWAY']) {
    test(`${direct ? '直接反制' : '申请审批'}保存选择的${mode}，业务动作仍是反制`, async () => {
      let body;
      const { context, state } = load({ create: async value => { body = value; return { authorization_no: 'MODE-NEW' }; } });
      await context[direct ? 'openDisposalDirect' : 'openDisposalRequest']({
        actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: `mode-${mode}-${direct}`
      });
      const form = state.forms[0];
      const field = form.fields.find(item => item.key === 'countermeasure_mode');
      assert.deepEqual(Array.from(field.options, item => item.label), ['迫降', '驱离']);
      assert.equal(field.visibleWhen({ action_type: 'COUNTERMEASURE' }), true);
      assert.equal(field.visibleWhen({ action_type: 'JAMMING' }), false);
      const model = { ...form.initial, countermeasure_mode: mode, channel: 'COUNTERMEASURE_4CH', device_id: 'ok' };
      assert.equal(form.validate(model), null);
      assert.match(form.validate({ ...model, countermeasure_mode: 'UNKNOWN' }), /请选择迫降或驱离/);
      await form.onSubmit(model);
      assert.equal(body.countermeasure_mode, mode);
      assert.equal(body.action_type, 'COUNTERMEASURE');
      assert.equal(body.device_id, 'ok');
    });
  }
}

test('禁选和原因校验保留，选项只显示编号与名称，其他通道不出现', () => {
  const { context } = load();
  const options = context.deviceOptions(DEVICES, 'COUNTERMEASURE_4CH');
  assert.deepEqual(options.map(option => [option.value, option.disabled]),
    [['ok', false], ['off', true], ['abn', true], ['unk', true], ['bad', true]]);
  assert.deepEqual(options.map(option => option.label), ['CM-1 · 一号', 'CM-2 · 二号', 'CM-3', 'CM-4', 'CM-5']);
  assert.equal(context.deviceUnavailableReason(DEVICES[1]), '设备离线');
  assert.equal(context.deviceUnavailableReason({ enabled: false, connectivity: 'ONLINE' }), '设备已停用');
  assert.equal(context.deviceUnavailableReason({ enabled: true, connectivity: 'ONLINE', health_code: 'GOOD' }), '');
});

test('申请表单：设备下拉随通道给出置灰选项，选到不能用的设备时提交前就说清原因', async () => {
  const { form } = await requestForm();
  const device = form.fields.find(field => field.key === 'device_id');
  assert.equal(device.help, undefined);
  assert.deepEqual(device.options({ channel: 'LINGYUN_B' }).map(option => option.disabled), [true]);
  const base = { ...form.initial, action_type: 'COUNTERMEASURE', channel: 'COUNTERMEASURE_4CH', reason: '现场核实后申请反制' };
  assert.equal(form.validate({ ...base, device_id: 'ok' }), null);
  assert.equal(form.validate({ ...base, device_id: 'off' }), '所选设备不能用：设备离线。请换一台设备。');
  assert.match(form.validate({ ...base, channel: 'LINGYUN_B', device_id: 'ifr-off' }), /这个执行通道的设备现在都不能用/);
  assert.match(form.warning, /批准后才可执行/);
  assert.doesNotMatch(form.warning, /自动.*信号干扰|不再二次审批/);
});

test('申请事由选填，填写时保留长度限制，设备仍必选', async () => {
  const { form } = await requestForm();
  const field = form.fields.find(field => field.key === 'reason');
  assert.equal(!!field.required, false);
  assert.match(field.placeholder, /选填/);
  const base = { channel: 'COUNTERMEASURE_4CH', device_id: 'ok' };
  for (const reason of [undefined, null, '', '   ', '说明', '字'.repeat(500)]) {
    assert.equal(form.validate({ ...base, reason }), null);
  }
  for (const reason of ['字', '字'.repeat(501)]) {
    assert.match(form.validate({ ...base, reason }), /2–500/);
  }
  assert.match(form.validate({ ...base, reason: '', device_id: null }), /执行设备/);
});

// 2026-10-14 rose：申请反制选设备时只显示覆盖范围照得到目标的设备，近的在前。
const REACH_DEVICES = [
  { device_id: 'far', device_no: 'CM-9', device_type_code: 'countermeasure', enabled: true, connectivity: 'ONLINE', longitude: 118.60, latitude: 37.52,
    coverage: { kind: 'CIRCLE', status: 'AVAILABLE', radius_m: 3000 } },
  { device_id: 'near', device_no: 'CM-1', device_type_code: 'countermeasure', enabled: true, connectivity: 'ONLINE', longitude: 118.60, latitude: 37.47,
    coverage: { kind: 'CIRCLE', status: 'AVAILABLE', radius_m: 3000 } },
  { device_id: 'mid-off', device_no: 'CM-2', device_type_code: 'countermeasure', enabled: true, connectivity: 'OFFLINE', longitude: 118.60, latitude: 37.48,
    coverage: { kind: 'CIRCLE', status: 'UNAVAILABLE', radius_m: 3000 } },
  { device_id: 'no-cover', device_no: 'CM-3', device_type_code: 'countermeasure', enabled: true, connectivity: 'ONLINE', longitude: 118.60, latitude: 37.46,
    coverage: { kind: null, status: 'UNKNOWN' } },
  { device_id: 'sector-away', device_no: 'CM-4', device_type_code: 'countermeasure', enabled: true, connectivity: 'ONLINE', longitude: 118.60, latitude: 37.45,
    coverage: { kind: 'SECTOR', status: 'AVAILABLE', range_m: 5000, azimuth_deg: 180, fov_deg: 60 } }
];
const TARGET = { lon: 118.60, lat: 37.461 };

test('给了目标位置：照得到的在前、没配范围的排后写明，配了范围照不到的不列', async () => {
  const { context } = load({ devices: REACH_DEVICES });
  const options = context.deviceOptions(REACH_DEVICES, 'COUNTERMEASURE_4CH', TARGET);
  assert.deepEqual(options.map(option => option.value), ['near', 'no-cover', 'mid-off']);
  assert.deepEqual(options.map(option => option.label), ['CM-1', 'CM-3', 'CM-2']);
  assert.equal(options[1].disabled, false);
  assert.equal(options[2].disabled, true);
  // 不给位置时保持原来的全部列出。
  assert.equal(context.deviceOptions(REACH_DEVICES, 'COUNTERMEASURE_4CH').length, 5);
});

test('申请表单按目标位置筛设备；读不到位置时保持清单，无下方说明', async () => {
  const loaded = load({ devices: REACH_DEVICES });
  await loaded.context.openDisposalRequest({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: 'event-1', targetPoint: TARGET });
  const form = loaded.state.forms[0];
  const device = form.fields.find(field => field.key === 'device_id');
  assert.equal(device.help, undefined);
  const base = { ...form.initial, action_type: 'COUNTERMEASURE', channel: 'COUNTERMEASURE_4CH', reason: '现场核实后申请反制' };
  assert.equal(form.validate({ ...base, device_id: 'near' }), null);
  assert.equal(form.validate({ ...base, device_id: 'no-cover' }), null);
  // 台账里一台都没配覆盖范围（测试库 v10 的情况）：仍能选，不能出现空下拉。
  const bare = REACH_DEVICES.map(device => ({ ...device, coverage: { kind: null, status: 'UNKNOWN' } }));
  assert.equal(loaded.context.deviceOptions(bare, 'COUNTERMEASURE_4CH', TARGET).filter(option => !option.disabled).length, 4);
  // 空下拉给中文说明，不显示“No Data”。
  assert.deepEqual(JSON.parse(JSON.stringify(device.options({ channel: 'LINGYUN_B' }).map(option => [option.label, option.disabled]))), [['这个执行通道没有登记设备，请换一个执行通道', true]]);
  assert.equal(form.validate({ ...base, device_id: 'far' }), '执行设备与所选通道不一致，请重新选择');
  assert.equal(form.validate({ ...base, channel: 'LINGYUN_B', device_id: null }), '当前执行通道没有可下发的设备');
  const unknown = load({ devices: REACH_DEVICES });
  await unknown.context.openDisposalRequest({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: 'event-1', targetPoint: null });
  const unknownDevice = unknown.state.forms[0].fields.find(field => field.key === 'device_id');
  assert.equal(unknownDevice.help, undefined);
  assert.equal(unknownDevice.options({ channel: 'COUNTERMEASURE_4CH' }).length, 5);
});

test('普通申请和直接反制都不再声明自动创建后续干扰', async () => {
  for (const subjectId of [crypto.randomUUID(), crypto.randomUUID()]) {
    const { context, state } = load();
    await context.openDisposalDirect({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId });
    assert.equal(state.forms.length, 1);
    assert.match(state.forms[0].warning, /免逐次审批权限/);
    assert.doesNotMatch(state.forms[0].warning, /自动.*信号干扰|不再二次审批/);
  }
});

test('反制已完成但没有后续干扰时，告警不重新显示发起入口；状态仍来自原授权', async () => {
  const { punishmentHandoffProgress } = await import('../src/ui/punishmentHandoffProgress.js');
  const source = readFileSync(path.join(__dirname, '../src/pages/AlarmsPage.vue'), 'utf8').replace(/\r\n/g, '\n');
  const functions = ['deriveAlarmProgress', 'selectedDisposalProgress', 'showCounterLaunch'].map(name => source.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'))[0]).join('\n');
  for (const source_mode of ['live', 'mock', 'replay']) {
    const eventId = crypto.randomUUID();
    const cur = { alarm: { event_id: eventId } };
    const disposal = { byAction: {}, handoff: null };
    const advisoryLive = { value: { event_id: eventId, counter_launch_visible: true } };
    const progressSources = new Map([[eventId, { auths: { items: [], failed: false }, handoffs: { items: [], failed: false } }]]);
    const view = new Function('cur', 'disposal', 'advisoryLive', 'pageProgress', 'progressSources', 'punishmentHandoffProgress', 'progressKey', functions + '; return { showCounterLaunch, deriveAlarmProgress };')(cur, disposal, advisoryLive, {}, progressSources, punishmentHandoffProgress, row => row?.event_id || '');
    assert.equal(view.showCounterLaunch(), true);
    const row = { authorization_id: crypto.randomUUID(), subject_id: eventId, action_type: 'COUNTERMEASURE', source_mode, status: 'COMPLETED', requested_at: Date.now() - 60000 };
    disposal.byAction.COUNTERMEASURE = row;
    assert.equal(view.showCounterLaunch(), false);
    assert.equal(view.deriveAlarmProgress([row], []), 'COUNTERMEASURE_DONE');
    row.status = 'FAILED';
    assert.equal(view.showCounterLaunch(), true);
    advisoryLive.value.counter_launch_visible = false;
    assert.equal(view.showCounterLaunch(), false);
  }
});

test('服务端在申请时拒绝坏设备、或说明不能反制的真实原因时，原话上屏，不再一律说“先核实”', async () => {
  const offline = '所选设备当前离线，不能用它申请处置。请换一台在线的设备。';
  let failure = { status: 409, code: 'DEVICE_UNAVAILABLE', message: offline };
  const { form } = await requestForm({ create: async () => { throw failure; } });
  const values = { action_type: 'COUNTERMEASURE', channel: 'COUNTERMEASURE_4CH', device_id: 'ok', reason: '现场核实后申请反制' };
  await assert.rejects(form.onSubmit(values), error => error.message === offline);
  const evidence = '证据不足：没有违规告警；事件也尚未核实属实，暂不能反制';
  failure = { status: 409, code: 'POLICY_REQUIRES_CONFIRMED_EVENT', message: evidence };
  await assert.rejects(form.onSubmit(values), error => error.message === evidence);
  failure = { status: 409, code: 'POLICY_REQUIRES_CONFIRMED_EVENT' };
  await assert.rejects(form.onSubmit(values), /要求事件先经人工核实/);
  failure = { status: 409, code: 'ACTIVE_AUTHORIZATION_EXISTS', message: 'active' };
  await assert.rejects(form.onSubmit(values), /已批准还没执行.*「反制办理」里撤回或撤销它/);
});

test('撤销已批准未执行的授权：带版本号提交，提示已撤销并回读', async () => {
  const { context, state } = load();
  const refresh = async result => { state.refreshed.push(result); return result; };
  assert.equal(context.openDisposalCancel({
    authorization: { authorization_id: 'auth-1', authorization_no: 'DSP-1', status: 'APPROVED', version: 3, allowed_actions: ['EXECUTE', 'CANCEL'] },
    refresh
  }), true);
  const form = state.forms[0];
  assert.equal(form.title, '撤销授权 · DSP-1');
  assert.equal(form.confirmText, '撤销授权');
  assert.match(form.warning, /还没有下发到设备.*重新申请/);
  assert.match(form.validate({ note: 'x'.repeat(501) }), /500/);
  await form.onSubmit({ note: '  设备离线，换一台重新申请  ' });
  assert.equal(state.cancels.length, 1);
  assert.equal(state.cancels[0][0], 'auth-1');
  assert.deepEqual(JSON.parse(JSON.stringify(state.cancels[0][1])), { expected_version: 3, note: '设备离线，换一台重新申请' });
  assert.match(state.cancels[0][2], /^key-/);
  assert.equal(state.closed, 1);
  assert.deepEqual(state.toasts, [['授权已撤销，当前为「CANCELLED」。', 'ok']]);
  assert.equal(state.refreshed[0].status, 'CANCELLED');
});

test('撤回待审批的申请时备注可空；没有撤销权限或已在执行的不弹表单', async () => {
  const { context, state } = load();
  context.openDisposalCancel({ authorization: { authorization_id: 'auth-2', status: 'REQUESTED', version: 0, allowed_actions: ['CANCEL'] } });
  assert.equal(state.forms[0].title, '撤回申请 · 处置授权');
  await state.forms[0].onSubmit({ note: '' });
  assert.equal(state.cancels[0][1].note, undefined);
  assert.equal(state.toasts.at(-1)[0], '申请已撤回，当前为「CANCELLED」。');
  for (const authorization of [
    { authorization_id: 'auth-3', status: 'APPROVED', version: 1, allowed_actions: ['EXECUTE'] },
    { authorization_id: 'auth-4', status: 'EXECUTING', version: 2, allowed_actions: ['CANCEL', 'STOP'] }
  ]) {
    assert.equal(context.openDisposalCancel({ authorization }), false);
  }
  assert.equal(state.forms.length, 1);
  assert.match(state.toasts.at(-1)[0], /不能撤销/);
});

test('办理记录：已批准未执行且有撤销权时给“撤销授权”，执行受阻时提示可以撤销换设备', async () => {
  const view = await import('../src/pages/alarms/authorizationQueueView.js');
  const approved = { channel: 'COUNTERMEASURE_4CH', status: 'APPROVED', allowed_actions: ['CANCEL', 'STOP'], execution_block_reason: 'DEVICE_OFFLINE' };
  assert.equal(view.canCancel(approved), true);
  assert.equal(view.cancelLabel(approved), '撤销授权');
  assert.match(view.nextStep(approved, 'someone'), /可以撤销这条授权，换设备重新申请/);
  assert.equal(view.cancelLabel({ status: 'REQUESTED' }), '撤回申请');
  assert.equal(view.canCancel({ ...approved, allowed_actions: ['STOP'] }), false);
  assert.equal(view.nextStep({ ...approved, allowed_actions: [] }, 'someone'), '执行受阻，请查看原因');
  assert.equal(view.canCancel({ ...approved, status: 'EXECUTING' }), false);
  assert.equal(view.resultText({ result_code: 'CANCELLED_BY_APPROVER' }), '审批人员撤销了这条授权');
  assert.equal(view.resultText({ result_code: 'CANCELLED_BY_REQUESTER' }), '申请人自己撤回或撤销了这条授权');
});

test('感知设备分组：状态未知单独计数，一台都不在线时直说“全部不在线”', async () => {
  const { deviceGroupState } = await import('../src/services/situationData.js');
  assert.deepEqual(deviceGroupState({ total: 2, online: 0, abnormal: 0, offline: 0, unknown: 2 }),
    { down: true, headline: '全部不在线', detail: '0异常 · 0离线 · 2状态未知' });
  assert.deepEqual(deviceGroupState({ total: 3, online: 1, abnormal: 1, offline: 1, unknown: 0 }),
    { down: false, headline: '1在线', detail: '1异常 · 1离线' });
  assert.equal(deviceGroupState({ total: 0 }).down, false);
});

test('历史接续已停用时保留撤销与证据入口，不提示换设备重新执行', async () => {
  const view = await import('../src/pages/alarms/authorizationQueueView.js');
  const labels = await import('../src/ui/labels.js');
  for (const channel of ['LINGYUN_B', 'COUNTERMEASURE_4CH']) {
    const row = { authorization_id: crypto.randomUUID(), execution_command_id: crypto.randomUUID(), action_type: 'JAMMING', channel,
      status: 'APPROVED', allowed_actions: ['CANCEL'], execution_block_reason: 'LEGACY_JAMMING_RETIRED' };
    assert.equal(view.primaryCode(row, 'operator'), '');
    assert.equal(view.canCancel(row), true);
    assert.match(view.executionEvidenceHref(row), /#\/evidence\?command=/);
    assert.match(view.nextStep(row, 'operator'), /自动接续已停用/);
    assert.doesNotMatch(view.nextStep(row, 'operator'), /换设备|重新申请/);
    assert.match(labels.DISPOSAL_BLOCK_REASON_LABEL[row.execution_block_reason], /不能再次执行/);
  }
});

test('处置只读分组：按明确组 ID 展示且保留每条原状态、权限和子记录选择', async () => {
  const { checkedAuthorizationGroups, groupRoot, groupContains, singleAuthorizationGroup } = await import('../src/pages/alarms/authorizationQueueView.js');
  for (const source_mode of ['live', 'mock', 'replay']) {
    const root = { authorization_id: crypto.randomUUID(), status: 'COMPLETED', allowed_actions: [], source_mode };
    const child = { authorization_id: crypto.randomUUID(), status: 'EXECUTING', allowed_actions: ['STOP'], source_mode };
    const separate = { ...root, authorization_id: crypto.randomUUID() };
    const group = { disposal_id: root.authorization_id, authorizations: [child, root] };
    const page = { items: [group, singleAuthorizationGroup(separate)], total: 21 };
    const before = JSON.stringify(page);
    assert.equal(checkedAuthorizationGroups(page), page.items);
    assert.equal(groupRoot(group), root);
    assert.equal(groupContains(group, child.authorization_id), true);
    assert.equal(groupContains(group, separate.authorization_id), false);
    assert.equal(groupContains(group, ''), false);
    assert.equal(JSON.stringify(page), before);
    assert.equal(page.items.length, 2);
  }
});

test('处置只读分组：缺根、跨组重复成员或不完整分页均报错，不隐藏或补造记录', async () => {
  const { checkedAuthorizationGroups, singleAuthorizationGroup } = await import('../src/pages/alarms/authorizationQueueView.js');
  const root = { authorization_id: crypto.randomUUID() }, other = { authorization_id: crypto.randomUUID() };
  const group = singleAuthorizationGroup(root);
  const cases = [null, { items: [], total: -1 }, { items: [group], total: 0 },
    { items: [group], total: 1.5 }, { items: [group, group], total: 2 },
    { items: [{ disposal_id: root.authorization_id, authorizations: [] }], total: 1 },
    { items: [{ disposal_id: root.authorization_id, authorizations: [null] }], total: 1 },
    { items: [{ disposal_id: root.authorization_id, authorizations: [other] }], total: 1 },
    { items: [group, { disposal_id: other.authorization_id, authorizations: [other, root] }], total: 2 }];
  for (const value of cases) assert.throws(() => checkedAuthorizationGroups(value), /处置记录数据不完整/);
  assert.deepEqual(checkedAuthorizationGroups({ items: [], total: 0 }), []);
});

test('处置只读分组：旧服务明确按原记录显示，权限或网络失败不回退', async () => {
  const { readAuthorizationGroupPage, singleAuthorizationGroup } = await import('../src/pages/alarms/authorizationQueueView.js');
  const row = { authorization_id: crypto.randomUUID() }, params = { page: 2, size: 20, status: 'COMPLETED' };
  let reads = 0;
  const list = async received => { assert.deepEqual(received, params); reads++; return { items: [row], total: 21 }; };
  const ok = await readAuthorizationGroupPage({ groups: async () => ({ items: [singleAuthorizationGroup(row)], total: 21 }), list }, params);
  assert.equal(ok.grouped, true); assert.equal(reads, 0);
  for (const status of [404, 501]) {
    const old = await readAuthorizationGroupPage({ groups: async () => { throw { status }; }, list }, params);
    assert.equal(old.grouped, false); assert.equal(old.items[0].authorizations[0], row); assert.equal(old.total, 21);
  }
  for (const status of [401, 403, 408, 500]) {
    await assert.rejects(readAuthorizationGroupPage({ groups: async () => { throw { status }; }, list }, params), error => error.status === status);
  }
  assert.equal(reads, 2);
});

test('目标视频：没有跟踪任务时把光电不在线等原因原样显示，只有默认那句缩成“暂无跟踪画面”', async () => {
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  const noTask = reason => targetVideoState('t1', { target_id: 't1', status: 'NO_TASK', video_status: 'NOT_CONFIGURED', reason }).message;
  const offline = '当前目标没有光电跟踪任务：目标所在区域的光电设备都不在线（共 2 台，停用、离线、异常或状态未知），暂无画面。';
  assert.equal(noTask(offline), offline);
  assert.equal(noTask('当前目标没有光电跟踪任务，暂无可查看画面。'), '暂无跟踪画面');
});

test('选中值只用名称、编号区分同名设备，不追加括号说明及下方小字', async () => {
  const devices = REACH_DEVICES.map((device, index) => ({ ...device,
    device_id: crypto.randomUUID(), device_no: `R-${index}-${Date.now()}`, name: '反制设备',
    longitude: device.longitude + 0.1 }));
  const point = { lon: TARGET.lon + 0.1, lat: TARGET.lat };
  const { context, state } = load({ devices });
  await context.openDisposalRequest({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: crypto.randomUUID(), targetPoint: point });
  const field = state.forms[0].fields.find(item => item.key === 'device_id');
  const model = { channel: 'COUNTERMEASURE_4CH', device_id: null };
  const options = field.options(model);
  assert.equal(options.length, 3, '超范围设备仍被过滤');
  for (const option of options) {
    assert.equal(option.selectedLabel, '反制设备');
    assert.match(option.label, /R-.*反制设备/);
    assert.equal(option.label, devices.find(d => d.device_id === option.value).device_no + ' · 反制设备');
    assert.equal(option.help, undefined);
  }
  assert.equal(field.help, undefined);
  assert.equal(options[2].disabled, true);
});

test('选中名称缺失有编号兜底，未知位置不假称覆盖', async () => {
  const { form } = await requestForm();
  const field = form.fields.find(item => item.key === 'device_id');
  const model = { channel: 'COUNTERMEASURE_4CH', device_id: 'ok' };
  assert.equal(field.help, undefined);
  assert.equal(field.options(model).find(item => item.value === 'abn').selectedLabel, 'CM-3');
});

test('选中值渲染不改变普通选择器、完整菜单标签和设备标识', async () => {
  const { selectTagRenderer, selectMenuProps } = await import('../src/components/form/selectProps.js');
  assert.deepEqual(selectMenuProps([{ label: '普通选项' }]), { class: 'u-select-menu', style: { minWidth: '136px' } });
  assert.equal(selectTagRenderer([{ value: 'one', label: '普通选项' }]), undefined);
  const option = { value: crypto.randomUUID(), label: '编号 · 设备（反制 · 距目标 500 m · 在覆盖范围内）', selectedLabel: '设备' };
  const before = JSON.stringify(option);
  const render = selectTagRenderer([option]);
  assert.match(selectMenuProps([option]).class, /u-select-menu--details/);
  assert.equal(render({ option }), '设备');
  assert.equal(JSON.stringify(option), before);
  assert.equal(render({ option: { label: '未设置短名称' } }), '未设置短名称');
  assert.equal(render({ option: { label: (_option, selected) => selected ? '动态名称' : '动态菜单' } }), '动态名称');
});

test('简化设备显示后申请仍提交原 device_id 和通道，不提交展示字段', async () => {
  let payload;
  const { form } = await requestForm({ create: async body => { payload = body; return { authorization_no: 'DSP-TEST' }; } });
  const values = { ...form.initial, action_type: 'COUNTERMEASURE', channel: 'COUNTERMEASURE_4CH', device_id: 'ok', reason: '核实依据后申请处置' };
  assert.equal(form.validate(values), null);
  await form.onSubmit(values);
  assert.equal(payload.device_id, 'ok');
  assert.equal(payload.channel, 'COUNTERMEASURE_4CH');
  assert.equal(payload.reason, values.reason);
  assert.equal(payload.selectedLabel, undefined);
  assert.equal(payload.help, undefined);
});

test('申请及直接反制均移除设备括号与小字，保留名称自身括号和读取错误', async () => {
  for (const method of ['openDisposalRequest', 'openDisposalDirect']) {
    const { context, state } = load({ devices: [{ ...DEVICES[0], name: '设备（东区）' }] });
    await context[method]({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: crypto.randomUUID(), targetPoint: TARGET });
    const field = state.forms[0].fields.find(item => item.key === 'device_id');
    const option = field.options({ channel: 'COUNTERMEASURE_4CH' })[0];
    assert.equal(option.label, 'CM-1 · 设备（东区）');
    assert.equal(option.selectedLabel, '设备（东区）');
    assert.equal(field.help, undefined);
    for (const listError of [{ status: 403 }, { message: '连接设备服务失败' }]) {
      const failed = load({ listError });
      await failed.context[method]({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: crypto.randomUUID() });
      assert.match(failed.state.forms[0].notice, /没有设备台账读取权限|连接设备服务失败/);
      assert.ok(failed.state.forms[0].validate({ reason: '依据有效', channel: 'COUNTERMEASURE_4CH', device_id: 'ok' }));
    }
  }
});

test('待审批只给申请人撤回入口，审批人和未知身份不能撤回，也不重复显示事件级撤销面板', async () => {
  const view = await import('../src/pages/alarms/authorizationQueueView.js');
  for (const channel of ['LINGYUN_B', 'COUNTERMEASURE_4CH']) {
    for (const source_mode of ['live', 'replay']) {
      const requester = crypto.randomUUID(), approver = crypto.randomUUID();
      const row = { authorization_id: crypto.randomUUID(), requested_by: requester, channel, source_mode,
        subject_kind: 'UAV_EVENT', action_type: 'COUNTERMEASURE', status: 'REQUESTED', allowed_actions: ['CANCEL', 'APPROVE', 'REJECT'] };
      assert.equal(view.canCancel(row, requester), true);
      assert.equal(view.primaryCode(row, requester), '');
      assert.equal(view.primaryCode(row, approver), 'APPROVE');
      assert.equal(view.canCancel(row, approver), false);
      assert.equal(view.canCancel(row), false);
      assert.equal(view.canCancel({ ...row, requested_by: null }, null), false);
      assert.equal(view.canCancel({ ...row, allowed_actions: [] }, requester), false);
      assert.equal(view.showEmergencyPanel(row), false);
      assert.equal(view.canCancel({ ...row, status: 'APPROVED' }, approver), true);
      for (const status of ['APPROVED', 'EXECUTING', 'STOPPED', 'COMPLETED', 'FAILED']) {
        assert.equal(view.showEmergencyPanel({ ...row, status }), true);
      }
      assert.equal(view.canCancel({ ...row, status: 'EXECUTING' }, requester), false);
      assert.equal(view.canStop({ ...row, status: 'EXECUTING', allowed_actions: ['STOP'] }), true);
    }
  }
});

test('反制准备已读取设备时表单复用该结果，失败不回退重发或给空权限设备',async()=>{
  for(const failed of [false,true]){
    const {context,state}=load();
    await context.openDisposalDirect({actionType:'COUNTERMEASURE',subjectKind:'UAV_EVENT',subjectId:'event-prepared',
      preparedDevices:failed?{error:Object.assign(new Error('forbidden'),{status:403})}:{items:DEVICES}});
    assert.equal(state.reads,0,'不重复等待设备接口');assert.equal(state.forms.length,1);
    const form=state.forms[0],options=form.fields.find(field=>field.key==='device_id').options({channel:'COUNTERMEASURE_4CH'});
    if(failed){assert.ok(options.every(row=>row.disabled));assert.match(form.notice,/没有设备台账读取权限/);}
    else assert.ok(options.some(row=>row.value==='ok'&&!row.disabled));
  }
});
