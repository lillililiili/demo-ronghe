import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryView, receiptView } from '../src/pages/punish/handoffStatus.js';

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