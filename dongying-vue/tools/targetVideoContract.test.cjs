const assert = require('node:assert/strict');
const { test } = require('node:test');

// 组件按源码装进 new Function 测；断网重试判断用 useRealtimeRefresh.js 里的真实实现（去掉 vue 和推送服务的依赖）。
async function retryHelpers() {
  const fs = require('node:fs');
  let source = fs.readFileSync(require('node:path').resolve(__dirname, '../src/hooks/useRealtimeRefresh.js'), 'utf8');
  source = 'const onMounted = () => {}, onUnmounted = () => {}, onDataChange = () => () => {};\n'
    + source.replace(/import[\s\S]*?from ['"][^'"]+['"];\r?\n/g, '');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('only complete authorized HLS association permits playback; tracking alone never suffices', async () => {
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  const ready = { target_id: 't1', task_id: 'job1', device_id: 'd1', stream_id: 's1', status: 'TRACKING', video_status: 'AVAILABLE', playback_type: 'HLS', playback_url: '/api/v1/targets/t1/video/streams/s1/index.m3u8', source_mode: 'live', simulated: false };
  assert.equal(targetVideoState('t1', ready).playable, true);
  for (const patch of [{ target_id: 'other' }, { playback_type: 'NONE' }, { status: 'ENDED' }, { status: 'WAITING' }, { video_status: 'WAITING' }, { video_status: 'INTERRUPTED' }, { task_id: '' }, { stream_id: '' }, { playback_url: '' }]) {
    assert.equal(targetVideoState('t1', { ...ready, ...patch }).playable, false);
  }
  assert.equal(targetVideoState('t1', { ...ready, simulated: true, source_mode: 'replay' }).simulated, true);
  assert.equal(targetVideoState('t1', null).playable, false);
});

test('video component discards stale responses and clears playback on task changes, errors and permission loss', async () => {
  const fs = require('node:fs');
  const vue = await import('vue');
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  let source = fs.readFileSync(require('node:path').resolve(__dirname, '../src/components/video/TargetLiveVideo.vue'), 'utf8').split('<script setup>')[1].split('</script>')[0];
  source = source.replace(/^import .*;\r?\n/gm, '').replace(/const props = defineProps\([\s\S]*?\r?\n\}\);/, '');
  const props = vue.reactive({ targetId: 'one', active: true, defaultExpanded: true, contextLabel: '', unavailableReason: '' });
  const authSession = vue.ref('session'), permission = vue.ref(true), requests = [], unmounts = [];
  const deviceApi = { targetVideo: id => new Promise((resolve, reject) => requests.push({ id, resolve, reject })) };
  const { shouldRetryRefresh, refreshFailureText } = await retryHelpers();
  const run = new Function('props', 'deviceApi', 'hasModuleAction', 'targetVideoState', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', 'shouldRetryRefresh', 'refreshFailureText', source + '\nreturn { video, expanded, refresh, clear };');
  const scope = vue.effectScope();
  const instance = scope.run(() => run(props, deviceApi, () => permission.value, targetVideoState, vue.computed, vue.ref, vue.watch, cb => unmounts.push(cb), authSession, shouldRetryRefresh, refreshFailureText));
  const response = (id, task = 'task') => ({ target_id: id, task_id: task, device_id: 'device', command_id: task, status: 'TRACKING', video_status: 'AVAILABLE', stream_id: 'stream', playback_url: '/api/v1/targets/one/video/streams/stream/index.m3u8', simulated: false, playback_type: 'HLS' });
  const flush = async () => { await Promise.resolve(); await vue.nextTick(); };
  try {
    assert.equal(requests[0].id, 'one');
    props.targetId = 'two';
    requests[0].resolve(response('one'));
    await flush();
    assert.equal(instance.video.value, null, 'old target response discarded');
    requests[1].resolve(response('two'));
    await flush();
    const refresh = instance.refresh();
    requests[2].resolve(response('two', 'new-task'));
    await refresh;
    assert.equal(instance.video.value.task_id, 'new-task', 'new task replaces association');
    permission.value = false;
    assert.equal(instance.video.value, null);
    permission.value = true;
    requests[3].resolve(response('two'));
    await flush();
    const failing = instance.refresh();
    requests[4].reject(Object.assign(new Error('HTTP 403'), { status: 403 }));
    await failing;
    assert.equal(instance.video.value, null);
    instance.expanded.value = false;
    await flush();
    instance.expanded.value = true;
    await flush();
    const last = requests.at(-1);
    unmounts.forEach(cb => cb());
    last.resolve(response('two'));
    await flush();
    assert.equal(instance.video.value, null, 'reply after unmount discarded');
  } finally { unmounts.forEach(cb => cb()); scope.stop(); }
});


test('HLS loader authenticates each resource and blocks off-origin, target changes and redirects', async () => {
  const { authenticatedHlsLoader, streamUrl } = await import('../src/components/video/authenticatedHlsLoader.js');
  const context = { origin: 'https://app.example', targetId: 't1', streamId: 's1' };
  const prefix = '/api/v1/targets/t1/video/streams/s1/';
  for (const url of ['https://evil.example/x', '/api/v1/targets/t2/video/streams/s1/a.ts', prefix + '../other/a.ts', prefix + 'index.m3u8?token=secret', prefix + '%2e%2e/a.ts']) {
    assert.throws(() => streamUrl(url, context));
  }
  let token = 'current-session', calls = [], unauthorized = 0;
  const original = global.fetch;
  const Loader = authenticatedHlsLoader({ ...context, session: token, readToken: () => token, onUnauthorized: () => unauthorized++ });
  const run = url => new Promise(resolve => {
    const loader = new Loader();
    loader.load({ url, responseType: 'arraybuffer' }, { timeout: 1000 }, {
      onSuccess: data => resolve({ ok: true, data }), onError: data => resolve({ ok: false, data }), onTimeout: () => resolve({ timeout: true })
    });
  });
  try {
    global.fetch = async (url, options) => { calls.push({ url, options }); return new Response(new Uint8Array([1, 2, 3])); };
    assert.equal((await run(prefix + 'segment.ts')).ok, true);
    assert.equal(calls[0].options.headers.get('Authorization'), 'Bearer current-session');
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal((await run('https://evil.example/a.ts')).ok, false);
    assert.equal(calls.length, 1);
    token = 'changed';
    assert.equal((await run(prefix + 'next.ts')).ok, false);
    assert.equal(calls.length, 1);
    token = 'current-session';
    global.fetch = async () => new Response('', { status: 401 });
    assert.equal((await run(prefix + 'index.m3u8')).ok, false);
    assert.equal(unauthorized, 1);
  } finally { global.fetch = original; }
});

test('late 401 from destroyed or previous-session HLS requests cannot clear the current session', async () => {
  const { authenticatedHlsLoader } = await import('../src/components/video/authenticatedHlsLoader.js');
  const original = global.fetch;
  try {
    for (const scenario of ['destroyed', 'session-changed']) {
      let token = 'old-session', resolveResponse, unauthorized = 0, callbacks = 0;
      global.fetch = () => new Promise(resolve => { resolveResponse = resolve; });
      const Loader = authenticatedHlsLoader({ origin: 'https://app.example', targetId: 't1', streamId: 's1',
        session: token, readToken: () => token, onUnauthorized: () => unauthorized++ });
      const loader = new Loader();
      loader.load({ url: '/api/v1/targets/t1/video/streams/s1/index.m3u8', responseType: 'text' }, { timeout: 1000 }, {
        onSuccess: () => callbacks++, onError: () => callbacks++, onTimeout: () => callbacks++
      });
      if (scenario === 'destroyed') loader.destroy();
      else token = 'new-session';
      resolveResponse(new Response('', { status: 401 }));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(unauthorized, 0, scenario + ' must not emit unauthorized');
      assert.equal(callbacks, 0, scenario + ' must discard stale response');
      loader.destroy();
    }
  } finally { global.fetch = original; }
});

test('MediaMTX permits only one UUID media session query within the current authorized stream', async () => {
  const { streamUrl } = await import('../src/components/video/authenticatedHlsLoader.js');
  const context = { origin: 'https://app.example', targetId: 't1', streamId: 's1' };
  const path = '/api/v1/targets/t1/video/streams/s1/video1_stream.m3u8';
  const uuid = '12345678-1234-1234-1234-123456789abc';
  assert.equal(streamUrl(path + '?session=' + uuid, context), context.origin + path + '?session=' + uuid);
  for (const suffix of ['?session=secret', '?session=' + uuid + '&session=' + uuid,
    '?session=' + uuid + '&token=secret', '?other=' + uuid, '?session=' + uuid + '#fragment',
    '?session=%31' + uuid.slice(1), '?session=' + uuid + '&']) {
    assert.throws(() => streamUrl(path + suffix, context));
  }
  assert.throws(() => streamUrl('https://other.example' + path + '?session=' + uuid, context));
  assert.throws(() => streamUrl(path.replace('/t1/', '/t2/') + '?session=' + uuid, context));
});

// OBS-03：值班员只有设备查看权限，也要能看光电画面和跟踪状态；控制按钮仍只来自后端 allowed_actions。
function componentScript(file) {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').resolve(__dirname, '../src/components/video/' + file), 'utf8')
    .split('<script setup>')[1].split('</script>')[0];
  return source.replace(/^import .*;\r?\n/gm, '').replace(/const props = defineProps\([\s\S]*?\r?\n\}\);/, '');
}
const viewOnly = asked => (module, action) => { asked.push(`${module}.${action}`); return module === 'devices' && action === 'read'; };

test('viewing EO video and tracking status needs only device view permission', async () => {
  const vue = await import('vue');
  const { shouldRetryRefresh, refreshFailureText } = await retryHelpers();
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  const unmounts = [], asked = [], videoReads = [], statusReads = [];
  const scope = vue.effectScope();
  try {
    const video = new Function('props', 'deviceApi', 'hasModuleAction', 'targetVideoState', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', 'shouldRetryRefresh', 'refreshFailureText',
      componentScript('TargetLiveVideo.vue') + '\nreturn { reason };');
    const panel = new Function('props', 'deviceApi', 'hasModuleAction', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', 'shouldRetryRefresh', 'refreshFailureText',
      componentScript('TargetTrackingPanel.vue') + '\nreturn { reason, actions, canOperate, state };');
    const props = vue.reactive({ targetId: 'one', active: true, defaultExpanded: true, contextLabel: '', unavailableReason: '', beginReason: '人工补充光电追踪' });
    const deviceApi = {
      targetVideo: id => { videoReads.push(id); return new Promise(() => {}); },
      eoTrackingStatus: id => { statusReads.push(id); return Promise.resolve({ target_id: id, status: 'TRACKING', allowed_actions: [] }); }
    };
    const { liveVideo, tracking } = scope.run(() => ({
      liveVideo: video(props, deviceApi, viewOnly(asked), targetVideoState, vue.computed, vue.ref, vue.watch, cb => unmounts.push(cb), vue.ref('session'), shouldRetryRefresh, refreshFailureText),
      tracking: panel(props, deviceApi, viewOnly(asked), vue.computed, vue.ref, vue.watch, cb => unmounts.push(cb), vue.ref('session'), shouldRetryRefresh, refreshFailureText)
    }));
    await Promise.resolve(); await vue.nextTick();
    assert.equal(liveVideo.reason.value, '');
    assert.equal(tracking.reason.value, '');
    assert.deepEqual(videoReads, ['one'], 'video association is read with view permission');
    assert.deepEqual(statusReads, ['one'], 'tracking status is read with view permission');
    assert.equal(tracking.state.value.status, 'TRACKING');
    assert.deepEqual(tracking.actions.value, [], 'no control buttons without server actions');
    assert.equal(tracking.canOperate.value, false, 'view-only accounts get the explanation instead of buttons');
    assert.ok(asked.includes('devices.read'));
  } finally { unmounts.forEach(cb => cb()); scope.stop(); }

  const deniedScope = vue.effectScope(), deniedUnmounts = [], reads = [];
  try {
    const props = vue.reactive({ targetId: 'one', active: true, defaultExpanded: true, contextLabel: '', unavailableReason: '', beginReason: '' });
    const deviceApi = { targetVideo: id => { reads.push(id); return new Promise(() => {}); }, eoTrackingStatus: id => { reads.push(id); return new Promise(() => {}); } };
    const video = new Function('props', 'deviceApi', 'hasModuleAction', 'targetVideoState', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', 'shouldRetryRefresh', 'refreshFailureText',
      componentScript('TargetLiveVideo.vue') + '\nreturn { reason };');
    const panel = new Function('props', 'deviceApi', 'hasModuleAction', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', 'shouldRetryRefresh', 'refreshFailureText',
      componentScript('TargetTrackingPanel.vue') + '\nreturn { reason };');
    const result = deniedScope.run(() => ({
      liveVideo: video(props, deviceApi, () => false, targetVideoState, vue.computed, vue.ref, vue.watch, cb => deniedUnmounts.push(cb), vue.ref('session'), shouldRetryRefresh, refreshFailureText),
      tracking: panel(props, deviceApi, () => false, vue.computed, vue.ref, vue.watch, cb => deniedUnmounts.push(cb), vue.ref('session'), shouldRetryRefresh, refreshFailureText)
    }));
    assert.equal(result.liveVideo.reason.value, '当前账号没有设备查看权限，无法查看光电画面。');
    assert.equal(result.tracking.reason.value, '当前账号没有设备查看权限，无法读取光电追踪。');
    assert.deepEqual(reads, [], 'no request is sent without device view permission');
  } finally { deniedUnmounts.forEach(cb => cb()); deniedScope.stop(); }
});

// BUG-07：后台重启、断网时光电追踪卡片和视频面板退避后自己再读，后台恢复后不用点“刷新”；没有权限等再读也不会好的错误照旧停下。
test('EO tracking card and video recover by themselves after a backend outage', async () => {
  const vue = await import('vue');
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  const { shouldRetryRefresh, refreshFailureText } = await retryHelpers();
  const timers = [];
  const fakeSetTimeout = (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; };
  const fakeClearTimeout = timer => { if (timer) timer.cleared = true; };
  const pending = () => timers.filter(timer => !timer.cleared && timer.ms !== 12000);
  async function fire(ms) {
    const due = pending();
    assert.deepEqual(due.map(timer => timer.ms), [ms], `next read is scheduled after ${ms} ms`);
    due[0].cleared = true;
    await due[0].fn();
    await vue.nextTick();
  }
  const outage = () => Object.assign(new Error('系统暂时无法处理，请稍后查看最新记录；若刚提交过操作，请先核对结果，避免重复提交。'), { code: 'HTTP_ERROR', status: 500 });
  const denied = () => Object.assign(new Error('当前账号没有设备查看权限'), { status: 403 });
  let statusReply = () => Promise.resolve({ target_id: 'one', status: 'TRACKING', allowed_actions: ['PAUSE'] });
  let videoReply = () => Promise.resolve({ target_id: 'one', task_id: 'task', device_id: 'd1', stream_id: 's1', status: 'TRACKING', video_status: 'AVAILABLE', playback_type: 'HLS', playback_url: '/api/v1/targets/one/video/streams/s1/index.m3u8', simulated: false });
  const deviceApi = { eoTrackingStatus: () => statusReply(), targetVideo: () => videoReply() };
  const props = vue.reactive({ targetId: 'one', active: true, defaultExpanded: true, contextLabel: '', unavailableReason: '', beginReason: '人工补充光电追踪' });
  const unmounts = [], scope = vue.effectScope();
  const panel = new Function('props', 'deviceApi', 'hasModuleAction', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', 'shouldRetryRefresh', 'refreshFailureText', 'setTimeout', 'clearTimeout',
    componentScript('TargetTrackingPanel.vue') + '\nreturn { state, readError, actions };');
  const video = new Function('props', 'deviceApi', 'hasModuleAction', 'targetVideoState', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', 'shouldRetryRefresh', 'refreshFailureText', 'setTimeout', 'clearTimeout',
    componentScript('TargetLiveVideo.vue') + '\nreturn { video, error };');
  try {
    const tracking = scope.run(() => panel(props, deviceApi, () => true, vue.computed, vue.ref, vue.watch, cb => unmounts.push(cb), vue.ref('session'), shouldRetryRefresh, refreshFailureText, fakeSetTimeout, fakeClearTimeout));
    await Promise.resolve(); await vue.nextTick();
    assert.equal(tracking.state.value.status, 'TRACKING');
    statusReply = () => Promise.reject(outage());
    await fire(5000);
    assert.equal(tracking.state.value.status, 'TRACKING', 'last state kept while the backend is away, so the video panel stays');
    assert.equal(tracking.readError.value, '跟踪状态暂时读不到（服务暂时不可用），正在自动重试。');
    assert.deepEqual(tracking.actions.value, [], 'no control buttons while the state cannot be confirmed');
    await fire(5000);
    await fire(10000);
    await fire(15000);
    statusReply = () => Promise.resolve({ target_id: 'one', status: 'LOST', allowed_actions: [] });
    await fire(15000);
    assert.equal(tracking.readError.value, '', 'recovered without clicking refresh');
    assert.equal(tracking.state.value.status, 'LOST');
    statusReply = () => Promise.reject(denied());
    await fire(5000);
    assert.equal(tracking.state.value, null);
    assert.deepEqual(pending(), [], 'no automatic re-read after a permission error');
  } finally { unmounts.splice(0).forEach(cb => cb()); }

  timers.length = 0;
  try {
    const live = scope.run(() => video(props, deviceApi, () => true, targetVideoState, vue.computed, vue.ref, vue.watch, cb => unmounts.push(cb), vue.ref('session'), shouldRetryRefresh, refreshFailureText, fakeSetTimeout, fakeClearTimeout));
    await Promise.resolve(); await vue.nextTick();
    assert.equal(live.video.value.task_id, 'task');
    videoReply = () => Promise.reject(Object.assign(new Error('Failed to fetch'), { code: 'NETWORK_ERROR' }));
    await fire(5000);
    assert.equal(live.video.value, null);
    assert.equal(live.error.value, '视频关联状态暂时读不到（暂时连不上系统），正在自动重试。');
    await fire(5000);
    await fire(10000);
    videoReply = () => Promise.resolve({ target_id: 'one', task_id: 'task-2', device_id: 'd1', stream_id: 's1', status: 'TRACKING', video_status: 'AVAILABLE', playback_type: 'HLS', playback_url: '/api/v1/targets/one/video/streams/s1/index.m3u8', simulated: false });
    await fire(15000);
    assert.equal(live.error.value, '');
    assert.equal(live.video.value.task_id, 'task-2', 'video association read again after recovery');
    assert.deepEqual(pending().map(timer => timer.ms), [5000], 'back to the normal 5 s reading');
  } finally { unmounts.splice(0).forEach(cb => cb()); scope.stop(); }
});
