import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { computed } from 'vue';
import { autoSmsView } from '../src/components/disposal/autoSmsView.js';
import { autoVoiceView } from '../src/components/disposal/autoVoiceView.js';
import { completedHandoffProgress } from '../src/components/disposal/autoHandoffView.js';
import { riskCaseProgress, riskCaseKey, riskCaseAlarm, riskCaseMatches, riskActionContext, riskConfirmed, riskCaseVisible, riskSummaryMatches, riskCaseVerificationLabel, riskCaseVerificationHint, verificationSourceLabel } from '../src/services/riskCaseView.js';
import { uavProcessActions } from '../src/pages/situation/situationFlow.js';
import { predictionVerificationState } from '../src/services/predictionView.js';
import { counterHiddenReason } from '../src/components/disposal/counterNextStep.js';

test('同风险从预测转入区保留稳定键和核实资格，不改写原事件结论', () => {
  for (const source_mode of ['live', 'replay']) {
    const risk_case_id = randomUUID(), initialAlarm = randomUUID(), observedAlarm = randomUUID();
    const initial = { alarm_id: initialAlarm, event_id: randomUUID(), state: 'CONFIRMED', source_mode,
      risk_case: { risk_case_id, version: 4, stage: 'PREDICTED', verification_status: 'CONFIRMED' } };
    const observed = { alarm_id: observedAlarm, event_id: randomUUID(), state: 'PENDING_VERIFICATION', source_mode,
      risk_case: { ...initial.risk_case, version: 5, stage: 'ENTERED', action_event_id: randomUUID(), related_alarm_ids: [initialAlarm, observedAlarm] } };
    const display = riskCaseAlarm(observed);
    assert.equal(riskCaseKey(initial), riskCaseKey(display));
    assert.equal(display.event_id, observed.risk_case.action_event_id);
    assert.equal(display.source_event_id, observed.event_id);
    assert.equal(display.state, 'PENDING_VERIFICATION');
    assert.equal(riskConfirmed(display), true);
    assert.equal(riskCaseMatches(display, initialAlarm), true);
    assert.deepEqual(uavProcessActions(display), ['counter']);
    assert.equal(predictionVerificationState({ origin_kind: 'PREDICTED_AIRSPACE_ENTRY' }, display, Date.now()), null);
  }
});

test('同事件不同区域和重新发生的风险保持独立版本上下文', () => {
  const event_id = randomUUID();
  const rows = Array.from({ length: 3 }, (_, index) => ({ event_id, alarm_id: randomUUID(),
    risk_case: { risk_case_id: randomUUID(), version: index + 1, stage: 'PREDICTED', verification_status: index ? 'PENDING_VERIFICATION' : 'CONFIRMED' } }));
  assert.equal(new Set(rows.map(riskCaseKey)).size, 3);
  assert.deepEqual(rows.map(riskConfirmed), [true, false, false]);
  rows.forEach(row => assert.deepEqual(riskActionContext(row), { risk_case_id: row.risk_case.risk_case_id, expected_case_version: row.risk_case.version }));
  assert.deepEqual(riskActionContext({ risk_case: { risk_case_id: randomUUID() } }), {}, '缺版本不能借用其他记录');
});

test('未知、已避开和结束退出融合风险，不能恢复反制入口', () => {
  for (const stage of ['UNKNOWN', 'CLEARED', 'ENDED']) {
    const row = { eventState: 'CONFIRMED', risk_case: { risk_case_id: randomUUID(), stage, verification_status: 'CONFIRMED' } };
    assert.equal(riskCaseVisible(row), false); assert.deepEqual(uavProcessActions(row), []);
  }
});

test('短信未送达与电话未完成不覆盖服务端优先反制资格，拒绝条件保持', () => {
  const alarm = { eventState: 'CONFIRMED' }, actions = ['counter'];
  for (const notify_phase of ['AUTO_SMS', 'AUTO_CALL', 'WATCHING']) {
    const summary = { notify_phase, response_order: { counter_priority: true }, counter_launch_visible: true };
    assert.equal(counterHiddenReason({ alarm, actions, summary }), '');
    assert.equal(counterHiddenReason({ alarm, actions, summary: { ...summary, counter_launch_visible: false, counter_block_reason: '当前证据不足' } }), '当前证据不足');
  }
});

test('同一实测事件的其他区域摘要不能借用，空白版本不作为动作版本', () => {
  const event_id = randomUUID(), first = randomUUID(), other = randomUUID();
  assert.equal(riskSummaryMatches({ event_id, _riskCaseId: first }, event_id, first), true);
  assert.equal(riskSummaryMatches({ event_id, _riskCaseId: first }, event_id, other), false);
  assert.equal(riskSummaryMatches({ event_id, risk_case_id: other, _riskCaseId: first }, event_id, first), false);
  assert.equal(riskSummaryMatches({ event_id }, event_id, first), false);
  assert.deepEqual(riskActionContext({ risk_case_id: first, risk_case_version: ' ' }), {});
});

test('统一风险转入区后暂时未知，不借用旧预测终态关闭核实入口', () => {
  for (const source_mode of ['live', 'replay']) for (const oldState of ['ENTERED', 'WITHDRAWN']) {
    const row = { source_mode, origin_kind: 'PREDICTED_AIRSPACE_ENTRY', prediction: { warning: { state: oldState } },
      risk_case: { risk_case_id: randomUUID(), stage: 'UNKNOWN', verification_status: 'PENDING_VERIFICATION' } };
    const state = predictionVerificationState({ origin_kind: 'PREDICTED_AIRSPACE_ENTRY' }, row, Date.now());
    assert.equal(state.terminal, false); assert.equal(state.blocked, true);
    assert.match(state.message, /当前风险依据不足/); assert.doesNotMatch(state.message, /请查看实际入区告警/);
    row.risk_case.stage = 'ENTERED';
    assert.equal(predictionVerificationState({}, row, Date.now()), null);
  }
});


test('办理进度优先采用本风险已授权的真实反制状态，未知仍保留未确认停机事实', () => {
  for (const source_mode of ['live', 'replay']) {
    const base = { source_mode, state: 'CONFIRMED', risk_case: { risk_case_id: randomUUID(), stage: 'ENTERED', verification_status: 'PENDING_VERIFICATION' } };
    assert.equal(riskConfirmed(base), false, '共享实测事件结论不能替代本风险核实');
    assert.equal(riskCaseProgress(base), null);
    for (const [status, expected] of [['REQUESTED', '待审批'], ['APPROVED', '已批准待启动'], ['EXECUTING', '反制执行中'], ['STOPPED', '反制已停止']]) {
      const row = { ...base, risk_case: { ...base.risk_case, counter: { status, action_type: 'COUNTERMEASURE' } } };
      assert.equal(riskCaseProgress(row).t, expected);
    }
    assert.equal(riskCaseProgress({ ...base, risk_case: { ...base.risk_case, stage: 'UNKNOWN' } }).t, '处置暂停');
    // 实测告警通知后确认撤离写明办完；预测风险解除（或缺少来源标记）仍写“风险已解除”。
    assert.equal(riskCaseProgress({ ...base, risk_case: { ...base.risk_case, stage: 'CLEARED', manual_counter_only: false } }).t, '已撤离 · 处置已结束');
    assert.equal(riskCaseProgress({ ...base, risk_case: { ...base.risk_case, stage: 'CLEARED', manual_counter_only: true } }).t, '风险已解除');
    assert.equal(riskCaseProgress({ ...base, risk_case: { ...base.risk_case, stage: 'CLEARED' } }).t, '风险已解除');
    assert.equal(riskCaseProgress({ ...base, risk_case: { ...base.risk_case, stage: 'UNKNOWN', counter: { status: 'EXECUTING' } } }).t, '反制执行中');
  }
});

function disposalSummaryView(summary) {
  const source = readFileSync(new URL('../src/components/disposal/RiskDisposalSummary.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?$/gm, '');
  return vm.runInNewContext(`${script}\n({ title: voiceOrderText.value || voice.value.title, reason: order.value?.reason, trigger: voiceTriggerText.value, ready: summaryReady.value, counter: counterText.value, orderTitle: orderTitle.value, order: order.value });`,
    { computed, autoSmsView, autoVoiceView, completedHandoffProgress, defineProps: () => ({ summary }) });
}

test('处置摘要区分待核实、确实依据不足和已结束，不改变资格或真实原因', () => {
  for (const source_mode of ['live', 'replay']) {
    const reason = '风险尚未核实或当前依据无效，暂停通知及新动作';
    const original = { event_id: randomUUID(), source_mode, response_order: { voice_status: 'PAUSED', reason, voice_allowed: false },
      can_direct_counter: false, can_request_counter: false, auto_voice: { status: 'BLOCKED', attempt_count: 0 },
      risk_case: { risk_case_id: randomUUID(), stage: 'ENTERED', verification_status: 'PENDING_VERIFICATION' } };
    for (const stage of ['PREDICTED', 'ENTERED', 'OBSERVED']) {
      const row = { ...original, risk_case: { ...original.risk_case, stage } }, before = JSON.stringify(row);
      assert.equal(disposalSummaryView(row).title, stage === 'PREDICTED' ? '等待人工核实，暂不拨打' : '等待核实，暂不拨打');
      assert.equal(disposalSummaryView(row).reason, reason);
      assert.equal(JSON.stringify(row), before, '仅展示，不更改服务端资格、核实或依据');
    }
    for (const verification_status of ['PENDING_VERIFICATION', 'CONFIRMED']) {
      const unknown = { ...original, risk_case: { ...original.risk_case, stage: 'UNKNOWN', verification_status } };
      assert.equal(disposalSummaryView(unknown).title, '依据不足，电话暂停', '未知应先提示依据不足，不能只要求核实');
      for (const stage of ['CLEARED', 'ENDED']) assert.equal(disposalSummaryView({ ...unknown,
        risk_case: { ...unknown.risk_case, stage } }).title, '风险已结束，不再拨打');
    }
    assert.equal(disposalSummaryView({ ...original, risk_case: { ...original.risk_case, verification_status: 'CONFIRMED' } }).title, '条件未满足，电话暂停');
    assert.equal(disposalSummaryView({ ...original, risk_case: undefined }).title, '条件未满足，电话暂停', '缺少结构字段不按合并原因猜测');
  }
});

test('真实通话状态优先于风险顺序暂停，保留正常优先流程文案', () => {
  const summary = { response_order: { voice_status: 'PAUSED', reason: '当前风险已结束' },
    risk_case: { stage: 'ENDED', verification_status: 'CONFIRMED' } };
  for (const [status, expected] of [['CALLING', '系统正在拨打'], ['SIMULATED_PLAYED', '模拟接通并播放完成'],
    ['UNKNOWN', '通话结果未确认'], ['FAILED', '电话通知失败，需人工处理']]) {
    assert.equal(disposalSummaryView({ ...summary, auto_voice: { status, attempt_count: 1 } }).title, expected);
  }
  assert.equal(disposalSummaryView({ ...summary, response_order: { voice_status: 'WAITING_START' }, auto_voice: { status: 'WAITING' } }).title, '电话等待启动确认');
});


test('预测人工核实与入区规则核实按当前阶段说明，人工反制标记不改变核实方式', () => {
  for (const source_mode of ['live', 'replay']) for (const manual_counter_only of [true, false]) {
    const row = { source_mode, risk_case: { risk_case_id: randomUUID(), manual_counter_only, stage: 'PREDICTED', verification_status: 'PENDING_VERIFICATION' } };
    assert.equal(riskCaseVerificationLabel(row), '待人工核实');
    assert.match(riskCaseVerificationHint(row), /人工核实本次预测风险/);
    row.risk_case.stage = 'ENTERED';
    assert.equal(riskCaseVerificationLabel(row), '待核实');
    assert.match(riskCaseVerificationHint(row), /满足已启用的核实规则可自动核实，也可人工核实/);
    for (const verification_status of ['CONFIRMED', 'FALSE_POSITIVE']) {
      row.risk_case.verification_status = verification_status;
      assert.equal(riskCaseVerificationHint(row), '', '已核实不再提示重复核实');
    }
  }
});

test('核实来源依赖真实触发方式，空操作人和预测来源都不能伪造自动核实', () => {
  assert.equal(verificationSourceLabel({ trigger_mode: 'AUTO', actor_id: null }), '系统自动核实');
  assert.match(verificationSourceLabel({ trigger_mode: 'MANUAL', actor_id: randomUUID() }), /人工核实/);
  assert.equal(verificationSourceLabel({ trigger_mode: 'MANUAL' }), '人工核实 · 核实人未提供');
  assert.equal(verificationSourceLabel({ actor_id: null }), '核实方式未提供');
  assert.equal(verificationSourceLabel({ manual_counter_only: true }), '核实方式未提供');
});


test('电话等待上限可见，真实通话结果附当次冻结原因，不能从最新策略推断旧原因', () => {
  for (const max_wait_seconds of [5, 60, 300]) {
    const waiting = { response_order: { voice_status: 'WAITING_START', max_wait_seconds }, auto_voice: { status: 'WAITING' } };
    assert.equal(disposalSummaryView(waiting).title, `电话等待启动确认（最长${max_wait_seconds}秒）`);
    const sent = { response_order: { voice_status: 'START_CONFIRMED', max_wait_seconds: 45 },
      auto_voice: { status: 'SIMULATED_PLAYED', attempt_count: 1,
        response_order_basis: { status: 'WAIT_TIMEOUT', max_wait_seconds } } };
    assert.equal(disposalSummaryView(sent).title, '模拟接通并播放完成');
    assert.equal(disposalSummaryView(sent).trigger, `优先等待已达${max_wait_seconds}秒，转电话通知`);
    for (const status of ['UNKNOWN', 'FAILED', 'CALLING']) {
      assert.equal(disposalSummaryView({ ...sent, auto_voice: { ...sent.auto_voice, status } }).trigger,
        `优先等待已达${max_wait_seconds}秒，转电话通知`);
    }
  }
  for (const [status, expected] of [['START_CONFIRMED', '设备确认启动后拨打'],
    ['START_FAILED', '设备启动失败，转电话通知'], ['START_UNAVAILABLE', '反制设备不可用，转电话通知']]) {
    assert.equal(disposalSummaryView({ response_order: { voice_status: 'PAUSED' },
      auto_voice: { status: 'SIMULATED_PLAYED', attempt_count: 1, response_order_basis: { status } } }).trigger, expected);
  }
  assert.equal(disposalSummaryView({ response_order: { voice_status: 'WAIT_TIMEOUT', max_wait_seconds: 60 },
    auto_voice: { status: 'SIMULATED_PLAYED', attempt_count: 1 } }).trigger, '', '旧通话没有冻结依据时不猜测拨打原因');
});

test('处置摘要未就绪时不显示旧顺序或待核实事实', () => {
  for (const summary of [null, { _unavailable: true, response_order: { counter_priority: false } }]) {
    const view = disposalSummaryView(summary);
    assert.equal(view.ready, false);
    assert.equal(view.order, null);
  }
  assert.equal(disposalSummaryView({ event_id: randomUUID(), response_order: { counter_priority: true } }).ready, true);
  const source = readFileSync(new URL('../src/components/disposal/RiskDisposalSummary.vue', import.meta.url), 'utf8');
  assert.match(source, /v-if="!summaryReady"[^>]*[^<]*>处置进度更新中，暂不能办理。/);
  assert.match(source, /<dl class="risk-channels" :aria-busy="!summaryReady"/);
});
test('入口可见不代表可以反制；摘要与按钮使用相同明确资格并保留阻断原因',()=>{
 const base={event_id:randomUUID(),counter_launch_visible:true,can_direct_counter:false,can_request_counter:false,counter_block_reason:'缺少当前有效实测入区依据'};
 assert.equal(disposalSummaryView(base).counter,base.counter_block_reason);
 assert.equal(disposalSummaryView({...base,can_direct_counter:true}).counter,'可直接反制');
 assert.equal(disposalSummaryView({...base,can_request_counter:true}).counter,'可申请反制（需审批）');
 assert.equal(disposalSummaryView({...base,_unavailable:true,can_direct_counter:true}).counter,'正在更新当前资格');
 assert.equal(disposalSummaryView(null).counter,'正在更新当前资格');
});

test('资格暂停不是后台切回通知优先，已受理电话继续呈现真实回执与冻结原因',()=>{
 const paused={response_order:{counter_priority:false,voice_status:'PAUSED'},risk_case:{stage:'UNKNOWN',verification_status:'CONFIRMED'},
  auto_voice:{status:'SIMULATED_PLAYED',attempt_count:1,response_order_basis:{status:'WAIT_TIMEOUT',max_wait_seconds:60}}};
 assert.equal(disposalSummaryView(paused).orderTitle,'处置进度');
 assert.equal(disposalSummaryView(paused).title,'模拟接通并播放完成');
 assert.equal(disposalSummaryView(paused).trigger,'优先等待已达60秒，转电话通知');
 assert.equal(disposalSummaryView(null).orderTitle,'处置进度');
});


test('风险摘要只凭明确失败结果码区分启动拦截，超时和设备失败不混淆',()=>{
 for(const source_mode of ['live','replay']) for(const [result_code,expected] of [
  ['AUTHORIZATION_STOPPED','启动被拦截'],['DEVICE_FAILED','启动失败'],['ADAPTER_TIMEOUT','启动失败'],[undefined,'启动失败']]){
  const counter={authorization_id:randomUUID(),status:'FAILED',result_code};
  const summary={event_id:randomUUID(),source_mode,risk_case:{risk_case_id:randomUUID(),counter}};
  assert.equal(disposalSummaryView(summary).counter,expected);
  const progress=riskCaseProgress(summary);
  assert.equal(progress.t,result_code==='AUTHORIZATION_STOPPED'?'启动被拦截':'反制失败');
 }
 assert.equal(disposalSummaryView({risk_case:{counter:{status:'EXECUTING',result_code:'AUTHORIZATION_STOPPED'}}}).counter,'执行中');
});


test('已完成反制仅附带同区域服务端移送进度，不根据阶段认定已移送或已处罚', () => {
  for (const source_mode of ['live', 'replay']) {
    const event_id = randomUUID(), risk_case_id = randomUUID();
    const base = { event_id, source_mode, risk_case: { risk_case_id, action_event_id: event_id, stage: 'ENTERED', manual_counter_only: true,
      counter: { status: 'COMPLETED' } } };
    for (const [status, label] of [['WAITING', '待移送'], ['BLOCKED', '移送受阻'], ['SUBMITTED', '已移送'], ['PENDING', '移送待发送']]) {
      const view = disposalSummaryView({ ...base, auto_handoff: { status, handoff_id: ['SUBMITTED', 'PENDING'].includes(status) ? randomUUID() : null } });
      assert.equal(view.counter, `已完成 · ${label}`);
      assert.doesNotMatch(view.counter, /已处罚|处罚已办结/);
    }
    assert.equal(disposalSummaryView(base).counter, '已完成');
    assert.equal(disposalSummaryView({ ...base, auto_handoff: { status: 'SUBMITTED' } }).counter, '已完成');
    assert.equal(disposalSummaryView({ ...base, _riskCaseId: randomUUID(), auto_handoff: { status: 'SUBMITTED', handoff_id: randomUUID() } }).counter, '已完成');
    assert.equal(disposalSummaryView({ ...base, event_id: randomUUID(), auto_handoff: { status: 'WAITING' } }).counter, '已完成');
    assert.equal(disposalSummaryView({ ...base, auto_handoff: { status: 'PENDING_DECISION', handoff_id: randomUUID() } }).counter, '已完成');
    assert.equal(disposalSummaryView({ ...base, risk_case: { ...base.risk_case, counter: { status: 'EXECUTING' } }, auto_handoff: { status: 'SUBMITTED', handoff_id: randomUUID() } }).counter, '执行中');
  }
});


test('民航自动停止、资格拦截和移送完成各按后端状态显示，不互相覆盖', () => {
  for (const [status, result_code, text] of [
    ['STOPPED', 'STOPPED_BY_AIRCRAFT', '已停止：附近有航班'],
    ['FAILED', 'AUTHORIZATION_STOPPED', '启动被拦截'],
    ['FAILED', 'STOPPED_BY_AIRCRAFT', '启动失败'],
    ['STOPPED', 'AUTHORIZATION_STOPPED', '已停止'],
    ['COMPLETED', null, '已完成']
  ]) {
    const summary = { risk_case: { counter: { status, result_code } } };
    assert.equal(disposalSummaryView(summary).counter, text);
    assert.equal(disposalSummaryView({ ...summary, _unavailable: true }).counter, '正在更新当前资格');
  }
});
