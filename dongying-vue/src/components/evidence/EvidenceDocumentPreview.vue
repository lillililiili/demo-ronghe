<script setup>
import { computed } from 'vue';
import { buildEvidenceDocument } from './evidenceDocumentView.js';
import EvidenceDocumentRows from './EvidenceDocumentRows.vue';
const props = defineProps({ text: { type: String, default: '' }, mime: String, kind: String });
const document = computed(() => buildEvidenceDocument(props.text, props.mime, props.kind));
</script>

<template>
  <article class="evidence-document" aria-label="证据材料内容">
    <template v-if="document.format === 'structured'">
      <p class="document-time-note">材料内时间按北京时间展示</p>
      <EvidenceDocumentRows v-if="document.rows.length" :rows="document.rows" />
      <p v-else class="document-notice">这份材料没有可展示的业务字段。</p>
      <p v-if="document.unmapped" class="document-notice" role="status">部分附加字段尚未转为中文说明，完整内容保留在原件中，可按权限下载查阅。</p>
    </template>
    <p v-else-if="document.format === 'unreadable'" class="document-notice" role="status">这份材料的内容格式无法识别，暂不能整理为可读记录。原件保持不变，可按权限下载查阅。</p>
    <p v-else class="document-text">{{ document.text || '这份材料没有文字内容。' }}</p>
  </article>
</template>

<style scoped>
.evidence-document { min-width: 0; max-height: 52vh; overflow: auto; padding: 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--canvas); font-size: 13px; line-height: 1.7; }
.document-time-note { margin: 0 0 14px; color: var(--txt-3); font-size: 12px; }
.document-text, .document-notice { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.document-notice { margin-top: 12px; color: var(--orange); font-size: 12px; }
</style>
