import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandView, commandSource } from '../src/components/evidence/evidenceCommandView.js';

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

test('凌云正常回执明确成功与失败，未知结果不推断成功', () => {
  for (const [status, code, tone] of [['SUCCEEDED', 'PROTOCOL_B_OK', 'success'], ['FAILED', 'PROTOCOL_B_FAILED', 'danger']]) {
    const view = buildCommandView({command_type:'LINGYUN_CONTROL', status, receipts:[{receipt_kind:'PROTOCOL_B', device_result_code:code}]});
    assert.equal(view.tone, tone);
    assert.equal(view.status, status === 'SUCCEEDED' ? '设备已返回成功回执' : '设备反馈执行失败');
    if (status === 'SUCCEEDED') assert.match(view.explanation, /不据此认定整次处置结束/);
  }
  assert.notEqual(buildCommandView({status:'SUCCEEDED', receipts:[{receipt_kind:'PROTOCOL_B', device_result_code:'UNKNOWN'}]}).tone, 'success');
});

test('迟到成功和失败留在原任务，不覆盖超时或取消结论', () => {
  for (const status of ['TIMED_OUT','CANCELLED']) for (const code of ['PROTOCOL_B_OK','PROTOCOL_B_FAILED','UNKNOWN']) {
    const input = {command_type:'LINGYUN_CONTROL',status,receipts:[{receipt_kind:'PROTOCOL_B_LATE',device_result_code:code}]};
    const before = JSON.stringify(input), view = buildCommandView(input);
    assert.match(view.status, status === 'TIMED_OUT' ? /超时.*迟到/ : /取消.*迟到/);
    assert.equal(view.tone,'warning');
    assert.match(view.explanation,/不自动重发或续链/);
    assert.match(view.receipts[0].text,/迟到设备反馈/);
    assert.equal(view.receipts[0].terminal,false);
    if(code === 'UNKNOWN') assert.equal(view.receipts[0].outcome,null);
    assert.equal(JSON.stringify(input),before);
  }
});

import { nextStep, resultText, executionEvidenceHref } from '../src/pages/alarms/authorizationQueueView.js';
test('普通授权超时说明实际结果待核查，不能当作设备未执行', () => {
  for (const code of ['ADAPTER_TIMEOUT','DEVICE_TIMED_OUT','TIMED_OUT']) {
    const row={status:'FAILED',channel:'LINGYUN_B',result_code:code};
    assert.match(nextStep(row,'u'),/实际执行结果待核查/);
    assert.match(resultText(row),/不代表设备未执行/);
    assert.match(resultText(row),/避免重复下发/);
  }
  assert.equal(nextStep({status:'FAILED',channel:'LINGYUN_B',result_code:'PROTOCOL_B_FAILED'},'u'),'执行失败，请查看原因');
});
test('授权设备反馈链接精确绑定原命令和授权，不猜测缺失关联', () => {
  const row={channel:'LINGYUN_B',execution_command_id:'cmd /1',authorization_id:'auth /1'};
  const href=executionEvidenceHref(row), params=new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('command'),'cmd /1');
  assert.equal(params.get('subjectKind'),'AUTHORIZATION');
  assert.equal(params.get('subjectId'),'auth /1');
  for(const missing of [{...row,execution_command_id:null},{...row,authorization_id:null},{...row,channel:'MANUAL'}]) assert.equal(executionEvidenceHref(missing),'');
});

test('凌云指令证据按明确来源展示成功回执，不修改历史或推定处置完成', () => {
  for (const [source_mode, simulated, status] of [
    ['live', false, '设备已返回成功回执'], ['live', true, '模拟设备已返回成功回执'],
    ['mock', false, '模拟设备已返回成功回执'], ['replay', true, '回放记录：指令返回成功'],
  ]) {
    const input = { command_id: crypto.randomUUID(), command_type: 'LINGYUN_CONTROL', status: 'SUCCEEDED', source_mode, simulated,
      receipts: [{ receipt_id: crypto.randomUUID(), occurred_at: Date.now(), receipt_kind: 'PROTOCOL_B', device_result_code: 'PROTOCOL_B_OK' }] };
    const before = JSON.stringify(input), view = buildCommandView(input);
    assert.equal(view.status, status);
    assert.match(view.explanation, /设备已经停止或现场效果已确认/);
    assert.equal(JSON.stringify(input), before);
  }
});

test('凌云缺失、未知、仅受理或迟到回执不显示已确认成功；其他指令不套用凌云回执', () => {
  for (const receipts of [[], [{ receipt_kind: 'ACK' }], [{ receipt_kind: 'COMPLETED' }],
    [{ receipt_kind: 'SUCCEEDED' }], [{ receipt_kind: 'PROTOCOL_B', device_result_code: 'UNKNOWN' }],
    [{ receipt_kind: 'PROTOCOL_B_LATE', device_result_code: 'PROTOCOL_B_OK' }]]) {
    const view = buildCommandView({ command_type: 'LINGYUN_CONTROL', status: 'SUCCEEDED', receipts });
    assert.equal(view.status, '平台记录完成，结果待核对');
    assert.equal(view.tone, 'warning');
  }
  const receipt = { receipt_kind: 'PROTOCOL_B', device_result_code: 'PROTOCOL_B_OK' };
  assert.equal(buildCommandView(command({ receipts: [receipt] })).tone, 'warning');
  const rows = [receipt, { receipt_kind: 'PROTOCOL_B', device_result_code: 'PROTOCOL_B_FAILED' }];
  for (const receipts of [rows, [...rows].reverse()]) {
    assert.equal(buildCommandView({ command_type: 'LINGYUN_CONTROL', status: 'SUCCEEDED', receipts }).status, '记录不一致，结果待核对');
  }
});

test('四通道明确回码仅确认设置成功，模拟、真实及回放来源保持区分', () => {
  for (const [mode, simulated, label, result] of [
    ['live', true, '模拟来源', '模拟设备已确认通道设置成功'],
    ['live', false, '现场来源', '设备已确认通道设置成功'],
    ['mock', false, '模拟来源', '模拟设备已确认通道设置成功'],
    ['replay', true, '回放来源', '回放记录：通道设置成功'],
  ]) {
    const input = { command_id: crypto.randomUUID(), command_type: 'COUNTERMEASURE_4CH', status: 'SUCCEEDED', simulated,
      receipts: [{ receipt_id: crypto.randomUUID(), receipt_kind: 'PROTOCOL_4CH', device_result_code: 'COUNTERMEASURE_SET_OK',
        occurred_at: Date.now(), payload: { simulated } }] };
    const before = JSON.stringify(input), view = buildCommandView(input, mode);
    assert.equal(commandSource(input, mode).label, label);
    assert.equal(view.status, result);
    assert.equal(view.tone, 'success');
    assert.match(view.receipts[0].text, /通道设置成功/);
    assert.match(view.explanation, /不代表射频已发射或目标已被反制/);
    assert.equal(JSON.stringify(input), before);
  }
});

test('四通道未知、缺失、仅受理及其他协议反馈均不推断通道设置成功', () => {
  for (const receipts of [[], [{ receipt_kind: 'ACK' }], [{ receipt_kind: 'COMPLETED' }],
    [{ receipt_kind: 'PROTOCOL_4CH', device_result_code: 'UNKNOWN' }],
    [{ receipt_kind: 'PROTOCOL_B', device_result_code: 'COUNTERMEASURE_SET_OK' }]]) {
    const view = buildCommandView({ command_type: 'COUNTERMEASURE_4CH', status: 'SUCCEEDED', receipts,
      result_detail: '继电器设置成功，不能用这段文字补造回执' });
    assert.equal(view.status, '平台记录完成，通道设置待核对');
    assert.equal(view.tone, 'warning');
  }
  assert.equal(buildCommandView(command({ receipts: [{ receipt_kind: 'PROTOCOL_4CH', device_result_code: 'COUNTERMEASURE_SET_OK' }] })).tone, 'warning');
});

test('四通道反馈不能覆盖失败、超时或取消记录，冲突不按顺序选成功', () => {
  const receipt = { receipt_kind: 'PROTOCOL_4CH', device_result_code: 'COUNTERMEASURE_SET_OK' };
  for (const status of ['FAILED', 'TIMED_OUT', 'CANCELLED', 'SENT']) {
    const input = { command_type: 'COUNTERMEASURE_4CH', status, receipts: [receipt] };
    const before = JSON.stringify(input), view = buildCommandView(input);
    assert.notEqual(view.tone, 'success');
    assert.equal(JSON.stringify(input), before);
  }
  const rows = [receipt, { receipt_kind: 'FAILED' }];
  for (const receipts of [rows, [...rows].reverse()]) {
    assert.equal(buildCommandView({ command_type: 'COUNTERMEASURE_4CH', status: 'SUCCEEDED', receipts }).status, '记录不一致，结果待核对');
  }
});

test('指令或原始回执的明确模拟标记不能被 live 通道覆盖，不从名称或文字猜来源', () => {
  for (const payload of [{ simulated: true }, JSON.stringify({ simulated: true })]) {
    assert.equal(commandSource({ simulated: false, receipts: [{ payload }] }, 'live').label, '模拟来源');
  }
  assert.equal(commandSource({ simulated: true }, 'live').label, '模拟来源');
  assert.equal(commandSource({ simulated: true }, 'replay').label, '回放来源');
  for (const payload of ['{broken', { simulated: 'true' }, { detail: '模拟器' }]) {
    assert.equal(commandSource({ device_name: '模拟器', receipts: [{ payload }] }, 'live').label, '现场来源');
  }
  assert.equal(commandSource({}).label, '来源未记录');
});
