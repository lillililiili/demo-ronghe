<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getEvidenceTrackPoints } from '@/services/evidenceApi.js';
import { COMMAND_STATE_LABEL, COMMAND_TYPE_LABEL, evidenceSubjectLocation } from '@/services/evidenceLedger.js';
import { EVIDENCE_SUBJECT_LABEL } from '@/ui/labels.js';
import { fmtEvidenceTime, openEvidenceFileModal } from '@/ui/evidenceFileDetail.js';
import EvidenceTrackPreview from './EvidenceTrackPreview.vue';
const props = defineProps({ detail: { type: Object, required: true } });
const router = useRouter();
const entry = computed(() => props.detail.entry);
const command = computed(() => props.detail.command);
const snapshot = ref(null), loading = ref(false), error = ref('');
let sequence = 0;
const sourceLabel = computed(() => ({ mock: '模拟来源', replay: '回放来源', live: '现场来源' }[entry.value.source_mode] || '来源未记录'));
async function loadTrack() {
  const own = ++sequence; snapshot.value = null; error.value = ''; loading.value = false;
  if (entry.value.source_kind !== 'TRACK') return;
  loading.value = true;
  try {
    const points = await getEvidenceTrackPoints(entry.value.source_id, { isCurrent: () => own === sequence });
    if (own === sequence) snapshot.value = { points, source_mode: entry.value.source_mode };
  } catch (e) { if (own === sequence) error.value = e.message || '轨迹读取失败'; }
  finally { if (own === sequence) loading.value = false; }
}
watch(() => entry.value.source_id, loadTrack, { immediate: true });
function go(link) {
  const destination = evidenceSubjectLocation(link.subject_kind, link.subject_id);
  if (destination) router.push(destination);
}
function accessChanged() { sequence += 1; snapshot.value = null; loading.value = false; error.value = '访问权限已变化，请重新打开当前记录'; }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { sequence += 1; window.removeEventListener('auth-access-change', accessChanged); });
const receiptLabel = value => ({ ACCEPTED: '设备受理', SUCCEEDED: '执行完成', COMPLETED: '执行完成', FAILED: '执行失败', ACK: '接收回执', RESULT: '执行回执' }[value] || value || '未记录');
</script>

<template>
  <section class="record-detail">
    <span v-if="entry.source_kind !== 'TRACK'" class="tag t-gray">{{ sourceLabel }}</span>
    <template v-if="entry.source_kind === 'TRACK'">
      <p v-if="loading" role="status">正在读取当前轨迹</p>
      <p v-else-if="error" role="alert">{{ error }} <button class="btn" @click="loadTrack">重新读取</button></p>
      <EvidenceTrackPreview v-else-if="snapshot" :key="entry.source_id" :snapshot="snapshot" details />
      <dl class="kv"><dt>轨迹分层</dt><dd>{{ { RAW: '原始观测', FUSED: '融合轨迹' }[entry.layer] || '未记录' }}</dd><dt>开始时间</dt><dd>{{ fmtEvidenceTime(entry.started_at) }}</dd><dt>结束时间</dt><dd>{{ fmtEvidenceTime(entry.ended_at) }}</dd></dl>
    </template>
    <template v-else-if="command">
      <section class="sect"><h4>指令记录</h4><dl class="kv">
        <dt>指令编号</dt><dd>{{ command.command_no }}</dd><dt>执行设备</dt><dd>{{ command.device_name || command.device_no }}</dd>
        <dt>动作</dt><dd>{{ COMMAND_TYPE_LABEL[command.command_type] || command.command_type }}</dd>
        <dt v-if="command.reason">操作说明</dt><dd v-if="command.reason">{{ command.reason }}</dd>
        <dt>创建时间</dt><dd>{{ fmtEvidenceTime(command.created_at) }}</dd><dt>下发时间</dt><dd>{{ command.issued_at == null ? '未记录下发时间' : fmtEvidenceTime(command.issued_at) }}</dd>
        <dt>当前状态</dt><dd>{{ COMMAND_STATE_LABEL[command.status] || '执行结果未知' }}</dd>
        <dt v-if="command.completed_at">状态记录时间</dt><dd v-if="command.completed_at">{{ fmtEvidenceTime(command.completed_at) }}</dd>
        <dt v-if="command.result_detail">结果说明</dt><dd v-if="command.result_detail">{{ command.result_detail }}</dd>
      </dl></section>
      <section class="sect"><h4>设备回执</h4><p v-if="!command.receipts?.length">尚未收到设备回执，不能据此认定执行成功或未执行。</p>
        <article v-for="receipt in command.receipts" :key="receipt.receipt_id" class="receipt">
          <b>{{ receiptLabel(receipt.receipt_kind) }}</b><span>{{ fmtEvidenceTime(receipt.occurred_at ?? receipt.received_at) }}</span>
          <div v-if="receipt.device_result_code">结果码：{{ receipt.device_result_code }}</div>
        </article>
        <p v-if="command.status === 'TIMED_OUT'" class="warning">回执超时，执行结果仍需确认。</p>
      </section>
      <details><summary>原始回执与关联日志</summary><pre>{{ JSON.stringify(command.receipts || [], null, 2) }}</pre>
        <button v-for="file in detail.attachments" :key="file.source_id" class="btn" @click="openEvidenceFileModal(file.source_id)">{{ file.original_name }}</button>
        <p v-if="!detail.attachments?.length">暂无关联日志文件</p>
      </details>
    </template>
    <section class="sect"><h4>被引用（{{ detail.links?.length || 0 }} 处）</h4>
      <div v-for="link in detail.links" :key="`${link.subject_kind}:${link.subject_id}`" class="reference">
        <span class="tag t-gray">{{ EVIDENCE_SUBJECT_LABEL[link.subject_kind] || link.subject_kind }}</span>
        <button v-if="evidenceSubjectLocation(link.subject_kind, link.subject_id)" class="btn ghost" @click="go(link)">{{ link.subject_no || link.subject_id }}</button>
        <span v-else>{{ link.subject_no || link.subject_id }}</span>
      </div><p v-if="!detail.links?.length">暂无可见关联事项</p>
    </section>
    <details v-if="entry.source_kind === 'TRACK'"><summary>轨迹编号与原始数据</summary><p>{{ entry.source_id }}</p><pre>{{ JSON.stringify(snapshot, null, 2) }}</pre></details>
  </section>
</template>

<style scoped>
.record-detail{min-width:0;display:flex;flex-direction:column;gap:14px;font-size:12px;line-height:1.7}.record-detail p{margin:0}.record-detail dd{overflow-wrap:anywhere}.reference,.receipt{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line)}.receipt>span{margin-left:auto}.receipt>div{width:100%}.warning{color:var(--orange)}summary{cursor:pointer;color:var(--txt-2)}pre{max-height:280px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.record-detail :deep(.track-point-facts){grid-template-columns:repeat(2,minmax(0,1fr))}
</style>
