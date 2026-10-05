const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function executionForm(error, latest = { status: 'APPROVED' }) {
  let form, refreshes = 0, closed = 0, sequence = 0;
  const keys = [], messages = [];
  const source = readFileSync(path.join(__dirname, '../src/ui/disposalAuthModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({
    openFormModal: value => { form = value; }, closeModal: () => { closed++; },
    toast: message => messages.push(message),
    disposalApi: { execute: async (_id, _body, key) => { keys.push(key); throw error; } },
    newDisposalIdempotencyKey: () => `test-key-${++sequence}`,
    isDisposalUnavailable: () => false, isUncertainOutcome: value => value.status === 409,
    DISPOSAL_ACTION_LABEL: {}, DISPOSAL_BLOCK_REASON_LABEL: {}, DISPOSAL_CHANNEL_LABEL: {},
    DISPOSAL_STATUS_LABEL: {}, disposalStatusText: value => value.status,
    labelOf: (_labels, value) => value
  });
  vm.runInContext(source, context);
  context.openDisposalExecution({
    authorization: { authorization_id: 'qa-auth', status: 'APPROVED', channel: 'COUNTERMEASURE_4CH', version: 1 },
    refresh: async () => { refreshes++; return latest; }
  });
  return { form, keys, messages, refreshes: () => refreshes, closed: () => closed };
}

test('设备故障是明确未下发，回读后仍保留执行弹窗供处理，不提示结果未知', async () => {
  const state = executionForm({ status: 409, code: 'DEVICE_NOT_OPERABLE', message: '设备已上报故障，不能下发启动指令' });
  await assert.rejects(state.form.onSubmit({ note: '' }), /本次没有下发。设备已上报故障/);
  assert.equal(state.refreshes(), 1);
  assert.equal(state.closed(), 0);
  assert.deepEqual(state.messages, []);
  await assert.rejects(state.form.onSubmit({ note: '' }), /本次没有下发/);
  assert.notEqual(state.keys[0], state.keys[1]);
});

test('故障回读发现授权已失效时显示最新状态并关闭过期执行表单', async () => {
  const state = executionForm({ status: 409, code: 'DEVICE_NOT_OPERABLE' }, { status: 'EXPIRED' });
  await state.form.onSubmit({ note: '' });
  assert.equal(state.closed(), 1);
  assert.match(state.messages[0], /本次没有下发.*EXPIRED/);
});

test('设备占用冲突明确显示未下发，不能被当作结果未知', async () => {
  const state = executionForm({ status: 409, code: 'DEVICE_BUSY' });
  await assert.rejects(state.form.onSubmit({ note: '' }), /本次没有下发。设备仍有未完成/);
  assert.equal(state.refreshes(), 1);
  assert.equal(state.closed(), 0);
  assert.deepEqual(state.messages, []);
});

test('未知冲突且无法回读时保留幂等键，不把不确定结果当作设备明确故障', async () => {
  const state = executionForm({ status: 409, code: 'UNEXPECTED_CONFLICT' }, null);
  await assert.rejects(state.form.onSubmit({ note: '' }), /提交结果未确认/);
  await assert.rejects(state.form.onSubmit({ note: '' }), /提交结果未确认/);
  assert.equal(state.keys[0], state.keys[1]);
  assert.equal(state.closed(), 0);
});
