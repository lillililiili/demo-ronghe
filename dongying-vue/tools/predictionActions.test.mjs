import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { predictionVerificationState, isPredictionAlarm } from '../src/services/predictionView.js';
const source = readFileSync(new URL('../src/pages/AlarmsPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
const now = Date.now();
function alarm(state, index = 1) {
  return { origin_kind: 'PREDICTED_AIRSPACE_ENTRY', event_id: `event-${index}`, prediction: { prediction_id: `snapshot-${index}`,
    status: 'READY', based_on_observed_at: now - 500, valid_until: now + 60000, warning: { state } } };
}
function render(a, event = {}) {
  const cur = { alarm: a, event: { state: 'PENDING_VERIFICATION', allowed_actions: ['VERIFY'], ...event } };
  return new Function('cur', 'predictionVerificationState', 'serverNow', 'esc', 'pendingNotifyNote',
    `${body('disposalActions')}\n${body('detailActionsHtml')}\nreturn detailActionsHtml();`)
    (cur, predictionVerificationState, () => now, value => String(value), () => '核实属实后自动发送飞手短信。');
}
test('告警详情终态不再提供核实预测风险或核实后短信提示，历史核实状态保持', () => {
  for (const state of ['WITHDRAWN', 'ENTERED']) for (const eventState of ['PENDING_VERIFICATION', 'CONFIRMED']) {
    const a = alarm(state, `${state}-${eventState}`), event = { state: eventState };
    const html = render(a, event);
    assert.doesNotMatch(html, /data-al="verify"|核实预测风险|核实属实后自动发送|事件事实尚待核实/);
    assert.match(html, state === 'WITHDRAWN' ? /预测预警已撤销/ : /请查看实际入区告警/);
    assert.equal(event.state, eventState);
  }
});
test('UNKNOWN、过期或后端依据不足只提供误报入口，有效预测说明通知条件', () => {
  const expired = alarm('ACTIVE', 'expired'); expired.prediction.valid_until = now;
  for (const [a, event] of [[alarm('UNKNOWN'), {}], [expired, {}], [alarm('ACTIVE', 'unconfirmed'), { verification_basis: { confirmable: false } }]]) {
    const html = render(a, event);
    assert.match(html, /核实为误报/); assert.match(html, /不能提交预测风险属实/);
    assert.doesNotMatch(html, /核实预测风险|核实属实后自动发送/);
  }
  const valid = render(alarm('ACTIVE'));
  assert.match(valid, /核实预测风险/); assert.match(valid, /当前预测依据、飞手信息和通道校验/);
  assert.doesNotMatch(valid, /核实属实后自动发送/);
});
test('实际入区和其他普通告警维持原事件核实流程', () => {
  for (const origin_kind of ['OBSERVED_AIRSPACE_ENTRY', 'ENGINE']) {
    const a = { ...alarm('ENTERED'), origin_kind };
    assert.equal(predictionVerificationState({}, a, now), null);
    const html = render(a);
    assert.match(html, /核实事件事实/); assert.match(html, /核实属实后自动发送飞手短信/);
  }
});


test('预测公共原因优先首次冻结空域，不混入目标最新实测违规；普通原因保持原口径', () => {
  const cur = { escalationsTotal: 0 };
  const esc = value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const ordinaryView = { tone: 'risk', label: '告警原因（出告警时）', text: '未记录具体触发原因' };
  let ordinaryCalls = 0;
  const reason = new Function('isPredictionAlarm', 'esc', 'cur', 'alarmReasonView', 'ruleReasonText', 'fmt',
    `${body('alarmReasonHtml')}\nreturn alarmReasonHtml;`)
    (isPredictionAlarm, esc, cur, () => { ordinaryCalls++; return ordinaryView; }, code => code, String);
  for (const [id, name] of [['first-event', '<最初禁飞区>'], ['another-event', '北侧禁飞区']]) {
    const a = { ...alarm('WITHDRAWN'), event_id: id, prediction_snapshot: { warning: { event_id: id, airspace_name: name } },
      prediction: { warning: { event_id: id, airspace_name: '后来改名区域' } } };
    const html = reason(a, { legality_summary: { legal_status: 'ILLEGAL', violation_reasons: ['UNRELATED_VIOLATION'] } });
    assert.match(html, /预测预警原因（出预警时）/);
    assert.ok(html.includes(`预计进入${esc(name)}`));
    assert.doesNotMatch(html, /后来改名区域|UNRELATED_VIOLATION|未记录具体触发原因/);
    assert.match(html, /首次预测与空域版本/);
  }
  assert.equal(ordinaryCalls, 0);
  const ordinary = reason({ origin_kind: 'OBSERVED_AIRSPACE_ENTRY' }, null);
  assert.match(ordinary, /告警原因（出告警时）/); assert.match(ordinary, /未记录具体触发原因/);
  assert.equal(ordinaryCalls, 1);
  const missing = reason({ origin_kind: 'PREDICTED_AIRSPACE_ENTRY', event_id: 'absent' }, null);
  assert.match(missing, /预计进入禁飞区（名称未提供）/);
});

test('预测轨迹图说明指向预测依据，普通历史空域的缺失、命中和权限提示不变', () => {
  const cur = { airspacesStatus: 'UNKNOWN' };
  const note = new Function('isPredictionAlarm', 'esc', 'cur', `${body('alarmMapAirspaceNote')}\nreturn alarmMapAirspaceNote;`)
    (isPredictionAlarm, String, cur);
  for (const state of ['ACTIVE', 'UNKNOWN', 'WITHDRAWN', 'ENTERED']) {
    assert.equal(note(alarm(state)), '显示实测轨迹；预测及空域依据见详情');
  }
  assert.equal(note({ origin_kind: 'OBSERVED_AIRSPACE_ENTRY' }), '未保存告警时空域依据');
  cur.airspacesStatus = 'AVAILABLE'; assert.equal(note({}), '告警命中空域 · 历史版本');
  cur.airspacesError = '无历史空域依据查看权限'; assert.equal(note({}), cur.airspacesError);
});
