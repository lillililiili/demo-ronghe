import { onMounted, onUnmounted, ref, watch } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';
import { refreshFailureText, shouldRetryRefresh } from '@/hooks/useRealtimeRefresh.js';

// 轮询只读状态，短信及电话通知的触发与重试调度始终由后台负责。
export function useUavAdvisory(eventId, onUpdated = () => {}, interval = 5000) {
  const data = ref(null), loading = ref(false), error = ref('');
  let alive = true, sequence = 0, timer, failures = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  // 断网、超时或后台重启（5xx）时按 2、4、8……最长 15 秒退避再读（与光电追踪卡片一致），读到后回到原来的间隔（BUG-07）。
  const nextDelay = () => failures ? Math.min(Math.max(interval, 2000) * 2 ** (failures - 1), 15000) : interval;
  function schedule() {
    clear();
    if (alive && eventId() && !document.hidden) timer = setTimeout(() => load(true), nextDelay());
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
        error.value = [404, 501].includes(e.status) ? '处置记录接口暂不可用，请稍后重试。'
          : retry ? `处置记录暂时读不到（${refreshFailureText(e)}），正在自动重试。` : e.message || '读取处置记录失败。';
      }
    } finally {
      if (alive && token === sequence) { loading.value = false; schedule(); }
    }
  }
  const visibility = () => { clear(); if (!document.hidden) void load(true); };
  watch(eventId, () => { ++sequence; clear(); failures = 0; data.value = null; error.value = ''; loading.value = false; void load(); }, { immediate: true });
  onMounted(() => document.addEventListener('visibilitychange', visibility));
  onUnmounted(() => { alive = false; ++sequence; clear(); document.removeEventListener('visibilitychange', visibility); });
  return { data, loading, error, load };
}
