import { readonly, ref } from 'vue';
import { apiRequest, readSessionToken, writeSessionToken } from './apiClient.js';

const ACCOUNT_KEY = 'dongying.demo.account.v1';
const sessionId = ref(readSessionToken());
const user = ref(null);
const restoring = ref(null);
const restoreError = ref(null);

export const authSession = readonly(sessionId);
export const authUser = readonly(user);
export const authRestoreError = readonly(restoreError);
export const DEMO_PASSWORD = 'changeme';

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
  writeSessionToken('');
  notifyAccessChanged();
}

export function rememberedAccount() { return storage('localStorage', ACCOUNT_KEY) || ''; }
export function forgetAccount() { storage('localStorage', ACCOUNT_KEY, null); }
export function isAuthenticated() { return !!(sessionId.value && user.value); }
export function needsPasswordChange() { return !!user.value?.must_change_password; }

export async function loadCurrentUser() {
  const current = await apiRequest('/auth/me');
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
  if (!restoring.value) {
    restoring.value = loadCurrentUser().catch(error => {
      if (error?.status === 401) clearSession();
      else restoreError.value = error;
      return null;
    }).finally(() => { restoring.value = null; });
  }
  return restoring.value;
}

export async function login({ account, password, remember }) {
  const data = await apiRequest('/auth/login', { method: 'POST', body: { account: account.trim(), password } });
  const persisted = writeSessionToken(data.session_id);
  sessionId.value = data.session_id;
  storage('localStorage', ACCOUNT_KEY, remember ? data.account : null);
  try { await loadCurrentUser(); }
  catch (error) { clearSession(); throw error; }
  return { ok: true, persisted };
}

export async function logout() {
  try { if (sessionId.value) await apiRequest('/auth/logout', { method: 'POST' }); }
  catch { /* 本地会话仍须清除，避免后端不可用时把用户困在旧会话中。 */ }
  finally { clearSession(); }
}

export async function changePassword(currentPassword, newPassword) {
  await apiRequest('/auth/change-password', { method: 'POST', body: { current_password: currentPassword, new_password: newPassword } });
  clearSession();
}

window.addEventListener('api:unauthorized', () => {
  const current = location.hash.slice(1) || '/workbench';
  clearSession();
  if (!location.hash.startsWith('#/login')) location.hash = `#/login?redirect=${encodeURIComponent(current)}`;
});
