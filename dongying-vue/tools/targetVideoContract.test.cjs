const assert = require('node:assert/strict');
const { test } = require('node:test');

test('only explicit available simulated endpoint responses permit playback', async () => {
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  const ready = { target_id: 't1', task_id: 'job1', device_id: 'd1', status: 'AVAILABLE', playback_type: 'SIMULATED_CANVAS', simulated: true, reason: '模拟跟踪已确认' };
  assert.equal(targetVideoState('t1', ready).simulated, true);
  for (const patch of [{ target_id: 'other' }, { playback_type: 'NONE' }, { status: 'NOT_INTEGRATED' }, { simulated: false }, { task_id: '' }]) {
    assert.equal(targetVideoState('t1', { ...ready, ...patch }).simulated, false);
  }
  assert.equal(targetVideoState('t1', null).simulated, false);
});

test('video component discards stale responses and clears playback on task changes, errors and permission loss', async () => {
  const fs = require('node:fs');
  const vue = await import('vue');
  const { targetVideoState } = await import('../src/components/video/targetVideoState.js');
  let source = fs.readFileSync(require('node:path').resolve(__dirname, '../src/components/video/TargetLiveVideo.vue'), 'utf8').split('<script setup>')[1].split('</script>')[0];
  source = source.replace(/^import .*;\n/gm, '').replace(/const props = defineProps\([\s\S]*?\n\}\);/, '');
  const props = vue.reactive({ targetId: 'one', active: true, defaultExpanded: true, contextLabel: '', unavailableReason: '' });
  const permission = vue.ref(true), requests = [], unmounts = [];
  const deviceApi = { targetVideo: id => new Promise((resolve, reject) => requests.push({ id, resolve, reject })) };
  const run = new Function('props', 'deviceApi', 'hasModuleAction', 'targetVideoState', 'computed', 'ref', 'watch', 'onUnmounted', source + '\nreturn { video, preview, expanded, refresh, clear };');
  const scope = vue.effectScope();
  const instance = scope.run(() => run(props, deviceApi, () => permission.value, targetVideoState, vue.computed, vue.ref, vue.watch, cb => unmounts.push(cb)));
  const response = (id, task = 'task') => ({ target_id: id, task_id: task, device_id: 'device', command_id: task, status: 'AVAILABLE', simulated: true, playback_type: 'SIMULATED_CANVAS' });
  const flush = async () => { await Promise.resolve(); await vue.nextTick(); };
  try {
    assert.equal(requests[0].id, 'one');
    props.targetId = 'two';
    requests[0].resolve(response('one'));
    await flush();
    assert.equal(instance.video.value, null, 'old target response discarded');
    requests[1].resolve(response('two'));
    await flush();
    instance.preview.value = true;
    const refresh = instance.refresh();
    requests[2].resolve(response('two', 'new-task'));
    await refresh;
    assert.equal(instance.preview.value, false, 'new task requires new playback');
    instance.preview.value = true;
    permission.value = false;
    assert.equal(instance.preview.value, false, 'lost permission stops immediately');
    assert.equal(instance.video.value, null);
    permission.value = true;
    requests[3].resolve(response('two'));
    await flush();
    instance.preview.value = true;
    const failing = instance.refresh();
    requests[4].reject(new Error('HTTP 403'));
    await failing;
    assert.equal(instance.preview.value, false);
    assert.equal(instance.video.value, null);
    instance.expanded.value = false;
    await flush();
    assert.equal(instance.preview.value, false);
    instance.expanded.value = true;
    await flush();
    const last = requests.at(-1);
    unmounts.forEach(cb => cb());
    last.resolve(response('two'));
    await flush();
    assert.equal(instance.video.value, null, 'reply after unmount discarded');
  } finally { unmounts.forEach(cb => cb()); scope.stop(); }
});
