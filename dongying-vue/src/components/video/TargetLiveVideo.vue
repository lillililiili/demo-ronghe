<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { deviceApi } from '@/services/deviceApi.js';
import { hasModuleAction } from '@/services/accessControl.js';
import SimulatedOpticalVideo from './SimulatedOpticalVideo.vue';
import { targetVideoState } from './targetVideoState.js';

const props = defineProps({
  targetId: { type: String, default: '' },
  contextLabel: { type: String, default: '' },
  unavailableReason: { type: String, default: '' },
  active: { type: Boolean, default: true },
  defaultExpanded: { type: Boolean, default: false },
  compact: { type: Boolean, default: false }
});
const expanded = ref(props.defaultExpanded), preview = ref(false), task = ref(null), command = ref(null);
const loading = ref(false), checked = ref(false), error = ref('');
const permitted = computed(() => hasModuleAction('devices', 'op'));
const state = computed(() => targetVideoState(props.targetId, task.value, command.value));
const reason = computed(() => props.unavailableReason || (!props.targetId ? '未提供可读取的关联目标，无法定位视频。' : '')
  || (!permitted.value ? '当前账号没有读取光电跟踪的设备操作权限。' : ''));
let generation = 0, timer, controller, alive = true;
function clear() {
  ++generation; clearTimeout(timer); controller?.abort(); preview.value = false;
  task.value = null; command.value = null; error.value = ''; loading.value = false; checked.value = false;
}
async function refresh() {
  clearTimeout(timer);
  if (!alive || !props.active || !expanded.value || reason.value) return;
  const token = ++generation, id = props.targetId;
  controller?.abort();
  const pending = new AbortController(); controller = pending;
  const deadline = setTimeout(() => pending.abort(), 12000);
  const options = { signal: pending.signal, dedupe: false };
  const current = () => alive && token === generation && props.active && expanded.value && props.targetId === id;
  loading.value = true; error.value = '';
  try {
    const nextTask = await deviceApi.currentEoTrack(id, options);
    if (!current()) return;
    if (nextTask && nextTask.target_id !== id) throw new Error('跟踪任务与当前目标不一致，已停止显示。');
    if (task.value?.task_id !== nextTask?.task_id || task.value?.command_id !== nextTask?.command_id) preview.value = false;
    const nextCommand = nextTask?.status === 'OPEN' && nextTask.command_id ? await deviceApi.command(nextTask.command_id, options) : null;
    if (!current()) return;
    task.value = nextTask; command.value = nextCommand;
    if (!state.value.simulated) preview.value = false;
  } catch (e) {
    if (current()) { task.value = null; command.value = null; preview.value = false; error.value = pending.signal.aborted ? '视频关联状态读取超时，请重试。' : e.message || '视频关联状态读取失败，请重试。'; }
  } finally {
    clearTimeout(deadline);
    if (current()) {
      loading.value = false; checked.value = true;
      if (!error.value) timer = setTimeout(refresh, 5000);
    }
  }
}
function toggle() { expanded.value = !expanded.value; }
watch([() => props.targetId, () => props.contextLabel, () => props.active, reason], () => { clear(); if (expanded.value) refresh(); });
watch(expanded, open => { clear(); if (open) refresh(); }, { immediate: true });
onUnmounted(() => { alive = false; clear(); });
</script>

<template>
  <section class="target-live-video" :class="{ compact }" aria-label="实时视频">
    <header>
      <strong>实时视频</strong>
      <div class="video-toolbar"><button v-if="compact && expanded && !reason" type="button" class="btn" :disabled="loading" @click="refresh">刷新</button>
      <button class="btn" type="button" :aria-expanded="expanded" @click="toggle">{{ expanded ? '收起视频' : '查看视频' }}</button></div>
    </header>
    <div v-if="expanded && active" class="video-content">
      <p v-if="compact && state.simulated" class="video-context">当前目标画面，不代表历史事发画面</p>
      <p v-else-if="!compact && contextLabel" class="video-context">{{ contextLabel }} · 当前目标画面，不代表历史事发画面</p>
      <p v-if="reason" role="status">{{ reason }}</p>
      <p v-else-if="error" role="alert" class="video-error">{{ error }}</p>
      <template v-else>
        <p v-if="loading && !checked" role="status">正在读取视频关联状态</p>
        <p v-else role="status">{{ state.message }}</p>
        <SimulatedOpticalVideo v-if="preview && state.simulated" :key="`${targetId}:${task.task_id}`" subtype="UAV" />
        <button v-if="state.simulated && !preview" type="button" class="btn" @click="preview = true">播放模拟画面</button>
      </template>
      <button v-if="!reason && !compact" class="btn refresh-video" type="button" :disabled="loading" @click="refresh">{{ loading ? '正在读取' : '刷新视频状态' }}</button>
    </div>
  </section>
</template>

<style scoped>
.target-live-video { flex:none; border:1px solid var(--line); border-radius:var(--r); background:var(--surface-1); margin:8px 12px; min-width:0; }
.video-toolbar { display:flex; gap:6px; flex-wrap:wrap; }
.compact header { padding:8px 12px; }
.compact .video-content { padding-bottom:4px; }
header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; }
strong { font-size:14px; }
.video-content { padding:0 12px 12px; }
p { margin:0 0 10px; font-size:13px; line-height:1.6; white-space:normal; overflow-wrap:anywhere; }
.video-context { color:var(--txt-2); font-size:12px; }
.video-error { color:var(--amber); }
.btn { min-height:34px; height:auto; white-space:normal; }
.refresh-video { margin:8px 0 0 8px; }
</style>
