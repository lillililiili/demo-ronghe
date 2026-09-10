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
    if (!response.ok) throw new ApiError(`服务返回异常（状态码 ${response.status}）`, 'HTTP_ERROR', response.status);
    return response;
  }
  let envelope;
  try { envelope = await response.json(); }
  catch { throw new ApiError('服务响应格式无效', 'INVALID_RESPONSE', response.status); }
  if (!response.ok || envelope?.ok !== true) {
    const error = envelope?.error || {};
    throw new ApiError(error.message || `请求失败（HTTP ${response.status}）`, error.code || 'REQUEST_FAILED', response.status);
  }
  return envelope.data;
}

export async function apiRequest(path, options = {}) {
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
    throw new ApiError('无法连接后端服务，请确认服务已启动后重试。', 'NETWORK_ERROR', 0);
  }
  try {
    return await decode(response);
  } catch (error) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new CustomEvent('api:unauthorized', { detail: error }));
    throw error;
  }
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
    if (controller.signal.aborted) throw new ApiError('请求超时，请核对最新状态。', 'TIMEOUT', 408);
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
  catch { throw new ApiError('无法连接后端服务，请稍后重试。', 'NETWORK_ERROR', 0); }
  if (!response.ok) {
    await decode(response);
    return null;
  }
  return response.blob();
}

export async function apiBinary(path) {
  const headers = new Headers({ Accept: '*/*' });
  const token = readSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let response;
  try { response = await fetch(`${API_BASE}${path}`, { headers }); }
  catch { throw new ApiError('无法连接后端服务，请稍后重试。', 'NETWORK_ERROR', 0); }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    await decode(response);
    return null;
  }
  if (!response.ok) throw new ApiError(`服务返回异常（状态码 ${response.status}）`, 'HTTP_ERROR', response.status);
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="?([^"]+)"?/i.exec(disposition);
  const filename = decodeURIComponent((utf && utf[1]) || (plain && plain[1]) || 'download');
  return { blob, filename };
}
