import { computed, ref, watch } from 'vue';

// 两路数据先按明确的风险编号关联，再统一筛选；不把同一目标的不同风险合并。
export function useAirspaceRiskList(monitor, risks, selected) {
  const page = ref(1), size = ref(10);
  const candidates = computed(() => {
    const records = new Map((risks.canRead ? risks.locatedRows : []).map(risk => [risk.risk_id, {
      key: `risk:${risk.risk_id}`, risk, target: null,
      type: risk.risk_type === 'FOREIGN_OBJECT' ? 'SPACE_OBJECT' : risk.risk_type,
      severity: risk.severity, state: risk.state, at: risk.occurred_at, activeRisk: window.UI.abnormalActive(risk),
    }]));
    const observations = [];
    for (const target of monitor.canRead ? monitor.recent : []) {
      const linked = !target.demo && records.get(target.risk_summary?.risk_id);
      if (linked) { linked.target = target; continue; }
      observations.push({ key: `target:${target.target_id}`, target, risk: null,
        type: target.demo ? 'SPACE_OBJECT' : '',
        severity: target.demo?.severity || target.risk_summary?.severity || '',
        state: target.demo ? 'DEMO' : target.risk_summary?.state || 'UNRECORDED',
        at: target.risk_summary?.occurred_at ?? target.last_seen_at,
        // 历史摘要和演示等级不能代替当前风险记录。
        activeRisk: window.UI.abnormalActive({ ...target, risk_summary: null }) });
    }
    return [...records.values(), ...observations];
  });
  const rows = computed(() => candidates.value.filter(row => {
    if (risks.timeError) return false;
    if (risks.onlySelected && selected.value
      && ![row.risk?.relation, row.target?.relation].some(value => ['INSIDE', 'BOUNDARY'].includes(value))) return false;
    if (monitor.isDemo && monitor.scene && row.target?.demo && row.target.demo.scene.id !== monitor.scene) return false;
    if (risks.riskType && (row.type || 'UNCLASSIFIED') !== risks.riskType) return false;
    if (risks.severity && row.severity !== risks.severity) return false;
    if (risks.state && row.state !== risks.state) return false;
    return !risks.occurred || (row.at != null && row.at >= risks.occurred[0] && row.at < risks.occurred[1]);
  }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || a.key.localeCompare(b.key)));
  const active = computed(() => rows.value.find(row =>
    (risks.activeId && row.risk?.risk_id === risks.activeId)
    || (monitor.activeId && row.target?.target_id === monitor.activeId)) || null);
  const pageRows = computed(() => rows.value.slice((page.value - 1) * size.value, page.value * size.value));
  const targetMapRows = computed(() => monitor.showLayer ? rows.value.map(row => row.target).filter(row => row?.point) : []);
  const mapPriority = risk => risk.risk_id === risks.activeId ? 10 : risk.state === 'EXCLUDED' ? 0
    : ({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[risk.severity] || 0);
  const riskMapRows = computed(() => risks.showLayer ? rows.value.map(row => row.risk).filter(row => row?.point)
    .sort((a, b) => mapPriority(a) - mapPriority(b)) : []);
  const unlocated = computed(() => rows.value.filter(row => !row.risk?.point && !row.target?.point).length);
  function revealActive() {
    const index = active.value ? rows.value.findIndex(row => row.key === active.value.key) : -1;
    if (index >= 0) page.value = Math.floor(index / size.value) + 1;
    else page.value = Math.min(page.value, Math.max(1, Math.ceil(rows.value.length / size.value)));
  }
  watch([() => risks.riskType, () => risks.severity, () => risks.state, () => risks.occurred,
    () => risks.onlySelected, selected, () => monitor.mode, () => monitor.scene, () => monitor.minutes], () => { page.value = 1; });
  watch(rows, value => {
    if (!value.some(row => row.risk?.risk_id === risks.activeId)) risks.activeId = '';
    if (!value.some(row => row.target?.target_id === monitor.activeId)) monitor.activeId = '';
    page.value = Math.min(page.value, Math.max(1, Math.ceil(value.length / size.value)));
  });
  watch([() => risks.activeId, () => monitor.activeId, size], revealActive);
  function closeDetail() { risks.activeId = ''; monitor.activeId = ''; }
  return { rows, pageRows, page, size, active, targetMapRows, riskMapRows, unlocated, closeDetail };
}
