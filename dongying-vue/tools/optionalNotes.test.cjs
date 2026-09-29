const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function riskForm(state = 'PENDING_VERIFICATION') {
  let form, submitted;
  const source = readFileSync(path.join(__dirname, '../src/ui/riskVerificationModal.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const context = vm.createContext({
    openFormModal: value => { form = value; }, closeModal() {}, toast() {},
    riskApi: { verifyRisk: async (id, body) => { submitted = body; return { state: 'PENDING_NOTIFICATION' }; } },
    newRiskIdempotencyKey: () => 'test-optional-note', isUncertainOutcome: () => false,
    RISK_TYPE_LABEL: {}, RISK_STATE_LABEL: {}, labelOf: () => '', readableNo: () => ''
  });
  vm.runInContext(source, context);
  context.openRiskVerification({ risk: { risk_id: 'test-risk', version: 0, state, allowed_actions: ['VERIFY'] } });
  return { form, submitted: () => submitted };
}

test('风险核验及改判允许说明留空，保留结论选择与长度上限', async () => {
  for (const state of ['PENDING_VERIFICATION', 'PENDING_NOTIFICATION']) {
    const { form, submitted } = riskForm(state);
    assert.equal(Boolean(form.fields.find(field => field.key === 'note').required), false);
    for (const note of [undefined, '', '   ']) assert.equal(form.validate({ note }), '');
    assert.equal(form.validate({ note: '字'.repeat(1000) }), '');
    assert.match(form.validate({ note: '字'.repeat(1001) }), /不能超过/);
    if (state === 'PENDING_VERIFICATION') assert.equal(form.fields.find(field => field.key === 'conclusion').required, true);
    await form.onSubmit({ conclusion: 'CONFIRMED', note: '   ' });
    assert.equal(submitted().note, '');
    assert.equal(submitted().conclusion, state === 'PENDING_NOTIFICATION' ? 'EXCLUDED' : 'CONFIRMED');
    assert.equal(submitted().expected_version, 0);
  }
});

test('合法性说明保留千字上限，空值不会被阻断', () => {
  const source = readFileSync(path.join(__dirname, '../src/ui/legalityReviewModal.js'), 'utf8');
  const functions = source.match(/function trimNote[\s\S]*?\n}\r?\n/)[0];
  const context = vm.createContext({});
  vm.runInContext(functions, context);
  for (const note of [undefined, null, '', '   ', '字'.repeat(1000)]) assert.equal(context.validateNote(note), '');
  assert.match(context.validateNote('字'.repeat(1001)), /不能超过/);
});
