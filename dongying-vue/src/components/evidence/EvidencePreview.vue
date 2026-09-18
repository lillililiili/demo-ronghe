<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { hasPermission } from '@/services/accessControl.js';
import { downloadEvidenceContent, previewEvidenceContent } from '@/services/evidenceApi.js';
import { EVIDENCE_KIND_LABEL, EVIDENCE_STATUS_LABEL, EVIDENCE_SUBJECT_LABEL, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
import { fmtEvidenceTime, saveEvidenceBlob } from '@/ui/evidenceFileDetail.js';
import { toast } from '@/ui/nv.js';
import EvidenceTrackPreview from './EvidenceTrackPreview.vue';
import EvidenceVideoPlayer from './EvidenceVideoPlayer.vue';
import EvidenceDocumentPreview from './EvidenceDocumentPreview.vue';

// 嵌入证据台账时，编号与状态由列表提供，关联与下载由同页详情提供。
const props = defineProps({ file: { type: Object, default: null }, compact: Boolean, details: Boolean, embedded: Boolean, showCapturedTime: Boolean });
const url = ref('');
const text = ref('');
const mime = ref('');
const loading = ref(false);
const error = ref('');
const imageWidth = ref(0);
const imageHeight = ref(0);
const downloading = ref(false);
let controller;
let sequence = 0;
let timer;
const canPreview = computed(() => hasPermission('evidence:preview'));
const canDownload = computed(() => hasPermission('evidence:download'));
const unavailable = computed(() => {
  if (!props.file) return '请选择证据文件';
  if (!canPreview.value) return '当前账号没有证据预览权限';
  return { PENDING: '文件正在入库，暂不能预览', MISSING: '原件缺失，无法预览',
    CORRUPT: '文件内容与入库时不一致，暂不能预览', DESTROYED: '原件已销毁，无法预览' }[props.file.status] || '';
});
const isText = computed(() => mime.value === 'application/json' || mime.value === 'text/plain');
const isTrack = computed(() => props.file?.kind_code === 'TRACK_SNAPSHOT' && isText.value);
const parsedTrackJson = computed(() => {
  if (!isTrack.value || !text.value) return null;
  try {
    const parsed = JSON.parse(text.value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
});
function imageLoaded(event) { imageWidth.value = event.target.naturalWidth; imageHeight.value = event.target.naturalHeight; }
function clear() {
  sequence += 1;
  controller?.abort();
  controller = null;
  clearTimeout(timer);
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = ''; text.value = ''; mime.value = ''; error.value = ''; loading.value = false;
  imageWidth.value = 0; imageHeight.value = 0;
}
async function load() {
  clear();
  if (unavailable.value) return;
  const id = props.file?.evidence_id;
  if (!id) return;
  const own = sequence;
  const request = new AbortController(); controller = request;
  loading.value = true;
  let timedOut = false;
  timer = setTimeout(() => { timedOut = true; request.abort(); }, 30_000);
  try {
    const result = await previewEvidenceContent(id, { signal: request.signal });
    if (own !== sequence || request.signal.aborted) return;
    const type = result.blob.type.split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'text/plain', 'application/json'].includes(type)) {
      throw new Error(props.details ? '该文件格式暂不支持预览，可按权限下载原件' : '该文件格式暂不支持预览，请查看证据详情');
    }
    if (['application/json', 'text/plain'].includes(type)) {
      const raw = await result.blob.text();
      if (own !== sequence) return;
      text.value = raw;
    } else url.value = URL.createObjectURL(result.blob);
    mime.value = type;
  } catch (e) {
    if (own !== sequence) return;
    error.value = timedOut ? '证据内容读取超时，请重试' : e.message || '证据内容读取失败，请重试';
  } finally {
    if (own === sequence) { clearTimeout(timer); loading.value = false; }
  }
}
function mediaError() { error.value = mime.value.startsWith('video/') ? '录像暂时无法播放，请重试或查看证据详情' : '文件无法显示，请重试或查看证据详情'; }
async function download() {
  if (!props.file?.evidence_id || downloading.value) return;
  downloading.value = true;
  try {
    const result = await downloadEvidenceContent(props.file.evidence_id);
    if (result) { saveEvidenceBlob(result.blob, result.filename); toast('已开始下载', 'ok'); }
  } catch (e) { toast(e.message || '下载失败', 'err'); }
  finally { downloading.value = false; }
}
watch(() => [props.file?.evidence_id, props.file?.status, props.file?.version, canPreview.value], load, { immediate: true });
function accessChanged() { clear(); if (canPreview.value) load(); }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { clear(); window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <section class="evidence-preview" :class="{ 'is-compact': compact, 'is-content-only': !details }" aria-label="证据内容预览">
    <div v-if="details || !isTrack || !parsedTrackJson" class="preview-toolbar">
      <b v-if="!embedded">{{ file ? labelOf(EVIDENCE_KIND_LABEL, file.kind_code, '证据内容') : '证据内容' }}</b>
      <span v-if="file" class="tag" :class="['mock', 'replay'].includes(file.source_mode) ? 't-orange' : 't-gray'"><template v-if="embedded && isTrack">文件来源：</template>{{ labelOf(SOURCE_MODE_LABEL, file.source_mode, '来源模式未记录') }}</span>
      <span v-if="!embedded && details && file" class="tag t-gray">{{ labelOf(EVIDENCE_STATUS_LABEL, file.status, file.status) }}</span>
      <span v-if="!details && !embedded && file?.captured_at != null" class="preview-captured">采集时间 {{ fmtEvidenceTime(file.captured_at) }}</span>
      <button v-if="!embedded && details && canDownload && file?.status === 'AVAILABLE'" type="button" class="btn" :disabled="downloading" @click="download">{{ downloading ? '正在下载' : '下载原件' }}</button>
    </div>
    <div class="preview-layout">
      <div class="preview-main">
        <div v-if="unavailable" class="preview-message" role="status">{{ unavailable }}</div>
        <div v-else-if="loading" class="preview-message" role="status">正在读取证据内容</div>
        <div v-else-if="error" class="preview-message" role="alert">{{ error }}<button type="button" class="btn" @click="load">重新读取</button></div>
        <template v-else-if="url || isText">
          <div v-if="mime.startsWith('image/')" class="preview-image-scroll">
            <img :src="url" :alt="file?.original_name || '证据图像'" @load="imageLoaded" @error="mediaError">
          </div>
          <EvidenceVideoPlayer v-else-if="mime.startsWith('video/')" :key="url" :src="url" :can-download="canDownload" @error="mediaError" />
          <!-- 仅已校验PDF的本页Blob可进入这里；sandbox会禁用Chrome内置PDF阅读器。 -->
          <iframe v-else-if="mime === 'application/pdf'" :key="url" :src="canDownload ? url : `${url}#toolbar=0&navpanes=0`" title="证据 PDF 预览" referrerpolicy="no-referrer" @error="mediaError" />
          <EvidenceTrackPreview v-else-if="isTrack && parsedTrackJson" :snapshot="parsedTrackJson" :file="file" :details="details" />
          <template v-else-if="isText">
            <p v-if="isTrack" class="preview-message" role="status">这份轨迹暂不能回放，可在证据详情查看原始记录。</p>
            <EvidenceDocumentPreview :text="text" :mime="mime" :kind="file?.kind_code" />
          </template>
        </template>
      </div>
      <aside v-if="details && file" class="preview-source" :aria-label="embedded ? '证据采集信息' : '证据来源与关联'">
        <h4>{{ embedded ? '采集信息' : '来源与关联' }}</h4>
        <dl class="preview-facts">
          <div v-if="!embedded && file.evidence_no"><dt>证据编号</dt><dd>{{ file.evidence_no }}</dd></div>
          <div v-if="!embedded || showCapturedTime"><dt>采集时间</dt><dd>{{ fmtEvidenceTime(file.captured_at) }}</dd></div>
          <div><dt>来源设备</dt><dd>{{ file.source_device_name || '未记录' }}</dd></div>
          <div><dt>采集位置</dt><dd v-if="file.capture_longitude != null && file.capture_latitude != null">经度 {{ file.capture_longitude }}，纬度 {{ file.capture_latitude }}（WGS84）</dd><dd v-else>未记录</dd></div>
          <div v-if="file.capture_provenance"><dt>采集信息依据</dt><dd>{{ file.capture_provenance === 'UPLOADER_DECLARED' ? '入库登记' : file.capture_provenance }}</dd></div>
          <div v-if="imageWidth"><dt>图像尺寸</dt><dd>{{ imageWidth }} × {{ imageHeight }} 像素</dd></div>
          <div v-if="!embedded"><dt>关联事项</dt><dd v-if="file.links?.length"><span v-for="link in file.links" :key="link.link_id">{{ labelOf(EVIDENCE_SUBJECT_LABEL, link.subject_kind, link.subject_kind) }} · {{ link.subject_no || link.subject_id }}</span></dd><dd v-else>无可见关联记录</dd></div>
        </dl>
        <slot name="details" />
      </aside>
    </div>
  </section>
</template>

<style scoped>
.evidence-preview { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.preview-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.preview-toolbar > .btn { margin-left: auto; }
.preview-captured { color: var(--txt-3); font-size: 12px; margin-left: auto; }
.preview-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 260px); gap: 18px; align-items: start; }
.is-content-only .preview-layout { grid-template-columns: minmax(0, 1fr); }
.preview-main { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.preview-source { min-width: 0; border-left: 1px solid var(--line-2); padding-left: 18px; }
.preview-source h4 { margin: 0 0 14px; font-size: 13px; color: var(--txt-2); }
.preview-message { min-height: 150px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; padding: 20px; text-align: center; color: var(--txt-2); line-height: 1.7; border: 1px solid var(--line); border-radius: 8px; }
.preview-image-scroll { max-height: 52vh; overflow: auto; min-height: 180px; background: var(--canvas); border-radius: 8px; }
.preview-image-scroll img { display: block; width: 100%; max-height: 48vh; height: auto; object-fit: contain; margin: 0 auto; }
iframe { width: 100%; min-width: 0; border: 0; border-radius: 8px; background: var(--canvas); }
iframe { height: 52vh; min-height: 300px; }
.preview-note { margin: 0; color: var(--orange); font-size: 12px; line-height: 1.7; }
.preview-facts { display: grid; grid-template-columns: 1fr; gap: 14px; margin: 0; font-size: 12px; line-height: 1.65; }
.preview-facts div, .preview-facts dd { min-width: 0; overflow-wrap: anywhere; }
.preview-facts dt { color: var(--txt-3); }
.preview-facts dd { margin: 0; color: var(--txt); }
.preview-facts dd span { display: block; }
.is-compact .preview-layout { grid-template-columns: 1fr; }
.is-compact .preview-source { padding: 12px 0 0; border-left: 0; border-top: 1px solid var(--line-2); }
.is-compact .preview-facts { grid-template-columns: 1fr; }
@media (max-width: 850px) {
  .preview-layout { grid-template-columns: 1fr; }
  .preview-source { padding: 12px 0 0; border-left: 0; border-top: 1px solid var(--line-2); }
  .preview-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 650px) { .preview-facts { grid-template-columns: 1fr; } }
</style>
