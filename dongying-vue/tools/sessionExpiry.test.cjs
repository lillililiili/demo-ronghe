// ZT-29：登录过期时就地重新登录，页面和已填内容保留；ZT-28：本人改资料带版本号。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { ref, readonly } = require('vue');

function auth() {
  const source = readFileSync(path.join(__dirname, '../src/services/auth.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  let token = 'A';
  const requests = [], listeners = {};
  const request = (route, options = {}) => new Promise((resolve, reject) => requests.push({ route, options, token, resolve, reject }));
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const window = { addEventListener: (type, fn) => { listeners[type] = fn; }, dispatchEvent() {}, localStorage: store };
  const location = { hash: '#/alarms' };
  const api = new Function('ref', 'readonly', 'apiRequest', 'apiRequestTimed', 'readSessionToken', 'writeSessionToken', 'window', 'Event', 'location',
    source + '\nreturn {restoreSession,loadCurrentUser,relogin,updateProfile,registerReloginHost,isSessionExpired,authUser,authSession,authExpired,authExpiredWhileSubmitting};')(
    ref, readonly, request, request, () => token, value => { token = value; }, window, class {}, location);
  const unauthorized = detail => listeners['api:unauthorized']({ detail });
  return { ...api, requests, location, unauthorized, token: () => token };
}

async function signedIn(a, user = { user_id: 'u-1', account: 'duty-1', name: '值班员', version: 3 }) {
  const load = a.restoreSession();
  a.requests.at(-1).resolve(user);
  await load;
}

test('业务页面开着时会话过期只标记过期，不清会话、不跳登录页', async () => {
  const a = auth();
  await signedIn(a);
  a.registerReloginHost();
  a.unauthorized({ submitting: true });
  assert.equal(a.isSessionExpired(), true);
  assert.equal(a.authExpiredWhileSubmitting.value, true);
  assert.equal(a.token(), 'A');
  assert.equal(a.authUser.value.account, 'duty-1');
  assert.equal(a.location.hash, '#/alarms');
  // 过期期间的回读同样是 401，也不能把页面清掉。
  const again = a.restoreSession();
  a.requests.at(-1).reject({ status: 401 });
  await again;
  assert.equal(a.authUser.value.account, 'duty-1');
});

test('没有重新登录弹窗时回登录页并标明登录已过期', async () => {
  const a = auth();
  await signedIn(a);
  const unregister = a.registerReloginHost();
  unregister(); unregister();
  a.unauthorized({ submitting: true });
  assert.equal(a.isSessionExpired(), false);
  assert.equal(a.token(), '');
  assert.equal(a.authUser.value, null);
  assert.equal(a.location.hash, '#/login?redirect=%2Falarms&expired=1');
});

test('用同一账号重新登录后换上新会话并清除过期标记', async () => {
  const a = auth();
  await signedIn(a);
  a.registerReloginHost();
  a.unauthorized({ submitting: true });
  const done = a.relogin('Duty#2026a');
  assert.equal(a.requests.at(-1).route, '/auth/login');
  assert.deepEqual(a.requests.at(-1).options.body, { account: 'duty-1', password: 'Duty#2026a' });
  a.requests.at(-1).resolve({ session_id: 'B' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.requests.at(-1).route, '/auth/me');
  assert.equal(a.requests.at(-1).token, 'B');
  a.requests.at(-1).resolve({ user_id: 'u-1', account: 'duty-1', version: 3 });
  const result = await done;
  assert.equal(result.sameUser, true);
  assert.equal(a.token(), 'B');
  assert.equal(a.isSessionExpired(), false);
  assert.equal(a.authExpiredWhileSubmitting.value, false);
});

test('重新登录密码不对时保持过期状态和原页面', async () => {
  const a = auth();
  await signedIn(a);
  a.registerReloginHost();
  a.unauthorized({ submitting: false });
  const done = a.relogin('wrong');
  a.requests.at(-1).reject(Object.assign(new Error('账号或密码错误'), { status: 401, code: 'INVALID_CREDENTIALS' }));
  await assert.rejects(done, /账号或密码错误/);
  assert.equal(a.isSessionExpired(), true);
  assert.equal(a.token(), 'A');
  assert.equal(a.authUser.value.account, 'duty-1');
});

test('本人改资料带当前版本号，成功后更新当前用户', async () => {
  const a = auth();
  await signedIn(a);
  const done = a.updateProfile({ name: '新名字', phone: '0546-1234567' });
  assert.equal(a.requests.at(-1).route, '/auth/profile');
  assert.equal(a.requests.at(-1).options.method, 'PATCH');
  assert.deepEqual(a.requests.at(-1).options.body, { name: '新名字', phone: '0546-1234567', expected_version: 3 });
  a.requests.at(-1).resolve({ user_id: 'u-1', account: 'duty-1', name: '新名字', version: 4 });
  await done;
  assert.equal(a.authUser.value.name, '新名字');
  assert.equal(a.authUser.value.version, 4);
});
