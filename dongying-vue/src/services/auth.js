/* 本地 Mock 演示会话：公开演示密码，不代表生产认证，不发送网络请求。
   用户/角色/权限仍取自 MOCK；接入真实后端时替换本服务。 */
import { ref, readonly } from 'vue';

export const DEMO_PASSWORD = 'Demo@2026';
const SESSION_KEY = 'dongying.demo.session.v1';
const ACCOUNT_KEY = 'dongying.demo.account.v1';
const sessionId = ref(null);
export const authSession = readonly(sessionId);
const M = window.MOCK;

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
  return !!(sessionId.value && M.currentUser?.id === sessionId.value && M.currentUser.status === '正常');
}
export function restoreSession() {
  const id = readStorage('sessionStorage', SESSION_KEY);
  const user = M.users.find(u => u.id === id && u.status === '正常');
  sessionId.value = user?.id || null;
  if (user) M.switchUser(user.id);
  else {
    writeStorage('sessionStorage', SESSION_KEY, null);
    M.clearCurrentUser();
  }
}
export function login({ account, password, remember }) {
  const user = M.users.find(u => u.account === account.trim());
  if (!user || password !== DEMO_PASSWORD) {
    M.pushAudit('系统登录', '演示账号登录', user?.account || '未知账号', '失败（账号或密码错误）');
    return { ok: false, message: '账号或密码不正确，请重试或查看“忘记密码”。' };
  }
  if (user.status !== '正常') {
    M.pushAudit('系统登录', '演示账号登录', user.account, '失败（账号已停用）');
    return { ok: false, message: '该账号已停用，请联系系统管理员。' };
  }
  M.switchUser(user.id);
  user.online = true;
  user.lastLogin = M.nowStr();
  sessionId.value = user.id;
  const persisted = writeStorage('sessionStorage', SESSION_KEY, user.id);
  writeStorage('localStorage', ACCOUNT_KEY, remember ? user.account : null);
  M.pushAudit('系统登录', '演示账号登录（未接入真实认证/MFA）', user.account);
  return { ok: true, persisted };
}
export function logout() {
  if (M.currentUser && sessionId.value) {
    M.pushAudit('系统登录', '退出演示登录', M.currentUser.account);
    M.currentUser.online = false;
  }
  sessionId.value = null;
  writeStorage('sessionStorage', SESSION_KEY, null);
  M.clearCurrentUser();
}
