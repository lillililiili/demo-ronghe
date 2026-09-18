<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { canAccessRoute, hasPermission } from '@/services/accessControl.js';
import { getEvidenceTrackPoints } from '@/services/evidenceApi.js';
import { closeModal } from '@/ui/modal.js';
import EvidenceTrackPreview from './EvidenceTrackPreview.vue';
import EvidencePreviewModal from './EvidencePreviewModal.vue';

const props = defineProps({ records: { type: Array, required: true }, truncated: Boolean,
  restricted: Boolean, subjectKind: String, subjectId: String, onReturn: { type: Function, required: true } });
const selected = ref(0);
const record = computed(() => props.records[selected.value]);
const isFile = computed(() => !!record.value?.summary?.kind_code);
const canViewDetails = computed(() => canAccessRoute('evidence') && hasPermission('evidence:read') && hasPermission('target:read'));
const detailHref = computed(() => props.subjectKind && props.subjectId && record.value
  ? `#/evidence?${new URLSearchParams({ subjectKind: props.subjectKind, subjectId: props.subjectId, track: record.value.record_id })}` : '');
const loading = ref(false);
const error = ref('');
const snapshot = ref(null);
let sequence = 0;
async function load() {
  const own = ++sequence;
  snapshot.value = null; error.value = ''; loading.value = false;
  if (isFile.value || !record.value) return;
  if (!hasPermission('target:read')) { error.value = '当前账号没有查看轨迹观测点的权限'; return; }
  loading.value = true;
  try {
    const page = await getEvidenceTrackPoints(record.value.record_id, { isCurrent: () => own === sequence });
    if (own !== sequence) return;
    snapshot.value = { points: page };
  } catch (e) { if (own === sequence) error.value = e.message || '轨迹观测点读取失败'; }
  finally { if (own === sequence) loading.value = false; }
}
watch(selected, load, { immediate: true });
function accessChanged() { sequence += 1; snapshot.value = null; loading.value = false; error.value = '登录状态或访问权限已变化，请返回后重新打开证据'; }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { sequence += 1; window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <section class="evidence-track-modal">
    <div v-if="records.length > 1" class="track-records" aria-label="切换轨迹证据">
      <button class="btn" type="button" :disabled="selected <= 0" @click="selected -= 1">上一份</button>
      <span>第 {{ selected + 1 }} 份 / 共 {{ records.length }} 份</span>
      <button class="btn" type="button" :disabled="selected >= records.length - 1" @click="selected += 1">下一份</button>
    </div>
    <p v-if="restricted" class="track-record-note">当前账号只能查看已获授权的轨迹文件，原始轨迹记录受权限限制。</p>
    <p v-if="truncated" class="track-record-note">当前只展示部分轨迹证据。</p>
    <EvidencePreviewModal v-if="isFile" :key="record.record_id" :evidence-id="record.record_id" :on-return="onReturn" />
    <template v-else>
      <div class="track-record-toolbar">
        <button class="btn" type="button" @click="onReturn">返回事项详情</button>
        <a v-if="detailHref && canViewDetails" class="btn track-details" :href="detailHref" @click="closeModal">查看证据详情</a>
        <span v-else-if="!canViewDetails" class="track-details">无证据详情查看权限</span>
      </div>
      <p v-if="loading" class="track-record-message" role="status">正在读取这份证据关联的轨迹观测点</p>
      <div v-else-if="error" class="track-record-message" role="alert">{{ error }} <button class="btn" type="button" @click="load">重新读取</button></div>
      <EvidenceTrackPreview v-else-if="snapshot" :key="record.record_id" :snapshot="snapshot" />
    </template>
  </section>
</template>

<style scoped>
.evidence-track-modal { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.track-records, .track-record-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.track-records { justify-content: center; font-size: 12px; }
.track-details { margin-left: auto; }
.track-record-note { margin: 0; font-size: 12px; color: var(--orange); line-height: 1.7; }
.track-record-toolbar span { margin-left: auto; color: var(--txt-3); font-size: 12px; }
.track-record-message { padding: 24px; border: 1px solid var(--line); border-radius: 8px; text-align: center; line-height: 1.7; }
</style>
