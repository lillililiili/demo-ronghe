<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import EvidenceTrackPreview from '@/components/evidence/EvidenceTrackPreview.vue';
import { hasPermission } from '@/services/accessControl.js';
import { getEvidenceChain, getEvidenceTrackPoints } from '@/services/evidenceApi.js';
import { fmtEvidenceTime } from '@/ui/evidenceFileDetail.js';
import { EVIDENCE_SUBJECT_LABEL, labelOf } from '@/ui/labels.js';

const props = defineProps({
  subjectKind: { type: String, required: true },
  subjectId: { type: String, required: true },
  trackId: { type: String, required: true },
  queryError: { type: String, default: '' }
});
defineEmits(['return']);
const chain = ref(null);
const record = ref(null);
const snapshot = ref(null);
const loading = ref(false);
const error = ref('');
let sequence = 0;
let disposed = false;
const layer = computed(() => ({ RAW: '原始观测', FUSED: '融合轨迹' }[record.value?.summary?.layer] || '分层未记录'));
const original = computed(() => snapshot.value ? JSON.stringify(snapshot.value, null, 2) : '');

async function load() {
  const own = ++sequence;
  chain.value = null; record.value = null; snapshot.value = null; error.value = ''; loading.value = false;
  if (props.queryError || !['EVENT', 'TARGET', 'CASE'].includes(props.subjectKind) || !props.subjectId || !props.trackId) {
    error.value = props.queryError || '轨迹定位信息无效，请从原事项重新打开这份轨迹。'; return;
  }
  if (!hasPermission('evidence:read') || !hasPermission('target:read')) {
    error.value = '当前账号没有查看这份轨迹证据的权限。'; return;
  }
  const { subjectKind, subjectId, trackId } = props;
  const isCurrent = () => !disposed && own === sequence;
  loading.value = true;
  try {
    // 先按事项重新授权，再确认该轨迹仍属于这条证据链；不信任地址或上一页缓存。
    const result = await getEvidenceChain(subjectKind, subjectId);
    if (!isCurrent()) return;
    if (result?.subject_kind !== subjectKind || result?.subject_id !== subjectId) throw new Error('返回的证据链与当前事项不一致，请重新读取');
    if (result.coverage?.TRACK?.status === 'FORBIDDEN') throw new Error('当前账号没有查看这份轨迹证据的权限。');
    const selected = (result.records || []).find(item => item.record_type === 'TRACK'
      && !item.summary?.kind_code && item.record_id === trackId);
    if (!selected) throw new Error(result.coverage?.TRACK?.truncated
      ? '本次证据链只返回部分轨迹，未包含指定记录，暂时无法确认这份轨迹。'
      : '当前事项未返回这份轨迹记录，记录可能已不可见或关联已变化。');
    chain.value = result;
    record.value = selected;
    if (selected.availability === 'UNAVAILABLE') throw new Error('这份轨迹证据当前不可用，已保留可见的记录信息。');
    const points = await getEvidenceTrackPoints(trackId, { isCurrent });
    if (!isCurrent()) return;
    snapshot.value = { points };
  } catch (e) {
    if (!isCurrent()) return;
    error.value = e.status === 404 ? '这份轨迹或关联事项不存在，或不在当前账号的可见范围内。'
      : e.status === 403 ? '当前账号没有查看这份轨迹证据的权限。' : e.message || '轨迹证据读取失败';
  } finally { if (isCurrent()) loading.value = false; }
}

watch(() => [props.subjectKind, props.subjectId, props.trackId, props.queryError], load, { immediate: true });
function accessChanged() {
  sequence += 1; chain.value = null; record.value = null; snapshot.value = null; loading.value = false;
  error.value = '登录状态或访问权限已变化，请重新打开这份轨迹证据';
}
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { disposed = true; sequence += 1; window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <section class="evidence-track-detail" aria-label="原始轨迹证据详情">
    <header class="track-detail-header">
      <h2>轨迹证据详情</h2>
      <button class="btn" type="button" @click="$emit('return')">返回证据台账</button>
    </header>
    <p v-if="loading" class="track-detail-message" role="status">正在读取指定轨迹证据</p>
    <div v-if="error" class="track-detail-message" role="alert">
      {{ error }} <button class="btn" type="button" @click="load">重新读取</button>
    </div>
    <template v-if="record">
      <dl class="track-detail-facts">
        <div><dt>轨迹分层</dt><dd>{{ layer }}</dd></div>
        <div><dt>关联事项</dt><dd>{{ labelOf(EVIDENCE_SUBJECT_LABEL, chain.subject_kind, '事项') }} · {{ chain.subject_no || chain.subject_id }}</dd></div>
        <div><dt>开始时间</dt><dd>{{ fmtEvidenceTime(record.summary?.started_at) }}</dd></div>
        <div><dt>结束时间</dt><dd>{{ fmtEvidenceTime(record.summary?.ended_at) }}</dd></div>
        <div><dt>记录点数</dt><dd>{{ record.summary?.point_count == null ? '未记录' : `${record.summary.point_count} 点` }}</dd></div>
        <div><dt>记录时刻</dt><dd>{{ fmtEvidenceTime(record.occurred_at) }}</dd></div>
      </dl>
      <EvidenceTrackPreview v-if="snapshot" :key="record.record_id" :snapshot="snapshot" details />
      <details class="track-detail-record">
        <summary>记录标识与链校验信息</summary>
        <dl class="track-detail-facts">
          <div><dt>轨迹记录 ID</dt><dd>{{ record.record_id }}</dd></div>
          <div><dt>关联事项 ID</dt><dd>{{ chain.subject_id }}</dd></div>
          <div><dt>记录指纹</dt><dd>{{ record.fingerprint || '未记录' }}</dd></div>
          <div><dt>链校验算法</dt><dd>{{ chain.integrity?.algorithm || '未记录' }}</dd></div>
          <div><dt>链校验值</dt><dd>{{ chain.integrity?.checksum || '未记录' }}</dd></div>
          <div><dt>链校验时间</dt><dd>{{ fmtEvidenceTime(chain.integrity?.computed_at) }}</dd></div>
        </dl>
      </details>
      <details v-if="snapshot" class="track-detail-record"><summary>查看轨迹原始数据</summary><pre>{{ original }}</pre></details>
    </template>
  </section>
</template>

<style scoped>
.evidence-track-detail { min-width: 0; height: 100%; overflow: auto; display: flex; flex-direction: column; gap: 14px; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
.track-detail-header { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.track-detail-header h2 { margin: 0; font-size: 17px; }.track-detail-header button { margin-left: auto; }
.track-detail-message { padding: 16px; margin: 0; border: 1px solid var(--line); border-radius: 6px; line-height: 1.8; overflow-wrap: anywhere; }
.track-detail-message[role="alert"] { color: var(--orange); }
.track-detail-facts { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; font-size: 12px; line-height: 1.7; }
.track-detail-facts dt { color: var(--txt-3); }.track-detail-facts dd { margin: 3px 0 0; color: var(--txt); overflow-wrap: anywhere; }
.track-detail-record { min-width: 0; border-top: 1px solid var(--line); }
.track-detail-record summary { padding: 12px 0; color: var(--txt-2); cursor: pointer; font-size: 12px; }
.track-detail-record pre { max-height: 360px; margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 monospace; }
@media (max-width: 720px) { .track-detail-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
