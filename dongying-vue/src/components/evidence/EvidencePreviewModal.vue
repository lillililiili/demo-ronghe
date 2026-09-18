<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getEvidenceFile } from '@/services/evidenceApi.js';
import { canAccessRoute, hasPermission } from '@/services/accessControl.js';
import { closeModal } from '@/ui/modal.js';
import EvidencePreview from './EvidencePreview.vue';
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
const canViewDetails = computed(() => canAccessRoute('evidence') && hasPermission('evidence:read'));
const detailHref = computed(() => `#/evidence?${new URLSearchParams({ file: selected.value })}`);
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
      <div v-if="files.length > 1" class="gallery-navigation" aria-label="切换证据">
        <button class="btn" type="button" :disabled="index <= 0" @click="selected = files[index - 1].evidence_id">上一份</button>
        <span>第 {{ index + 1 }} 份 / 共 {{ files.length }} 份</span>
        <button class="btn" type="button" :disabled="index >= files.length - 1" @click="selected = files[index + 1].evidence_id">下一份</button>
      </div>
      <a v-if="canViewDetails" class="btn gallery-details" :href="detailHref" @click="closeModal">查看证据详情</a>
      <span v-else class="gallery-details gallery-access">无证据详情查看权限</span>
    </div>
    <p v-if="loading" role="status">正在读取证据信息</p>
    <div v-else-if="error" role="alert">{{ error }} <button class="btn" type="button" @click="load">重新读取</button></div>
    <EvidencePreview v-else-if="file" :key="selected" :file="file" />
  </div>
</template>

<style scoped>
.evidence-preview-modal { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.gallery-toolbar, .gallery-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.gallery-navigation { margin-left: auto; }
.gallery-details { margin-left: auto; }
.gallery-access { color: var(--txt-3); }
</style>
