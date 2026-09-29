const assert = require('node:assert/strict');
const { test } = require('node:test');

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
  const run = new Function('props', 'deviceApi', 'hasModuleAction', 'targetVideoState', 'computed', 'ref', 'watch', 'onUnmounted', 'authSession', source + '\nreturn { video, expanded, refresh, clear };');
  const scope = vue.effectScope();
  const instance = scope.run(() => run(props, deviceApi, () => permission.value, targetVideoState, vue.computed, vue.ref, vue.watch, cb => unmounts.push(cb), authSession));
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
    requests[4].reject(new Error('HTTP 403'));
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
