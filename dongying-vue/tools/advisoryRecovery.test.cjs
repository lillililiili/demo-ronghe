const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

// 钩子按源码装进 new Function 测（去掉 import 和 export），定时器、document 换成假的；断网重试判断用 useRealtimeRefresh.js 里的真实实现。
async function retryHelpers() {
  let source = fs.readFileSync(path.resolve(__dirname, '../src/hooks/useRealtimeRefresh.js'), 'utf8');
  source = 'const onMounted = () => {}, onUnmounted = () => {}, onDataChange = () => () => {};\n'
    + source.replace(/import[\s\S]*?from ['"][^'"]+['"];\r?\n/g, '');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
function hookScript() {
  return fs.readFileSync(path.resolve(__dirname, '../src/hooks/useUavAdvisory.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export function useUavAdvisory', 'function useUavAdvisory');
}

// BUG-07：后台重启、断网时处置进度退避后自己再读，读到后回到原来的间隔；提示说清是暂时读不到，不再叫人“核对是否重复提交”。
test('disposal progress backs off during an outage and returns to its interval once the backend answers', async () => {
  const vue = await import('vue');
  const { shouldRetryRefresh, refreshFailureText } = await retryHelpers();
  const timers = [], mounts = [], unmounts = [];
  const fakeSetTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  const fakeClearTimeout = timer => { if (timer) timer.cleared = true; };
  const pending = () => timers.filter(timer => !timer.cleared);
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); await vue.nextTick(); };
  async function fire(ms) {
    const due = pending();
    assert.deepEqual(due.map(timer => timer.ms), [ms], `next read is scheduled after ${ms} ms`);
    due[0].cleared = true;
    due[0].fn();
    await flush();
  }
  const outage = () => Object.assign(new Error('系统暂时无法处理，请稍后查看最新记录；若刚提交过操作，请先核对结果，避免重复提交。'), { code: 'HTTP_ERROR', status: 502 });
  let reply = () => Promise.resolve({ event_id: 'e1', sms: { status: 'SENT' } });
  const updates = [];
  const uavAdvisoryApi = { get: () => reply() };
  const useUavAdvisory = new Function('onMounted', 'onUnmounted', 'ref', 'watch', 'uavAdvisoryApi', 'shouldRetryRefresh', 'refreshFailureText', 'setTimeout', 'clearTimeout', 'document',
    hookScript() + '\nreturn useUavAdvisory;')(cb => mounts.push(cb), cb => unmounts.push(cb), vue.ref, vue.watch, uavAdvisoryApi, shouldRetryRefresh, refreshFailureText, fakeSetTimeout, fakeClearTimeout, document);
  const scope = vue.effectScope();
  try {
    // 态势页卡片每 1 秒读一次。
    const { data, error } = scope.run(() => useUavAdvisory(() => 'e1', value => updates.push(value), 1000));
    await flush();
    assert.equal(data.value.sms.status, 'SENT');
    reply = () => Promise.reject(outage());
    await fire(1000);
    assert.equal(error.value, '处置记录暂时读不到（服务暂时不可用），正在自动重试。');
    assert.equal(data.value.sms.status, 'SENT', 'last progress stays on screen while the backend is away');
    await fire(2000);
    await fire(4000);
    await fire(8000);
    await fire(15000);
    reply = () => Promise.reject(Object.assign(new Error('Failed to fetch'), { code: 'NETWORK_ERROR' }));
    await fire(15000);
    assert.equal(error.value, '处置记录暂时读不到（暂时连不上系统），正在自动重试。');
    reply = () => Promise.resolve({ event_id: 'e1', sms: { status: 'DELIVERED' } });
    await fire(15000);
    assert.equal(error.value, '', 'recovered without a click');
    assert.equal(data.value.sms.status, 'DELIVERED');
    assert.equal(updates.length, 2);
    await fire(1000);
    // 没有权限、接口不存在不是暂时的：照旧按原间隔读，不退避。
    reply = () => Promise.reject(Object.assign(new Error('当前账号没有处置查看权限'), { status: 403 }));
    await fire(1000);
    assert.equal(error.value, '当前账号没有处置查看权限');
    reply = () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    await fire(1000);
    assert.equal(error.value, '处置记录接口暂不可用，请稍后重试。');
    assert.deepEqual(pending().map(timer => timer.ms), [1000]);
  } finally {
    unmounts.splice(0).forEach(cb => cb());
    scope.stop();
  }
  assert.deepEqual(pending(), [], 'no read is left scheduled after the card closes');
});
