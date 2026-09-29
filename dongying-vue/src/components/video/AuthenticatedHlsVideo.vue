<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Hls from 'hls.js';
import { authSession } from '@/services/auth.js';
import { readSessionToken } from '@/services/apiClient.js';
import { targetVideoState } from './targetVideoState.js';
import { authenticatedHlsLoader, streamUrl } from './authenticatedHlsLoader.js';

const props = defineProps({ targetId: { type: String, required: true }, video: { type: Object, required: true } });
const media = ref(null), phase = ref('WAITING'), error = ref('');
const playable = computed(() => targetVideoState(props.targetId, props.video).playable);
const text = computed(() => error.value || ({ WAITING: '视频加载中', READY: '视频已加载，请点击播放', PLAYING: '播放中', BUFFERING: '等待视频数据', PAUSED: '视频已暂停', INTERRUPTED: '视频已中断，请刷新视频状态' })[phase.value]);
let player, sequence = 0, watchdog;
function destroy() {
  clearTimeout(watchdog);
  player?.destroy(); player = null;
  if (media.value) { media.value.pause(); media.value.removeAttribute('src'); media.value.load(); }
}
function interrupt(message = '视频已中断，请刷新视频状态') {
  ++sequence; error.value = message; phase.value = 'INTERRUPTED'; destroy();
}
function waitForData() {
  if (error.value) return;
  phase.value = 'BUFFERING';
  clearTimeout(watchdog); watchdog = setTimeout(() => interrupt(), 15000);
}
function playing() {
  if (error.value || !playable.value || !player) return;
  clearTimeout(watchdog); phase.value = 'PLAYING';
}
async function start() {
  const current = ++sequence;
  destroy(); error.value = ''; phase.value = 'WAITING';
  if (!playable.value || !authSession.value) return;
  await nextTick();
  if (current !== sequence || !media.value) return;
  if (!Hls.isSupported()) { interrupt('当前浏览器不支持带会话授权的视频播放，请使用支持 MediaSource 的浏览器。'); return; }
  try {
    const options = { origin: location.origin, targetId: props.targetId, streamId: props.video.stream_id };
    const url = streamUrl(props.video.playback_url, options);
    player = new Hls({ enableWorker: true, loader: authenticatedHlsLoader({ ...options,
      session: authSession.value, readToken: readSessionToken,
      onUnauthorized: () => window.dispatchEvent(new Event('api:unauthorized')) }) });
    player.on(Hls.Events.ERROR, (_event, data) => {
      if (current === sequence && (data.fatal || data.type === Hls.ErrorTypes.NETWORK_ERROR)) interrupt();
    });
    player.on(Hls.Events.MANIFEST_PARSED, () => { if (current === sequence) { clearTimeout(watchdog); phase.value = 'READY'; } });
    player.attachMedia(media.value);
    player.loadSource(url);
    watchdog = setTimeout(() => interrupt(), 15000);
  } catch { interrupt('视频地址或会话无效，请刷新视频状态'); }
}
watch([() => props.targetId, () => props.video.task_id, () => props.video.command_id,
  () => props.video.stream_id, () => props.video.playback_url, playable, authSession], start, { immediate: true, flush: 'post' });
onBeforeUnmount(() => { ++sequence; destroy(); });
</script>

<template>
  <div class="external-video" :data-player-state="phase">
    <video v-show="!error" ref="media" controls muted playsinline preload="metadata" aria-label="外部光电视频"
      @playing="playing" @waiting="waitForData" @stalled="waitForData"
      @pause="!error && (phase = 'PAUSED')" @ended="interrupt()" @error="interrupt()" />
    <p :role="error ? 'alert' : 'status'">{{ text }}</p>
  </div>
</template>

<style scoped>
.external-video { min-width:0; }
video { width:100%; max-height:360px; background:#000; display:block; }
p { margin:8px 0; color:var(--txt-2); font-size:13px; }
</style>
