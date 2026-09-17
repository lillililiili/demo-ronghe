<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getEvidenceFile } from '@/services/evidenceApi.js';
import EvidencePreview from './EvidencePreview.vue';
import EvidenceThumbnail from './EvidenceThumbnail.vue';
import { renderEvidenceFileDetail } from '@/ui/evidenceFileDetail.js';
const props = defineProps({
  evidenceId: { type: String, required: true },
  files: { type: Array, default: () => [] },
  returnLabel: { type: String, default: '返回事项详情' },
  onReturn: { type: Function, required: true }
});
const selected = ref(props.evidenceId);
const file = ref(null);
const loading = ref(false);
const error = ref('');
let sequence = 0;
const files = computed(() => props.files.length ? props.files : [{ evidence_id: props.evidenceId }]);
const index = computed(() => files.value.findIndex(row => row.evidence_id === selected.value));
const metadata = computed(() => file.value ? renderEvidenceFileDetail(file.value, { mode: 'preview' }) : '');
async function load() {
  const own = ++sequence;
  file.value = null; error.value = ''; loading.value = true;
  try {
    const result = await getEvidenceFile(selected.value);
    if (own === sequence) file.value = result;
  } catch (e) { if (own === sequence) error.value = e.message || '证据信息读取失败'; }
  finally { if (own === sequence) loading.value = false; }
}
watch(selected, load, { immediate: true });
function accessChanged() { sequence += 1; file.value = null; loading.value = false; error.value = '登录状态或访问权限已变化，请返回后重新打开证据'; }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { sequence += 1; window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <div class="evidence-preview-modal">
    <div class="gallery-toolbar">
      <button class="btn" type="button" @click="onReturn">{{ returnLabel }}</button>
      <span v-if="files.length > 1">第 {{ index + 1 }} 份 / 共 {{ files.length }} 份</span>
      <button v-if="files.length > 1" class="btn" type="button" :disabled="index <= 0" @click="selected = files[index - 1].evidence_id">上一份</button>
      <button v-if="files.length > 1" class="btn" type="button" :disabled="index >= files.length - 1" @click="selected = files[index + 1].evidence_id">下一份</button>
    </div>
    <p v-if="loading" role="status">正在读取证据信息</p>
    <div v-else-if="error" role="alert">{{ error }} <button class="btn" type="button" @click="load">重新读取</button></div>
    <template v-else-if="file">
      <h3 class="gallery-filename">{{ file.original_name }}</h3>
      <EvidencePreview :key="selected" :file="file" />
      <details class="gallery-metadata"><summary>文件信息、关联与保管记录</summary><div v-html="metadata"></div></details>
    </template>
    <div v-if="files.length > 1" class="gallery-files" aria-label="同组证据">
      <button v-for="item in files" :key="item.evidence_id" class="gallery-file" type="button" :aria-pressed="item.evidence_id === selected" @click="selected = item.evidence_id">
        <EvidenceThumbnail :file="item" />
        <span>{{ item.original_name || item.evidence_no || '证据文件' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.evidence-preview-modal { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.gallery-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.gallery-toolbar > span { margin-left: auto; }
.gallery-filename { font-size: 16px; margin: 0; line-height: 1.6; overflow-wrap: anywhere; }
.gallery-metadata > summary { padding: 10px 0; cursor: pointer; }
.gallery-files { display: grid; grid-template-columns: repeat(auto-fill, minmax(125px, 1fr)); gap: 8px; max-height: 240px; overflow: auto; }
.gallery-file { display: flex; flex-direction: column; gap: 8px; padding: 8px; min-width: 0; color: var(--txt); background: transparent; border: 1px solid var(--line); border-radius: 6px; text-align: left; cursor: pointer; }
.gallery-file[aria-pressed="true"] { border-color: var(--blue); background: rgba(64,158,255,.12); }
.gallery-file > span { overflow-wrap: anywhere; font-size: 12px; line-height: 1.5; }
</style>
