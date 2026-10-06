/* 反制设备可用性、撤销授权与“为什么不能反制”的提示（BUG-03 / ZT-18）：node tools/disposalDeviceCancel.test.cjs */
const { test } = require('node:test');
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

/** 去掉 import/export 后在隔离上下文里跑弹窗模块，表单、提示和接口调用都记下来。 */
function load({ devices = DEVICES, create, cancel } = {}) {
  const state = { forms: [], toasts: [], closed: 0, cancels: [], refreshed: [] };
  const source = readFileSync(path.join(__dirname, '../src/ui/disposalAuthModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  let sequence = 0;
  const context = vm.createContext({
    openFormModal: form => state.forms.push(form), closeModal: () => { state.closed++; },
    toast: (message, kind) => state.toasts.push([message, kind]),
    deviceApi: { list: async () => ({ items: devices }) },
    disposalApi: {
      create: create || (async () => ({ authorization_no: 'DSP-NEW' })),
      cancel: cancel || (async (id, body, key) => { state.cancels.push([id, body, key]); return { authorization_id: id, status: 'CANCELLED' }; })
    },
    newDisposalIdempotencyKey: () => `key-${++sequence}`,
    isDisposalUnavailable: () => false, isUncertainOutcome: () => false,
    DISPOSAL_ACTION_LABEL: {}, DISPOSAL_BLOCK_REASON_LABEL: {}, DISPOSAL_CHANNEL_LABEL: {},
    DISPOSAL_STATUS_LABEL: {}, disposalStatusText: value => value?.status,
    labelOf: (_labels, value) => value
  });
  vm.runInContext(source, context);
  return { context, state };
}

async function requestForm(options) {
  const loaded = load(options);
  await loaded.context.openDisposalRequest({ actionType: 'COUNTERMEASURE', subjectKind: 'UAV_EVENT', subjectId: 'event-1' });
  assert.equal(loaded.state.forms.length, 1);
  return { ...loaded, form: loaded.state.forms[0] };
}

test('不能用的设备置灰并写明原因，能用的排在前面，别的通道的设备不出现', () => {
  const { context } = load();
  const options = context.deviceOptions(DEVICES, 'COUNTERMEASURE_4CH');
  assert.deepEqual(options.map(option => [option.value, option.disabled]),
    [['ok', false], ['off', true], ['abn', true], ['unk', true], ['bad', true]]);
  assert.doesNotMatch(options[0].label, /不能选/);
  assert.match(options[1].label, /不能选：设备离线/);
  assert.match(options[2].label, /不能选：设备上报工作异常（故障）/);
  assert.match(options[3].label, /不能选：设备状态不明（没有上报状态）/);
  assert.match(options[4].label, /不能选：设备上报故障/);
  assert.equal(context.deviceUnavailableReason({ enabled: false, connectivity: 'ONLINE' }), '设备已停用');
  assert.equal(context.deviceUnavailableReason({ enabled: true, connectivity: 'ONLINE', health_code: 'GOOD' }), '');
});

test('申请表单：设备下拉随通道给出置灰选项，选到不能用的设备时提交前就说清原因', async () => {
  const { form } = await requestForm();
  const device = form.fields.find(field => field.key === 'device_id');
  assert.match(device.help, /置灰不能选/);
  assert.deepEqual(device.options({ channel: 'LINGYUN_B' }).map(option => option.disabled), [true]);
  const base = { action_type: 'COUNTERMEASURE', channel: 'COUNTERMEASURE_4CH', reason: '现场核实后申请反制' };
  assert.equal(form.validate({ ...base, device_id: 'ok' }), null);
  assert.equal(form.validate({ ...base, device_id: 'off' }), '所选设备不能用：设备离线。请换一台设备。');
  assert.match(form.validate({ ...base, channel: 'LINGYUN_B', device_id: 'ifr-off' }), /这个执行通道的设备现在都不能用/);
  assert.match(form.warning, /不再二次审批，有效期不超过这次授权/);
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

test('目标视频：没有跟踪任务时把光电不在线等原因原样显示，只有默认那句缩成“暂无跟踪画面”', async () => {
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  const noTask = reason => targetVideoState('t1', { target_id: 't1', status: 'NO_TASK', video_status: 'NOT_CONFIGURED', reason }).message;
  const offline = '当前目标没有光电跟踪任务：目标所在区域的光电设备都不在线（共 2 台，停用、离线、异常或状态未知），暂无画面。';
  assert.equal(noTask(offline), offline);
  assert.equal(noTask('当前目标没有光电跟踪任务，暂无可查看画面。'), '暂无跟踪画面');
});
