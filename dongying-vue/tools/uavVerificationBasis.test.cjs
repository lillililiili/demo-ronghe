const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function verificationForm(event, verify, alarm = {}) {
  let form;
  const source = readFileSync(path.join(__dirname, '../src/ui/uavVerificationModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({
    openFormModal: value => { form = value; }, closeModal() {}, toast() {}, crypto: globalThis.crypto,
    verifyUavEvent: verify, isUncertainOutcome: error => !!error && (error.status === 409 || error.code === 'TIMEOUT'),
    ALARM_TYPE_LABEL: {}, labelOf: () => '', readableNo: value => value || '', serverNow: () => Date.now()
  });
  vm.runInContext(readFileSync(path.join(__dirname, '../src/ui/deviceNumber.js'), 'utf8').replace(/\bexport /g, ''), context);
  vm.runInContext(readFileSync(path.join(__dirname, '../src/services/predictionView.js'), 'utf8').replace(/\bexport /g, ''), context);
  vm.runInContext(source, context);
  const opened = context.openUavVerification({ event, alarm: { alarm_id: 'a1', alarm_no: 'AL-1', target_id: 't1', ...alarm } });
  return { form, opened };
}

const pending = patch => ({ event_id: 'e1', version: 3, state: 'PENDING_VERIFICATION', allowed_actions: ['VERIFY'], ...patch });

test('缺少核实依据时“属实”不可选并说明原因，误报照常提交', async () => {
  const submitted = [];
  const { form, opened } = verificationForm(pending({
    verification_basis: { confirmable: false, missing: ['NO_CURRENT_DATA'], checked_at: 1,
      message: '缺少依据，不能核实为属实：目标已超过 120 秒没有上报<img src=x>。' }
  }), async (id, body) => { submitted.push({ id, body }); return { state: 'FALSE_POSITIVE' }; });
  assert.equal(opened, true);
  assert.match(form.warning, /缺少依据，不能核实为属实：目标已超过 120 秒没有上报/);
  assert.equal(form.warning.includes('<img'), false, '服务端文案按文本显示');
  const confirmed = form.fields[0].options.find(option => option.value === 'CONFIRMED');
  assert.equal(confirmed.disabled, true);
  assert.match(confirmed.label, /缺少依据/);
  assert.equal(form.initial.conclusion, undefined, '不预选结论');
  assert.match(form.validate({ conclusion: 'CONFIRMED' }), /缺少依据/);
  assert.equal(form.validate({ conclusion: 'FALSE_POSITIVE' }), '', '核实说明为选填');
  assert.match(form.validate({ conclusion: 'FALSE_POSITIVE', note: '字'.repeat(1001) }), /不能超过1000字/);
  assert.equal(form.validate({ conclusion: 'FALSE_POSITIVE', note: '已核对关联观测与证据' }), '');
  await form.onSubmit({ conclusion: 'FALSE_POSITIVE', note: '已核对关联观测与证据' });
  assert.equal(submitted[0].id, 'e1');
  assert.equal(submitted[0].body.conclusion, 'FALSE_POSITIVE');
  assert.equal(submitted[0].body.expected_version, 3);
  assert.equal(submitted[0].body.note, '已核对关联观测与证据');
});

test('依据齐全或接口未返回依据时保持原来的属实预选', () => {
  for (const basis of [undefined, null, { confirmable: true, missing: [], message: '', checked_at: 1 }]) {
    const { form } = verificationForm(pending({ verification_basis: basis }), async () => ({}));
    assert.equal(form.warning, '');
    assert.equal(form.fields[0].options[0].disabled, false);
    assert.equal(form.initial.conclusion, 'CONFIRMED');
    assert.equal(form.validate({ conclusion: 'CONFIRMED' }), '', '核实说明为选填');
    assert.match(form.validate({ conclusion: 'CONFIRMED', note: '字'.repeat(1001) }), /不能超过1000字/);
    assert.equal(form.validate({ conclusion: 'CONFIRMED', note: '核对当前观测和明确违规研判' }), '');
  }
});

test('提交时服务端判定缺依据（422）按明确失败说明原因，下次提交换新幂等键', async () => {
  const keys = [];
  const { form } = verificationForm(pending(), async (id, body, key) => {
    keys.push(key);
    throw Object.assign(new Error('缺少依据，不能核实为属实：本次告警还没有合法性研判。'), { status: 422, code: 'VERIFICATION_BASIS_MISSING' });
  });
  await assert.rejects(form.onSubmit({ conclusion: 'CONFIRMED' }), /本次告警还没有合法性研判/);
  await assert.rejects(form.onSubmit({ conclusion: 'CONFIRMED' }), /缺少依据/);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});


test('预测核实绑定事件返回的快照及事件版本，不用列表旧快照替换', async () => {
  const sent = [];
  const { form } = verificationForm(pending({ verification_basis: { confirmable: true, prediction_id: 'prediction-current' } }),
    async (id, body) => { sent.push(body); return { state: 'CONFIRMED' }; },
    { origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { prediction_id: 'prediction-old', status: 'READY', based_on_observed_at: Date.now() - 500, valid_until: Date.now() + 60000, warning: { state: 'ACTIVE' } } });
  assert.match(form.fields[0].options[0].label, /预测风险成立/);
  await form.onSubmit({ conclusion: 'CONFIRMED' });
  assert.equal(sent[0].prediction_id, 'prediction-current');
  assert.equal(sent[0].expected_version, 3);
});

test('预测依据缺失时不能确认，且不预选属实；普通核实仍不发送预测字段', async () => {
  const { form } = verificationForm(pending(), async () => ({}), { origin_kind: 'PREDICTED_AIRSPACE_ENTRY' });
  assert.equal(form.fields[0].options[0].disabled, true);
  assert.equal(form.initial.conclusion, undefined);
  assert.match(form.warning, /预测快照/);
  let body;
  const ordinary = verificationForm(pending(), async (id, value) => { body = value; return { state: 'CONFIRMED' }; });
  await ordinary.form.onSubmit({ conclusion: 'CONFIRMED' });
  assert.equal(Object.hasOwn(body, 'prediction_id'), false);
});


test('预测终态不打开核实弹窗，UNKNOWN和打开时过期只允许误报，同周期快照交服务端重验', async () => {
  for (const state of ['WITHDRAWN', 'ENTERED', 'UNKNOWN']) {
    const submitted = [];
    const alarm = { origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { prediction_id: `prediction-${state}`, status: 'READY',
      based_on_observed_at: Date.now() - 500, valid_until: Date.now() + 60000, warning: { state } } };
    const { form, opened } = verificationForm(pending({ verification_basis: { confirmable: true, prediction_id: `prediction-${state}` } }),
      async (id, body) => { submitted.push(body); return { state: 'FALSE_POSITIVE' }; }, alarm);
    if (state !== 'UNKNOWN') { assert.equal(opened, false); assert.equal(form, undefined); continue; }
    assert.equal(form.fields[0].options[0].disabled, true);
    assert.equal(form.initial.conclusion, undefined);
    assert.match(form.warning, /不能提交预测风险属实/);
    await assert.rejects(form.onSubmit({ conclusion: 'CONFIRMED' }), /不能提交预测风险属实/);
    assert.equal(submitted.length, 0);
    await form.onSubmit({ conclusion: 'FALSE_POSITIVE' });
    assert.equal(submitted[0].conclusion, 'FALSE_POSITIVE');
  }
  const alarm = { origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { prediction_id: 'expires-after-open', status: 'READY',
    based_on_observed_at: Date.now() - 500, valid_until: Date.now() + 60000, warning: { state: 'ACTIVE' } } };
  const submitted = [];
  const { form } = verificationForm(pending(), async (id, body) => submitted.push(body), alarm);
  assert.equal(form.fields[0].options[0].disabled, false);
  alarm.prediction.valid_until = Date.now() - 1;
  // 已打开的核实仍提交当时选择的快照，由服务端验证当前同周期依据，不因每秒刷新重新要求操作人选择。
  await form.onSubmit({ conclusion: 'CONFIRMED' });
  assert.equal(submitted[0].prediction_id, 'expires-after-open');
  const expired = verificationForm(pending(), async () => { throw new Error('不应请求'); }, alarm);
  assert.equal(expired.form.fields[0].options[0].disabled, true);
  assert.match(expired.form.validate({ conclusion: 'CONFIRMED' }), /不能提交预测风险属实/);
  await assert.rejects(expired.form.onSubmit({ conclusion: 'CONFIRMED' }), /不能提交预测风险属实/);
});
