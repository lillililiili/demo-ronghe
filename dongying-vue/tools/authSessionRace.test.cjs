const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { ref, readonly } = require('vue');

function auth() {
  const source = readFileSync(path.join(__dirname, '../src/services/auth.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  let token = 'A'; const requests = [];
  const request = route => new Promise((resolve, reject) => requests.push({ route, token, resolve, reject }));
  const store = { getItem: () => null, setItem() {}, removeItem() {} };
  const window = { addEventListener() {}, dispatchEvent() {}, localStorage: store };
  const api = new Function('ref', 'readonly', 'apiRequest', 'apiRequestTimed', 'readSessionToken', 'writeSessionToken', 'window', 'Event', source + '\nreturn {restoreSession,loadCurrentUser,logout,authUser,authRestoreError,authSession};')(
    ref, readonly, request, request, () => token, value => { token = value; }, window, class {});
  return { ...api, requests, token: () => token, switch: value => { token = value; } };
}
test('restoring the new account does not wait on an old account request', async () => {
  const a = auth(), old = a.restoreSession();
  a.switch('B'); const current = a.restoreSession();
  assert.equal(a.requests.length, 2);
  a.requests[1].resolve({ account: 'B' }); await current;
  a.requests[0].reject({ code: 'SESSION_CHANGED', status: 409 }); await old;
  assert.equal(a.authUser.value.account, 'B'); assert.equal(a.authRestoreError.value, null);
});
test('old restore errors cannot hide a successfully loaded new account', async () => {
  const a = auth(), old = a.restoreSession();
  a.switch('B'); const current = a.loadCurrentUser();
  a.requests[1].resolve({ account: 'B' }); await current;
  a.requests[0].reject({ code: 'SESSION_CHANGED', status: 409 }); await old;
  assert.equal(a.authUser.value.account, 'B'); assert.equal(a.authRestoreError.value, null);
});
test('late logout response only clears the session that initiated logout', async () => {
  const a = auth(), logout = a.logout();
  a.switch('B'); const current = a.loadCurrentUser();
  a.requests[1].resolve({ account: 'B' }); await current;
  a.requests[0].reject({ code: 'SESSION_CHANGED', status: 409 }); await logout;
  assert.equal(a.token(), 'B'); assert.equal(a.authUser.value.account, 'B');
});
test('current account authentication failure still clears its own session', async () => {
  const a = auth(), load = a.restoreSession();
  a.requests[0].reject({ status: 401 }); await load;
  assert.equal(a.token(), ''); assert.equal(a.authUser.value, null);
});
test('completed restore is released so later navigation checks current permissions', async () => {
  const a = auth(), first = a.restoreSession();
  a.requests[0].resolve({ account: 'A' }); await first;
  const again = a.restoreSession();
  assert.equal(a.requests.length, 2);
  a.requests[1].resolve({ account: 'A', permissions: [] }); await again;
  assert.deepEqual([...a.authUser.value.permissions], []);
});
