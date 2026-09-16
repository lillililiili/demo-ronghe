import { coverageContainsPoint } from '@/services/situationData.js';

export function eoCanMonitor(target, devices = []) {
  return !!target && devices.some(device => device.typeCode === 'EO' && coverageContainsPoint(device, target));
}

export function showEoVideo(target, devices = []) {
  if (!eoCanMonitor(target, devices)) return false;
  if (target.objectTypeCode === 'UAV') {
    return (target.relatedAlarms || []).some(alarm => alarm.eventState !== 'FALSE_POSITIVE');
  }
  return (target.relatedRisks || []).some(risk => risk.active);
}

export function disposalStage(summary) {
  const status = String(summary?.status || '').toUpperCase();
  if (status === 'EXECUTING') return 'jamming';
  if (status === 'COMPLETED' || status === 'SUCCEEDED') return 'completed';
  if (status === 'REQUESTED' || status === 'APPROVED') return 'requested';
  return 'none';
}

export function uavProcessActions(alarm) {
  if (!alarm || alarm.eventState === 'FALSE_POSITIVE' || alarm.handoff) return [];
  if (alarm.disposalStage === 'completed') return ['punish'];
  if (alarm.disposalStage === 'jamming' || alarm.disposalStage === 'requested') return [];
  return ['false-positive', 'counter'];
}

export function uavProcessStatus(alarm) {
  if (!alarm) return '';
  if (alarm.eventState === 'FALSE_POSITIVE') return '误报';
  if (alarm.handoff) return '已移送处罚';
  if (alarm.disposalStage === 'jamming') return '信号干扰中';
  if (alarm.disposalStage === 'completed') return '已干扰';
  if (alarm.disposalStage === 'requested') return '待审批';
  if (alarm.eventState === 'CONFIRMED') return '已核实，待处置';
  return '待核实';
}
