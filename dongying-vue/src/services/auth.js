import { readonly, ref } from 'vue';
import { apiRequest, apiRequestTimed, readSessionToken, writeSessionToken } from './apiClient.js';

const ACCOUNT_KEY = 'dongying.demo.account.v1';
const sessionId = ref(readSessionToken());
const user = ref(null);
const restoring = ref(null);
const restoreError = ref(null);
// 登录过期后就地重新登录（ZT-29）：会话被拒时保留外壳、页面和已填内容，只标记过期并弹出重新登录。
const expired = ref(false);
const expiredWhileSubmitting = ref(false);
let reloginHosts = 0;

export const authSession = readonly(sessionId);
export const authUser = readonly(user);
export const authRestoreError = readonly(restoreError);
export const authExpired = readonly(expired);
export const authExpiredWhileSubmitting = readonly(expiredWhileSubmitting);

function storage(kind, key, value) {
  try {
    if (arguments.length === 2) return window[kind].getItem(key);
    if (value) window[kind].setItem(key, value);
    else window[kind].removeItem(key);
    return true;
  } catch { return false; }
}

function notifyAccessChanged() {
  window.__API_ACCESS = user.value ? {
    menuKeys: new Set(user.value.menu_keys || []),
    permissionCodes: new Set(user.value.permission_codes || [])
  } : null;
  window.dispatchEvent(new Event('auth-access-change'));
  window.dispatchEvent(new Event('mock-access-change'));
}

function clearSession() {
  sessionId.value = '';
  user.value = null;
  restoreError.value = null;
  expired.value = false;
  expiredWhileSubmitting.value = false;
  writeSessionToken('');
  notifyAccessChanged();
}

export function rememberedAccount() { return storage('localStorage', ACCOUNT_KEY) || ''; }
export function forgetAccount() { storage('localStorage', ACCOUNT_KEY, null); }
export function isAuthenticated() { return !!(sessionId.value && user.value); }
export function needsPasswordChange() { return !!user.value?.must_change_password; }
export function isSessionExpired() { return expired.value; }

/** 业务外壳挂载重新登录弹窗时登记；返回注销函数。没有弹窗在场时会话过期仍回登录页。 */
export function registerReloginHost() {
  reloginHosts += 1;
  let active = true;
  return () => { if (active) { active = false; reloginHosts -= 1; } };
}

/** 会话被服务端拒绝；业务页面开着时只标记过期，页面和已填内容原样保留。返回是否就地处理。 */
export function markSessionExpired({ submitting = false } = {}) {
  if (!user.value || reloginHosts < 1) return false;
  expired.value = true;
  if (submitting) expiredWhileSubmitting.value = true;
  return true;
}

export async function loadCurrentUser() {
  const token = readSessionToken();
  const current = await apiRequestTimed('/auth/me', {}, 8_000);
  if (token !== readSessionToken()) return null;
  user.value = current;
  restoreError.value = null;
  notifyAccessChanged();
  return current;
}

export async function restoreSession() {
  const token = readSessionToken();
  sessionId.value = token;
  if (!token) {
    user.value = null;
    restoreError.value = null;
    return null;
  }
  if (!restoring.value || restoring.value.token !== token) {
    const attempt = { token, promise: null };
    attempt.promise = loadCurrentUser().catch(error => {
      if (token !== readSessionToken()) return null;
      // 已就地标记过期的会话留给重新登录弹窗处理，不清掉页面。
      if (error?.status === 401) { if (!expired.value) clearSession(); }
      else restoreError.value = error;
      return null;
    }).finally(() => { if (restoring.value?.promise === attempt.promise) restoring.value = null; });
    restoring.value = attempt;
  }
  return restoring.value.promise;
}

export async function login({ account, password, remember }) {
  const data = await apiRequest('/auth/login', { method: 'POST', body: { account: account.trim(), password } });
  const persisted = writeSessionToken(data.session_id);
  sessionId.value = data.session_id;
  storage('localStorage', ACCOUNT_KEY, remember ? data.account : null);
  try { await loadCurrentUser(); }
  catch (error) { if (readSessionToken() === data.session_id) clearSession(); throw error; }
  return { ok: true, persisted };
}

/** 用同一账号就地重新登录；失败时保持过期状态，页面不动。 */
export async function relogin(password) {
  const previous = user.value;
  if (!previous?.account) throw new Error('当前账号信息已失效，请换个账号登录。');
  const data = await apiRequest('/auth/login', { method: 'POST', body: { account: previous.account, password } });
  writeSessionToken(data.session_id);
  sessionId.value = data.session_id;
  // loadCurrentUser 会广播访问变化：实时推送按新会话重连，页面按新权限补读。
  const current = await loadCurrentUser();
  if (!current) throw new Error('登录账号已变化，请重新读取当前页面。');
  expired.value = false;
  expiredWhileSubmitting.value = false;
  return { user: current, sameUser: current.user_id === previous.user_id };
}

/** 本人只改姓名和电话；带当前版本号，别处改过时服务端返回冲突（ZT-28）。 */
export async function updateProfile({ name, phone }) {
  const token = readSessionToken();
  const updated = await apiRequest('/auth/profile', { method: 'PATCH', body: { name, phone, expected_version: user.value?.version ?? 0 } });
  if (token !== readSessionToken()) return null;
  user.value = updated;
  return updated;
}

export async function logout() {
  const token = readSessionToken();
  try { if (token) await apiRequest('/auth/logout', { method: 'POST' }); }
  catch { /* 本地会话仍须清除，避免后端不可用时把用户困在旧会话中。 */ }
  finally { if (readSessionToken() === token) clearSession(); }
}

export async function changePassword(currentPassword, newPassword) {
  const token = readSessionToken();
  await apiRequest('/auth/change-password', { method: 'POST', body: { current_password: currentPassword, new_password: newPassword } });
  if (readSessionToken() === token) clearSession();
}

window.addEventListener('api:unauthorized', event => {
  if (markSessionExpired(event?.detail || {})) return;
  const current = location.hash.slice(1) || '/situation';
  const hadSession = !!(sessionId.value || user.value);
  clearSession();
  // 原来有会话的说明是登录过期，登录页据此提示。
  if (!location.hash.startsWith('#/login')) location.hash = `#/login?redirect=${encodeURIComponent(current)}${hadSession ? '&expired=1' : ''}`;
});
