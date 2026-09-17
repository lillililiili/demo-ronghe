import { onMounted, onUnmounted, ref, watch } from 'vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';

// 轮询只读状态，短信及电话通知的触发与重试调度始终由后台负责。
export function useUavAdvisory(eventId, onUpdated = () => {}, interval = 5000) {
  const data = ref(null), loading = ref(false), error = ref('');
  let alive = true, sequence = 0, timer;
  const clear = () => { clearTimeout(timer); timer = null; };
  function schedule() {
    clear();
    if (alive && eventId() && !document.hidden) timer = setTimeout(() => load(true), interval);
  }
  async function load(background = false) {
    clear();
    const token = ++sequence, id = eventId();
    if (!id || !alive) return;
    if (!background || !data.value) loading.value = true;
    try {
      const result = await uavAdvisoryApi.get(id);
      if (!alive || token !== sequence || id !== eventId()) return;
      data.value = result; error.value = '';
      onUpdated(result);
    } catch (e) {
      if (alive && token === sequence) error.value = [404, 501].includes(e.status)
        ? '处置记录接口暂不可用，请稍后重试。' : e.message || '读取处置记录失败。';
    } finally {
      if (alive && token === sequence) { loading.value = false; schedule(); }
    }
  }
  const visibility = () => { clear(); if (!document.hidden) void load(true); };
  watch(eventId, () => { ++sequence; clear(); data.value = null; error.value = ''; loading.value = false; void load(); }, { immediate: true });
  onMounted(() => document.addEventListener('visibilitychange', visibility));
  onUnmounted(() => { alive = false; ++sequence; clear(); document.removeEventListener('visibilitychange', visibility); });
  return { data, loading, error, load };
}
