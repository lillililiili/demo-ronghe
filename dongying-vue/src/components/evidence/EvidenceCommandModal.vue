<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getEvidenceRecord } from '@/services/evidenceApi.js';
import EvidenceRecordDetail from './EvidenceRecordDetail.vue';
import EvidencePreviewModal from './EvidencePreviewModal.vue';
const props = defineProps({ records: { type: Array, required: true }, context: { type: Object, required: true }, truncated: Boolean, onReturn: Function });
const index = ref(0), detail = ref(null), error = ref(''), loading = ref(false);
const record = computed(() => props.records[index.value]);
const isFile = computed(() => record.value?.summary?.source_kind === 'FILE');
const href = computed(() => `#/evidence?${new URLSearchParams({ command: record.value.record_id, subjectKind: props.context.subject_kind, subjectId: props.context.subject_id })}`);
let sequence = 0;
async function load() {
  const own = ++sequence; detail.value = null; error.value = ''; loading.value = false;
  if (isFile.value) return;
  loading.value = true;
  try { const data = await getEvidenceRecord('COMMAND', record.value.record_id, props.context); if (own === sequence) detail.value = data; }
  catch (e) { if (own === sequence) error.value = e.message || '指令读取失败'; }
  finally { if (own === sequence) loading.value = false; }
}
watch(record, load, { immediate: true });
function accessChanged() { sequence += 1; detail.value = null; loading.value = false; error.value = '访问权限已变化，请重新打开'; }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { sequence += 1; window.removeEventListener('auth-access-change', accessChanged); });
</script>
<template>
  <section class="command-modal">
    <div v-if="records.length > 1" class="record-controls"><button class="btn" :disabled="index === 0" @click="index--">上一份</button><span>第 {{ index + 1 }} 份 / 共 {{ records.length }} 份</span><button class="btn" :disabled="index === records.length - 1" @click="index++">下一份</button></div>
    <p v-if="truncated">当前只返回部分指令，请在证据管理按关联事项查询全部记录。</p>
    <EvidencePreviewModal v-if="isFile" :key="record.record_id" :evidence-id="record.record_id" :on-return="onReturn" />
    <template v-else><p v-if="loading" role="status">正在读取当前指令</p><p v-else-if="error" role="alert">{{ error }} <button class="btn" @click="load">重新读取</button></p><EvidenceRecordDetail v-else-if="detail" :detail="detail" /><a class="btn" :href="href" @click="onReturn?.()">查看证据详情</a></template>
  </section>
</template>
<style scoped>.command-modal{display:flex;flex-direction:column;gap:14px;min-width:0}.record-controls{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;font-size:12px}.command-modal>p{font-size:12px;line-height:1.7}</style>
