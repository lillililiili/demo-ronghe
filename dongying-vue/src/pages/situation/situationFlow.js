import { coverageContainsPoint, planIsCurrent, riskMatchesPlan, targetIsCurrent } from '../../services/situationData.js';
import { riskCaseOf, riskCaseVisible, riskVerificationState } from '../../services/riskCaseView.js';
import { serverNow } from '../../services/serverClock.js';

export function eoCanMonitor(target, devices = []) {
  return !!target && devices.some(device => device.typeCode === 'EO' && coverageContainsPoint(device, target));
}

export function showEoVideo(target, devices = []) {
  return eoCanMonitor(target, devices);
}

export function disposalStage(summary) {
  if (!summary) return 'none';
  const status = String(summary.status || '').toUpperCase();
  const action = String(summary.actionType || summary.action_type || '').toUpperCase();
  if (['FAILED', 'STOPPED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(status)) return 'none';
  if (status === 'REQUESTED') return 'requested';
  if (status === 'APPROVED' || status === 'EXECUTING') {
    return action === 'JAMMING' ? 'jamming' : action === 'COUNTERMEASURE' ? 'counter' : 'active';
  }
  if (status === 'COMPLETED' || status === 'SUCCEEDED') {
    return action === 'JAMMING' ? 'jammed' : action === 'COUNTERMEASURE' ? 'countered' : 'completed';
  }
  return 'none';
}

export function uavProcessActions(alarm) {
  if (!alarm || !riskCaseVisible(alarm) || riskVerificationState(alarm) === 'FALSE_POSITIVE' || alarm.handoff) return [];
  if (['jamming', 'counter', 'active', 'requested'].includes(alarm.disposalStage)) return [];
  if (['jammed', 'countered', 'completed'].includes(alarm.disposalStage)) return [];
  if (['PENDING_VERIFICATION', 'PENDING'].includes(riskVerificationState(alarm))) return ['verify'];
  if (riskVerificationState(alarm) === 'CONFIRMED') return ['counter'];
  return [];
}

/**
 * 融合感知右侧只展示仍需要人工关注的当天告警：待核实，或已核实但尚未进入处置流程的待反制。
 * 已经进入自动/人工处置、已移送或已结束的事件留在告警详情和历史记录中，不继续占用实时待办列表。
 */
export function situationAlarmNeedsAttention(alarm) {
  if (!alarm || alarm.handoff || riskVerificationState(alarm) === 'FALSE_POSITIVE') return false;
  if (riskCaseOf(alarm)) return riskCaseVisible(alarm);
  if (alarm.eventState === 'PENDING_VERIFICATION') return true;
  return alarm.eventState === 'CONFIRMED' && (!alarm.disposalStage || alarm.disposalStage === 'none');
}

/** 航线风险待办只保留当前目标仍在且已经核验、等待通知上级的风险。 */
export function situationRouteRiskNeedsAttention(risk) {
  return !!risk && risk.active === true && risk.state === 'PENDING_NOTIFICATION';
}

/** 待核验、待通知风险保留列表入口；当前位置与地图标记由独立时效条件控制。 */
export function situationRouteRiskVisible(risk) {
  if (!risk || !['PENDING_VERIFICATION', 'PENDING_NOTIFICATION'].includes(risk.state)) return false;
  if (!['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk.riskType || risk.risk_type)) return false;
  return !!(risk.planId || risk.plan_id) && !!(risk.routeVersionId || risk.route_version_id);
}

/** 本页实时航线风险：有效任务时段 + 同源有效位置 + 后端确认当前仍在风险范围内。 */
export function situationRouteRiskIsCurrent(risk, plan, target, now = serverNow()) {
  if (!risk || !['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk.riskType)) return false;
  if (risk.currentStatus !== 'CURRENT' || !['PENDING_VERIFICATION', 'PENDING_NOTIFICATION', 'NOTIFIED', 'ACKNOWLEDGED'].includes(risk.state)) return false;
  if (!riskMatchesPlan(risk, plan) || !planIsCurrent(plan, now)) return false;
  if (!risk.targetInternalId || risk.targetInternalId !== target?.targetId || !targetIsCurrent(target, now) || target.posValid !== true) return false;
  // 范围由后端按规则、实际位置和航线几何判断，不能用旧发现点或通知状态推断仍有风险。
  return !!risk.sourceMode && risk.sourceMode === target.sourceMode && risk.mapVisible !== false;
}

export function uavProcessStatus(alarm) {
  if (!alarm) return '';
  if (alarm.eventState === 'FALSE_POSITIVE') return '误报';
  // handoff 为移送进度：HANDOFF_PENDING 是交接已建立还没发出，不能写成已移送。
  if (alarm.handoff) return alarm.handoff === 'HANDOFF_PENDING' ? '待发送移送' : '已移送处罚';
  if (alarm.disposalStage === 'jamming') return '信号干扰中';
  if (alarm.disposalStage === 'counter' || alarm.disposalStage === 'active') return '反制执行中';
  if (alarm.disposalStage === 'jammed') return '已干扰';
  if (alarm.disposalStage === 'countered' || alarm.disposalStage === 'completed') return '反制已完成';
  if (alarm.disposalStage === 'requested') return '待审批';
  if (alarm.eventState === 'CONFIRMED') return '告警已确认';
  return '待核实';
}
