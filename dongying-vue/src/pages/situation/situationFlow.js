import { coverageContainsPoint } from '@/services/situationData.js';

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
  if (!alarm || alarm.eventState === 'FALSE_POSITIVE' || alarm.handoff) return [];
  if (['jamming', 'counter', 'active', 'requested'].includes(alarm.disposalStage)) return [];
  if (['jammed', 'countered', 'completed'].includes(alarm.disposalStage)) return [];
  if (alarm.eventState === 'PENDING_VERIFICATION') return ['verify'];
  if (alarm.eventState === 'CONFIRMED') return ['counter'];
  return [];
}

/**
 * 融合感知右侧只展示仍需要人工关注的当天告警：待核实，或已核实但尚未进入处置流程的待反制。
 * 已经进入自动/人工处置、已移送或已结束的事件留在告警详情和历史记录中，不继续占用实时待办列表。
 */
export function situationAlarmNeedsAttention(alarm) {
  if (!alarm || alarm.handoff || alarm.eventState === 'FALSE_POSITIVE') return false;
  if (alarm.eventState === 'PENDING_VERIFICATION') return true;
  return alarm.eventState === 'CONFIRMED' && (!alarm.disposalStage || alarm.disposalStage === 'none');
}

/** 航线风险待办只保留当前目标仍在且已经核验、等待通知上级的风险。 */
export function situationRouteRiskNeedsAttention(risk) {
  return !!risk && risk.active === true && risk.state === 'PENDING_NOTIFICATION';
}

/** 融合感知页的航线风险只展示已经核验、等待通知上级的当前风险。 */
export function situationRouteRiskVisible(risk) {
  if (!risk || risk.state !== 'PENDING_NOTIFICATION') return false;
  if (!['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk.riskType || risk.risk_type)) return false;
  return !!(risk.planId || risk.plan_id) && !!(risk.routeVersionId || risk.route_version_id);
}

export function uavProcessStatus(alarm) {
  if (!alarm) return '';
  if (alarm.eventState === 'FALSE_POSITIVE') return '误报';
  if (alarm.handoff) return '已移送处罚';
  if (alarm.disposalStage === 'jamming') return '信号干扰中';
  if (alarm.disposalStage === 'counter' || alarm.disposalStage === 'active') return '反制执行中';
  if (alarm.disposalStage === 'jammed') return '已干扰';
  if (alarm.disposalStage === 'countered' || alarm.disposalStage === 'completed') return '反制已完成';
  if (alarm.disposalStage === 'requested') return '待审批';
  if (alarm.eventState === 'CONFIRMED') return '告警已确认';
  return '待核实';
}
