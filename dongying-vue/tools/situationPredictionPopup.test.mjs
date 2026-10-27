import * as riskHelpers from '../src/services/riskCaseView.js';
import { predictionWarningRows } from '../src/services/predictionView.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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
 const deps = { ...riskHelpers, targetAlarm: () => alarm, advisorySummaries: { value: {} }, autoSmsView: () => null, autoVoiceView: () => null,
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
  { ...alarm.prediction.warning, state: 'ACTIVE' }
 ] };
 const selection = { value: { kind: 'target', id: target.id } }, predictions = { value: [latest] };
 const selectedPredictionAlarmDetail = { value: { alarm_id: alarm.alarmId, prediction_snapshot: alarm.prediction_snapshot } };
 const predictionUnavailable = { value: false };
 const predictionRows = { get value() { return predictionWarningRows(predictions.value, now, predictionUnavailable.value); } };
 const choose = new Function(...Object.keys(riskHelpers), 'predictionRows', 'selection', 'predictions', 'selectedPredictionAlarmDetail', 'predictionUnavailable', 'isPredictionAlarm',
  `const selectedRiskContext = { value: null }, selectedRiskSelectionKey = () => '';\n${body('targetAlarm')}\nreturn targetAlarm;`)(...Object.values(riskHelpers), predictionRows, selection, predictions, selectedPredictionAlarmDetail, predictionUnavailable, isPredictionAlarm);
 const chosen = choose(target);
 assert.equal(chosen.prediction.prediction_id, 'latest-snapshot'); assert.equal(chosen.prediction.warning.event_id, alarm.eventId);
 assert.equal(chosen.prediction.warnings.length, 1); assert.equal(chosen.prediction_snapshot, alarm.prediction_snapshot);
 predictionUnavailable.value = true; assert.equal(choose(target), null, '读取失败的旧预测不进入目标卡');
});
test('地图核实先读完整告警和事件，把当前预测ID交共用核实弹窗', async () => {
 const raw = rawAlarm('verify'), mapped = toAlarms([raw])[0], event = { event_id: raw.event_id, version: 8, allowed_actions: ['VERIFY'] };
 let opened;
 const fn = new Function(...Object.keys(riskHelpers), 'targetAlarm', 'toast', 'getUavEvent', 'getAlarm', 'openUavVerification', 'source', 'openModal', 'h',
  `let verificationOpening = null;
${body('openTargetVerification')}\nreturn openTargetVerification;`)
  (...Object.values(riskHelpers), () => mapped, () => {}, async id => { assert.equal(id, raw.event_id); return event; },
    async id => { assert.equal(id, raw.alarm_id); return raw; }, input => { opened = input; return true; }, { refresh: async () => {} }, () => ({ isCurrent: () => true, close() {} }), () => null);
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

test('统一风险的旧入区依据不引导到另一条告警', () => {
  for (const id of ['unified-north', 'unified-south']) {
    const alarm = { ...rawAlarm(id, 'ENTERED'), risk_case: { risk_case_id: `case-${id}`, stage: 'UNKNOWN' } };
    const html = predictionAlarmStatusHtml(alarm, { now });
    assert.match(html, /同一风险记录中办理/);
    assert.doesNotMatch(html, /请查看实际入区告警/);
    alarm.risk_case.stage = 'PREDICTED';
    const gate = predictionVerificationState(null, alarm, now);
    assert.equal(gate.blocked, true);
    assert.match(gate.message, /刷新本条风险/);
    assert.doesNotMatch(gate.message, /请查看实际入区告警/);
  }
});


function verificationEntry(readCase) {
 const forms = [], notices = [], submissions = [], caseReads = [], loading = [], selectedUavAlarm = { value: null };
 let activeModal = null;
 const openModal = options => { const handle = { options, isCurrent: () => activeModal === handle, close: () => { if (activeModal === handle) activeModal = null; } }; activeModal = handle; loading.push(handle); return handle; };
 const context = vm.createContext({ ...riskHelpers, predictionVerificationState, serverNow: () => now,
  openFormModal: form => { activeModal = null; forms.push(form); },
  openModal: options => { activeModal = null; const result = options.render(); forms.push(result.props.form); return { isCurrent:()=>true, close(){} }; },
  h:(component,props)=>({component,props}), RiskVerificationForm:{}, shallowRef:value=>({value}), readSessionToken:()=> 'session',
  setTimeout,clearTimeout,getUavRiskCase:readCase, closeModal() {}, toast: message => notices.push(message),
  crypto: globalThis.crypto, isUncertainOutcome: () => false, ALARM_TYPE_LABEL: {},
  labelOf: () => '', readableNo: value => value || '', displayAlarmNo: value => value, displayTargetNo: value => value,
  verifyUavRiskCase: async (id, body) => { submissions.push({ id, body }); return { state: 'CONFIRMED' }; },
  verifyUavEvent: () => { throw new Error('风险核实不能退回原始事件提交'); } });
 vm.runInContext(readFileSync(new URL('../src/services/uavRiskVerificationSession.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, ''), context);
 vm.runInContext(readFileSync(new URL('../src/ui/uavVerificationModal.js', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, ''), context);
 const deps = { ...riskHelpers, selectedUavAlarm, openModal, h: (...args) => args, targetAlarm: () => { throw new Error('不能从当前筛选列表重新选择风险'); },
  toast: message => notices.push(message), getUavRiskCase: async id => { caseReads.push(id); return readCase(id); },
  getUavEvent: () => { throw new Error('已有风险时不能读取原始事件代替'); },
  getAlarm: () => { throw new Error('已有风险时不能读取原始告警代替'); },
  openUavVerification: context.openUavVerification, source: { refresh: async () => {} } };
 const click = new Function(...Object.keys(deps), `let verificationOpening = null;\n${body('verifySelectedAlarm')}\n${body('openTargetVerification')}\nreturn verifySelectedAlarm;`)(...Object.values(deps));
 return { click, forms, notices, submissions, caseReads, selectedUavAlarm, loading };
}
function caseDetail(id, stage = 'PREDICTED', verification_status = 'PENDING_VERIFICATION') {
 const raw = rawAlarm(id, stage === 'ENTERED' ? 'ENTERED' : 'ACTIVE');
 const risk_case = { risk_case_id: `case-${id}`, version: 12, stage, verification_status,
  allowed_actions: verification_status === 'CONFIRMED' ? [] : ['VERIFY'] };
 return { risk_case, alarm: raw, event: { event_id: stage === 'ENTERED' ? `actual-${id}` : raw.event_id,
  version: 9, state: 'PENDING_VERIFICATION', allowed_actions: [], origin_kind: 'PREDICTED_AIRSPACE_ENTRY',
  prediction: raw.prediction, verification_basis: { confirmable: true, prediction_id: raw.prediction.prediction_id } } };
}

test('核实点击保留同区域风险，列表移除或选中别区不会丢失异步打开上下文', async () => {
 for (const id of ['retained-east', 'retained-west']) {
  const latest = caseDetail(id), clicked = { ...toAlarms([rawAlarm(id)])[0],
   risk_case: { ...latest.risk_case, version: 4 }, prediction: { prediction_id: 'old-list-snapshot' } };
  let resolve, readCount = 0;
  const entry = verificationEntry(() => readCount++ ? latest : new Promise(done => { resolve = done; }));
  // 点击时当前筛选结果已经移除；明确点击上下文仍能定位，无需目标继续显示在地图。
  entry.selectedUavAlarm.value = null;
  const opening = entry.click(clicked);
  assert.deepEqual(entry.caseReads, [latest.risk_case.risk_case_id]);
  entry.selectedUavAlarm.value = { risk_case: { risk_case_id: 'different-region' } };
  resolve(latest);
  assert.equal(await opening, true);
  assert.equal(entry.forms.length, 1); assert.equal(entry.notices.length, 0);
  await entry.forms[0].onSubmit({ conclusion: 'CONFIRMED' });
  assert.equal(entry.submissions[0].id, latest.risk_case.risk_case_id);
  assert.equal(entry.submissions[0].body.prediction_id, latest.event.verification_basis.prediction_id);
  assert.equal(entry.submissions[0].body.expected_case_version, 12);
  assert.equal(entry.submissions[0].body.expected_version, 9);
 }
});

test('点击后转实测按最新资格打开，已自动核实不重复，未知或过期不允许属实', async () => {
 for (const stage of ['ENTERED', 'AUTO', 'UNKNOWN', 'EXPIRED']) {
  const id = `latest-${stage}`, latest = caseDetail(id, stage === 'AUTO' ? 'ENTERED' : stage === 'EXPIRED' ? 'PREDICTED' : stage,
   stage === 'AUTO' ? 'CONFIRMED' : 'PENDING_VERIFICATION');
  if (stage === 'EXPIRED') latest.event.prediction = { ...latest.event.prediction, valid_until: now - 1 };
  const clicked = { ...toAlarms([rawAlarm(id)])[0], risk_case: { ...latest.risk_case, stage: 'PREDICTED',
   verification_status: 'PENDING_VERIFICATION', allowed_actions: ['VERIFY'] } };
  const entry = verificationEntry(async () => latest);
  const opened = await entry.click(clicked);
  assert.deepEqual(entry.caseReads, [latest.risk_case.risk_case_id]);
  if (stage === 'AUTO') {
   assert.equal(opened, false); assert.equal(entry.forms.length, 0); assert.equal(entry.submissions.length, 0);
   assert.equal(entry.notices.length, 1);
  } else {
   assert.equal(opened, true); assert.equal(entry.forms.length, 1);
   const form = entry.forms[0];
   if (stage === 'ENTERED') {
    assert.equal(form.fields[0].options[0].disabled, false);
    assert.match(form.introHtml, /<dd>待核实<\/dd>/);
    await form.onSubmit({ conclusion: 'CONFIRMED' });
    assert.equal(entry.submissions[0].body.prediction_id, undefined, '已入区不再提交旧预测快照');
   } else {
    assert.equal(form.fields[0].options[0].disabled, true);
    await assert.rejects(form.onSubmit({ conclusion: 'CONFIRMED' }), /依据不足|过期|不可判断/);
    assert.equal(entry.submissions.length, 0);
   }
  }
 }
});

test('核实详情身份不符时明确拒绝，不借另一禁飞区资格打开', async () => {
 const latest = caseDetail('another-region'), clicked = { eventId: 'pending-event', risk_case: { risk_case_id: 'selected-region' } };
 const entry = verificationEntry(async () => latest);
 await entry.click(clicked);
 assert.deepEqual(entry.caseReads, ['selected-region']);
 assert.equal(entry.forms.length, 0); assert.match(entry.notices[0], /风险详情与所选记录不一致/);
});


test('核实点击立即显示读取反馈，同风险重复点击不重复读取，最新依据到达再打开表单', async () => {
 const latest = caseDetail('immediate-loading'); let resolve;
 const entry = verificationEntry(() => new Promise(done => resolve = done));
 const clicked = { eventId: latest.event.event_id, risk_case: latest.risk_case };
 const pending = entry.click(clicked);
 assert.equal(entry.loading.length, 1); assert.equal(entry.loading[0].isCurrent(), true);
 assert.match(entry.loading[0].options.title, /正在读取核实依据/);
 const rendered = entry.loading[0].options.render();
 assert.equal(rendered[1].role, 'status'); assert.equal(rendered[1]['aria-live'], 'polite');
 assert.equal(entry.forms.length, 0); assert.equal(entry.submissions.length, 0);
 await entry.click(clicked); assert.equal(entry.caseReads.length, 1); assert.equal(entry.loading.length, 1);
 resolve(latest); assert.equal(await pending, true); assert.equal(entry.forms.length, 1);
 assert.equal(entry.loading[0].isCurrent(), false);
});

test('关闭读取反馈或开始别区核实后迟到响应不打开旧表单', async () => {
 for (const change of ['close', 'another-risk']) {
  const first = caseDetail('cancel-first'), second = caseDetail('cancel-second'), waits = new Map();
  const entry = verificationEntry(id => new Promise(done => waits.set(id, done)));
  const pending = entry.click({ eventId: first.event.event_id, risk_case: first.risk_case });
  let next;
  if (change === 'close') entry.loading[0].close();
  else next = entry.click({ eventId: second.event.event_id, risk_case: second.risk_case });
  waits.get(first.risk_case.risk_case_id)(first); assert.equal(await pending, false);
  assert.equal(entry.forms.length, 0); assert.equal(entry.notices.length, 0);
  if (next) { waits.get(second.risk_case.risk_case_id)(second); assert.equal(await next, true); assert.equal(entry.forms.length, 1); }
 }
});

test('核实读取失败关闭加载并显示真实原因，已核实优先说明无需重复而非权限不足', async () => {
 const failed = verificationEntry(async () => { throw new Error('风险阶段更新，请重新读取'); });
 assert.equal(await failed.click({ eventId: 'event-error', risk_case: { risk_case_id: 'case-error' } }), false);
 assert.equal(failed.loading[0].isCurrent(), false); assert.equal(failed.forms.length, 0);
 assert.match(failed.notices[0], /风险阶段更新/);
 const latest = caseDetail('already-confirmed', 'ENTERED', 'CONFIRMED');
 const entry = verificationEntry(async () => latest);
 assert.equal(await entry.click({ eventId: latest.event.event_id, risk_case: latest.risk_case }), false);
 assert.equal(entry.loading[0].isCurrent(), false); assert.equal(entry.forms.length, 0);
 assert.match(entry.notices[0], /本次风险已核实，无需重复核实/);
 assert.doesNotMatch(entry.notices[0], /权限|自动/); assert.equal(entry.submissions.length, 0);
});
