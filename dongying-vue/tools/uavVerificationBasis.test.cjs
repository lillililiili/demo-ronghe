const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function verificationForm(event, verify) {
  let form;
  const source = readFileSync(path.join(__dirname, '../src/ui/uavVerificationModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({
    openFormModal: value => { form = value; }, closeModal() {}, toast() {}, crypto: globalThis.crypto,
    verifyUavEvent: verify, isUncertainOutcome: error => !!error && (error.status === 409 || error.code === 'TIMEOUT'),
    ALARM_TYPE_LABEL: {}, labelOf: () => '', readableNo: value => value || ''
  });
  vm.runInContext(source, context);
  const opened = context.openUavVerification({ event, alarm: { alarm_id: 'a1', alarm_no: 'AL-1', target_id: 't1' } });
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
  assert.equal(form.validate({ conclusion: 'FALSE_POSITIVE' }), '');
  await form.onSubmit({ conclusion: 'FALSE_POSITIVE' });
  assert.equal(submitted[0].id, 'e1');
  assert.equal(submitted[0].body.conclusion, 'FALSE_POSITIVE');
  assert.equal(submitted[0].body.expected_version, 3);
});

test('依据齐全或接口未返回依据时保持原来的属实预选', () => {
  for (const basis of [undefined, null, { confirmable: true, missing: [], message: '', checked_at: 1 }]) {
    const { form } = verificationForm(pending({ verification_basis: basis }), async () => ({}));
    assert.equal(form.warning, '');
    assert.equal(form.fields[0].options[0].disabled, false);
    assert.equal(form.initial.conclusion, 'CONFIRMED');
    assert.equal(form.validate({ conclusion: 'CONFIRMED' }), '');
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
