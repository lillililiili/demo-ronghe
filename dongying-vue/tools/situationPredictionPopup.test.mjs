import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toAlarms } from '../src/services/situationData.js';
import { isPredictionAlarm, predictionVerificationState } from '../src/services/predictionView.js';
import { predictionAlarmStatusHtml, predictionDetailsHtml } from '../src/ui/predictionDetails.js';
const source = readFileSync(new URL('../src/pages/SituationPage.vue', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function body(name) {
 const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
 return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, source.indexOf('\n}\n', start) + 3);
}
const now = Date.now();
function rawAlarm(id, state = 'ACTIVE') {
 return { alarm_id: `alarm-${id}`, event_id: `event-${id}`, alarm_no: `AL-${id}`, target_id: `target-${id}`, target_no: `UAV-${id}`,
  alarm_type: 'PREDICTED_AIRSPACE_ENTRY', origin_kind: 'PREDICTED_AIRSPACE_ENTRY', state: 'PENDING_VERIFICATION',
  prediction: { prediction_id: `prediction-${id}`, status: 'READY', based_on_observed_at: now - 500, valid_until: now + 5000,
   warning: { event_id: `event-${id}`, state, airspace_name: '当前禁飞区', entry_at: now + 18000 } },
  prediction_snapshot: { warning: { event_id: `event-${id}`, state: 'ACTIVE', airspace_name: `首次<${id}>禁飞区` } } };
}
function render(alarm, current = true) {
 const deps = { targetAlarm: () => alarm, advisorySummaries: { value: {} }, autoSmsView: () => null, autoVoiceView: () => null,
  isPredictionAlarm, predictionAlarmStatusHtml, targetNowStatus: () => { throw new Error('预测不应进入普通实测状态'); },
  alarmReasonView: () => { throw new Error('预测不应套用普通违规原因'); }, devices: { value: [] }, ruleReasonText: code => code,
  displayNumberReferences: () => '', uavProcessStatus: () => '待核实', targetIconHtml: () => '', displayTargetNo: value => value,
  esc: value => String(value ?? ''), U: { icon: () => '' }, targetIsCurrent: () => current, nowTick: { value: now },
  formatMetric: () => '100', formatClock: () => '12:00', reportAge: () => '刚刚', clockLagText: () => '',
  pilotLocationText: () => '没有遥控器位置', pilotDistanceNote: () => '', showTargetVideo: { value: false }, renderTargetActions: () => '' };
 const target = { id: alarm.targetId, targetId: alarm.targetInternalId, objectTypeCode: 'UAV', legalitySummary: { legal_status: 'LEGAL' } };
 return new Function(...Object.keys(deps), `${body('renderTargetTip')}\nreturn renderTargetTip;`)(...Object.values(deps))(target);
}
test('预测告警字段穿过融合转换，目标弹窗区分预测与实测合法，状态/冻结原因可读', () => {
 for (const id of ['north', 'south']) for (const state of ['ACTIVE', 'UNKNOWN', 'WITHDRAWN', 'ENTERED']) {
  const raw = rawAlarm(id, state), alarm = toAlarms([raw])[0];
  assert.equal(alarm.prediction.prediction_id, raw.prediction.prediction_id);
  assert.equal(alarm.prediction_snapshot.warning.airspace_name, raw.prediction_snapshot.warning.airspace_name);
  assert.equal(alarm.type, '预测入区预警');
  const html = render(alarm);
  assert.match(html, /预测入区风险/); assert.match(html, /首次&lt;/);
  assert.doesNotMatch(html, /已不再违规|现在的违规原因|出告警时：未记录|PREDICTED_AIRSPACE_ENTRY/);
  if (state === 'ACTIVE') assert.match(html, /当前实测尚未进入预警空域/);
  if (state === 'UNKNOWN') assert.match(html, /预测暂不可判断/);
  if (state === 'WITHDRAWN') assert.match(html, /预测已撤销/);
  if (state === 'ENTERED') assert.match(html, /已进入（实测）/);
  assert.equal(predictionVerificationState(null, alarm, now).terminal, ['WITHDRAWN', 'ENTERED'].includes(state));
 }
 const confirmed = toAlarms([{ ...rawAlarm('confirmed'), state: 'CONFIRMED' }])[0];
 assert.match(render(confirmed), /预测风险已核实/);
 assert.match(render(confirmed, false), /不能当作已进入或已撤离/);
});
test('只将当前目标同事件预测关联到弹窗，首次冻结快照单独保留', () => {
 const alarm = toAlarms([rawAlarm('selected')])[0];
 const target = { id: alarm.targetId, targetId: alarm.targetInternalId, relatedAlarms: [alarm] };
 const latest = { ...alarm.prediction, target_id: target.targetId, prediction_id: 'latest-snapshot', warnings: [
  { event_id: 'other-event', state: 'ACTIVE', airspace_name: '其他区域' },
  { ...alarm.prediction.warning, state: 'UNKNOWN' }
 ] };
 const selection = { value: { kind: 'target', id: target.id } }, predictions = { value: [latest] };
 const selectedPredictionAlarmDetail = { value: { alarm_id: alarm.alarmId, prediction_snapshot: alarm.prediction_snapshot } };
 const predictionUnavailable = { value: false };
 const choose = new Function('selection', 'predictions', 'selectedPredictionAlarmDetail', 'predictionUnavailable', 'isPredictionAlarm',
  `${body('targetAlarm')}\nreturn targetAlarm;`)(selection, predictions, selectedPredictionAlarmDetail, predictionUnavailable, isPredictionAlarm);
 const chosen = choose(target);
 assert.equal(chosen.prediction.prediction_id, 'latest-snapshot'); assert.equal(chosen.prediction.warning.event_id, alarm.eventId);
 assert.equal(chosen.prediction.warnings.length, 1); assert.equal(chosen.prediction_snapshot, alarm.prediction_snapshot);
 predictionUnavailable.value = true; assert.equal(choose(target).prediction.status, 'UNKNOWN');
});
test('地图核实先读完整告警和事件，把当前预测ID交共用核实弹窗', async () => {
 const raw = rawAlarm('verify'), mapped = toAlarms([raw])[0], event = { event_id: raw.event_id, version: 8, allowed_actions: ['VERIFY'] };
 let opened;
 const fn = new Function('targetAlarm', 'toast', 'getUavEvent', 'getAlarm', 'openUavVerification', 'source',
  `${body('openTargetVerification')}\nreturn openTargetVerification;`)
  (() => mapped, () => {}, async id => { assert.equal(id, raw.event_id); return event; },
    async id => { assert.equal(id, raw.alarm_id); return raw; }, input => { opened = input; }, { refresh: async () => {} });
 await fn({ targetId: raw.target_id });
 assert.equal(opened.event, event); assert.equal(opened.alarm.prediction.prediction_id, raw.prediction.prediction_id);
 assert.equal(opened.alarm.origin_kind, 'PREDICTED_AIRSPACE_ENTRY');
});
test('UNKNOWN最后依据与首次空域冻结清楚标识，不能恢复当前预测倒计时', () => {
 for (const basis of ['FIRST_FROZEN', 'LAST_KNOWN']) {
  const raw = rawAlarm('lost', 'UNKNOWN').prediction;
  Object.assign(raw, { status: 'UNKNOWN', evidence_status: 'LAST_KNOWN', reason_codes: ['STALE_OR_UNTRUSTED_MEASUREMENT'], points: [] });
  raw.warning.airspace_basis = basis;
  const html = predictionDetailsHtml(raw, { now });
  assert.match(html, /保留的历史依据仅供追溯，不能作为当前有效预测/);
  assert.match(html, basis === 'FIRST_FROZEN' ? /缺失空域资料来自首次冻结依据/ : /空域名称与版本为最后有效预测依据/);
  assert.match(html, /实测已过期或时间不可信/); assert.doesNotMatch(html, /约 \d+ 秒后/);
 }
});
