<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { deviceApi, newIdempotencyKey } from '@/services/deviceApi.js';
import { canAccessRoute, hasPermission } from '@/services/accessControl.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { toast } from '@/ui/nv.js';
import {
  MAX_RECORDING_MS, RECORDING_BITS_PER_SECOND, captureBackgroundText, captureBlocked, captureFailure,
  captureFileName, captureSavedText, elapsedText, recordingFormat
} from './eoCapture.js';

/* 光电跟踪画面取证：从平台正在播放的跟踪视频截图或录像，保存为证据并关联目标、来源光电设备和告警事件。
   设备协议没有图片、视频回传，取证只能来自平台播放的视频流；服务端按当前跟踪任务核定设备和视频流。 */
const props = defineProps({
  media: { default: null },
  targetId: { type: String, required: true },
  video: { type: Object, required: true },
  eventId: { type: String, default: '' },
  playing: { type: Boolean, default: false }
});

const format = typeof MediaRecorder === 'undefined' ? null : recordingFormat(type => MediaRecorder.isTypeSupported(type));
const busy = ref(false), recording = ref(false), elapsed = ref(0);
const savedText = ref(''), savedId = ref(''), error = ref(''), retry = ref(null);
const canOpenLedger = computed(() => canAccessRoute('evidence') && hasPermission('evidence:read'));
const ledgerHref = computed(() => `#/evidence?${new URLSearchParams({ file: savedId.value })}`);
let session = null, tick = null, limit = null, alive = true;

function reset() { savedText.value = ''; savedId.value = ''; error.value = ''; retry.value = null; }

/* 不能取证的原因在点击时说明。 */
function blocked(kindCode) {
  return captureBlocked({ permitted: hasPermission('evidence:ingest'), playing: props.playing, recordable: !!format, kindCode });
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
    const text = pending.note + captureSavedText(result, pending.kindCode, pending.simulated);
    if (!sameSubject(pending)) { toast(text, 'ok'); return; }
    savedId.value = result?.evidence_id || '';
    savedText.value = text;
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
  if (busy.value || recording.value) return;
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

function clearTimers() { clearInterval(tick); clearTimeout(limit); tick = null; limit = null; }

function startRecording() {
  if (busy.value || recording.value) return;
  reset();
  const reason = blocked('EO_VIDEO');
  if (reason) { error.value = reason; return; }
  const media = props.media;
  const capture = media?.captureStream || media?.mozCaptureStream;
  if (!media || typeof capture !== 'function') { error.value = '当前浏览器不能从视频画面录像，可以先截图取证。'; return; }
  let stream, active;
  try {
    stream = new MediaStream(capture.call(media).getVideoTracks());
    active = new MediaRecorder(stream, { mimeType: format.mimeType, videoBitsPerSecond: RECORDING_BITS_PER_SECOND });
  } catch {
    stream?.getTracks().forEach(track => track.stop());
    error.value = '无法从当前画面录像，请刷新视频后重试。';
    return;
  }
  const from = subject(), startedAt = performance.now(), parts = [];
  const current = { recorder: active, note: '' };
  // 视频已关闭或换了目标时，结果改用全局提示。
  const notify = message => (sameSubject(from) ? (error.value = message) : toast(message, 'err'));
  active.ondataavailable = event => { if (event.data?.size) parts.push(event.data); };
  active.onstop = () => {
    stream.getTracks().forEach(track => track.stop());
    if (session === current) { session = null; clearTimers(); recording.value = false; }
    // 录像途中换了跟踪任务：服务端不能再核定这段画面的来源，不提交。
    if (from.streamId !== (props.video?.stream_id || '')) return notify('视频已换成新的跟踪任务，这段录像没有保存，请重新录像。');
    const blob = new Blob(parts, { type: format.type });
    if (!blob.size) return notify('没有录到画面，请确认视频在播放后再录像。');
    send(pendingOf(from, 'EO_VIDEO', blob, format.type, format.extension, startedAt, current.note));
  };
  try { active.start(1000); }
  catch { stream.getTracks().forEach(track => track.stop()); error.value = '无法开始录像，请刷新视频后重试。'; return; }
  session = current;
  recording.value = true; elapsed.value = 0;
  tick = setInterval(() => { elapsed.value = performance.now() - startedAt; }, 250);
  limit = setTimeout(() => stopRecording('已录满 1 分钟，自动停止。'), MAX_RECORDING_MS);
}

/** 停止并保存已录下的画面；note 说明为什么自动停止。 */
function stopRecording(note = '') {
  const current = session;
  if (!current || current.recorder.state === 'inactive') return;
  current.note = note;
  try { current.recorder.stop(); }
  catch { session = null; clearTimers(); recording.value = false; error.value = '录像停止失败，这段录像没有保存，请刷新视频后重试。'; }
}

/* 画面暂停、中断、关闭或换了跟踪任务时停止录像；同一任务的已录部分照常保存，证据不因离开页面丢失。 */
watch(() => props.playing, value => { if (!value && recording.value) stopRecording('视频已暂停或中断，录像已停止。'); });
watch(() => [props.targetId, props.eventId], () => { if (!busy.value) reset(); });
onBeforeUnmount(() => {
  alive = false;
  stopRecording('视频已关闭或中断，录像已停止。');
  clearTimers();
});
</script>

<template>
  <div class="eo-capture" role="group" aria-label="光电取证">
    <div class="eo-capture__actions">
      <button class="btn" type="button" :disabled="busy || recording" @click="snapshot">截图取证</button>
      <button v-if="!recording" class="btn" type="button" :disabled="busy" @click="startRecording">开始录像</button>
      <button v-else class="btn" type="button" @click="stopRecording()">停止录像 {{ elapsedText(elapsed) }} / {{ elapsedText(MAX_RECORDING_MS) }}</button>
    </div>
    <p v-if="busy" role="status">正在保存取证</p>
    <p v-if="savedText" role="status">{{ savedText }}</p>
    <a v-if="savedText && savedId && canOpenLedger" class="btn eo-capture__ledger" :href="ledgerHref">在证据台账查看</a>
    <p v-if="error" class="eo-capture__error" role="alert">{{ error }}
      <button v-if="retry" class="btn" type="button" :disabled="busy" @click="send(retry)">按原文件重新提交</button></p>
  </div>
</template>

<style scoped>
.eo-capture { margin:4px 0 0; min-width:0; }
.eo-capture__actions { display:flex; gap:8px; flex-wrap:wrap; }
.eo-capture p { margin:8px 0 0; font-size:13px; line-height:1.6; overflow-wrap:anywhere; }
.eo-capture__error { color:var(--amber); }
.eo-capture__ledger { margin-top:8px; text-decoration:none; }
.btn { min-height:34px; height:auto; white-space:normal; }
</style>
