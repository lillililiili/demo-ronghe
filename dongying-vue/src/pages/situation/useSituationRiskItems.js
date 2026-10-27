import { onUnmounted, ref, watch } from 'vue';
import { apiRequest, buildQuery } from '@/services/apiClient.js';
import { authSession } from '@/services/auth.js';

/** One in-flight refresh, server pagination/counts and no last-success-as-current fallback. */
export function useSituationRiskItems(enabled) {
  const kind = ref('ALL'), page = ref(1), view = ref('ACTIVE');
  const rows = ref([]), counts = ref({}), availability = ref({}), total = ref(null);
  const loading = ref(false), error = ref(''), revision = ref(0);
  let generation = 0, timer, controller, alive = true;
  async function refresh() {
    clearTimeout(timer);
    const token = ++generation;
    controller?.abort();
    if (!alive || !enabled.value) return;
    controller = new AbortController();
    const requestController=controller,deadline=setTimeout(()=>requestController.abort(),15000);
    loading.value = true;
    try {
      const result = await apiRequest(`/situation/risk-items${buildQuery({ kind: kind.value, page: page.value, size: 20, view: view.value })}`,
        { signal: controller.signal, dedupe: false });
      if (!alive || token !== generation) return;
      if (!Array.isArray(result?.items) || !Number.isInteger(result?.total)) throw new Error('风险列表响应不完整');
      rows.value = result.items; counts.value = result.counts || {}; availability.value = result.availability || {};
      total.value = result.total; error.value = ''; revision.value++;
      if (page.value > 1 && !rows.value.length && result.total < (page.value - 1) * 20 + 1) page.value = Math.max(1, Math.ceil(result.total / 20));
    } catch (cause) {
      if (!alive || token !== generation) return;
      rows.value = []; counts.value = {}; availability.value = {}; total.value = null;
      error.value = cause.message || '风险列表读取失败，请重试'; revision.value++;
    } finally {
      clearTimeout(deadline);
      if (alive && token === generation) { loading.value = false; timer = setTimeout(refresh, 5000); }
    }
  }
  function changeKind(value) { kind.value = value; page.value = 1; }
  function changeView(value) { view.value = value; page.value = 1; }
  watch([enabled, kind, page, view, authSession], () => {
    rows.value = []; total.value = null; error.value = ''; counts.value = {}; availability.value = {};
    if (enabled.value) refresh();
    else { ++generation; controller?.abort(); clearTimeout(timer); loading.value = false; }
  }, { immediate: true });
  onUnmounted(() => { alive = false; generation++; clearTimeout(timer); controller?.abort(); });
  return { kind, page, view, rows, counts, availability, total, loading, error, revision, refresh, changeKind, changeView };
}
