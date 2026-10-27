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
  const pending = ['ENTERED', 'OBSERVED'].includes(riskStage(row)) ? '待核实' : '待人工核实';
  return { CONFIRMED: '风险已核实', FALSE_POSITIVE: '已核实为误报', PENDING_VERIFICATION: pending, PENDING: pending }[riskVerificationState(row)] || '核实状态未提供';
}

/** 核实方式随当前阶段说明；不把人工反制标记当成人工核实限制。 */
export function riskCaseVerificationHint(row) {
  if (!['PENDING_VERIFICATION', 'PENDING'].includes(riskVerificationState(row))) return '';
  const stage = riskStage(row);
  if (stage === 'PREDICTED') return '请人工核实本次预测风险。';
  if (stage === 'ENTERED') return '已实测入区；满足已启用的核实规则可自动核实，也可人工核实。';
  if (stage === 'OBSERVED') return '满足已启用的核实规则可自动核实，也可人工核实。';
  return '';
}

/** 空操作人不能证明系统自动核实，来源以实际记录为准。 */
export function verificationSourceLabel(record) {
  if (record?.trigger_mode === 'AUTO') return '系统自动核实';
  if (record?.actor_id) return `人工核实 · 核实人 ${record.actor_name || '姓名未提供'}`;
  if (record?.trigger_mode === 'MANUAL') return '人工核实 · 核实人未提供';
  return '核实方式未提供';
}

/** 共享事件也不能共享不同区域风险的办理资格。 */
export function riskSummaryMatches(summary, eventId, caseId = '', expectedCaseVersion) {
  const summaryCase = summary?.risk_case?.risk_case_id || summary?.risk_case_id || summary?._riskCaseId || '';
  if (!eventId || summary?._unavailable || summary?.event_id !== eventId || summaryCase !== (caseId || '')) return false;
  // 三参数调用仅校验身份；当前办理入口同时传case版本，不能沿用核实/阶段变化前的资格。
  if (!caseId || arguments.length < 4) return true;
  const expected = expectedCaseVersion && typeof expectedCaseVersion === 'object' ? expectedCaseVersion : null;
  const requiredVersion = expected ? expected.version : expectedCaseVersion;
  const version = summary.risk_case?.version ?? summary.risk_case_version;
  if (version == null || requiredVersion == null || String(version).trim() === '' || String(requiredVersion).trim() === ''
    || !Number.isInteger(Number(version)) || !Number.isInteger(Number(requiredVersion))) return false;
  if (!expected) return Number(version) >= Number(requiredVersion);
  // 高版本先由选中上下文接续；不能把新阶段资格与旧阶段标题混在一起。
  return Number(version) === Number(requiredVersion)
    && (!expected.stage || summary.risk_case?.stage === expected.stage)
    && (!expected.verification_status || summary.risk_case?.verification_status === expected.verification_status);
}

/** 只展示服务端已授权的本风险反制摘要，不从共享事件推断其他区域的办理进度。 */
export function riskCaseProgress(row) {
  const risk = riskCaseOf(row);
  if (!risk) return null;
  const counter = risk.counter;
  if (counter?.status === 'FAILED' && counter.result_code === 'AUTHORIZATION_STOPPED') return { t: '启动被拦截', c: 't-amber' };
  const counterLabels = { REQUESTED: ['待审批', 't-amber'], APPROVED: ['已批准待启动', 't-amber'],
    EXECUTING: [counter?.action_type === 'JAMMING' ? '干扰执行中' : '反制执行中', 't-cyan'],
    COMPLETED: ['反制已完成', 't-green'], STOPPED: ['反制已停止', 't-gray'], FAILED: ['反制失败', 't-red'],
    CANCELLED: ['反制已取消', 't-gray'], EXPIRED: ['反制授权已失效', 't-gray'] };
  const value = counterLabels[counter?.status];
  if (value) return { t: value[0], c: value[1] };
  if (risk.stage === 'UNKNOWN') return { t: '处置暂停', c: 't-amber' };
  if (risk.stage === 'CLEARED') return { t: '风险已解除', c: 't-green' };
  if (risk.stage === 'ENDED') return { t: '处置已结束', c: 't-gray' };
  return null;
}
