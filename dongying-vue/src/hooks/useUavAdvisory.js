import { onMounted, onUnmounted, ref, watch } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { refreshFailureText, shouldRetryRefresh, useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';

// SSE 更新只读状态；观察窗口跨时点补读结论，短信、电话触发仍由后台负责。
export function useUavAdvisory(eventId, onUpdated = () => {}, interval = 5000) {
  const data = ref(null), loading = ref(false), error = ref('');
  let alive = true, sequence = 0, timer, failures = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  // 断网时退避；正常成功后等待 SSE。观察窗口到期可能没有写库，仅 WATCHING 阶段保留时间检查。
  const nextDelay = () => failures ? Math.min(Math.max(interval, 2000) * 2 ** (failures - 1), 15000) : interval;
  function schedule() {
    clear();
    if ((failures || data.value?.notify_phase === 'WATCHING') && alive && eventId() && !document.hidden) timer = setTimeout(() => load(true), nextDelay());
  }
  async function load(background = false) {
    clear();
    const token = ++sequence, id = eventId();
    if (!id || !alive) return;
    if (!background || !data.value) loading.value = true;
    try {
      const result = await uavAdvisoryApi.get(id);
      if (!alive || token !== sequence || id !== eventId()) return;
      data.value = result; error.value = ''; failures = 0;
      onUpdated(result);
    } catch (e) {
      if (alive && token === sequence) {
        const retry = shouldRetryRefresh(e);
        failures = retry ? failures + 1 : 0;
        if ([401, 403, 404].includes(e.status)) data.value = null;
        error.value = [404, 501].includes(e.status) ? '处置记录接口暂不可用，请稍后重试。'
          : retry ? `处置记录暂时读不到（${refreshFailureText(e)}），正在自动重试。` : e.message || '读取处置记录失败。';
      }
    } finally {
      if (alive && token === sequence) { loading.value = false; schedule(); }
    }
  }
  useRealtimeRefresh(['alarm', 'target', 'disposal', 'punishment'], () => load(true), { minIntervalMs: interval });
  const visibility = () => { clear(); if (!document.hidden) void load(true); };
  watch(eventId, () => { ++sequence; clear(); failures = 0; data.value = null; error.value = ''; loading.value = false; void load(); }, { immediate: true });
  onMounted(() => document.addEventListener('visibilitychange', visibility));
  onUnmounted(() => { alive = false; ++sequence; clear(); document.removeEventListener('visibilitychange', visibility); });
  return { data, loading, error, load };
}
