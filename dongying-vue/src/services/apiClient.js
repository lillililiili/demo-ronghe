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
    if (!response.ok) throw new ApiError(`服务返回异常（HTTP ${response.status}）`, 'HTTP_ERROR', response.status);
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
