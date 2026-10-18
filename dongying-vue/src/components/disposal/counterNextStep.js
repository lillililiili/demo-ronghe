/* 「下一步」反制入口的文字（2026-10-14 rose 认可的页面设计第 2、6 条）：
   能反制时按钮名按账号权限写清是直接反制还是要审批；不能反制时按钮保留变灰，写一句为什么。 */

export function counterLaunchLabel(summary) {
  if (summary?.can_direct_counter === true) return '直接反制';
  if (summary?.can_request_counter === true) return '申请反制（需审批）';
  return '发起反制';
}

export function counterPermissionHint(summary) {
  if (summary?.can_direct_counter === true) return '你的账号可直接反制，不用审批';
  if (summary?.can_request_counter === true) return '提交后要审批人同意才执行';
  return '';
}

const PHASE_REASON = {
  AUTO_SMS: '正在给飞手发短信，发完并观察后再决定是否反制',
  WATCHING: '已通知飞手，正在观察无人机是否离开',
  AUTO_CALL: '正在给飞手打电话，打完并观察后再决定是否反制'
};

/**
 * 反制按钮为什么现在不出现；返回空字符串表示按钮正常出现（能不能点由 CounterLaunch 按后台资格判断）。
 * @param {object} input
 * @param {object} input.alarm 融合感知的告警行（eventState、disposalStage、handoff）
 * @param {string[]} input.actions uavProcessActions(alarm)
 * @param {string} [input.processStatus] uavProcessStatus(alarm)
 * @param {object} [input.summary] 本事件的通知与处置概况
 * @param {object} [input.nowStatus] uavNowStatus 的结果
 */
export function counterHiddenReason({ alarm, actions = [], processStatus = '', summary, nowStatus }) {
  if (!alarm) return '';
  if (alarm.eventState === 'PENDING_VERIFICATION') return '告警还没核实属实，核实后才能反制';
  if (!actions.includes('counter')) return processStatus ? `现在的处理进度是「${processStatus}」，这里不再发起反制` : '现在这一步不能反制';
  if (!summary) return '正在读取能否反制';
  if (summary._unavailable === true) return '处置进度读取失败，恢复后重新判断';
  if (summary.no_counter?.decision_active === true) return '已决定不反制，现场处置结束';
  if (summary.counter_launch_visible === true) return '';
  if (summary.counter_block_reason) return summary.counter_block_reason;
  if (nowStatus?.departed) return '无人机已飞离，不需要反制；在告警事件页继续办理';
  if (PHASE_REASON[summary.notify_phase]) return PHASE_REASON[summary.notify_phase];
  if (summary.departure_observation?.presence === 'LEFT') {
    return nowStatus?.key === 'VIOLATING'
      ? '通知后曾判定已离开，系统收起了反制按钮；但无人机现在仍在违规'
      : '通知后已判定离开，系统收起了反制按钮';
  }
  return '现在这一步不能反制';
}

/** “无风险不反制”是告警核实动作（后端要求告警核实权限）：没有这项权限的账号不显示入口（#34），后端校验不变。 */
export const NO_COUNTER_PERMISSION = 'alarm:verify';
export function noCounterEntryVisible(has) {
  return typeof has === 'function' && has(NO_COUNTER_PERMISSION) === true;
}
