import { onMounted, onUnmounted } from 'vue';
import { onDataChange } from '@/services/realtime.js';

/* 页面订阅后端数据变化信号并重读。
   - 同一时刻只跑一次重读，期间再来的信号合并成结束后的一次；两次重读至少间隔 minIntervalMs。
   - 页面隐藏时不读，回到前台再补一次。
   - reload(topics) 收到合并后的变化类别（"*" 表示全部），应是页面已有的“按当前筛选和分页重读”，
     不重置用户的筛选、分页或选中项。 */
export function useRealtimeRefresh(topics, reload, { minIntervalMs = 1_000 } = {}) {
  let running = false;
  let lastAt = 0;
  let timer = null;
  let stop = null;
  let changed = new Set();

  async function run() {
    timer = null;
    if (document.hidden || running || !changed.size) return;
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) { timer = setTimeout(run, wait); return; }
    running = true;
    lastAt = Date.now();
    const batch = [...changed];
    changed = new Set();
    try { await reload(batch); } catch { /* 页面自己的 reload 负责显示错误 */ }
    finally {
      running = false;
      if (changed.size && !timer) timer = setTimeout(run, 0);
    }
  }

  function trigger(received = ['*']) {
    received.forEach(topic => changed.add(topic));
    if (!timer && !running) timer = setTimeout(run, 0);
  }
  function onVisible() { if (!document.hidden && changed.size) trigger([]); }

  onMounted(() => {
    stop = onDataChange(topics, trigger);
    document.addEventListener('visibilitychange', onVisible);
  });
  onUnmounted(() => {
    stop?.();
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  });
  return { trigger };
}
