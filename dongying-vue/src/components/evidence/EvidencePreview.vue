<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { hasPermission } from '@/services/accessControl.js';
import { downloadEvidenceContent, previewEvidenceContent } from '@/services/evidenceApi.js';
import { EVIDENCE_STATUS_LABEL, EVIDENCE_SUBJECT_LABEL, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
import { fmtEvidenceTime, saveEvidenceBlob } from '@/ui/evidenceFileDetail.js';
import { toast } from '@/ui/nv.js';

const props = defineProps({ file: { type: Object, default: null }, compact: Boolean });
const url = ref('');
const text = ref('');
const mime = ref('');
const loading = ref(false);
const error = ref('');
const zoom = ref(1);
const downloading = ref(false);
let controller;
let sequence = 0;
let timer;
const canPreview = computed(() => hasPermission('evidence:preview'));
const canDownload = computed(() => hasPermission('evidence:download'));
const unavailable = computed(() => {
  if (!props.file) return '请选择证据文件';
  if (!canPreview.value) return '当前账号没有证据预览权限，仍可查看已获授权的文件信息';
  return { PENDING: '文件正在入库，内容尚未就绪', MISSING: '原件缺失，文件信息仍保留',
    CORRUPT: '原件校验异常，内容暂不可用', DESTROYED: '原件已销毁，文件信息与销毁记录保留' }[props.file.status] || '';
});
const isText = computed(() => mime.value === 'application/json' || mime.value === 'text/plain');
function clear() {
  sequence += 1;
  controller?.abort();
  controller = null;
  clearTimeout(timer);
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = ''; text.value = ''; mime.value = ''; error.value = ''; zoom.value = 1; loading.value = false;
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
      throw new Error('该文件格式暂不支持预览，可按权限下载原件');
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
function mediaError() { error.value = mime.value.startsWith('video/') ? '当前浏览器无法播放该录像编码，可按权限下载原件' : '文件无法显示，可重试或按权限下载原件'; }
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
  <section class="evidence-preview" :class="{ 'is-compact': compact }" aria-label="证据内容预览">
    <div class="preview-toolbar">
      <b>证据内容</b>
      <span v-if="file" class="tag t-gray">{{ labelOf(SOURCE_MODE_LABEL, file.source_mode, '来源模式未记录') }}</span>
      <span v-if="file" class="tag t-gray">{{ labelOf(EVIDENCE_STATUS_LABEL, file.status, file.status) }}</span>
      <button v-if="canDownload && file?.status === 'AVAILABLE'" type="button" class="btn" :disabled="downloading" @click="download">{{ downloading ? '正在下载' : '下载原件' }}</button>
    </div>
    <div v-if="unavailable" class="preview-message" role="status">{{ unavailable }}</div>
    <div v-else-if="loading" class="preview-message" role="status">正在读取证据内容</div>
    <div v-else-if="error" class="preview-message" role="alert">{{ error }}<button type="button" class="btn" @click="load">重新读取</button></div>
    <template v-else-if="url || isText">
      <div v-if="mime.startsWith('image/')" class="preview-image-tools">
        <button type="button" class="btn" :disabled="zoom <= 1" @click="zoom = Math.max(1, zoom - 0.5)">缩小</button>
        <button type="button" class="btn" :disabled="zoom >= 4" @click="zoom = Math.min(4, zoom + 0.5)">放大</button>
        <button type="button" class="btn" @click="zoom = 1">适应窗口</button>
      </div>
      <div v-if="mime.startsWith('image/')" class="preview-image-scroll">
        <img :src="url" :alt="file?.original_name || '证据图像'" :style="{ width: `${zoom * 100}%`, maxWidth: 'none' }" @error="mediaError">
      </div>
      <video v-else-if="mime.startsWith('video/')" :key="url" :src="url" controls preload="metadata" playsinline @error="mediaError" />
      <!-- 仅已校验PDF的本页Blob可进入这里；sandbox会禁用Chrome内置PDF阅读器。 -->
      <iframe v-else-if="mime === 'application/pdf'" :key="url" :src="canDownload ? url : `${url}#toolbar=0&navpanes=0`" title="证据 PDF 预览" referrerpolicy="no-referrer" @error="mediaError" />
      <pre v-else-if="isText" class="preview-text">{{ text }}</pre>
    </template>
    <dl v-if="file" class="preview-facts">
      <div><dt>采集时间</dt><dd>{{ fmtEvidenceTime(file.captured_at) }}</dd></div>
      <div><dt>来源设备</dt><dd>{{ file.source_device_name || '未记录' }}</dd></div>
      <div><dt>采集位置</dt><dd v-if="file.capture_longitude != null && file.capture_latitude != null">经度 {{ file.capture_longitude }}，纬度 {{ file.capture_latitude }}（WGS84）</dd><dd v-else>未记录</dd></div>
      <div v-if="file.capture_provenance"><dt>采集信息依据</dt><dd>{{ file.capture_provenance === 'UPLOADER_DECLARED' ? '入库登记' : file.capture_provenance }}</dd></div>
      <div><dt>关联事项</dt><dd v-if="file.links?.length"><span v-for="link in file.links" :key="link.link_id">{{ labelOf(EVIDENCE_SUBJECT_LABEL, link.subject_kind, link.subject_kind) }} · {{ link.subject_no || link.subject_id }}</span></dd><dd v-else>无可见关联记录</dd></div>
    </dl>
  </section>
</template>

<style scoped>
.evidence-preview { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.preview-toolbar, .preview-image-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.preview-toolbar > .btn { margin-left: auto; }
.preview-message { min-height: 150px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 12px; padding: 20px; text-align: center; color: var(--txt-2); line-height: 1.7; border: 1px solid var(--line); border-radius: 8px; }
.preview-image-scroll { max-height: 52vh; overflow: auto; min-height: 180px; background: rgba(0, 0, 0, .22); border-radius: 8px; }
.preview-image-scroll img { display: block; height: auto; min-height: 120px; object-fit: contain; }
video, iframe { width: 100%; min-width: 0; border: 0; border-radius: 8px; background: rgba(0, 0, 0, .22); }
video { max-height: 52vh; min-height: 220px; }
iframe { height: 52vh; min-height: 300px; }
.preview-text { max-height: 52vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 16px; margin: 0; background: rgba(0, 0, 0, .2); color: var(--txt); font: 13px/1.7 monospace; }
.preview-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 0; font-size: 12px; line-height: 1.65; }
.preview-facts div, .preview-facts dd { min-width: 0; overflow-wrap: anywhere; }
.preview-facts dt { color: var(--txt-3); }
.preview-facts dd { margin: 0; color: var(--txt); }
.preview-facts dd span { display: block; }
.is-compact .preview-facts { grid-template-columns: 1fr; }
@media (max-width: 650px) { .preview-facts { grid-template-columns: 1fr; } }
</style>
