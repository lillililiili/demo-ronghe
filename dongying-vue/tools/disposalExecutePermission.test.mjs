import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBlockedReason, nextStep, primaryCode } from '../src/pages/alarms/authorizationQueueView.js';

// BUG-02：已批准的设备反制，当前账号点不了“执行”时要用大白话说清缺什么；按钮仍只看后端 allowed_actions。
const approved = { status: 'APPROVED', channel: 'LINGYUN_B', authorization_mode: 'REVIEW', requested_by: 'duty', allowed_actions: ['CANCEL'] };
const holding = (...codes) => code => codes.includes(code);

test('已批准的申请审批反制：缺执行处置或设备操作权限时分别说明原因', () => {
  assert.match(executeBlockedReason(approved, 'reviewer', holding('devices.op')), /没有“执行处置”权限/);
  assert.match(executeBlockedReason(approved, 'reviewer', holding('disposal:execute')), /设备操作权限/);
  assert.match(executeBlockedReason(approved, 'reviewer', holding()), /没有“执行处置”权限/);
  // 列表里的下一步仍是原来的概括，原因只在详情里补充，不冒充可以执行。
  assert.equal(nextStep(approved, 'reviewer'), '等待有权限的人员执行');
  assert.equal(primaryCode(approved, 'reviewer'), '');
});

test('后端已给出执行动作、人工通道、非已批准或已有执行受阻原因时不另加说明', () => {
  const can = holding('disposal:execute', 'devices.op');
  assert.equal(executeBlockedReason({ ...approved, allowed_actions: ['EXECUTE', 'CANCEL'] }, 'auth', holding()), '');
  assert.equal(executeBlockedReason({ ...approved, channel: 'MANUAL' }, 'auth', holding()), '');
  for (const status of ['REQUESTED', 'EXECUTING', 'COMPLETED', 'FAILED', 'STOPPED']) {
    assert.equal(executeBlockedReason({ ...approved, status }, 'auth', holding()), '');
  }
  assert.equal(executeBlockedReason({ ...approved, execution_block_reason: 'TARGET_LOST' }, 'auth', holding()), '');
  // 权限都在但后端仍未给执行（例如状态刚变化）：不编造原因，交给列表的“等待有权限的人员执行”与刷新。
  assert.equal(executeBlockedReason(approved, 'auth', can), '');
});

test('免逐次审批的直接反制只能由发起人本人凭直接反制权限下发', () => {
  const direct = { ...approved, authorization_mode: 'DIRECT', requested_by: 'owner' };
  assert.match(executeBlockedReason(direct, 'someone-else', holding('disposal:direct', 'disposal:execute', 'devices.op')), /只能由发起人本人/);
  assert.match(executeBlockedReason(direct, 'owner', holding('disposal:execute', 'devices.op')), /没有直接反制权限/);
  assert.match(executeBlockedReason(direct, 'owner', holding('disposal:direct')), /设备操作权限/);
});
