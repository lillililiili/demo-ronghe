import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { riskApi } from '@/services/riskApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { polygonRings } from '@/services/situationData.js';
import { loadRiskPages, pointRelation, riskSnapshotPoint } from './airspaceRiskModel.js';

export function useAirspaceRisks(district, selected) {
  const rows = ref([]), loading = ref(false), error = ref(''), errorStatus = ref(0);
  const severity = ref(''), state = ref(''), riskType = ref(''), onlySelected = ref(false), showLayer = ref(true);
  const activeId = ref('');
  const occurred = ref(null);
  const timeError = computed(() => occurred.value != null && (!Array.isArray(occurred.value) || occurred.value.length !== 2
    || !occurred.value.every(Number.isFinite) || occurred.value[0] >= occurred.value[1]) ? '开始时间必须早于结束时间。' : '');
  const districts = ref([]);
  const canRead = computed(() => hasPermission('risk:read'));
  let token = 0;

  async function reload() {
    const current = ++token;
    rows.value = []; activeId.value = ''; error.value = ''; errorStatus.value = 0;
    loading.value = false;
    if (!canRead.value) return;
    loading.value = true;
    try {
      const data = await loadRiskPages(riskApi.listRisks, district.value ? { district_id: district.value } : {}, () => current === token);
      if (current !== token || !data) return;
      rows.value = data;
    } catch (reason) {
      if (current !== token) return;
      errorStatus.value = reason.status || 0;
      error.value = reason.status === 403 ? '当前账号没有查看空域风险的权限。'
        : reason.status === 401 ? '登录已失效，请重新登录。'
          : reason.message || '风险读取失败，请重试。';
    } finally { if (current === token) loading.value = false; }
  }

  const polygons = computed(() => polygonRings(selected.value?.current_version?.boundary));
  const locatedRows = computed(() => rows.value.map(risk => {
    const point = riskSnapshotPoint(risk);
    return { ...risk, point, relation: pointRelation(point, polygons.value) };
  }));
  const matchingRows = computed(() => locatedRows.value.filter(risk => (!severity.value || risk.severity === severity.value)
    && (!state.value || risk.state === state.value) && (!riskType.value || risk.risk_type === riskType.value)
    && !timeError.value && (!occurred.value || (risk.occurred_at != null
      && risk.occurred_at >= occurred.value[0] && risk.occurred_at < occurred.value[1]))));
  const inSelected = computed(() => matchingRows.value.filter(risk => ['INSIDE', 'BOUNDARY'].includes(risk.relation)));
  const unlocated = computed(() => matchingRows.value.filter(risk => !risk.point).length);
  const filtered = computed(() => [...(onlySelected.value && selected.value ? inSelected.value : matchingRows.value)]
    .sort((a, b) => (b.occurred_at ?? b.received_at ?? 0) - (a.occurred_at ?? a.received_at ?? 0)));
  const mapPriority = risk => risk.risk_id === activeId.value ? 10 : risk.state === 'EXCLUDED' ? 0
    : ({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[risk.severity] || 0);
  const mapRows = computed(() => showLayer.value ? filtered.value.filter(risk => risk.point)
    .sort((a, b) => mapPriority(a) - mapPriority(b)) : []);
  const pending = computed(() => filtered.value.filter(risk => risk.state === 'PENDING_VERIFICATION').length);
  // 合并列表负责筛选与取消选择；详情从原记录读取，避免两套筛选争抢选中项。
  const active = computed(() => locatedRows.value.find(risk => risk.risk_id === activeId.value) || null);
  watch([district, canRead], reload, { immediate: true });
  let districtToken = 0;
  async function loadDistricts() {
    const current = ++districtToken;
    districts.value = [];
    if (!canRead.value) return;
    try {
      const data = await riskApi.listDistricts();
      if (current === districtToken) districts.value = data || [];
    } catch { /* 字典失败不影响风险读取；父页可用已读记录中的区县。 */ }
  }
  function accessChanged() { reload(); loadDistricts(); }
  onMounted(() => { loadDistricts(); window.addEventListener('auth-access-change', accessChanged); });
  // 点选与刷新详情不启用范围筛选；只有清除选中时退出已失去对象的范围。
  watch(selected, value => { if (!value) onlySelected.value = false; });
  onUnmounted(() => { token++; districtToken++; window.removeEventListener('auth-access-change', accessChanged); });
  return { rows, locatedRows, filtered, loading, error, errorStatus, canRead, severity, state, riskType, onlySelected,
    showLayer, activeId, active, polygons, inSelected, unlocated, mapRows, pending, districts, reload, occurred, timeError };
}
