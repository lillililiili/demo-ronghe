/* 「下一步」反制入口的按钮名与不能反制的原因（2026-10-14 页面设计第 2、6 条）：node --test tools/counterNextStep.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { counterHiddenReason, counterLaunchLabel, counterPermissionHint } from '../src/components/disposal/counterNextStep.js';

test('button name follows account permission', () => {
  assert.equal(counterLaunchLabel({ can_direct_counter: true, can_request_counter: true }), '直接反制');
  assert.equal(counterLaunchLabel({ can_request_counter: true }), '申请反制（需审批）');
  assert.equal(counterLaunchLabel(null), '发起反制');
  assert.equal(counterPermissionHint({ can_direct_counter: true }), '你的账号可直接反制，不用审批');
  assert.equal(counterPermissionHint({}), '');
});

test('reason when counter is not offered', () => {
  const alarm = { eventState: 'CONFIRMED' };
  const actions = ['counter'];
  assert.equal(counterHiddenReason({ alarm: { eventState: 'PENDING_VERIFICATION' }, actions: ['verify'] }), '告警还没核实属实，核实后才能反制');
  assert.match(counterHiddenReason({ alarm, actions: [], processStatus: '反制执行中' }), /「反制执行中」/);
  assert.equal(counterHiddenReason({ alarm, actions }), '正在读取能否反制');
  assert.equal(counterHiddenReason({ alarm, actions, summary: { counter_launch_visible: true } }), '');
  assert.equal(counterHiddenReason({ alarm, actions, summary: { counter_launch_visible: true, no_counter: { decision_active: true } } }), '已决定不反制，本次处置已结束');
  assert.match(counterHiddenReason({ alarm, actions, summary: { notify_phase: 'AUTO_CALL' } }), /正在给飞手打电话/);
  assert.match(counterHiddenReason({ alarm, actions, summary: {}, nowStatus: { departed: true } }), /已飞离，不需要反制/);
  const left = { departure_observation: { presence: 'LEFT' } };
  assert.match(counterHiddenReason({ alarm, actions, summary: left, nowStatus: { key: 'VIOLATING' } }), /但无人机现在仍在违规/);
  assert.equal(counterHiddenReason({ alarm, actions, summary: {} }), '现在这一步不能反制');
});
