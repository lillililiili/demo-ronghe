const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sourceRoot = path.resolve(__dirname, '../src');

test('unknown SMS never offers blind resend even if a stale backend flag permits it', async () => {
  const { autoSmsView } = await import(pathToFileURL(path.join(sourceRoot, 'components/disposal/autoSmsView.js')).href);
  const view = autoSmsView({ auto_sms: { status: 'UNKNOWN', can_retry: true, reason: '发送结果未知' } });
  assert.equal(view.title, '发送结果未知');
  assert.equal(view.canRetry, false);
  assert.equal(view.tone, 'warning');
});

test('plan feedback unknown outcome does not claim no send happened', () => {
  const source = readFileSync(path.join(sourceRoot, 'pages/flights/components/PlanVerificationPanel.vue'), 'utf8');
  const match = source.match(/function notificationMessage\(result\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'Plan feedback keeps a testable notification outcome message');
  const message = new Function('result', match[1]);
  assert.equal(message({ delivery_status: 'SUBMITTED', blocked_reason: 'DELIVERY_OUTCOME_UNKNOWN' }),
    '检查结果已保存，通知发送结果未知，请先核对原发送记录。');
  assert.equal(message({ delivery_status: 'DELIVERED' }), '检查结果已保存，通知已送达。');
  assert.equal(message({ delivery_status: 'FAILED' }), '检查结果已保存，通知尚未发出，请查看记录中的原因。');
});
