const publicBase = String(import.meta.env.APP_PUBLIC_API_BASE_URL || '/api').replace(/\/$/, '');
const API_BASE = publicBase.endsWith('/v1') ? publicBase : `${publicBase}/v1`;
const SESSION_KEY = 'dongying.api.session.v1';

export class ApiError extends Error {
  constructor(message, code = 'REQUEST_FAILED', status = 0) {
    super(message || '请求失败');
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function readSessionToken() {
  try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}

export function writeSessionToken(token) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
    return true;
  } catch { return false; }
}

function idempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function decode(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) throw new ApiError('系统暂时无法处理，请稍后重试；仍有问题请联系管理员。', 'HTTP_ERROR', response.status);
    return response;
  }
  let envelope;
  try { envelope = await response.json(); }
  catch { throw new ApiError('系统返回的数据无法读取，请刷新页面；仍有问题请联系管理员。', 'INVALID_RESPONSE', response.status); }
  if (!response.ok || envelope?.ok !== true) {
    const error = envelope?.error || {};
    throw new ApiError(error.message || '操作未完成，请刷新后查看最新状态。', error.code || 'REQUEST_FAILED', response.status);
  }
  return envelope.data;
}

const inflightGets = new Map();

function getDedupeKey(path, options) {
  const method = String(options.method || 'GET').toUpperCase();
  if (method !== 'GET' || options.body != null || options.mutation || options.dedupe === false) return '';
  return path;
}

export async function apiRequest(path, options = {}) {
  const key = getDedupeKey(path, options);
  if (key) {
    const pending = inflightGets.get(key);
    if (pending) return pending;
  }
  const run = sendRequest(path, options);
  if (key) {
    inflightGets.set(key, run);
    const clear = () => { if (inflightGets.get(key) === run) inflightGets.delete(key); };
    // 清理分支同时消费拒绝，避免网络错误已由调用方处理后又产生悬空 rejected Promise。
    run.then(clear, clear);
  }
  return run;
}

async function sendRequest(path, options) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (options.body != null && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const token = readSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.mutation) headers.set('Idempotency-Key', options.idempotencyKey || idempotencyKey());

  let response;
  try {
    const body = options.body == null || options.body instanceof FormData ? options.body : JSON.stringify(options.body);
    response = await fetch(`${API_BASE}${path}`, { ...options, headers, body });
  } catch {
    throw new ApiError('暂时连不上系统，请检查网络后刷新；刚提交过操作的，请先查看是否已保存。', 'NETWORK_ERROR', 0);
  }
  try {
    return await decode(response);
  } catch (error) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new CustomEvent('api:unauthorized', { detail: error }));
    throw error;
  }
}

/** 限制并发，避免一页同时打出几十个只读请求把连接打满。 */
export async function mapPool(items, limit, mapper) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return [];
  const n = Math.max(1, Number(limit) || 1);
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next;
      next += 1;
      out[i] = await mapper(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, () => worker()));
  return out;
}

/* 把非空查询参数序列化为 ?a=b；各业务 api 共用，避免每个文件各写一份。 */
export function buildQuery(values = {}) {
  const search = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

/* 带超时的请求：主动中止统一抛 TIMEOUT/408，与断网 NETWORK_ERROR 区分。
   写请求超时属于“结果未知”，页面必须保留幂等键并回读服务端，不能当作失败换键重试。 */
export async function apiRequestTimed(path, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try { return await apiRequest(path, { ...options, signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted) throw new ApiError('系统响应超时，请刷新后查看最新记录；刚提交过的操作可能已保存，请勿重复提交。', 'TIMEOUT', 408);
    throw error;
  } finally { globalThis.clearTimeout(timeout); }
}

/* 写请求的“结果未知”判定：409 冲突、超时、断网都可能已在服务端落库。 */
export function isUncertainOutcome(error) {
  return !!error && (error.status === 409 || error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR');
}

export async function apiDownload(path) {
  const headers = new Headers({ Accept: 'text/csv' });
  const token = readSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { headers }); }
  catch { throw new ApiError('暂时连不上系统，请检查网络后重试。', 'NETWORK_ERROR', 0); }
  if (!response.ok) {
    await decode(response);
    return null;
  }
  return response.blob();
}

export async function apiBinary(path, { signal, maxBytes } = {}) {
  const headers = new Headers({ Accept: '*/*' });
  const token = readSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { headers, signal, cache: 'no-store' }); }
  catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError('暂时连不上系统，请检查网络后重试。', 'NETWORK_ERROR', 0);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    try { await decode(response); }
    catch (error) {
      if (response.status === 401) window.dispatchEvent(new CustomEvent('api:unauthorized', { detail: error }));
      throw error;
    }
  }
  if (maxBytes && Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new ApiError('文件超过预览大小上限，可按权限下载原件。', 'FILE_TOO_LARGE', 413);
  }
  // 成功 JSON 是证据原件，不能把它误当 {ok,data,error} 接口包装。
  let blob;
  if (maxBytes && response.body) {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new ApiError('文件超过预览大小上限，可按权限下载原件。', 'FILE_TOO_LARGE', 413);
        }
        chunks.push(value);
      }
      blob = new Blob(chunks, { type: contentType });
    } finally { reader.releaseLock(); }
  } else blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^"]+)"?/i.exec(disposition);
  const filename = decodeURIComponent((utf && utf[1]) || (plain && plain[1]) || 'download');
  return { blob, filename, contentType };
}
