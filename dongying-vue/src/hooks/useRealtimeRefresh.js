import { onMounted, onUnmounted } from 'vue';
import { onDataChange } from '@/services/realtime.js';

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/** 断网、超时或服务暂时不可用（5xx）值得再读；登录失效、没有权限、记录不存在等再读也不会好。 */
export function shouldRetryRefresh(error) {
  if (error?.code === 'SESSION_CHANGED') return false;
  const status = Number(error?.status) || 0;
  return !status || status === 408 || status === 429 || status >= 500;
}

/** 自动刷新失败时给用户看的简短原因（接在“自动刷新失败”后面）：断网、超时、服务暂不可用说清楚，其余用接口的说明。 */
export function refreshFailureText(error, fallback = '读取失败') {
  if (error?.code === 'NETWORK_ERROR') return '暂时连不上系统';
  if (error?.code === 'TIMEOUT') return '服务响应超时';
  if (Number(error?.status) >= 500) return '服务暂时不可用';
  return String(error?.message || fallback).replace(/[。.！!；;，,\s]+$/, '');
}

/* 页面订阅后端数据变化信号并重读。
   - 同一时刻只跑一次重读，期间再来的信号合并成结束后的一次；两次重读至少间隔 minIntervalMs。
   - 页面隐藏时不读，回到前台再补一次。
   - reload(topics) 收到合并后的变化类别（"*" 表示全部），应是页面已有的“按当前筛选和分页重读”，
     不重置用户的筛选、分页或选中项；读取失败时应抛出错误（页面自己负责显示）。
   - 断网、超时或 5xx 失败后按 2、4、8……最长 30 秒退避再读同一批变化；
     重连或网络恢复（recovery）时立即再读，不等退避结束。 */
export function useRealtimeRefresh(topics, reload, { minIntervalMs = 1_000 } = {}) {
  let running = false;
  let lastAt = 0;
  let timer = null;
  let stop = null;
  let changed = new Set();
  let retryDelay = 0;
  let retryAt = 0;

  async function run() {
    timer = null;
    if (document.hidden || running || !changed.size) return;
    const wait = Math.max(lastAt + minIntervalMs, retryAt) - Date.now();
    if (wait > 0) { timer = setTimeout(run, wait); return; }
    running = true;
    lastAt = Date.now();
    const batch = [...changed];
    changed = new Set();
    try {
      await reload(batch);
      retryDelay = 0;
      retryAt = 0;
    } catch (error) {
      // 页面自己的 reload 负责显示错误；暂时性失败把这批变化留到退避后再读。
      if (shouldRetryRefresh(error)) {
        batch.forEach(topic => changed.add(topic));
        retryDelay = Math.min(retryDelay ? retryDelay * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
        retryAt = Date.now() + retryDelay;
      }
    } finally {
      running = false;
      if (changed.size && !timer) timer = setTimeout(run, 0);
    }
  }

  function trigger(received = ['*'], { recovery = false } = {}) {
    received.forEach(topic => changed.add(topic));
    if (recovery) {
      retryDelay = 0;
      retryAt = 0;
      if (timer && !running) { clearTimeout(timer); timer = null; }
    }
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
