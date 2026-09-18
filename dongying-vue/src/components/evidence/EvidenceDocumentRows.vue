<script setup>
import { computed } from 'vue';
const props = defineProps({ rows: { type: Array, required: true } });
const main = computed(() => props.rows.filter(row => !row.secondary));
const secondary = computed(() => props.rows.filter(row => row.secondary));
</script>

<template>
  <dl class="document-rows">
    <div v-for="(row, index) in main" :key="index" :class="{ 'document-group': row.children?.length, 'document-wide': row.value?.length > 75 }">
      <dt>{{ row.label }}</dt>
      <dd><EvidenceDocumentRows v-if="row.children?.length" :rows="row.children" /><template v-else>{{ row.value }}</template></dd>
    </div>
  </dl>
  <details v-if="secondary.length" class="document-related">
    <summary>相关记录与当时办理条件</summary>
    <dl class="document-rows">
      <div v-for="(row, index) in secondary" :key="index"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
    </dl>
  </details>
</template>

<style scoped>
.document-rows { display: grid; gap: 12px; margin: 0; min-width: 0; }
.document-rows > div { display: grid; grid-template-columns: minmax(96px, .8fr) minmax(0, 1.2fr); gap: 4px 12px; min-width: 0; }
dt { color: var(--txt-3); font-size: 12px; }
dd { margin: 0; color: var(--txt); white-space: pre-wrap; overflow-wrap: anywhere; }
.document-rows > .document-group, .document-rows > .document-wide { display: block; }
.document-wide > dd { margin-top: 4px; }
.document-group { border-top: 1px solid var(--line); padding-top: 12px; }
.document-group > dt { color: var(--cyan); font-weight: 600; margin-bottom: 10px; }
.document-group > dd { padding-left: 12px; border-left: 2px solid var(--line); }
.document-related { margin-top: 12px; }
summary { color: var(--txt-2); cursor: pointer; padding: 4px 0 10px; font-size: 12px; }
</style>
