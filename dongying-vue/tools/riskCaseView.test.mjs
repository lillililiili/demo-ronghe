import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { computed } from 'vue';
import { autoSmsView } from '../src/components/disposal/autoSmsView.js';
import { autoVoiceView } from '../src/components/disposal/autoVoiceView.js';
import { riskCaseProgress, riskCaseKey, riskCaseAlarm, riskCaseMatches, riskActionContext, riskConfirmed, riskCaseVisible, riskSummaryMatches } from '../src/services/riskCaseView.js';
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
    assert.equal(riskCaseProgress({ ...base, risk_case: { ...base.risk_case, stage: 'UNKNOWN', counter: { status: 'EXECUTING' } } }).t, '反制执行中');
  }
});

function disposalSummaryView(summary) {
  const source = readFileSync(new URL('../src/components/disposal/RiskDisposalSummary.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*;\r?$/gm, '');
  return vm.runInNewContext(`${script}\n({ title: voiceOrderText.value || voice.value.title, reason: order.value?.reason });`,
    { computed, autoSmsView, autoVoiceView, defineProps: () => ({ summary }) });
}

test('处置摘要区分待核实、确实依据不足和已结束，不改变资格或真实原因', () => {
  for (const source_mode of ['live', 'replay']) {
    const reason = '风险尚未核实或当前依据无效，暂停通知及新动作';
    const original = { event_id: randomUUID(), source_mode, response_order: { voice_status: 'PAUSED', reason, voice_allowed: false },
      can_direct_counter: false, can_request_counter: false, auto_voice: { status: 'BLOCKED', attempt_count: 0 },
      risk_case: { risk_case_id: randomUUID(), stage: 'ENTERED', verification_status: 'PENDING_VERIFICATION' } };
    for (const stage of ['PREDICTED', 'ENTERED', 'OBSERVED']) {
      const row = { ...original, risk_case: { ...original.risk_case, stage } }, before = JSON.stringify(row);
      assert.equal(disposalSummaryView(row).title, '等待人工核实，暂不拨打');
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
