/** 风险记录只承接处置资格；原告警、研判与核实事实不在浏览器改写。 */
export const RISK_STAGE_LABEL = { PREDICTED: '预计入区', ENTERED: '已实际入区', CLEARED: '已避开', UNKNOWN: '依据不足', ENDED: '已结束', OBSERVED: '实测告警' };
export const riskCaseOf = row => row?.risk_case || row?.riskCase || (row?.risk_case_id ? { risk_case_id: row.risk_case_id, version: row.risk_case_version } : null);
export const riskCaseKey = row => riskCaseOf(row)?.risk_case_id || row?.alarm_id || row?.alarmId || row?.id || '';
export const riskStage = row => riskCaseOf(row)?.stage || '';
export const riskStageLabel = row => RISK_STAGE_LABEL[riskStage(row)] || '';
export const riskVerificationState = row => riskCaseOf(row)?.verification_status || row?.eventState || row?.state || '';
export const riskConfirmed = row => riskVerificationState(row) === 'CONFIRMED';
export function riskActionContext(row) {
  const risk = riskCaseOf(row);
  return risk?.risk_case_id && Number.isInteger(Number(risk.version)) && risk.version != null && String(risk.version).trim() !== ''
    ? { risk_case_id: risk.risk_case_id, expected_case_version: Number(risk.version) } : {};
}
export function riskCaseAlarm(alarm) {
  if (!alarm) return alarm;
  const risk = riskCaseOf(alarm);
  return risk?.action_event_id ? { ...alarm, source_event_id: alarm.source_event_id || alarm.event_id,
    event_id: risk.action_event_id } : alarm;
}
export function riskCaseVisible(row) {
  const risk = riskCaseOf(row);
  return !risk || ['PREDICTED', 'ENTERED', 'OBSERVED'].includes(risk.stage);
}
export function riskCaseMatches(row, id) {
  const risk = riskCaseOf(row);
  return riskCaseKey(row) === id || row?.alarm_id === id || (risk?.related_alarm_ids || []).includes(id);
}
export function riskCaseVerificationLabel(row) {
  return { CONFIRMED: '风险已核实', FALSE_POSITIVE: '已核实为误报', PENDING_VERIFICATION: '待人工核实', PENDING: '待人工核实' }[riskVerificationState(row)] || '核实状态未提供';
}

/** 共享事件也不能共享不同区域风险的办理资格。 */
export function riskSummaryMatches(summary, eventId, caseId = '') {
  const summaryCase = summary?.risk_case?.risk_case_id || summary?.risk_case_id || summary?._riskCaseId || '';
  return !!eventId && summary?.event_id === eventId && summaryCase === (caseId || '');
}

/** 只展示服务端已授权的本风险反制摘要，不从共享事件推断其他区域的办理进度。 */
export function riskCaseProgress(row) {
  const risk = riskCaseOf(row);
  if (!risk) return null;
  const counter = risk.counter;
  const counterLabels = { REQUESTED: ['待审批', 't-amber'], APPROVED: ['已批准待启动', 't-amber'],
    EXECUTING: [counter?.action_type === 'JAMMING' ? '干扰执行中' : '反制执行中', 't-cyan'],
    COMPLETED: ['反制已完成', 't-green'], STOPPED: ['反制已停止', 't-gray'], FAILED: ['反制失败', 't-red'],
    CANCELLED: ['反制已取消', 't-gray'], EXPIRED: ['反制授权已失效', 't-gray'] };
  const value = counterLabels[counter?.status];
  if (value) return { t: value[0], c: value[1] };
  if (risk.stage === 'UNKNOWN') return { t: '处置暂停', c: 't-amber' };
  // 实测告警的风险记录只在通知后按有效位置确认撤离时变为 CLEARED（预测风险另有自己的解除），2026-10-26 用户要求写明办完。
  if (risk.stage === 'CLEARED') return risk.manual_counter_only === false ? { t: '已撤离 · 处置已结束', c: 't-green' } : { t: '风险已解除', c: 't-green' };
  if (risk.stage === 'ENDED') return { t: '处置已结束', c: 't-gray' };
  return null;
}
