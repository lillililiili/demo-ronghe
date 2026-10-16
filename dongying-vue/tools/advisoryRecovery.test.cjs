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

// BUG-07：后台重启、断网时处置进度退避后自己再读，读到后等待 SSE 更新；提示说清是暂时读不到，不再叫人“核对是否重复提交”。
test('disposal progress backs off during an outage and waits for SSE once the backend answers', async () => {
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
  let onChange;
  const useRealtimeRefresh = (topics, callback) => { assert.ok(topics.includes('alarm')); onChange = callback; };
  const uavAdvisoryApi = { get: () => reply() };
  const useUavAdvisory = new Function('onMounted', 'onUnmounted', 'ref', 'watch', 'uavAdvisoryApi', 'shouldRetryRefresh', 'refreshFailureText', 'setTimeout', 'clearTimeout', 'document', 'useRealtimeRefresh',
    hookScript() + '\nreturn useUavAdvisory;')(cb => mounts.push(cb), cb => unmounts.push(cb), vue.ref, vue.watch, uavAdvisoryApi, shouldRetryRefresh, refreshFailureText, fakeSetTimeout, fakeClearTimeout, document, useRealtimeRefresh);
  const scope = vue.effectScope();
  try {
    // 处置卡片订阅 SSE，两次变化读取至少间隔 1 秒。
    const { data, error } = scope.run(() => useUavAdvisory(() => 'e1', value => updates.push(value), 1000));
    await flush();
    assert.equal(data.value.sms.status, 'SENT');
    reply = () => Promise.reject(outage());
    assert.deepEqual(pending(), [], 'healthy reads do not poll');
    await onChange(); await flush();
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
    assert.deepEqual(pending(), [], 'healthy reads do not poll');
    await onChange(); await flush();
    // 没有权限、接口不存在不自行重试；后续变化才重新读取。
    reply = () => Promise.reject(Object.assign(new Error('当前账号没有处置查看权限'), { status: 403 }));
    assert.deepEqual(pending(), [], 'healthy reads do not poll');
    await onChange(); await flush();
    assert.equal(error.value, '当前账号没有处置查看权限');
    reply = () => Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
    assert.deepEqual(pending(), [], 'healthy reads do not poll');
    await onChange(); await flush();
    assert.equal(error.value, '处置记录接口暂不可用，请稍后重试。');
    assert.deepEqual(pending(), []);
    assert.equal(data.value, null, 'revoked or missing data is removed');
    reply = () => Promise.resolve({ event_id: 'e1', notify_phase: 'WATCHING' });
    await onChange(); await flush();
    assert.deepEqual(pending().map(timer => timer.ms), [1000], 'observation window retains its business timer');
    reply = () => Promise.resolve({ event_id: 'e1', notify_phase: 'AWAIT_COUNTER' });
    await fire(1000);
    assert.deepEqual(pending(), [], 'observation ends only from the server response, then stops its timer');
  } finally {
    unmounts.splice(0).forEach(cb => cb());
    scope.stop();
  }
  assert.deepEqual(pending(), [], 'no read is left scheduled after the card closes');
});


// 编译真实父子模板，验证资格响应确实传到按钮，不能只测子组件的计算属性。
function advisoryComponent(file, dependencies) {
  const vue = require('vue');
  const { parse, compileScript } = require('@vue/compiler-sfc');
  const filename = path.resolve(__dirname, '../src/' + file);
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'advisory-qualification', inlineTemplate: true });
  const code = compiled.content
    .replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g, (_, names, from) => {
      const bindings = names.replace(/\s+as\s+/g, ': ');
      return `const { ${bindings} } = ${from === 'vue' ? 'Vue' : 'dependencies'};`;
    })
    .replace(/import\s+(\w+)\s+from\s*['"][^'"]+['"];?/g, (_, name) => `const ${name} = dependencies.${name};`)
    .replace('export default', 'return');
  return new Function('Vue', 'dependencies', 'window', code)(vue, dependencies, { UI: { icon: () => '' } });
}

// 2026-10-14 页面设计第 2 条：反制入口移到卡片上方的「下一步」，不能反制时按钮保留变灰并写原因。
async function renderSituationNextStep(summary, alarmOverrides = {}) {
  const { displayBusinessNo } = await import('../src/ui/deviceNumber.js');
  const nextStep = await import('../src/components/disposal/counterNextStep.js');
  const vue = require('vue');
  const { renderToString } = require('@vue/server-renderer');
  const stub = { render: () => null };
  const counter = advisoryComponent('pages/alarms/CounterLaunch.vue', {
    NoCounterDecisionModal: stub, NoCounterBasis: stub, ...nextStep
  });
  const card = advisoryComponent('pages/situation/SituationNextStep.vue', {
    displayBusinessNo, CounterLaunch: counter, ...nextStep,
    uavProcessActions: alarm => alarm.eventState === 'CONFIRMED' ? ['counter'] : alarm.eventState === 'PENDING_VERIFICATION' ? ['verify'] : [],
    uavProcessStatus: alarm => alarm.eventState === 'CONFIRMED' ? '告警已确认' : '已移送处罚'
  });
  const alarm = { alarmId: 'a1', id: 'AL-1', eventId: summary?.event_id, eventState: 'CONFIRMED', ...alarmOverrides };
  return renderToString(vue.createSSRApp(card, { alarm, summary }));
}
const counterButton = html => html.match(/<button[^>]*>(?:(?!<button)[^])*?(?:发起反制|直接反制|申请反制（需审批）)<\/button>/)?.[0];
const disabled = /\bdisabled(?:[\s=>])/;

test('fusion card enables counter launch only from this event request/direct eligibility', async () => {
  const { randomUUID } = require('node:crypto');
  for (const [permission, label, hint] of [['can_request_counter', '申请反制（需审批）', '提交后要审批人同意才执行'], ['can_direct_counter', '直接反制', '你的账号可直接反制，不用审批']]) {
    const event_id = randomUUID();
    const html = await renderSituationNextStep({ event_id, counter_launch_visible: true, [permission]: true });
    assert.ok(counterButton(html), permission);
    assert.ok(counterButton(html).includes(label), label);
    assert.ok(html.includes(hint), hint);
    assert.doesNotMatch(counterButton(html), disabled);
    assert.doesNotMatch(html, /尚未确认反制资格/);
  }
});

test('fusion card shows actual counter block reasons and never borrows another event eligibility', async () => {
  const { randomUUID } = require('node:crypto');
  const event_id = randomUUID();
  for (const reason of ['当前账号没有反制申请或直接反制权限', '目标观测已过期，无法确认当前位置', '电话观察期尚未结束']) {
    const html = await renderSituationNextStep({ event_id, counter_launch_visible: true,
      can_request_counter: false, can_direct_counter: false, counter_block_reason: reason });
    assert.match(counterButton(html), disabled);
    assert.ok(html.includes(reason));
    assert.doesNotMatch(html, /尚未确认反制资格/);
  }
  const allowed = { event_id, counter_launch_visible: true, can_request_counter: true };
  // 别的事件的资格不能借用：按钮变灰，写正在读取。
  const other = await renderSituationNextStep(allowed, { eventId: randomUUID() });
  assert.match(counterButton(other), disabled);
  assert.match(other, /暂不能反制：正在读取能否反制/);
  const handedOff = await renderSituationNextStep(allowed, { eventState: 'HANDED_OFF' });
  assert.match(counterButton(handedOff), disabled);
  assert.match(handedOff, /现在的处理进度是「已移送处罚」/);
  const watching = await renderSituationNextStep({ ...allowed, counter_launch_visible: false, notify_phase: 'WATCHING' });
  assert.match(counterButton(watching), disabled);
  assert.match(watching, /已通知飞手，正在观察无人机是否离开/);
  const decided = await renderSituationNextStep({ ...allowed, counter_launch_visible: false, no_counter: { decision_active: true } });
  assert.match(decided, /已决定不反制，本次处置已结束/);
  const pending = await renderSituationNextStep(allowed, { eventState: 'PENDING_VERIFICATION' });
  assert.equal(counterButton(pending), undefined);
  assert.match(pending, />核实<\/button>/);
  assert.match(pending, /告警还没核实属实，核实后才能反制/);
  const unknown = await renderSituationNextStep({ event_id, counter_launch_visible: true });
  assert.match(counterButton(unknown), disabled);
  assert.match(unknown, /尚未确认反制资格/);
});
