<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { deviceApi } from '@/services/deviceApi.js';
import { hasModuleAction } from '@/services/accessControl.js';
import AuthenticatedHlsVideo from './AuthenticatedHlsVideo.vue';
import { authSession } from '@/services/auth.js';
import { targetVideoState } from './targetVideoState.js';

const props = defineProps({
  targetId: { type: String, default: '' },
  contextLabel: { type: String, default: '' },
  unavailableReason: { type: String, default: '' },
  active: { type: Boolean, default: true },
  defaultExpanded: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  subtype: { type: String, default: 'UAV' },
  // 截图、录像取证时一并关联的告警事件；没有时只关联目标和光电设备。
  eventId: { type: String, default: '' }
});
const expanded = ref(props.defaultExpanded), video = ref(null);
const loading = ref(false), checked = ref(false), error = ref('');
// 看画面只是读取：与后端 /targets/{id}/video 一致只要设备查看权限（OBS-03，值班员要能看光电画面）。
const permitted = computed(() => hasModuleAction('devices', 'read'));
const state = computed(() => targetVideoState(props.targetId, video.value));
const reason = computed(() => props.unavailableReason || (!props.targetId ? '未提供可读取的关联目标，无法定位视频。' : '')
  || (!permitted.value ? '当前账号没有设备查看权限，无法查看光电画面。' : ''));
let generation = 0, timer, controller, alive = true;
function clear() {
  ++generation; clearTimeout(timer); controller?.abort();
  video.value = null; error.value = ''; loading.value = false; checked.value = false;
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
    const nextVideo = await deviceApi.targetVideo(id, options);
    if (!current()) return;
    if (!nextVideo || nextVideo.target_id !== id) throw new Error('视频与当前目标不一致，已停止显示。');
    video.value = nextVideo;
  } catch (e) {
    if (current()) { video.value = null; error.value = pending.signal.aborted ? '视频关联状态读取超时，请重试。' : e.message || '视频关联状态读取失败，请重试。'; }
  } finally {
    clearTimeout(deadline);
    if (current()) {
      loading.value = false; checked.value = true;
      if (!error.value) timer = setTimeout(refresh, 5000);
    }
  }
}
function reloadVideo() { clear(); refresh(); }
function toggle() { expanded.value = !expanded.value; }
watch([() => props.targetId, () => props.contextLabel, () => props.active, authSession, reason], () => { clear(); if (expanded.value) refresh(); }, { flush: 'sync' });
watch(expanded, open => { clear(); if (open) refresh(); }, { immediate: true });
onUnmounted(() => { alive = false; clear(); });
</script>

<template>
  <section class="target-live-video" :class="{ compact }" aria-label="实时视频">
    <header>
      <div class="video-heading">
        <slot name="title"><strong>实时视频</strong></slot>
        <span v-if="state.simulated" class="video-context">测试视频 · 非现场</span>
        <span v-else-if="state.playable" class="video-context">当前画面 · 非事发录像</span>
      </div>
      <div class="video-toolbar"><button v-if="expanded && !reason" type="button" class="btn" aria-label="刷新视频状态" :disabled="loading" @click="reloadVideo">刷新</button>
      <slot name="actions"><button class="btn" type="button" :aria-expanded="expanded" @click="toggle">{{ expanded ? '收起视频' : '查看视频' }}</button></slot></div>
    </header>
    <div v-if="expanded && active" class="video-content">
      <p v-if="reason" role="status">{{ reason }}</p>
      <p v-else-if="error" role="alert" class="video-error">{{ error }}</p>
      <template v-else>
        <p v-if="loading && !checked" role="status">视频读取中</p>
        <p v-else-if="!state.playable" role="status">{{ state.message }}</p>
        <AuthenticatedHlsVideo v-if="state.playable" :target-id="targetId" :video="video" :event-id="eventId" />
      </template>
    </div>
  </section>
</template>

<style scoped>
.target-live-video { flex:none; border:1px solid var(--line); border-radius:var(--r); background:var(--surface-1); margin:8px 12px; min-width:0; }
.video-toolbar { display:flex; gap:6px; flex-wrap:wrap; }
.video-heading { display:flex; align-items:center; gap:8px; flex-wrap:wrap; min-width:0; }
.compact header { padding:8px 12px; }
.compact .video-content { padding-bottom:4px; }
header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; flex-wrap:wrap; }
strong { font-size:14px; }
.video-content { padding:0 12px 12px; }
p { margin:0 0 10px; font-size:13px; line-height:1.6; white-space:normal; overflow-wrap:anywhere; }
.video-context { color:var(--txt-2); font-size:12px; }
.video-error { color:var(--amber); }
.btn { min-height:34px; height:auto; white-space:normal; }
</style>
