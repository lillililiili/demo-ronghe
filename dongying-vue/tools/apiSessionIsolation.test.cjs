const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function client() {
  const labels = readFileSync(path.join(__dirname, '../src/ui/labels.js'), 'utf8').replace(/^export /gm, '');
  const userFacingMessage = new Function(labels + '\nreturn userFacingMessage;')();
  const source = readFileSync(path.join(__dirname, '../src/services/apiClient.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/import\.meta\.env/g, '{}').replace(/^export /gm, '');
  const storage = new Map(), events = [], requests = [];
  const sessionStorage = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  // 平台时钟校准（serverClock.js）与会话隔离无关，这里给个空实现。
  const api = new Function('userFacingMessage', 'fetch', 'sessionStorage', 'window', 'CustomEvent', 'noteServerDate', source + '\nreturn {apiRequest,apiDownload,apiBinary,writeSessionToken,readSessionToken};')(
    userFacingMessage, fetch, sessionStorage, { dispatchEvent: event => events.push(event) }, class { constructor(type, options) { this.type = type; this.detail = options.detail; } }, () => {});
  api.writeSessionToken('session-A');
  return { ...api, events, requests };
}
const json = (data, status = 200) => new Response(JSON.stringify(status === 200 ? { ok: true, data } : { ok: false, error: { code: 'UNAUTHENTICATED', message: 'session expired' } }), { status, headers: { 'Content-Type': 'application/json' } });
const changed = error => error.code === 'SESSION_CHANGED';

test('late 401 from a logged-out account cannot expire the new account', async () => {
  const c = client(), pending = c.apiRequest('/flight-plans');
  c.writeSessionToken('session-B'); c.requests[0].resolve(json(null, 401));
  await assert.rejects(pending, changed);
  assert.equal(c.events.length, 0); assert.equal(c.readSessionToken(), 'session-B');
});
test('late successful data from the previous account is discarded', async () => {
  const c = client(), pending = c.apiRequest('/flight-plans');
  c.writeSessionToken('session-B'); c.requests[0].resolve(json({ owner: 'A' }));
  await assert.rejects(pending, changed);
});
test('new account does not reuse the previous account in-flight GET', async () => {
  const c = client(), old = c.apiRequest('/flight-plans').catch(error => error);
  c.writeSessionToken('session-B'); const fresh = c.apiRequest('/flight-plans');
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests[1].options.headers.get('Authorization'), 'Bearer session-B');
  c.requests[1].resolve(json({ owner: 'B' })); assert.deepEqual(await fresh, { owner: 'B' });
  c.requests[0].resolve(json({ owner: 'A' })); assert.equal((await old).code, 'SESSION_CHANGED');
});
test('same-account GET still deduplicates and current 401 still expires authentication', async () => {
  const c = client(), a = c.apiRequest('/same'), b = c.apiRequest('/same');
  assert.equal(c.requests.length, 1); c.requests[0].resolve(json({ id: 1 }));
  assert.deepEqual(await a, await b);
  const failed = c.apiRequest('/denied'); c.requests[1].resolve(json(null, 401));
  await assert.rejects(failed, error => error.status === 401); assert.equal(c.events.length, 1);
});
test('switching account while JSON is decoding cannot return the old body', async () => {
  const c = client(); let body;
  const pending = c.apiRequest('/slow-body');
  c.requests[0].resolve({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: () => new Promise(resolve => { body = resolve; }) });
  await Promise.resolve(); await Promise.resolve();
  c.writeSessionToken('session-B'); body({ ok: true, data: { owner: 'A' } });
  await assert.rejects(pending, changed);
});
test('late binary 401 never signs out the new account', async () => {
  const c = client(), pending = c.apiBinary('/evidence/one/content');
  c.writeSessionToken('session-B'); c.requests[0].resolve(json(null, 401));
  await assert.rejects(pending, changed); assert.equal(c.events.length, 0);
});
test('late CSV and evidence downloads never return previous-account files', async () => {
  for (const method of ['apiDownload', 'apiBinary']) {
    const c = client(), pending = c[method]('/download');
    c.writeSessionToken('session-B'); c.requests[0].resolve(new Response('account-A-file', { headers: { 'Content-Type': 'text/plain' } }));
    await assert.rejects(pending, changed);
  }
});
test('account change during streamed evidence discards the buffered file', async () => {
  const c = client(); let stream;
  const pending = c.apiBinary('/stream', { maxBytes: 100 });
  c.requests[0].resolve(new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  await Promise.resolve(); await Promise.resolve();
  c.writeSessionToken('session-B'); stream.enqueue(new TextEncoder().encode('private-A')); stream.close();
  await assert.rejects(pending, changed);
});
test('successful files and failed login preserve their existing behavior', async () => {
  const c = client(), file = c.apiDownload('/csv'); c.requests[0].resolve(new Response('id\n1'));
  assert.equal(await (await file).text(), 'id\n1');
  const login = c.apiRequest('/auth/login', { method: 'POST', body: { account: 'fixture' } });
  c.requests[1].resolve(json(null, 401)); await assert.rejects(login, error => error.status === 401);
  assert.equal(c.events.length, 0);
});
test('current 401 says whether a submission was rejected; logout 401 is not an expiry', async () => {
  const c = client();
  const save = c.apiRequest('/uav-events/e-1/verify', { method: 'POST', body: { conclusion: 'FALSE_POSITIVE' }, mutation: true });
  c.requests[0].resolve(json(null, 401)); await assert.rejects(save, error => error.status === 401);
  const read = c.apiRequest('/alarms');
  c.requests[1].resolve(json(null, 401)); await assert.rejects(read, error => error.status === 401);
  assert.deepEqual(c.events.map(event => [event.type, event.detail.submitting, event.detail.error.status]),
    [['api:unauthorized', true, 401], ['api:unauthorized', false, 401]]);
  const out = c.apiRequest('/auth/logout', { method: 'POST' });
  c.requests[2].resolve(json(null, 401)); await assert.rejects(out, error => error.status === 401);
  assert.equal(c.events.length, 2);
});
