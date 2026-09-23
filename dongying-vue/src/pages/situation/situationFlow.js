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
  return ['false-positive', 'counter'];
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
