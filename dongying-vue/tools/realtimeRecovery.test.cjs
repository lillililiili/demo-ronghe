#!/usr/bin/env node
/* 实时推送恢复（BUG-07 / ZT-07）：连接卡住由看门狗断开重连，重连、网络恢复后通知页面全部重读；
   后端没在监听或连不上时按兜底间隔通知重读；会话被拒（401）后不再用旧会话连接，换会话后立即重连。
   页面重读失败（断网、超时、5xx）按退避重试，没有权限等再读也不会好的错误不重试，恢复时立即再读。
   计时常数按比例缩短后用真实计时器验证。 */
const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let failed = 0;
function ok(name, condition) {
  if (condition) { passed++; return; }
  failed++;
  console.error(`✗ ${name}`);
}
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed++; return; }
  failed++;
  console.error(`✗ ${name}\n  期望 ${JSON.stringify(expected)}\n  实到 ${JSON.stringify(actual)}`);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, ms = 1_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await delay(5);
  }
  return condition();
}

globalThis.window = new EventTarget();
globalThis.document = Object.assign(new EventTarget(), { hidden: false });

function loadModule(file, prelude, rewrite = source => source) {
  let source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
  source = source.replace(/import[\s\S]*?from ['"][^'"]+['"];\r?\n/g, '');
  source = `${prelude}\n${rewrite(source)}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Date.now()}`);
}

/* 假的推送接口：每次连接返回一个可由测试写入、关闭的数据流。 */
const streams = [];
let token = 'token-a';
let nextStatus = 200;
globalThis.fetch = async (url, options) => {
  const entry = { url, headers: options.headers, signal: options.signal, controller: null, closed: false };
  streams.push(entry);
  if (nextStatus !== 200) return new Response('', { status: nextStatus });
  const body = new ReadableStream({ start(controller) { entry.controller = controller; } });
  options.signal.addEventListener('abort', () => {
    entry.closed = true;
    try { entry.controller.error(new Error('aborted')); } catch { /* 已关闭 */ }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};
const encoder = new TextEncoder();
const send = (entry, text) => { if (!entry.closed && entry.controller) entry.controller.enqueue(encoder.encode(text)); };
const close = entry => { entry.closed = true; entry.controller.close(); };
/* 后端每 20 秒发一次心跳；测试里除了专门验证“连接卡住”的一段，都按缩短后的节奏给最新连接发心跳。 */
let heartbeat = true;
const heartbeatTimer = setInterval(() => { if (heartbeat && streams.length) send(streams[streams.length - 1], ':ping\n\n'); }, 50);

async function serviceTests() {
  globalThis.__realtimeDeps = { readSessionToken: () => token };
  const service = await loadModule('../src/services/realtime.js',
    'const { readSessionToken } = globalThis.__realtimeDeps;',
    source => source
      .replace(/import\.meta\.env\.APP_PUBLIC_API_BASE_URL/g, 'undefined')
      .replace('const FALLBACK_MS = 15_000;', 'const FALLBACK_MS = 150;')
      .replace('const STALL_MS = 45_000;', 'const STALL_MS = 400;')
      .replace('const HIDDEN_RESYNC_MS = 60_000;', 'const HIDDEN_RESYNC_MS = 100;')
      .replace('const MAX_BACKOFF_MS = 30_000;', 'const MAX_BACKOFF_MS = 120;')
      .replace(/1_000/g, '20'));

  const calls = [];
  const stop = service.onDataChange(['alarm'], (topics, meta) => calls.push({ topics, recovery: !!meta.recovery }));
  await until(() => streams.length === 1);
  const first = streams[0];
  check('带登录会话连接推送接口', [first.url, first.headers.Authorization], ['/api/v1/realtime/events', 'Bearer token-a']);
  send(first, 'event: ready\ndata: {"listening":true,"at":1}\n\n');
  await delay(20);
  check('首次连上不要求页面重读', calls, []);
  ok('连上后显示为已连接', service.isRealtimeConnected());
  send(first, 'event: change\ndata: {"topics":["alarm"],"at":2}\n\n');
  send(first, 'event: change\ndata: {"topics":["device"],"at":3}\n\n');
  await until(() => calls.length >= 1);
  await delay(20);
  check('只通知订阅的类别', calls, [{ topics: ['alarm'], recovery: false }]);

  // 心跳维持连接：间隔小于看门狗时限的心跳不触发重连。
  await delay(800);
  check('有心跳时不重连', streams.length, 1);

  // 后端重启后旧连接既不断开也不再有数据：看门狗断开重连，连上后通知全部重读。
  calls.length = 0;
  heartbeat = false;
  ok('连接卡住后看门狗断开重连', await until(() => streams.length === 2, 1_500));
  heartbeat = true;
  ok('旧连接已被中止', first.signal.aborted);
  send(streams[1], 'event: ready\ndata: {"listening":true,"at":4}\n\n');
  ok('重连后通知页面全部重读', await until(() => calls.some(call => call.recovery && call.topics.includes('*'))));

  // 后端主动断开：退避后重连，同样补读。
  calls.length = 0;
  close(streams[1]);
  ok('连接断开后自动重连', await until(() => streams.length === 3, 600));
  send(streams[2], 'event: ready\ndata: {"listening":false,"at":5}\n\n');
  ok('断开重连后同样补读', await until(() => calls.some(call => call.recovery)));
  ok('后端没在监听时连接仍显示已连接', service.isRealtimeConnected());

  // 后端没在监听数据库：按兜底间隔通知重读。
  calls.length = 0;
  ok('没在监听时按兜底间隔通知重读', await until(() => calls.filter(call => call.topics.includes('*')).length >= 2, 700));
  send(streams[2], 'event: change\ndata: {"topics":["alarm"],"at":6}\n\n');
  await delay(20);
  calls.length = 0;
  await delay(350);
  check('重新收到信号后停止兜底重读', calls.filter(call => call.topics.includes('*')), []);

  // 网络恢复：立即重连并补读。
  calls.length = 0;
  window.dispatchEvent(new Event('online'));
  ok('网络恢复后立即重连', await until(() => streams.length === 4, 200));
  ok('网络恢复时中止旧连接', streams[2].signal.aborted);
  send(streams[3], 'event: ready\ndata: {"listening":true,"at":7}\n\n');
  ok('网络恢复后通知全部重读', await until(() => calls.some(call => call.recovery)));

  // 会话被拒（401）：不再用旧会话连接，也不再兜底通知；换会话后立即重连。
  calls.length = 0;
  nextStatus = 401;
  close(streams[3]);
  ok('断开后用原会话重连一次', await until(() => streams.length === 5, 600));
  await delay(400);
  check('会话被拒后不再用旧会话连接', streams.length, 5);
  check('会话被拒后不兜底重读', calls, []);
  ok('会话被拒后显示未连接', !service.isRealtimeConnected());
  nextStatus = 200;
  token = 'token-b';
  window.dispatchEvent(new Event('auth-access-change'));
  ok('换会话后立即重连', await until(() => streams.length === 6, 200));
  check('重连使用新会话', streams[5].headers.Authorization, 'Bearer token-b');
  send(streams[5], 'event: ready\ndata: {"listening":true,"at":8}\n\n');
  ok('换会话重连后补读', await until(() => calls.some(call => call.recovery)));

  // 页面全部离开：断开连接，不再重连。
  stop();
  ok('没有订阅后断开连接', streams[5].signal.aborted);
  await delay(400);
  check('没有订阅后不再重连', streams.length, 6);
  ok('没有订阅后显示未连接', !service.isRealtimeConnected());
}

async function hookTests() {
  let trigger = null;
  const mounted = [];
  globalThis.__hookDeps = {
    onMounted: fn => mounted.push(fn),
    onUnmounted: () => {},
    onDataChange: (topics, handler) => { trigger = handler; return () => {}; }
  };
  const hook = await loadModule('../src/hooks/useRealtimeRefresh.js',
    'const { onMounted, onUnmounted, onDataChange } = globalThis.__hookDeps;',
    source => source.replace('const RETRY_MIN_MS = 2_000;', 'const RETRY_MIN_MS = 300;')
      .replace('const RETRY_MAX_MS = 30_000;', 'const RETRY_MAX_MS = 1200;'));

  check('断网、超时、5xx 值得再读', [{}, { status: 0 }, { status: 503 }, { status: 408 }, { status: 429 }].map(hook.shouldRetryRefresh), [true, true, true, true, true]);
  check('登录失效、没有权限、不存在、会话已更换不再读', [{ status: 401 }, { status: 403 }, { status: 404 }, { code: 'SESSION_CHANGED' }].map(hook.shouldRetryRefresh), [false, false, false, false]);

  const runs = [];
  let failures = 2;
  hook.useRealtimeRefresh(['alarm'], async topics => {
    runs.push({ topics, at: Date.now() });
    if (failures > 0) { failures--; const error = new Error('服务暂时不可用'); error.status = 503; throw error; }
  }, { minIntervalMs: 10 });
  mounted.forEach(fn => fn());
  trigger(['alarm']);
  ok('暂时失败后退避重试直到成功', await until(() => runs.length === 3, 3_000));
  check('重试读的是同一批变化', runs.map(run => run.topics), [['alarm'], ['alarm'], ['alarm']]);
  ok('第二次重试比第一次等得更久', runs[2].at - runs[1].at >= runs[1].at - runs[0].at);
  await delay(700);
  check('成功后不再重读', runs.length, 3);

  // 没有权限：不重试。
  const denied = [];
  mounted.length = 0;
  hook.useRealtimeRefresh(['alarm'], async () => { denied.push(1); const error = new Error('没有权限'); error.status = 403; throw error; }, { minIntervalMs: 10 });
  mounted.forEach(fn => fn());
  trigger(['alarm']);
  await delay(700);
  check('没有权限时不重试', denied.length, 1);

  // 退避中收到恢复信号：立即再读，不等退避结束。
  const recovered = [];
  let fail = true;
  mounted.length = 0;
  hook.useRealtimeRefresh(['alarm'], async topics => {
    recovered.push({ topics, at: Date.now() });
    if (fail) { fail = false; throw new Error('网络中断'); }
  }, { minIntervalMs: 10 });
  mounted.forEach(fn => fn());
  trigger(['alarm']);
  await until(() => recovered.length === 1);
  await delay(5);
  const before = Date.now();
  trigger(['*'], { recovery: true });
  ok('恢复信号立即再读', await until(() => recovered.length === 2, 250));
  ok('恢复重读没有等退避', recovered[1].at - before < 250);
  check('恢复重读合并了未完成的变化', recovered[1].topics.sort(), ['*', 'alarm']);

  // 重读进行中再来的信号合并成结束后的一次。
  const merged = [];
  let release = null;
  mounted.length = 0;
  hook.useRealtimeRefresh(['alarm'], topics => { merged.push(topics); return new Promise(resolve => { release = resolve; }); }, { minIntervalMs: 10 });
  mounted.forEach(fn => fn());
  trigger(['alarm']);
  await until(() => merged.length === 1);
  trigger(['disposal']);
  trigger(['punishment']);
  await delay(30);
  check('重读进行中不并发', merged.length, 1);
  release();
  await until(() => merged.length === 2);
  check('期间的信号合并成一次', merged[1].sort(), ['disposal', 'punishment']);
  release();
}

async function main() {
  await serviceTests();
  clearInterval(heartbeatTimer);
  await hookTests();
  console.log(`realtimeRecovery: ${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
