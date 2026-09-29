const STATE_ORDER = ['PENDING_VERIFICATION', 'PENDING_NOTIFICATION', 'NOTIFIED', 'ACKNOWLEDGED', 'EXCLUDED'];
const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

// 只聚合有完整事实的同一观测；接收时间、相似文字和距离不能充当事件身份。
// 不把相邻观测推断为持续事件，也不修改每个计划的核验/通知记录。
function observationKey(risk) {
  const fact = risk.spaceFact;
  const identity = [risk.targetInternalId, risk.routeVersionId, risk.sourceMode, risk.sourceCode,
    risk.ownerOrgId, risk.districtId, risk.riskType, risk.reasonCode, fact?.ruleVersionId, fact?.subtypeCode];
  if (!['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk.riskType) || !risk.planId
    || identity.some(value => !value) || !Number.isFinite(risk.observedAt)) return null;
  return JSON.stringify([...identity, risk.observedAt]);
}

export function groupRouteRisks(risks = []) {
  const groups = new Map();
  const seen = new Set();
  for (const risk of risks) {
    if (!risk?.riskId || seen.has(risk.riskId)) continue;
    seen.add(risk.riskId);
    const groupId = observationKey(risk) || `risk:${risk.riskId}`;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(risk);
  }
  return [...groups].map(([groupId, members]) => {
    const rank = row => { const index = STATE_ORDER.indexOf(row.state); return index < 0 ? -1 : index; };
    const ordered = members.slice().sort((a, b) => rank(a) - rank(b) || a.riskId.localeCompare(b.riskId));
    const highest = members.reduce((a, b) => (SEVERITY_RANK[b.severity] || 0) > (SEVERITY_RANK[a.severity] || 0) ? b : a);
    const stateCounts = Object.fromEntries([...new Set(ordered.map(row => row.state))]
      .map(state => [state, members.filter(row => row.state === state).length]));
    return { ...ordered[0], groupId, members: ordered, stateCounts,
      planCount: new Set(members.map(row => row.planId).filter(Boolean)).size,
      active: members.some(row => row.active), isNew: members.some(row => row.isNew),
      severity: highest.severity, level: highest.level };
  }).sort((a, b) => Number(b.active) - Number(a.active) || b.occurredAt - a.occurredAt || a.groupId.localeCompare(b.groupId));
}
