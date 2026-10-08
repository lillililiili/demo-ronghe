const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function reasonsOf(values) {
  const labels = await import('../src/ui/labels.js');
  const dictionary = readFileSync(path.join(__dirname, '../src/ui/legalityReviewModal.js'), 'utf8')
    .replace(/^import [\s\S]*?;\r?\n/gm, '').replace(/\bexport /g, '') + '\n;globalThis.reasonText = ruleReasonText;';
  const context = vm.createContext({ sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
  vm.runInContext(dictionary, context);
  const script = readFileSync(path.join(__dirname, '../src/pages/alarms/NoCounterBasis.vue'), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?\n/gm, '');
  const run = new Function('defineProps', 'computed', 'VIOLATION_CODE_LABEL', 'REASON_CODE_LABEL', 'ruleReasonText',
    script + '\nreturn reasons.value;');
  return run(() => ({ basis: { violation_reasons: values } }), fn => ({ value: fn() }),
    labels.VIOLATION_CODE_LABEL, labels.REASON_CODE_LABEL, context.reasonText);
}
test('no-counter basis uses the same known reason names as the alarm and legality pages', async () => {
  assert.deepEqual(await reasonsOf(['INSIDE_RESTRICTED_AIRSPACE', 'ROUTE_DEVIATION', { code: 'NIGHT_FLIGHT' }]),
    ['进入禁飞/限制空域', '偏航（偏离报备航线）', '夜间飞行']);
});
test('no-counter basis keeps unknown explanations and codes rather than hiding evidence', async () => {
  assert.deepEqual(await reasonsOf([{ code: 'FUTURE_REASON', message: '新的来源说明' }, 'NEW_CODE', null]),
    ['新的来源说明', 'NEW_CODE', '未提供具体原因']);
  assert.deepEqual(await reasonsOf(undefined), []);
});
