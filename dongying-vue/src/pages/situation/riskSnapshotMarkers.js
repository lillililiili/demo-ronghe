import { planRiskLocation } from '../../services/riskMapGeometry.js';
import { riskMatchesPlan } from '../../services/situationData.js';

// 只消费已按权限、来源与日期读取的风险；任务上下文必须同时匹配计划与航线版本。
export function riskSnapshotMarkers(groups, { pendingRiskIds = [], selectedPlan = null, selectedGroupId = '' } = {}) {
  const pending = new Set(pendingRiskIds);
  return groups.flatMap(group => {
    if (!group.members.some(risk => pending.has(risk.riskId) || riskMatchesPlan(risk, selectedPlan))
      && group.groupId !== selectedGroupId) return [];
    if (!['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(group.riskType)) return [];
    const location = planRiskLocation({ risk_type: group.riskType, space_fact: group.spaceFact });
    if (!location) return [];
    return [{ id: group.groupId, anchor: location.anchor, group,
      subtypeCode: group.spaceFact?.subtypeCode, title: group.spaceFact?.subtypeName || '异物',
      occurredAt: group.occurredAt, sourceMode: group.sourceMode }];
  });
}

export function riskSnapshotTime(value) {
  if (!Number.isFinite(value) || value <= 0) return '时间未知';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
