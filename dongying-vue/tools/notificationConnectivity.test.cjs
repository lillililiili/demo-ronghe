const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const sourceRoot = path.resolve(__dirname, '../src');

test('notification copy explains expired settings without changing the original record', async () => {
  const { userFacingMessage, notificationBlockedReason } = await import(pathToFileURL(path.join(sourceRoot, 'ui/labels.js')).href);
  const notice = Object.freeze({ blocked_reason: '通知配置已超过有效期', delivery_status: 'PENDING_DELIVERY' });
  assert.equal(notificationBlockedReason(notice), '通知设置已到期，暂时发不了通知。请联系管理员更新设置。');
  assert.equal(notice.blocked_reason, '通知配置已超过有效期');
  assert.equal(notice.delivery_status, 'PENDING_DELIVERY');
  assert.equal(userFacingMessage('未收录的具体原因'), '未收录的具体原因');
  assert.equal(userFacingMessage('toString'), 'toString');
  assert.equal(userFacingMessage(null), '');
  assert.equal(notificationBlockedReason({ blocked_reason: 'LOCAL_SIMULATOR_WAITING:123' }), '');
});

test('unknown send outcome asks to check records, never assumes failure or recommends resend', async () => {
  const { userFacingMessage } = await import(pathToFileURL(path.join(sourceRoot, 'ui/labels.js')).href);
  const text = userFacingMessage('DELIVERY_OUTCOME_UNKNOWN');
  assert.match(text, /不确定/);
  assert.match(text, /查看发送记录/);
  assert.match(text, /不要重复发送/);
  assert.doesNotMatch(text, /发送失败|尚未发出|重新发送/);
});

test('unknown SMS never offers blind resend even if a stale backend flag permits it', async () => {
  const { autoSmsView } = await import(pathToFileURL(path.join(sourceRoot, 'components/disposal/autoSmsView.js')).href);
  const view = autoSmsView({ auto_sms: { status: 'UNKNOWN', can_retry: true, reason: '发送结果未知' } });
  assert.equal(view.title, '发送结果未知');
  assert.equal(view.canRetry, false);
  assert.equal(view.tone, 'warning');
});

test('unavailable voice channel is shown instead of being reduced to SMS waiting', async () => {
  const { autoVoiceView } = await import(pathToFileURL(path.join(sourceRoot, 'components/disposal/autoVoiceView.js')).href);
  const view = autoVoiceView({
    voice_mode: 'UNAVAILABLE',
    auto_voice: { status: 'WAITING', reason: '飞手短信尚未送达，电话要等短信送达并观察 3 秒' }
  });
  assert.equal(view.title, '电话通道不可用');
  assert.equal(view.channelUnavailable, true);
  assert.match(view.reason, /模拟器|录音|通道/);
  assert.equal(view.tone, 'warning');
  assert.equal(view.simulated, false);
});

test('plan feedback unknown outcome does not claim no send happened', () => {
  const source = readFileSync(path.join(sourceRoot, 'pages/flights/components/PlanVerificationPanel.vue'), 'utf8');
  const match = source.match(/function notificationBlocker\(item\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'Plan feedback keeps a testable notification outcome message');
  const message = new Function('item', match[1]);
  assert.equal(message({ delivery_status: 'SUBMITTED', blocked_reason: 'DELIVERY_OUTCOME_UNKNOWN' }),
    '通知发送结果未知，请先核对原发送记录，不能重复通知。');
  assert.equal(message({ delivery_status: 'FAILED', blocked_reason: 'CHANNEL_NOT_CONNECTED' }),
    '通知功能尚未接通，记录已保存但还未发出。');
  assert.equal(message({ delivery_status: 'DELIVERED' }), undefined);
  assert.match(source, /item\.blocked_reason === 'DELIVERY_OUTCOME_UNKNOWN' \? '发送结果未知'/);
});

test('pending risk delivery does not claim a disconnected channel or a completed result', async () => {
  const { notificationSubmissionMessage, notificationBlockedReason } = await import(pathToFileURL(path.join(sourceRoot, 'ui/labels.js')).href);
  for (const id of ['alpha-01', 'changed-02']) {
    const notice = Object.freeze({ delivery_status: 'SUBMITTED', blocked_reason: `SIMULATOR_WAITING:${id}` });
    const view = notificationSubmissionMessage(notice);
    assert.match(view.title, /等待送达确认/);
    assert.doesNotMatch(view.message, /未接通|没有发出去|已送达|已驱离/);
    assert.equal(notificationBlockedReason(notice), '');
  }
  assert.match(notificationSubmissionMessage({ delivery_status: 'FAILED' }).title, /发送失败/);
  assert.match(notificationSubmissionMessage({ delivery_status: 'DELIVERED', receipt_status: 'ACKNOWLEDGED' }).message, /查看.*处理结果/);
  assert.doesNotMatch(notificationSubmissionMessage({ delivery_status: 'FUTURE_UNKNOWN' }).title, /已送达|失败/);
});
