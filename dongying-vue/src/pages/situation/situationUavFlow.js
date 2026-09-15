/* 融合感知无人机异常卡片的处置步骤。
   误报与反制并列展示；处置完成后再通知处罚部门。
   高异常且融合置信高时，反制跳过两人审批，直接进入信号干扰中。 */
import { coverageContainsPoint } from '../../services/situationData.js';

export const UAV_FLOW_STORAGE_KEY = 'situation.mock.uav-flow.v1';
export const HIGH_FUSION_CONFIDENCE = 85;

export function isHighUavAlarm(alarm) {
  return alarm?.level === '高' || alarm?.severity === 'HIGH' || alarm?.severity === 'CRITICAL';
}

export function skipCountermeasureApproval(alarm, target) {
  return isHighUavAlarm(alarm) && Number(target?.fusedConf) >= HIGH_FUSION_CONFIDENCE;
}

export function eoCanMonitor(target, devices = []) {
  if (!target) return false;
  return devices.some(device => device.typeCode === 'EO' && coverageContainsPoint(device, target));
}

export function showEoVideo(target, devices = []) {
  if (!eoCanMonitor(target, devices)) return false;
  if (target.objectTypeCode === 'UAV') {
    return (target.relatedAlarms || []).some(alarm => alarm.eventState !== 'FALSE_POSITIVE');
  }
  return (target.relatedRisks || []).some(risk => risk.active);
}

export function applyUavFlow(alarm, flow = {}) {
  if (!alarm) return alarm;
  const saved = flow instanceof Map ? flow.get(alarm.id) : flow[alarm.id];
  return {
    ...alarm,
    eventState: saved?.eventState || alarm.eventState || 'PENDING_VERIFICATION',
    disposalStage: saved?.disposalStage || alarm.disposalStage || 'none',
    handoff: !!(saved?.handoff ?? alarm.handoff)
  };
}

/** 当前应显示的流程按钮：误报与反制并列；处置完成后显示处罚交接。 */
export function uavProcessActions(alarm) {
  if (!alarm || alarm.eventState === 'FALSE_POSITIVE' || alarm.handoff) return [];
  if (alarm.disposalStage === 'jamming' || alarm.disposalStage === 'completed') return ['punish'];
  if (alarm.disposalStage === 'requested') return [];
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
