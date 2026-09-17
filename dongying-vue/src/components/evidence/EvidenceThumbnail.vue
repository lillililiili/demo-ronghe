<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { hasPermission } from '@/services/accessControl.js';
import { previewEvidenceContent } from '@/services/evidenceApi.js';
const props = defineProps({ file: { type: Object, required: true } });
const root = ref(null);
const url = ref('');
const error = ref('');
const visible = ref(false);
let observer;
let controller;
let sequence = 0;
let timer;
const allowed = computed(() => hasPermission('evidence:preview') && props.file.status === 'AVAILABLE');
const isImage = computed(() => String(props.file.content_type || '').startsWith('image/') || ['EO_STILL', 'SCENE_PHOTO'].includes(props.file.kind_code));
function clear() { sequence += 1; controller?.abort(); clearTimeout(timer); if (url.value) URL.revokeObjectURL(url.value); url.value = ''; error.value = ''; }
function imageError() { if (url.value) URL.revokeObjectURL(url.value); url.value = ''; error.value = '缩略图暂不可用'; }
async function load() {
  clear();
  if (!visible.value || !allowed.value || !isImage.value) return;
  const own = sequence;
  controller = new AbortController();
  const request = controller;
  timer = setTimeout(() => request.abort(), 15_000);
  try {
    const result = await previewEvidenceContent(props.file.evidence_id, { thumbnail: true, signal: controller.signal });
    if (sequence === own) url.value = URL.createObjectURL(result.blob);
  } catch (e) { if (sequence === own) error.value = e.message || '缩略图暂不可用'; }
  finally { if (sequence === own) clearTimeout(timer); }
}
watch(() => [props.file.evidence_id, allowed.value, visible.value], load);
onMounted(() => {
  observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { visible.value = true; observer.disconnect(); } });
  observer.observe(root.value);
});
window.addEventListener('auth-access-change', load);
onBeforeUnmount(() => { clear(); observer?.disconnect(); window.removeEventListener('auth-access-change', load); });
</script>

<template>
  <span ref="root" class="evidence-thumbnail">
    <img v-if="url" :src="url" alt="证据缩略图" @error="imageError">
    <span v-else>{{ !allowed ? '内容受限或不可用' : error ? '缩略图暂不可用' : isImage ? '图像预览' : '文件预览' }}</span>
  </span>
</template>

<style scoped>
.evidence-thumbnail { display: flex; align-items: center; justify-content: center; width: 100%; height: 72px; border-radius: 5px; background: rgba(0,0,0,.2); color: var(--txt-3); font-size: 11px; }
.evidence-thumbnail img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style>
