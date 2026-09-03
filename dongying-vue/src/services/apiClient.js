export const SESSION_TOKEN_KEY = 'dongying.auth.session.v1';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function sessionStorageRef() {
  try { return window.sessionStorage; } catch { return null; }
}

let sessionToken = (() => {
  try { return sessionStorageRef()?.getItem(SESSION_TOKEN_KEY) || null; } catch { return null; }
})();
let unauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null;
}

export function setSessionToken(token) {
  sessionToken = typeof token === 'string' && token ? token : null;
  try {
    const storage = sessionStorageRef();
    if (sessionToken) storage?.setItem(SESSION_TOKEN_KEY, sessionToken);
    else storage?.removeItem(SESSION_TOKEN_KEY);
    return !!storage;
  } catch {
    return false;
  }
}

export function getSessionToken() {
  return sessionToken;
}

export function clearSessionToken() {
  sessionToken = null;
  try { sessionStorageRef()?.removeItem(SESSION_TOKEN_KEY); } catch { /* 内存态仍已清除 */ }
}

function clearUnauthorizedSession() {
  clearSessionToken();
  unauthorizedHandler?.();
}

function errorFrom(status, payload) {
  const error = payload?.error;
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : (status ? 'HTTP_ERROR' : 'NETWORK_ERROR');
  const message = typeof error?.message === 'string' && error.message
    ? error.message
    : (status === 401 ? '登录状态已失效，请重新登录。' : `请求失败（HTTP ${status}）。`);
  return new ApiError(status, code, message);
}

export async function apiRequest(method, path, body) {
  const headers = { Accept: 'application/json' };
  const token = getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const options = { method: String(method || 'GET').toUpperCase(), headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '无法连接服务，请确认后端服务可用。');
  }

  if (response.status === 401) clearUnauthorizedSession();

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, 'INVALID_RESPONSE', '服务返回格式异常。');
  }

  if (!response.ok || payload?.ok === false) throw errorFrom(response.status, payload);
  if (payload?.ok !== true || !Object.hasOwn(payload, 'data')) {
    throw new ApiError(response.status, 'INVALID_RESPONSE', '服务返回格式异常。');
  }
  return payload.data;
}
