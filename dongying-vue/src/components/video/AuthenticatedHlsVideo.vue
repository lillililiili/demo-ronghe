<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Hls from 'hls.js';
import { authExpired, authSession } from '@/services/auth.js';
import { readSessionToken } from '@/services/apiClient.js';
import { targetVideoState } from './targetVideoState.js';
import { authenticatedHlsLoader, streamUrl } from './authenticatedHlsLoader.js';
import EoEvidenceCapture from './EoEvidenceCapture.vue';

const props = defineProps({ targetId: { type: String, required: true }, video: { type: Object, required: true }, eventId: { type: String, default: '' } });
const media = ref(null), phase = ref('WAITING'), error = ref('');
const container = ref(null), fullscreen = ref(false), fullscreenError = ref('');
let fullscreenGeneration = 0;
function syncFullscreen() { fullscreen.value = document.fullscreenElement === container.value; }
function fullscreenFailed() { syncFullscreen(); fullscreenError.value = '未能切换视频全屏，请检查浏览器是否允许全屏显示'; }
async function exitOwnedFullscreen() {
  ++fullscreenGeneration;
  if (container.value && document.fullscreenElement === container.value) {
    try { await document.exitFullscreen(); } catch { /* The browser may already be removing this element. */ }
  }
}
async function toggleFullscreen() {
  const generation = ++fullscreenGeneration, element = container.value;
  fullscreenError.value = '';
  try {
    if (document.fullscreenElement === container.value) await document.exitFullscreen();
    else if (container.value?.requestFullscreen) await container.value.requestFullscreen();
    else throw new Error('Fullscreen unavailable');
    if (generation !== fullscreenGeneration || !alive) {
      if (document.fullscreenElement === element) await document.exitFullscreen();
      return;
    }
    syncFullscreen();
  } catch { if (generation === fullscreenGeneration && alive) fullscreenFailed(); }
}
onMounted(() => {
  document.addEventListener('fullscreenchange', syncFullscreen);
  container.value?.addEventListener('fullscreenerror', fullscreenFailed);
});
const playable = computed(() => targetVideoState(props.targetId, props.video).playable);
const text = computed(() => error.value || ({ WAITING: '正在连接直播', PLAYING: '直播中', BUFFERING: '直播缓冲中',
  RECONNECTING: '直播连接中断，正在自动重连', BLOCKED: '浏览器阻止了自动播放，请点击连接直播', INTERRUPTED: '直播已停止' })[phase.value]);
let player, sequence = 0, watchdog, reconnectTimer, retryDelay = 0, alive = true;
function destroy() {
  clearTimeout(watchdog); watchdog = null;
  clearTimeout(reconnectTimer); reconnectTimer = null;
  const previous = player; player = null; previous?.destroy();
  if (media.value) { media.value.pause(); media.value.removeAttribute('src'); media.value.load(); }
}
function interrupt(message) {
  ++sequence; error.value = message; phase.value = 'INTERRUPTED'; destroy(); exitOwnedFullscreen();
}
function canConnect() { return alive && playable.value && !!authSession.value && !authExpired.value; }
function reconnect(current = sequence) {
  if (current !== sequence || !canConnect() || error.value || reconnectTimer) return;
  ++sequence; destroy(); phase.value = 'RECONNECTING';
  retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 10000);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (canConnect()) start(); }, retryDelay);
}
function watchForData(current = sequence) {
  if (!watchdog) watchdog = setTimeout(() => { watchdog = null; reconnect(current); }, 15000);
}
function waitForData() {
  if (error.value || !player || phase.value === 'BLOCKED') return;
  phase.value = 'BUFFERING';
  watchForData();
}
function playing() {
  if (error.value || !playable.value || !player) return;
  clearTimeout(watchdog); watchdog = null; retryDelay = 0; phase.value = 'PLAYING';
}
async function playLive(current = sequence) {
  if (current !== sequence || !canConnect() || !player || !media.value) return;
  media.value.muted = true;
  try { await media.value.play(); }
  catch (failure) {
    if (current !== sequence || !canConnect()) return;
    if (failure.name === 'NotAllowedError') {
      clearTimeout(watchdog); watchdog = null; phase.value = 'BLOCKED';
    } else if (failure.name !== 'AbortError') reconnect(current);
  }
}
function resumeLive() {
  if (!player || error.value || phase.value === 'BLOCKED' || !canConnect()) return;
  watchForData(); playLive();
}
async function start() {
  const current = ++sequence;
  destroy(); error.value = ''; phase.value = 'WAITING';
  if (!canConnect()) return;
  await nextTick();
  if (current !== sequence || !media.value) return;
  if (!Hls.isSupported()) { interrupt('当前浏览器不支持带会话授权的视频播放，请使用支持 MediaSource 的浏览器。'); return; }
  try {
    const options = { origin: location.origin, targetId: props.targetId, streamId: props.video.stream_id };
    const url = streamUrl(props.video.playback_url, options);
    player = new Hls({ enableWorker: true, liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 6, backBufferLength: 15,
      loader: authenticatedHlsLoader({ ...options,
      session: authSession.value, readToken: readSessionToken,
      onUnauthorized: () => {
        if (current !== sequence) return;
        interrupt('登录已过期，请重新登录后查看直播');
        window.dispatchEvent(new Event('api:unauthorized'));
      } }) });
    player.on(Hls.Events.ERROR, (_event, data) => {
      if (current !== sequence) return;
      const status = data.response?.code || data.networkDetails?.status;
      if (status === 401 || status === 403) { interrupt('当前会话无权读取直播，请重新登录或刷新视频状态'); return; }
      // HLS 会自行重试非致命网络/缓冲错误；一次丢片不能销毁整条直播。
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR || data.type === Hls.ErrorTypes.MEDIA_ERROR) reconnect(current);
      else interrupt('当前视频无法解码，请刷新视频状态');
    });
    player.on(Hls.Events.MANIFEST_PARSED, () => { if (current === sequence) playLive(current); });
    player.attachMedia(media.value);
    player.loadSource(url);
    watchForData(current);
  } catch { interrupt('视频地址或会话无效，请刷新视频状态'); }
}
watch([() => props.targetId, () => props.video.task_id, () => props.video.command_id,
  () => props.video.stream_id, () => props.video.playback_url, playable, authSession, authExpired],
  () => {
    retryDelay = 0;
    if (!authSession.value || authExpired.value) interrupt('登录已过期，请重新登录后查看直播');
    else start();
  }, { immediate: true, flush: 'post' });
watch([() => props.targetId, () => props.video.task_id, authSession, authExpired], () => exitOwnedFullscreen(), { flush: 'sync' });
onBeforeUnmount(() => {
  alive = false; ++sequence; exitOwnedFullscreen(); destroy();
  document.removeEventListener('fullscreenchange', syncFullscreen);
  container.value?.removeEventListener('fullscreenerror', fullscreenFailed);
});
</script>

<template>
  <div ref="container" class="external-video" :data-player-state="phase">
    <div class="fullscreen-toolbar">
      <span v-if="fullscreen">{{ targetVideoState(targetId, video).simulated ? '测试视频 · 非现场' : '当前画面 · 非事发录像' }}</span>
      <button class="btn" type="button" :aria-pressed="fullscreen" @click="toggleFullscreen">{{ fullscreen ? '退出全屏' : '视频全屏' }}</button>
    </div>
    <video v-show="!error" ref="media" autoplay muted playsinline disablepictureinpicture preload="auto" aria-label="外部光电直播"
      @playing="playing" @waiting="waitForData" @stalled="waitForData"
      @pause="resumeLive" @ended="reconnect()" @error="player && reconnect()" />
    <p :role="error ? 'alert' : 'status'">{{ text }}</p>
    <p v-if="fullscreenError" role="alert">{{ fullscreenError }}</p>
    <button v-if="phase === 'BLOCKED'" class="btn" type="button" @click="playLive()">连接直播</button>
    <EoEvidenceCapture v-if="!error" :media="media" :target-id="targetId" :video="video" :event-id="eventId"
      :playing="phase === 'PLAYING'" />
  </div>
</template>

<style scoped>
.external-video { min-width:0; }
.fullscreen-toolbar { display:flex; align-items:center; justify-content:flex-end; gap:12px; margin-bottom:8px; }
.external-video:fullscreen { display:flex; flex-direction:column; width:100%; height:100%; padding:16px; box-sizing:border-box; background:var(--surface-1,#0b1533); color:var(--txt,#fff); overflow:auto; }
.external-video:fullscreen video { flex:1; min-height:0; width:100%; max-height:none; object-fit:contain; }
.external-video:fullscreen .fullscreen-toolbar { flex:none; justify-content:space-between; }
video { width:100%; max-height:360px; background:#000; display:block; }
p { margin:8px 0; color:var(--txt-2); font-size:13px; }
</style>
