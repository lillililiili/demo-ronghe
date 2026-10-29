<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { deviceApi, newIdempotencyKey } from '@/services/deviceApi.js';
import { canAccessRoute, hasPermission } from '@/services/accessControl.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { toast } from '@/ui/nv.js';
import {
  MAX_RECORDING_MS, RECORDING_BITS_PER_SECOND, captureBackgroundText, captureBlocked, captureFailure,
  captureFileName, captureSavedParts, captureSavedText, elapsedText, recordingFormats
} from './eoCapture.js';
import { captureVideoStream, recordVideo } from './eoRecording.js';

/* 光电跟踪画面取证：从平台正在播放的跟踪视频截图或录像，保存为证据并关联目标、来源光电设备和告警事件。
   设备协议没有图片、视频回传，取证只能来自平台播放的视频流；服务端按当前跟踪任务核定设备和视频流。 */
const props = defineProps({
  media: { default: null },
  targetId: { type: String, required: true },
  video: { type: Object, required: true },
  eventId: { type: String, default: '' },
  playing: { type: Boolean, default: false }
});

const formats = typeof MediaRecorder === 'undefined' ? [] : recordingFormats(type => MediaRecorder.isTypeSupported(type));
const busy = ref(false), starting = ref(false), recording = ref(false), elapsed = ref(0);
const saved = ref(null), savedId = ref(''), error = ref(''), retry = ref(null);
const canOpenLedger = computed(() => canAccessRoute('evidence') && hasPermission('evidence:read'));
const ledgerHref = computed(() => `#/evidence?${new URLSearchParams({ file: savedId.value })}`);
let session = null, preparation = null, tick = null, limit = null, interruption = null, alive = true;

const icon = name => window.UI.icon(name);

function reset() { saved.value = null; savedId.value = ''; error.value = ''; retry.value = null; }

/* 不能取证的原因在点击时说明。 */
function blocked(kindCode) {
  return captureBlocked({ permitted: hasPermission('evidence:ingest'), playing: props.playing, recordable: !!formats.length, kindCode });
}

/* 取证所属目标、事件和视频流在截图或开始录像那一刻固定，重试也按原样提交。 */
function subject() {
  return { targetId: props.targetId, eventId: props.eventId || '', streamId: props.video?.stream_id || '', simulated: props.video?.simulated === true };
}
const sameSubject = from => alive && from.targetId === props.targetId && from.eventId === (props.eventId || '');

function pendingOf(from, kindCode, blob, type, extension, startedAt, note = '') {
  const name = captureFileName(kindCode, Date.now() - (performance.now() - startedAt), extension);
  return { ...from, kindCode, startedAt, note, key: newIdempotencyKey('eo-capture'), file: new File([blob], name, { type }) };
}

async function send(pending) {
  busy.value = true; error.value = ''; retry.value = null;
  try {
    const result = await deviceApi.captureTargetVideo(pending.targetId, {
      file: pending.file, kindCode: pending.kindCode, streamId: pending.streamId, eventId: pending.eventId,
      captureAgeMs: performance.now() - pending.startedAt
    }, pending.key);
    if (!sameSubject(pending)) { toast(pending.note + captureSavedText(result, pending.kindCode, pending.simulated), 'ok'); return; }
    savedId.value = result?.evidence_id || '';
    saved.value = { note: pending.note, ...captureSavedParts(result, pending.kindCode, pending.simulated) };
  } catch (failure) {
    const outcome = captureFailure(failure, isUncertainOutcome(failure));
    if (!sameSubject(pending)) { toast(pending.note + captureBackgroundText(pending.kindCode, outcome), 'err'); return; }
    error.value = pending.note + outcome.text;
    retry.value = outcome.retry ? { ...pending, note: '' } : null;
  } finally {
    if (alive) busy.value = false;
  }
}

async function snapshot() {
  if (busy.value || starting.value || recording.value) return;
  reset();
  const reason = blocked('EO_STILL');
  if (reason) { error.value = reason; return; }
  const media = props.media;
  if (!media || media.readyState < 2 || !media.videoWidth || !media.videoHeight) {
    error.value = '画面还没有加载出来，请等视频播放后再截图。';
    return;
  }
  const from = subject(), startedAt = performance.now();
  const canvas = document.createElement('canvas');
  canvas.width = media.videoWidth; canvas.height = media.videoHeight;
  let blob = null;
  try {
    canvas.getContext('2d').drawImage(media, 0, 0, canvas.width, canvas.height);
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  } catch { blob = null; }
  if (!sameSubject(from)) return;
  if (!blob) { error.value = '截图失败，请刷新视频后重试。'; return; }
  await send(pendingOf(from, 'EO_STILL', blob, 'image/jpeg', 'jpg', startedAt));
}

function clearTimers() {
  clearInterval(tick); clearTimeout(limit); clearTimeout(interruption);
  tick = null; limit = null; interruption = null;
}

async function startRecording() {
  if (busy.value || starting.value || recording.value) return;
  reset();
  const reason = blocked('EO_VIDEO');
  if (reason) { error.value = reason; return; }
  const media = props.media, from = subject();
  const pending = new AbortController(); preparation = pending; starting.value = true;
  let stream;
  try {
    stream = await captureVideoStream(media, pending.signal);
  } catch (failure) {
    if (sameSubject(from) && failure.name !== 'AbortError') error.value = failure.message || '无法从当前画面录像，请刷新视频后重试。';
    return;
  } finally {
    if (preparation === pending) { preparation = null; starting.value = false; }
  }
  const release = () => stream.getTracks().forEach(track => track.stop());
  if (pending.signal.aborted || !sameSubject(from) || from.streamId !== props.video?.stream_id || !props.playing) {
    release(); return;
  }
  const startedAt = performance.now(), current = { recorder: null, note: '', release };
  // 视频已关闭或换了目标时，结果改用全局提示。
  const notify = message => (sameSubject(from) ? (error.value = message) : toast(message, 'err'));
  const finish = () => {
    release();
    if (session === current) { session = null; clearTimers(); recording.value = false; }
  };
  current.recorder = recordVideo(stream, {
    formats, bitsPerSecond: RECORDING_BITS_PER_SECOND,
    onError: message => { finish(); notify(message); },
    onStop: (blob, format) => {
      finish();
      // 录像途中换了跟踪任务：服务端不能再核定这段画面的来源，不提交。
      if (from.streamId !== (props.video?.stream_id || '')) return notify('视频已换成新的跟踪任务，这段录像没有保存，请重新录像。');
      if (!blob.size) return notify('这段录像未取得视频数据，请等画面稳定后重新录像。');
      send(pendingOf(from, 'EO_VIDEO', blob, format.type, format.extension, startedAt, current.note));
    }
  });
  session = current;
  recording.value = true; elapsed.value = 0;
  tick = setInterval(() => { elapsed.value = performance.now() - startedAt; }, 250);
  limit = setTimeout(() => stopRecording('已录满 1 分钟，自动停止。'), MAX_RECORDING_MS);
}

/** 停止并保存已录下的画面；note 说明为什么自动停止。 */
function stopRecording(note = '') {
  preparation?.abort();
  const current = session;
  if (!current) return;
  current.note = note;
  try { current.recorder.stop(); }
  catch { current.release(); session = null; clearTimers(); recording.value = false; error.value = '录像停止失败，这段录像没有保存，请刷新视频后重试。'; }
}

/* 短暂缓冲不等于停止：HLS 在捕获启动或换片时可能先 waiting 再 playing。
   只容许 3 秒恢复；暂停、关闭、切换任务仍立即停止，不生成或补画缺失帧。 */
watch(() => props.playing, value => {
  clearTimeout(interruption); interruption = null;
  if (value) return;
  const media = props.media;
  if (recording.value && media && !media.paused && !media.ended && !media.error) {
    interruption = setTimeout(() => {
      if (!props.playing) stopRecording('视频持续缓冲，录像已停止。');
    }, 3000);
  } else stopRecording('视频已暂停或中断，录像已停止。');
});
watch([() => props.targetId, () => props.eventId, () => props.video?.stream_id], () => {
  stopRecording('视频关联已变化，录像已停止。');
  if (!busy.value) reset();
});
onBeforeUnmount(() => {
  alive = false;
  stopRecording('视频已关闭或中断，录像已停止。');
  clearTimers();
});
</script>

<template>
  <div class="eo-capture" role="group" aria-label="光电取证">
    <div class="eo-capture__bar">
      <slot name="status" />
      <div class="eo-capture__actions">
        <button class="btn" type="button" :disabled="busy || starting || recording" @click="snapshot">
          <span aria-hidden="true" v-html="icon('camera')"></span>截图取证</button>
        <button v-if="!recording" class="btn" type="button" :disabled="busy || starting" @click="startRecording">
          <span aria-hidden="true" v-html="icon('video')"></span>{{ starting ? '正在准备录像' : '录像取证' }}</button>
        <button v-else class="btn eo-capture__stop" type="button" @click="stopRecording()">
          <i class="eo-capture__rec" aria-hidden="true"></i>停止录像 <span class="eo-capture__time">{{ elapsedText(elapsed) }} / {{ elapsedText(MAX_RECORDING_MS) }}</span></button>
      </div>
    </div>
    <p v-if="busy" class="eo-capture__strip" role="status">正在保存取证…</p>
    <p v-else-if="saved" class="eo-capture__strip is-ok" role="status">
      <span aria-hidden="true" v-html="icon('check')"></span>{{ saved.note }}{{ saved.label }}
      <a v-if="saved.no && savedId && canOpenLedger" class="eo-capture__no" :href="ledgerHref" title="在证据台账查看">{{ saved.no }}</a>
      <span v-else-if="saved.no" class="eo-capture__no">{{ saved.no }}</span>
      <a v-else-if="savedId && canOpenLedger" class="eo-capture__no" :href="ledgerHref">在证据台账查看</a>
      <em v-if="saved.simulated" class="eo-capture__tag">测试画面</em>
    </p>
    <p v-if="error" class="eo-capture__strip is-warn" role="alert">
      <span aria-hidden="true" v-html="icon('warning')"></span><span class="eo-capture__msg">{{ error }}</span>
      <button v-if="retry" class="eo-capture__retry" type="button" :disabled="busy" @click="send(retry)">重新提交</button></p>
  </div>
</template>

<style scoped>
.eo-capture { margin:4px 0 8px; min-width:0; }
.eo-capture__bar { display:flex; align-items:center; justify-content:space-between; gap:8px 12px; flex-wrap:wrap; min-height:36px; }
.eo-capture__actions { display:flex; gap:6px; flex-wrap:wrap; margin-left:auto; }
.eo-capture .btn { display:inline-flex; align-items:center; gap:5px; min-height:30px; height:auto; padding:0 10px; border-radius:4px; white-space:nowrap;
  background:var(--button-bg); border:1px solid var(--button-line); color:var(--button-text); }
.eo-capture .btn:disabled { opacity:.45; cursor:not-allowed; }
.eo-capture .btn > span, .eo-capture__strip > span:first-child { display:inline-flex; }
.eo-capture :deep(.svg-icon) { width:15px; height:15px; }
.eo-capture .eo-capture__stop { background:color-mix(in srgb, var(--red) 16%, transparent); border-color:color-mix(in srgb, var(--red) 55%, transparent); color:var(--tag-red-text, var(--red)); }
.eo-capture__rec { width:8px; height:8px; border-radius:50%; background:var(--red); animation:eo-capture-blink 1.2s ease-in-out infinite; }
.eo-capture__time { font-variant-numeric:tabular-nums; }
@keyframes eo-capture-blink { 50% { opacity:.3; } }
.eo-capture__strip { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin:6px 0 0; padding:5px 9px; min-height:30px; box-sizing:border-box;
  border:1px solid var(--line); border-radius:4px; font-size:13px; line-height:1.5; color:var(--txt-2); overflow-wrap:anywhere; }
.eo-capture__strip.is-ok { color:var(--tag-green-text, var(--green)); background:color-mix(in srgb, var(--green) 12%, transparent); border-color:color-mix(in srgb, var(--green) 35%, transparent); }
.eo-capture__strip.is-warn { color:var(--amber); background:color-mix(in srgb, var(--amber) 12%, transparent); border-color:color-mix(in srgb, var(--amber) 40%, transparent); }
.eo-capture__no { color:var(--txt); font-family:var(--app-font-mono, inherit); }
a.eo-capture__no { color:var(--link-hover, #7fb4ff); text-decoration:underline; text-underline-offset:2px; }
.eo-capture__tag { font-style:normal; font-size:11px; padding:0 5px; border-radius:3px; color:var(--txt-2); background:color-mix(in srgb, var(--txt-2) 16%, transparent); }
.eo-capture__msg { flex:1; min-width:0; }
.eo-capture__retry { margin-left:auto; padding:0; border:0; background:none; color:inherit; font:inherit; text-decoration:underline; cursor:pointer; }
.eo-capture__retry:disabled { opacity:.5; cursor:not-allowed; }
</style>
