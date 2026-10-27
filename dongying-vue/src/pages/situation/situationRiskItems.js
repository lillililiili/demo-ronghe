import { coverageContainsPoint } from '@/services/situationData.js';
import { riskCaseOf, riskStageLabel } from '@/services/riskCaseView.js';
import { displayTargetNo } from '@/ui/deviceNumber.js';
import { ruleReasonText } from '@/ui/legalityReviewModal.js';

export const riskSelectionKey = row => row?.riskCaseId ? `risk:${row.riskCaseId}` : row?.key || `event:${row?.eventId || ''}`;
export function candidateFromRisk(item, targets = []) {
  if (item.kind !== 'UAV' || !item.event_id) return null;
  const target = targets.find(row => row.targetId === item.target_id);
  return { key: item.risk_case_id ? `risk:${item.risk_case_id}` : `event:${item.event_id}`,
    riskCaseId: item.risk_case_id, riskCaseVersion: item.risk_case_version,
    eventId: item.event_id, eventVersion: item.event_version, alarmId: item.alarm_id,
    targetId: item.target_id, mapId: target?.id, label: displayTargetNo(item.target_no || target?.id) || '目标编号未提供',
    eventState: item.state, lon: target?.lon, lat: target?.lat, airspaceId: item.area_id, airspaceName: item.area_name,
    reasonText: item.reason_text || ruleReasonText(item.reason_code), riskStageText: ({PREDICTED:'预测预警',ENTERED:'实测入区',OBSERVED:'实测风险',UNKNOWN:'依据不足',CLEARED:'已避开',ENDED:'已结束'})[item.stage] || '',
    unavailable: !target || target.posValid === false || (item.current_status && item.current_status !== 'CURRENT')
      || !['PREDICTED','ENTERED','OBSERVED'].includes(item.stage), riskItem: item };
}
export function riskFromAlarm(alarm, target) {
  const risk = riskCaseOf(alarm), eventId = alarm.eventId || alarm.event_id;
  return { key: risk?.risk_case_id ? `risk:${risk.risk_case_id}` : `event:${eventId}`, kind: 'UAV',
    risk_case_id: risk?.risk_case_id, risk_case_version: risk?.version, event_id: risk?.action_event_id || eventId,
    event_version: risk?.action_event_version, alarm_id: alarm.alarmId || alarm.alarm_id,
    target_id: target?.targetId || alarm.targetInternalId, target_no: target?.id || alarm.targetId,
    area_id: risk?.airspace_id, area_name: risk?.airspace_name,
    stage: risk?.stage || 'OBSERVED', state: risk?.verification_status || alarm.eventState,
    severity: alarm.severity || ({高:'HIGH',中:'MEDIUM',低:'LOW'})[alarm.level],
    reason_text: (alarm.violationReasons || []).map(ruleReasonText).filter(Boolean).join('、') || alarm.reasonText || alarm.type,
    occurred_at: alarm.ts, updated_at: risk?.updated_at || alarm.ts, source_mode: alarm.sourceMode, simulated: alarm.simulated,
    position: target?.posValid !== false && Number.isFinite(target?.lon) && Number.isFinite(target?.lat)
      ? {longitude:target.lon,latitude:target.lat,observed_at:target.observedAt,basis:'CURRENT_MEAS'} : null,
    risk_stage_text: riskStageLabel(alarm) };
}
export function riskCoverageText(item, device, targets = []) {
  if (!device?.coverage || !Number.isFinite(device.lon) || !Number.isFinite(device.lat)) return '光电覆盖关系未知';
  const target = targets.find(row => row.targetId === item.target_id);
  const point = target?.posValid !== false && Number.isFinite(target?.lon) && Number.isFinite(target?.lat) ? target
    : item.position?.basis === 'EVENT_SNAPSHOT' ? {lon: Number(item.position.longitude), lat: Number(item.position.latitude)} : null;
  if (!point) return item.kind === 'WEATHER' ? '气象影响范围见地图依据' : '当前位置未确认';
  const within = coverageContainsPoint({...device,coverage:{...device.coverage,status:'available'}},point);
  const suffix = !target ? '（发现时位置）' : '';
  return within ? `本台光电覆盖内${suffix}` : `本台光电覆盖范围外${suffix}`;
}
