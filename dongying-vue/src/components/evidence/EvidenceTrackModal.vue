<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { hasPermission } from '@/services/accessControl.js';
import { getEvidenceRecord, getEvidenceTrackPoints } from '@/services/evidenceApi.js';
import { evidenceTrackSnapshot, loadEvidenceTrackHistory } from '@/services/evidenceTrackData.js';
import { targetApi } from '@/services/targetApi.js';
import { clockText, dateText } from '@/components/replay/trackReplayModel.js';
import EvidenceTrackPreview from './EvidenceTrackPreview.vue';
import EvidencePreviewModal from './EvidencePreviewModal.vue';

const props = defineProps({ records: { type: Array, required: true }, truncated: Boolean,
  restricted: Boolean, subjectKind: String, subjectId: String,
  historyContext: { type: Object, default: null },
  videos: { type: Array, default: null }, onReturn: { type: Function, required: true } });
const selected = ref(0);
const scope = ref(props.historyContext ? 'history' : 'record');
const record = computed(() => props.records[selected.value]);
const isFile = computed(() => !!record.value?.summary?.kind_code);
const loading = ref(false);
const error = ref('');
const snapshot = ref(null);
const detailHref = computed(() => `#/evidence?${new URLSearchParams({ track: record.value.record_id,
  ...(props.subjectKind && props.subjectId ? { subjectKind: props.subjectKind, subjectId: props.subjectId } : {}) })}`);
let sequence = 0;
async function load() {
  const own = ++sequence;
  snapshot.value = null; error.value = ''; loading.value = false;
  if (isFile.value || !record.value) return;
  if (!hasPermission('target:read')) { error.value = '当前账号没有查看轨迹观测点的权限'; return; }
  loading.value = true;
  try {
    const detail = await getEvidenceRecord('TRACK', record.value.record_id, props.subjectKind && props.subjectId
      ? { subject_kind: props.subjectKind, subject_id: props.subjectId } : {});
    if (own !== sequence) return;
    const metadata = evidenceTrackSnapshot(record.value.record_id, detail, null);
    if (scope.value === 'history' && props.historyContext) {
      if (props.subjectKind !== 'TARGET' || props.subjectId !== props.historyContext.targetId)
        throw new Error('轨迹回放与当前研判目标不一致，请重新打开');
      const history = await loadEvidenceTrackHistory(targetApi, { ...props.historyContext,
        trackId: record.value.record_id, isCurrent: () => own === sequence });
      if (own !== sequence) return;
      if (history.layer !== metadata.layer) throw new Error('轨迹分层已变化，请重新读取');
      snapshot.value = { ...history, source_mode: metadata.source_mode };
    } else {
      const page = await getEvidenceTrackPoints(record.value.record_id, { isCurrent: () => own === sequence });
      if (own !== sequence) return;
      snapshot.value = { ...metadata, points: page };
    }
  } catch (e) { if (own === sequence) error.value = e.message || '轨迹观测点读取失败'; }
  finally { if (own === sequence) loading.value = false; }
}
watch(() => [selected.value, scope.value, props.records, props.historyContext, props.subjectKind, props.subjectId], load, { immediate: true });
function accessChanged() { sequence += 1; snapshot.value = null; loading.value = false; error.value = '登录状态或访问权限已变化，请返回后重新打开证据'; }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { sequence += 1; window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <section class="evidence-track-modal">
    <div v-if="historyContext && !isFile" class="track-records" role="group" aria-label="轨迹查看范围">
      <button class="btn" type="button" :aria-pressed="scope === 'history'" @click="scope = 'history'">截至本次研判的完整轨迹</button>
      <button class="btn" type="button" :aria-pressed="scope === 'record'" @click="scope = 'record'">本次引用片段</button>
    </div>
    <div v-if="records.length > 1" class="track-records" aria-label="切换轨迹证据">
      <button class="btn" type="button" :disabled="selected <= 0" @click="selected -= 1">上一份</button>
      <span>第 {{ selected + 1 }} 份 / 共 {{ records.length }} 份</span>
      <button class="btn" type="button" :disabled="selected >= records.length - 1" @click="selected += 1">下一份</button>
    </div>
    <p v-if="restricted" class="track-record-note">当前账号只能查看已获授权的轨迹文件，原始轨迹记录受权限限制。</p>
    <p v-if="truncated" class="track-record-note">当前只展示部分轨迹证据。</p>
    <EvidencePreviewModal v-if="isFile" :key="record.record_id" :evidence-id="record.record_id" :on-return="onReturn" />
    <template v-else>
      <p v-if="loading" class="track-record-message" role="status">正在读取这份证据关联的轨迹观测点</p>
      <div v-else-if="error" class="track-record-message" role="alert">{{ error }} <button class="btn" type="button" @click="load">重新读取</button></div>
      <template v-else-if="snapshot">
        <p v-if="scope === 'history'" class="track-record-note">同一目标、同一观测来源，共 {{ snapshot.segment_count }} 个轨迹段；截至 {{ dateText(snapshot.through) }} {{ clockText(snapshot.through) }}，段间保留中断。</p>
        <p v-else class="track-record-note">当前仅显示这一份原始轨迹片段。</p>
        <EvidenceTrackPreview :key="`${record.record_id}:${scope}`" :snapshot="snapshot" :videos="videos" />
      </template>
      <a class="btn" :href="detailHref" @click="onReturn()">{{ historyContext ? '查看本次引用的证据详情' : '查看证据详情' }}</a>
    </template>
  </section>
</template>

<style scoped>
.evidence-track-modal { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.track-records { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: center; font-size: 12px; }
.track-records .btn[aria-pressed="true"] { color: var(--cyan); border-color: var(--cyan); }
.track-record-note { margin: 0; font-size: 12px; color: var(--orange); line-height: 1.7; }
.track-record-message { padding: 24px; border: 1px solid var(--line); border-radius: 8px; text-align: center; line-height: 1.7; }
</style>
