const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vue = require('vue');
const riskHelpers = require('./riskCaseTestHelpers.cjs');

function fixture(kind, withCase = true) {
  const props = vue.reactive({ disabled: false, data: { event_id: randomUUID(), event_version: 3,
    ...(withCase ? { risk_case: { risk_case_id: randomUUID(), version: 7 } } : {}) } });
  const state = { calls: [], modal: null, notices: [] };
  const source = readFileSync(path.join(__dirname, `../src/components/disposal/Auto${kind}Notice.vue`), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
  const deps = { ...riskHelpers, ...vue, defineProps: () => props, defineEmits: () => () => {}, onUnmounted: () => {},
    autoSmsView: () => ({ canRetry: true }), autoVoiceView: () => ({ canRetry: true }),
    newHandoffIdempotencyKey: randomUUID, toast: value => state.notices.push(value),
    openFormModal: options => { state.modal = options; return { isCurrent: () => true, close() {} }; },
    uavAdvisoryApi: { retrySms: async (...args) => state.calls.push(args), retryVoice: async (...args) => state.calls.push(args) } };
  const api = new Function(...Object.keys(deps), source + '\nreturn { retry };')(...Object.values(deps));
  return { props, state, ...api };
}

for (const kind of ['Sms', 'Voice']) {
  test(`${kind}: 同一实测事件切换禁飞区后，已打开的重试表单不能提交到另一风险`, async () => {
    const f = fixture(kind); f.retry();
    f.props.data.risk_case = { risk_case_id: randomUUID(), version: 7 };
    await assert.rejects(f.state.modal.onSubmit({ note: '' }), /风险或事件已切换/);
    assert.equal(f.state.calls.length, 0);
  });
  test(`${kind}: 同一风险刷新版本后，提交仍绑定打开时的版本，由服务端检查冲突`, async () => {
    const f = fixture(kind); const original = { ...f.props.data.risk_case }; f.retry();
    f.props.data.risk_case = { ...original, version: original.version + 1 };
    await f.state.modal.onSubmit({ note: '已核对' });
    assert.equal(f.state.calls[0][1].risk_case_id, original.risk_case_id);
    assert.equal(f.state.calls[0][1].expected_case_version, original.version);
    assert.equal(f.state.calls[0][1].expected_version, 3);
  });
  test(`${kind}: 已识别风险但缺少版本时不降级成旧事件入口；旧独立事件仍兼容`, async () => {
    const f = fixture(kind); delete f.props.data.risk_case.version; f.retry();
    assert.equal(f.state.modal, null); assert.equal(f.state.notices.length, 1);
    const legacy = fixture(kind, false); legacy.retry(); await legacy.state.modal.onSubmit({ note: '' });
    assert.equal(legacy.state.calls.length, 1);
    assert.equal(legacy.state.calls[0][1].risk_case_id, undefined);
  });
  test(`${kind}: 风险失效后禁用提交，不重新发送通知`, async () => {
    const f = fixture(kind); f.retry(); f.props.disabled = true;
    await assert.rejects(f.state.modal.onSubmit({ note: '' }), /当前状态不允许/);
    assert.equal(f.state.calls.length, 0);
  });
}
