/* 实时数据变化信号（后端 /api/v1/realtime/events，SSE）。
   后端只推“哪类数据变了”（alarm/target/legality/risk/plan/airspace/device/disposal/evidence/punishment，
   "*" 表示全部），页面收到后经原有接口重读，权限仍由读取接口控制。
   EventSource 不能带 Bearer 头，这里用 fetch 读流；断线指数退避重连，重连成功后通知全部重读。
   推送不可用时退回每 15 秒通知一次重读，页面不会停在旧数据上。 */
import { readSessionToken } from './apiClient.js';

const publicBase = String(import.meta.env.APP_PUBLIC_API_BASE_URL || '/api').replace(/\/$/, '');
const API_BASE = publicBase.endsWith('/v1') ? publicBase : `${publicBase}/v1`;
const FALLBACK_MS = 15_000;

const subscribers = new Set();
let controller = null;
let connectedToken = '';
let connected = false;
let retryTimer = null;
let fallbackTimer = null;
let backoff = 1_000;
let started = false;
let hadConnection = false;

function emit(topics) {
  const set = new Set(topics);
  subscribers.forEach(sub => {
    if (set.has('*') || sub.topics.some(topic => set.has(topic))) sub.notify([...set]);
  });
}

function setConnected(value) {
  connected = value;
  if (value) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  } else if (!fallbackTimer && subscribers.size) {
    fallbackTimer = setInterval(() => emit(['*']), FALLBACK_MS);
  }
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

function handleEvent(block) {
  let name = 'message';
  const data = [];
  block.split('\n').forEach(line => {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  });
  if (name === 'ready') {
    backoff = 1_000;
    setConnected(true);
    // 首次连接时页面刚加载过数据；重连才可能错过信号，需要全部重读。
    if (hadConnection) emit(['*']);
    hadConnection = true;
  } else if (name === 'change') {
    try { emit(JSON.parse(data.join('\n')).topics || []); } catch { /* 忽略无法解析的信号 */ }
  }
}

async function connect() {
  clearTimeout(retryTimer);
  controller?.abort();
  const token = readSessionToken();
  connectedToken = token;
  if (!token || !subscribers.size) { setConnected(false); return; }
  const current = new AbortController();
  controller = current;
  try {
    const response = await fetch(`${API_BASE}/realtime/events`, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: current.signal
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const value = chunk.value;
      buffer += value.replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        handleEvent(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    }
  } catch {
    if (current.signal.aborted) return;
  }
  if (controller !== current) return;
  setConnected(false);
  scheduleReconnect();
}

function ensureStarted() {
  if (started || typeof window === 'undefined') return;
  started = true;
  // 登录、退出或换账号时按新会话重连。
  window.addEventListener('auth-access-change', () => {
    if (readSessionToken() !== connectedToken) { backoff = 1_000; connect(); }
  });
}

/** 订阅一组数据类别的变化；返回取消函数。 */
export function onDataChange(topics, handler) {
  ensureStarted();
  const sub = { topics: Array.isArray(topics) ? topics : [topics], notify: handler };
  subscribers.add(sub);
  if (subscribers.size === 1 || !controller) connect();
  else if (!connected) setConnected(false);
  return () => {
    subscribers.delete(sub);
    if (!subscribers.size) {
      controller?.abort();
      controller = null;
      clearTimeout(retryTimer);
      clearInterval(fallbackTimer);
      fallbackTimer = null;
      connected = false;
      hadConnection = false;
    }
  };
}

export function isRealtimeConnected() { return connected; }
