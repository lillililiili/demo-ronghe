<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { deviceApi } from '@/services/deviceApi.js';
import { hasModuleAction } from '@/services/accessControl.js';
import { authSession } from '@/services/auth.js';
import TargetLiveVideo from './TargetLiveVideo.vue';

const props = defineProps({
  targetId: { type: String, default: '' },
  contextLabel: { type: String, default: '' },
  active: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  unavailableReason: { type: String, default: '' },
  beginReason: { type: String, default: '人工补充光电追踪' },
  eventId: { type: String, default: '' }
});
const state = ref(null), loading = ref(false), busy = ref(false);
const readError = ref(''), actionMessage = ref('');
// 查看跟踪状态只要设备查看权限（与后端 eo-tracking-status 一致，OBS-03）；补跟踪、暂停等按钮仍只来自后端 allowed_actions。
const permitted = computed(() => hasModuleAction('devices', 'read'));
const canOperate = computed(() => hasModuleAction('devices', 'op'));
const reason = computed(() => props.unavailableReason || (!props.targetId ? '没有关联目标，无法读取光电追踪。' : '')
  || (!permitted.value ? '当前账号没有设备查看权限，无法读取光电追踪。' : ''));
const actions = computed(() => !reason.value && !readError.value && !busy.value && !loading.value && state.value
  && Array.isArray(state.value.allowed_actions) ? state.value.allowed_actions : []);
const statusText = computed(() => ({
  IDLE: '暂无跟踪任务', WAITING_DEVICE: '等待可用设备', STARTING: '正在启动跟踪',
  TRACKING: '正在跟踪', LOST: '跟踪信号中断', ENDING: '正在结束跟踪',
  END_UNCONFIRMED: '结束结果未确认', FAILED: '跟踪失败', PAUSED: '自动追踪已暂停',
  BLOCKED: '当前无法追踪', DISABLED: '自动追踪未启用', ENDED: '跟踪已结束'
})[state.value?.status] || '跟踪状态未确认');
const statusDetail = computed(() => {
  const message = (state.value?.message || '')
    .replace('目标位置已过期或轨迹不可用，不能以失联推断飞离', '位置过期或轨迹不可用，飞离未确认')
    .replace('已收到跟踪回执；视频可用性独立显示', '')
    .replace('此目标已暂停自动追踪', '')
    .replace('自动追踪能力未启用', '')
    .replace('存在观察需求，等待后台调度可用设备', '')
    .replace(/^；/, '');
  return message === statusText.value ? '' : message;
});
const pauseLabel = computed(() => ['STARTING', 'TRACKING', 'LOST', 'ENDING', 'END_UNCONFIRMED'].includes(state.value?.status)
  ? '暂停并结束' : '暂停自动追踪');
let generation = 0, contextGeneration = 0, timer = null, controller = null, alive = true;

function invalidate() {
  ++generation;
  ++contextGeneration;
  clearTimeout(timer);
  controller?.abort();
  controller = null;
  state.value = null;
  loading.value = false;
  busy.value = false;
  readError.value = '';
  actionMessage.value = '';
}

async function refresh(silent = false) {
  clearTimeout(timer);
  if (!alive || !props.active || reason.value || busy.value) return;
  const token = ++generation, id = props.targetId;
  controller?.abort();
  const pending = new AbortController();
  controller = pending;
  const deadline = setTimeout(() => pending.abort(), 12000);
  const current = () => alive && token === generation && props.active && props.targetId === id && !reason.value;
  if (!silent) loading.value = true;
  try {
    const result = await deviceApi.eoTrackingStatus(id, { signal: pending.signal, dedupe: false });
    if (!current()) return;
    if (!result || result.target_id !== id || !result.status || !Array.isArray(result.allowed_actions)) {
      throw new Error('跟踪状态响应不完整，请重新读取。');
    }
    state.value = result;
    readError.value = '';
  } catch (error) {
    if (current()) {
      state.value = null;
      readError.value = pending.signal.aborted ? '跟踪状态读取超时，请重试。' : error.message || '跟踪状态读取失败，请重试。';
    }
  } finally {
    clearTimeout(deadline);
    if (current()) {
      loading.value = false;
      if (!readError.value) timer = setTimeout(() => refresh(true), 5000);
    }
  }
}

async function perform(action) {
  if (!actions.value.includes(action)) return;
  const id = props.targetId, token = ++generation, context = contextGeneration;
  clearTimeout(timer);
  controller?.abort();
  busy.value = true;
  actionMessage.value = '';
  let failure = '';
  try {
    if (action === 'BEGIN' || action === 'RETRY') await deviceApi.beginEoTrack(id, { reason: props.beginReason });
    else if (action === 'PAUSE') await deviceApi.pauseEoTracking(id);
    else if (action === 'RESUME') await deviceApi.resumeEoTracking(id);
  } catch (error) {
    failure = error.message || '请求结果未确认';
  } finally {
    if (alive && token === generation && props.targetId === id) {
      state.value = null;
      busy.value = false;
      actionMessage.value = failure ? `${failure}；正在回读当前跟踪状态。` : '';
      await refresh();
      if (failure && alive && context === contextGeneration) actionMessage.value = `${failure}；请以当前跟踪状态为准。`;
    }
  }
}

watch([() => props.targetId, () => props.contextLabel, () => props.active, authSession, reason], () => {
  invalidate();
  if (props.active) refresh();
}, { immediate: true, flush: 'sync' });
onUnmounted(() => { alive = false; invalidate(); });
</script>

<template>
  <section class="target-tracking-panel" :class="{ compact }" aria-label="光电追踪与视频">
    <div class="tracking-head">
      <div class="tracking-summary"><strong>光电追踪</strong>
        <span v-if="active && !reason && !readError && state" class="tracking-status" role="status">{{ statusText }}</span>
      </div>
      <button v-if="!reason && active" class="btn" type="button" aria-label="刷新跟踪状态" :disabled="loading || busy" @click="refresh()">{{ loading ? '读取中' : '刷新' }}</button>
    </div>
    <p v-if="reason" role="status">{{ reason }}</p>
    <p v-else-if="!active" role="status">切换回当前页面后读取跟踪状态。</p>
    <p v-else-if="readError" class="tracking-error" role="alert">{{ readError }}</p>
    <template v-else-if="active">
      <p v-if="loading && !state" role="status">正在读取跟踪状态</p>
      <template v-else-if="state">
        <p v-if="statusDetail" class="tracking-detail" role="status">{{ statusDetail }}</p>
        <p v-if="!canOperate" class="tracking-detail" role="note">当前账号只能查看光电追踪；补跟踪、暂停等操作需要设备操作权限。</p>
        <div v-if="actions.length" class="tracking-actions">
          <button v-if="actions.includes('BEGIN')" class="btn" type="button" @click="perform('BEGIN')">人工补跟踪</button>
          <button v-if="actions.includes('RETRY')" class="btn" type="button" @click="perform('RETRY')">重试跟踪</button>
          <button v-if="actions.includes('PAUSE')" class="btn" type="button" title="暂停该目标的自动追踪，三个页面同步生效" @click="perform('PAUSE')">{{ pauseLabel }}</button>
          <button v-if="actions.includes('RESUME')" class="btn" type="button" @click="perform('RESUME')">恢复自动追踪</button>
        </div>
      </template>
    </template>
    <p v-if="busy" role="status">正在提交操作，随后读取最新状态。</p>
    <p v-if="actionMessage" class="tracking-error" role="alert">{{ actionMessage }}</p>
    <TargetLiveVideo v-if="state && !state.auto_paused && state.status !== 'PAUSED'"
      :target-id="targetId" :event-id="eventId" :context-label="contextLabel" :active="active"
      :compact="compact" :unavailable-reason="unavailableReason" />
  </section>
</template>

<style scoped>
.target-tracking-panel { margin:8px 12px; padding:10px 12px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface-1); min-width:0; }
.tracking-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.tracking-summary { display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0; }
.tracking-status { color:var(--txt-2); font-size:12px; overflow-wrap:anywhere; }
strong { font-size:14px; }
p { margin:8px 0; font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
.tracking-detail { color:var(--txt-2); }
.tracking-error { color:var(--amber); }
.tracking-actions { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
.btn { min-height:34px; height:auto; white-space:normal; }
.target-tracking-panel :deep(.target-live-video) { margin:10px 0 0; border:0; border-top:1px solid var(--line); border-radius:0; background:transparent; }
.target-tracking-panel :deep(.target-live-video header) { padding:10px 0; flex-wrap:wrap; }
.target-tracking-panel :deep(.video-content) { padding:0; }
</style>
