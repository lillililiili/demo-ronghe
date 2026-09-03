import { readonly, ref } from 'vue';
import {
  ApiError,
  apiRequest,
  clearSessionToken,
  getSessionToken,
  setSessionToken
} from './apiClient.js';

const ACCOUNT_KEY = 'dongying.auth.account.v1';
const sessionId = ref(getSessionToken());
const currentUser = ref(null);
export const authSession = readonly(sessionId);
export const authUser = readonly(currentUser);
const M = window.MOCK;

const ROLE_NAMES = {
  'ROLE-ADMIN': '系统管理员',
  'ROLE-AUTH': '处置授权人',
  'ROLE-DUTY': '值班员',
  'ROLE-JUDGE': '研判员',
  'ROLE-OPS': '设备运维',
  'ROLE-AUDIT': '审计员'
};
const MOCK_ROLES = {
  'ROLE-ADMIN': 'R1',
  'ROLE-AUTH': 'R2',
  'ROLE-DUTY': 'R3',
  'ROLE-JUDGE': 'R3',
  'ROLE-OPS': 'R4',
  'ROLE-AUDIT': 'R5'
};

function readStorage(kind, key) {
  try { return window[kind].getItem(key); } catch { return null; }
}
function writeStorage(kind, key, value) {
  try {
    if (value) window[kind].setItem(key, value);
    else window[kind].removeItem(key);
    return true;
  } catch { return false; }
}

export function rememberedAccount() {
  return readStorage('localStorage', ACCOUNT_KEY) || '';
}
export function forgetAccount() {
  writeStorage('localStorage', ACCOUNT_KEY, null);
}
export function isAuthenticated() {
  return !!(sessionId.value && sessionId.value === getSessionToken() && currentUser.value);
}

function userSummary(data, previous = {}) {
  return {
    id: data.user_id,
    account: data.account,
    name: data.name,
    roleCode: data.role_code,
    roleName: ROLE_NAMES[data.role_code] || data.role_code || '—',
    org: data.org || previous.org || '—',
    mfa: data.mfa || previous.mfa || '—',
    lastLogin: previous.lastLogin || '当前会话',
    lastIp: previous.lastIp || '—',
    sourceMode: data.source_mode ?? previous.sourceMode,
    expireAt: data.expire_at ?? previous.expireAt
  };
}

function syncMockPermissions(roleCode) {
  const role = MOCK_ROLES[roleCode];
  if (role && M.switchUser(role)) return;
  M.clearCurrentUser();
}

function acceptSession(data, token) {
  if (!data || !token) throw new ApiError(502, 'INVALID_RESPONSE', '认证服务返回的会话信息不完整。');
  sessionId.value = token;
  currentUser.value = userSummary(data, currentUser.value || {});
  syncMockPermissions(data.role_code);
}

function clearLocalSession() {
  clearSessionToken();
  sessionId.value = null;
  currentUser.value = null;
  M.clearCurrentUser();
}

export async function restoreSession() {
  const token = getSessionToken();
  if (!token) {
    clearLocalSession();
    return false;
  }
  try {
    const data = await apiRequest('GET', '/api/v1/auth/me');
    acceptSession(data, token);
    return true;
  } catch {
    clearLocalSession();
    return false;
  }
}

export async function login({ account, password, remember }) {
  try {
    const cleanAccount = account.trim();
    const data = await apiRequest('POST', '/api/v1/auth/login', { account: cleanAccount, password });
    if (typeof data?.session_id !== 'string' || !data.session_id) {
      throw new ApiError(502, 'INVALID_RESPONSE', '认证服务返回的会话信息不完整。');
    }
    const persisted = setSessionToken(data.session_id);
    acceptSession(data, data.session_id);
    writeStorage('localStorage', ACCOUNT_KEY, remember ? data.account : null);
    return { ok: true, persisted, user: currentUser.value };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) clearLocalSession();
    throw error;
  }
}

export async function logout() {
  const hadSession = !!getSessionToken();
  try {
    if (hadSession) await apiRequest('POST', '/api/v1/auth/logout');
  } finally {
    clearLocalSession();
  }
}
