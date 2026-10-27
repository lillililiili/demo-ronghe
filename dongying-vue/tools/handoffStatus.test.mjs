import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deliveryView, receiptView, statusQuery, notificationActions, declineReasonError, notificationStatisticsFilters, pendingOperationSettled, NOTIFICATION_OPTIONS } from '../src/pages/punish/handoffStatus.js';

test('当前模拟回执显示模拟送达和签收，不根据 simulated 标记推断为历史', () => {
  const row = { simulated: true, delivery_status: 'DELIVERED', receipt_status: 'ACKNOWLEDGED' };
  assert.equal(deliveryView(row).label, '模拟已送达');
  assert.equal(receiptView(row).label, '模拟已签收');
  assert.equal(deliveryView({ ...row, simulated: false }).label, '已送达');
  assert.equal(receiptView({ ...row, simulated: false }).label, '已签收');
});
test('提交未知和回执等待不得显示模拟成功', () => {
  const row = { simulated: true, delivery_status: 'SUBMITTED', receipt_status: 'PENDING', blocked_reason: 'DELIVERY_OUTCOME_UNKNOWN' };
  assert.equal(deliveryView(row).label, '发送结果未知');
  assert.equal(receiptView(row).label, '回执待确认');
  assert.equal(receiptView({ delivery_status: 'DELIVERED', receipt_status: 'NOT_EXPECTED' }).label, '未要求签收回执');
});

test('待决定及不通知覆盖投递初始值，但不能改写旧交接事实', () => {
  for (const simulated of [false, true]) {
    const row = { simulated, delivery_status: 'PENDING_DELIVERY', receipt_status: 'NOT_EXPECTED' };
    assert.equal(deliveryView({ ...row, notification_decision: { state: 'PENDING_DECISION' } }).label, '待决定通知');
    assert.equal(deliveryView({ ...row, notification_decision: { state: 'DO_NOT_NOTIFY' } }).label, '已选择不通知');
    assert.equal(deliveryView(row).label, '待发送');
  }
  assert.equal(deliveryView({ delivery_status: 'DELIVERED', notification_decision: { state: 'NOTIFY' } }).label, '已送达');
});

test('通知筛选使用服务端决定或投递字段，统计同维度交集不覆盖筛选', () => {
  assert.deepEqual(statusQuery('PENDING_DECISION', 'NOT_EXPECTED'), { notification_decision: 'PENDING_DECISION', receipt_status: 'NOT_EXPECTED' });
  assert.deepEqual(statusQuery('DO_NOT_NOTIFY', ''), { notification_decision: 'DO_NOT_NOTIFY' });
  assert.deepEqual(statusQuery('FAILED', 'TIMEOUT'), { delivery_status: 'FAILED', receipt_status: 'TIMEOUT' });
  assert.deepEqual(statusQuery('bad', 'bad'), {});
  assert.deepEqual(notificationStatisticsFilters({ source_kind: 'UAV_EVENT', notification_decision: 'DO_NOT_NOTIFY', created_from: 10 }),
    { source_kind: 'UAV_EVENT', notification_status: 'DO_NOT_NOTIFY', created_from: 10 });
  assert.deepEqual(notificationStatisticsFilters({ delivery_status: 'FAILED', receipt_status: 'PENDING' }), { notification_status: 'FAILED', receipt_status: 'PENDING' });
});

test('缺渠道仍可不通知；发送结果未知只允许刷新，明确失败沿原通知重试', () => {
  const row = { notification_decision: { state: 'PENDING_DECISION', version: 0 }, can_notify: false, can_decline: true, delivery_status: 'PENDING_DELIVERY' };
  assert.deepEqual(notificationActions(row), { showNotify: true, canNotify: false, showDecline: true, canDecline: true, refreshOnly: false, canRetryOriginal: false });
  assert.equal(notificationActions({ ...row, can_notify: true }).canNotify, true);
  assert.equal(notificationActions(row, { kind: 'notify', attempt: 1 }).refreshOnly, true);
  assert.equal(notificationActions(row, { kind: 'notify', attempt: 1 }).canDecline, false);
  const unknown = { ...row, can_notify: true, can_decline: true, delivery_status: 'SUBMITTED', latest_delivery: { blocked_reason: 'DELIVERY_OUTCOME_UNKNOWN' } };
  assert.deepEqual(notificationActions(unknown), { showNotify: false, canNotify: false, showDecline: false, canDecline: false, refreshOnly: true, canRetryOriginal: false });
  assert.equal(notificationActions({ ...unknown, delivery_status: 'FAILED', latest_delivery: { blocked_reason: 'CHANNEL_FAILURE' }, notification_decision: { state: 'NOTIFY' }, can_decline: false }).canNotify, true);
  assert.equal(notificationActions({ ...unknown, delivery_status: 'FAILED', notification_decision: { state: 'NOTIFY' }, can_decline: false }).canNotify, false);
  assert.equal(notificationActions({ ...row, notification_decision: { state: 'DO_NOT_NOTIFY' } }).showNotify, false);
});

test('未落地操作经成功重读后只可重试原请求，后台发送未知不能恢复成新决定', () => {
  const row = { notification_decision: { state: 'PENDING_DECISION', version: 4 }, delivery_status: 'PENDING_DELIVERY', receipt_status: 'NOT_EXPECTED', expected_attempt_no: 3, can_notify: true, can_decline: true };
  for (const pending of [{ kind: 'notify', attempt: 3 }, { kind: 'decline', version: 4, reason: '原原因' }]) {
    assert.equal(notificationActions(row, pending, false).canRetryOriginal, false);
    assert.equal(notificationActions(row, pending, true).canRetryOriginal, true);
    assert.equal(notificationActions({ ...row, can_notify: false, can_decline: false }, pending, true).canRetryOriginal, false);
    assert.equal(notificationActions({ ...row, delivery_status: 'SUBMITTED', latest_delivery: { blocked_reason: 'DELIVERY_OUTCOME_UNKNOWN' } }, pending, true).canRetryOriginal, false);
    assert.equal(notificationActions({ ...row, notification_decision: { state: 'NOTIFY', version: 5 } }, pending, true).canRetryOriginal, false);
  }
  assert.equal(notificationActions(row, { kind: 'notify', attempt: 2 }, true).canRetryOriginal, false);
  assert.equal(notificationActions(row, { kind: 'decline', version: 3 }, true).canRetryOriginal, false);
  const failed = { ...row, delivery_status: 'FAILED', notification_decision: { state: 'NOTIFY', version: 5 }, can_decline: false };
  assert.equal(notificationActions(failed, { kind: 'notify', attempt: 3 }, true).canRetryOriginal, true);
  assert.equal(notificationActions(failed, { kind: 'decline', version: 5 }, true).canRetryOriginal, false);
  assert.equal(notificationActions({ ...failed, latest_delivery: { blocked_reason: 'DELIVERY_OUTCOME_UNKNOWN' } }, { kind: 'notify', attempt: 3 }, true).canRetryOriginal, false);
});

test('不通知原因去除首尾空白后校验，保留真实依据且最多1000字', () => {
  assert.match(declineReasonError('  '), /填写/);
  assert.equal(declineReasonError('  已核对无需通知上级  '), '');
  assert.match(declineReasonError('原'.repeat(1001)), /1000/);
});

test('并发决定或已受理投递以后台结果解除本地未知，未受理操作仍保留原键', () => {
  const pending = { kind: 'notify', attempt: 1, key: 'original' };
  assert.equal(pendingOperationSettled(pending, { expected_attempt_no: 1, notification_decision: { state: 'PENDING_DECISION', version: 0 } }), false);
  assert.equal(pendingOperationSettled(pending, { expected_attempt_no: 2, notification_decision: { state: 'NOTIFY', version: 1 } }), true);
  assert.equal(pendingOperationSettled(pending, { expected_attempt_no: 1, notification_decision: { state: 'DO_NOT_NOTIFY', version: 1 } }), true);
  assert.equal(pendingOperationSettled({ kind: 'decline', version: 3 }, { notification_decision: { state: 'NOTIFY', version: 4 } }), true);
});

function apiWith(request) {
  const source = readFileSync(new URL('../src/services/handoffApi.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const distribution = readFileSync(new URL('../src/services/distributionStatistics.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, '');
  const pool = async (items, size, fn) => Promise.all(items.map(fn));
  const readCounts = new Function('mapPool', `${distribution}\nreturn readDistributionCounts;`)(pool);
  return new Function('apiRequestTimed', 'buildQuery', 'mapPool', 'readDistributionCounts', 'NOTIFICATION_OPTIONS', 'notificationStatisticsFilters', 'statusQuery',
    `${source}\nreturn {getHandoffStatistics, declineHandoffNotification, notifyHandoff, createHandoff};`)(request,
    params => `?${new URLSearchParams(params)}`, pool, readCounts, NOTIFICATION_OPTIONS, notificationStatisticsFilters, statusQuery);
}

test('通知分类统计使用相同服务端筛选交集，待决定/不通知不重复计入待发送', async () => {
  const at = Date.now();
  const rows = [
    { notification_decision: 'PENDING_DECISION', delivery_status: 'PENDING_DELIVERY', receipt_status: 'NOT_EXPECTED' },
    { notification_decision: 'DO_NOT_NOTIFY', delivery_status: 'PENDING_DELIVERY', receipt_status: 'NOT_EXPECTED' },
    { notification_decision: null, delivery_status: 'PENDING_DELIVERY', receipt_status: 'NOT_EXPECTED' },
    { notification_decision: 'NOTIFY', delivery_status: 'SUBMITTED', receipt_status: 'PENDING' },
    { notification_decision: null, delivery_status: 'DELIVERED', receipt_status: 'ACKNOWLEDGED' },
    { notification_decision: 'NOTIFY', delivery_status: 'FAILED', receipt_status: 'NOT_EXPECTED' }
  ].map(row => ({ ...row, created_at: at, source_kind: 'UAV_EVENT' }));
  const api = apiWith(async url => {
    const query = Object.fromEntries(new URL(url, 'http://local').searchParams);
    assert.equal(query.source_kind, 'UAV_EVENT');
    assert.equal(query.notification_status, undefined, 'UI的组合状态不能发给API');
    const matches = rows.filter(row => (!query.notification_decision || row.notification_decision === query.notification_decision)
      && (!query.delivery_status || (row.delivery_status === query.delivery_status && !['PENDING_DECISION', 'DO_NOT_NOTIFY'].includes(row.notification_decision)))
      && (!query.receipt_status || row.receipt_status === query.receipt_status)
      && (!query.created_from || row.created_at >= Number(query.created_from)) && (!query.created_to || row.created_at < Number(query.created_to)));
    return { total: matches.length };
  });
  const all = await api.getHandoffStatistics({ source_kind: 'UAV_EVENT' });
  assert.equal(all.total, rows.length);
  assert.equal(all.by_delivery.reduce((sum, row) => sum + row.count, 0), all.total);
  for (const value of ['DO_NOT_NOTIFY', 'PENDING_DECISION', 'FAILED']) {
    const selected = await api.getHandoffStatistics({ source_kind: 'UAV_EVENT', ...statusQuery(value) });
    assert.equal(selected.total, 1);
    assert.deepEqual(selected.by_delivery.filter(row => row.count), [{ code: value, count: 1 }]);
    assert.equal(selected.by_receipt.reduce((sum, row) => sum + row.count, 0), 1);
  }
});

test('发送与不通知各自保留真实请求版本、原因和幂等键，不提交伪造回执', async () => {
  const requests = [];
  const api = apiWith(async (url, options) => { requests.push({ url, ...options }); });
  await api.declineHandoffNotification('event/a', 7, '留存原因', 'decline-key');
  await api.notifyHandoff('event/b', 3, 'notify-key');
  assert.deepEqual(requests.map(row => [row.url, row.method, row.mutation, row.idempotencyKey, row.body]), [
    ['/handoffs/event%2Fa/notification-decision', 'POST', true, 'decline-key', { decision: 'DO_NOT_NOTIFY', expected_version: 7, reason: '留存原因' }],
    ['/handoffs/event%2Fb/notifications', 'POST', true, 'notify-key', { expected_attempt_no: 3 }]
  ]);
});


test('创建处罚交接显式携带区域风险，旧请求兼容且不把risk_case_id塞进旧body', async () => {
  const calls = [];
  const api = apiWith(async (url, options) => { calls.push({ url, options }); return {}; });
  const body = { source_kind: 'UAV_EVENT', source_id: 'observed-event', handoff_type: 'UAV_PUNISHMENT', recipient_id: 'recipient', expected_version: 8 };
  await api.createHandoff({ ...body, risk_case_id: 'region-risk-a' }, 'same-key-a');
  await api.createHandoff({ ...body, risk_case_id: 'region-risk-b' }, 'same-key-b');
  await api.createHandoff(body, 'legacy-key');
  assert.equal(calls[0].url, '/handoffs?risk_case_id=region-risk-a');
  assert.equal(calls[1].url, '/handoffs?risk_case_id=region-risk-b');
  assert.equal(calls[2].url, '/handoffs');
  for (const call of calls) { assert.deepEqual(call.options.body, body); assert.equal(call.options.mutation, true); }
  assert.equal(calls[0].options.idempotencyKey, 'same-key-a');
});
