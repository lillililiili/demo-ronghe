import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { apiRequestTimed, buildQuery } from '@/services/apiClient.js';
import { hasPermission } from '@/services/accessControl.js';
import { polygonRings } from '@/services/situationData.js';
import { recentMonitoredTargets } from './airspaceRiskModel.js';
import { buildAirspaceDemo, DEMO_FRAMES } from './airspaceMonitorDemo.js';

// 五分钟仅是页面展示窗口，不是风险阈值，也不代表目标仍然在场。
export function useAirspaceMonitor(district, selected, onlySelected = computed(() => !!selected.value)) {
  const rows = ref([]), loading = ref(false), error = ref(''), errorStatus = ref(0);
  const updatedAt = ref(null), now = ref(Date.now()), minutes = ref(5), showLayer = ref(true), activeId = ref('');
  // 本地开发默认展示用户要求的模拟场景；正式构建仍默认读取接口，失败绝不自动切模拟。
  const mode = ref(import.meta.env.DEV ? 'demo' : 'live'), scene = ref(''), frame = ref(0), paused = ref(false), showHeat = ref(false);
  const isDemo = computed(() => mode.value === 'demo');
  const canRead = computed(() => hasPermission('target:read'));
  const polygons = computed(() => polygonRings(selected.value?.current_version?.boundary));
  let token = 0, timer;

  async function reload() {
    const current = ++token;
    loading.value = false; error.value = ''; errorStatus.value = 0;
    if (!canRead.value) { rows.value = []; updatedAt.value = null; return; }
    if (isDemo.value) {
      now.value = Date.now();
      rows.value = buildAirspaceDemo(frame.value, now.value).filter(row => !district.value || row.district_id === district.value);
      updatedAt.value = now.value;
      return;
    }
    loading.value = true;
    const to = Date.now(), from = to - minutes.value * 60_000;
    try {
      const items = [];
      for (let page = 1; ; page++) {
        const data = await apiRequestTimed(`/targets${buildQuery({ district_id: district.value,
          seen_from: from, seen_to: to, page, size: 100 })}`);
        if (current !== token) return;
        if (!Array.isArray(data?.items) || !Number.isInteger(data.total) || data.total < 0
          || (!data.items.length && items.length < data.total)) throw new Error('监测目标读取不完整，请重试。');
        items.push(...data.items);
        if (items.length >= data.total) break;
      }
      rows.value = [...new Map(items.map(row => [row.target_id, row])).values()];
      now.value = Date.now(); updatedAt.value = now.value;
    } catch (reason) {
      if (current !== token) return;
      rows.value = []; updatedAt.value = null;
      errorStatus.value = reason.status || 0;
      error.value = reason.status === 403 ? '当前账号没有查看监测目标的权限。'
        : reason.status === 401 ? '登录已失效，请重新登录。' : reason.message || '监测数据读取失败，请重试。';
    } finally { if (current === token) loading.value = false; }
  }

  const recent = computed(() => recentMonitoredTargets(rows.value, now.value, minutes.value, polygons.value));
  const filtered = computed(() => recent.value.filter(row => (!onlySelected.value || !selected.value || ['INSIDE', 'BOUNDARY'].includes(row.relation))
    && (!isDemo.value || !scene.value || row.demo?.scene.id === scene.value)));
  const unlocated = computed(() => recent.value.filter(row => !row.point).length);
  const mapRows = computed(() => showLayer.value ? filtered.value.filter(row => row.point) : []);
  // 当前选择由合并列表统一维护，保留同一风险关联目标的最近位置。
  const active = computed(() => recent.value.find(row => row.target_id === activeId.value));
  function resetAndReload() { rows.value = []; updatedAt.value = null; reload(); }
  watch([district, minutes, canRead, mode], resetAndReload, { immediate: true });
  function stepDemo() { frame.value = (frame.value + 1) % DEMO_FRAMES; reload(); }
  onMounted(() => {
    window.addEventListener('auth-access-change', resetAndReload);
    timer = setInterval(() => {
      if (loading.value || document.hidden) return;
      if (isDemo.value) { if (!paused.value) stepDemo(); }
      else { now.value = Date.now(); reload(); }
    }, 10_000);
  });
  onUnmounted(() => { token++; clearInterval(timer); window.removeEventListener('auth-access-change', resetAndReload); });
  return { rows, recent, filtered, unlocated, polygons, mapRows, activeId, active,
    loading, error, errorStatus, canRead, updatedAt, minutes, showLayer, reload,
    mode, isDemo, scene, frame, paused, showHeat, stepDemo };
}
