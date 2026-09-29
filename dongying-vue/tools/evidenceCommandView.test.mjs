import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandView } from '../src/components/evidence/evidenceCommandView.js';

const feedback = (code = 200, event = 'EndTracking') => ({ event, metadata: { codeStatus: code } });
const command = (extra = {}) => ({ command_type: 'EO_END_TRACK', reason: 'OPERATOR_END_TRACK', status: 'SUCCEEDED', receipts: [], ...extra });

test('旧光电结果有成功报文但没有独立回执时，保留反馈事实并要求核对', () => {
  const input = command({ result_detail: JSON.stringify(feedback()) });
  const original = JSON.stringify(input);
  const view = buildCommandView(input);
  assert.equal(view.reason, '操作员手动结束跟踪');
  assert.equal(view.action, '停止摄像机对目标的自动跟踪');
  assert.equal(view.status, '平台记录完成，结果待核对');
  assert.match(view.explanation, /已保存.*成功反馈/);
  assert.match(view.explanation, /独立.*回执/);
  assert.equal(view.receipts.length, 0);
  assert.equal(JSON.stringify(input), original);
});

test('光电独立成功回执与指令类型匹配时才展示设备确认完成', () => {
  const view = buildCommandView(command({ receipts: [{ receipt_kind: 'PROTOCOL_C', payload: feedback(), device_result_code: '200' }] }));
  assert.equal(view.status, '设备反馈执行完成');
  assert.equal(view.receipts[0].text, '设备反馈：已结束光电跟踪');
  assert.equal(view.tone, 'success');
});

test('仅有接收回执、未知回执或不匹配的光电事件不当成执行成功', () => {
  for (const receipt of [{ receipt_kind: 'ACK' }, { receipt_kind: 'NEW_KIND', device_result_code: '200' },
    { receipt_kind: 'PROTOCOL_C', payload: feedback(200, 'CameraStatus') },
    { receipt_kind: 'PROTOCOL_C', payload: feedback(null) }]) {
    const view = buildCommandView(command({ receipts: [receipt] }));
    assert.equal(view.status, '平台记录完成，结果待核对');
    assert.notEqual(view.tone, 'success');
  }
});

test('失败与成功反馈冲突时不展示绿色成功，也不按数组顺序挑结果', () => {
  const receipts = [200, 500].map(code => ({ receipt_kind: 'PROTOCOL_C', payload: feedback(code) }));
  for (const rows of [receipts, [...receipts].reverse()]) {
    const view = buildCommandView(command({ receipts: rows }));
    assert.equal(view.status, '记录不一致，结果待核对');
    assert.equal(view.tone, 'warning');
  }
});

test('平台失败不能仅凭一条设备成功回执被改写成成功', () => {
  const view = buildCommandView(command({ status: 'FAILED', receipts: [{ receipt_kind: 'SUCCEEDED' }] }));
  assert.equal(view.status, '记录不一致，结果待核对');
});

test('等待、受理、失败、超时和取消保持不同含义', () => {
  const expected = { QUEUED: '等待下发', SENT: '已下发，等待设备反馈', ACCEPTED: '设备已接收，等待执行结果',
    FAILED: '指令处理失败', TIMED_OUT: '设备反馈超时，结果待确认', CANCELLED: '指令已取消' };
  for (const [status, label] of Object.entries(expected)) assert.equal(buildCommandView(command({ status })).status, label);
  assert.match(buildCommandView(command({ status: 'TIMED_OUT' })).explanation, /不代表设备未执行/);
});

test('损坏 JSON、未知代码和未知指令不会泄露为主说明或被推定成功', () => {
  for (const result_detail of ['{broken', JSON.stringify({ code: 200 }), 'null']) {
    assert.equal(buildCommandView(command({ result_detail })).status, '平台记录完成，结果待核对');
  }
  const view = buildCommandView(command({ command_type: 'NEW_ACTION', reason: 'UNKNOWN_REASON' }));
  assert.doesNotMatch(view.action + view.reason + view.explanation, /NEW_ACTION|UNKNOWN_REASON/);
  assert.equal(buildCommandView(command({ reason: '值班员交接，停止跟踪' })).reason, '值班员交接，停止跟踪');
});
