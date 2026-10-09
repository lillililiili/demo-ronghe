<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getEvidenceTrackPoints, listEvidenceFiles } from '@/services/evidenceApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { COMMAND_STATE_LABEL, COMMAND_TYPE_LABEL, evidenceSubjectLocation } from '@/services/evidenceLedger.js';
import { EVIDENCE_SUBJECT_LABEL } from '@/ui/labels.js';
import { displayDeviceNo } from '@/ui/deviceNumber.js';
import { fmtEvidenceTime, openEvidenceFileModal } from '@/ui/evidenceFileDetail.js';
import EvidenceTrackPreview from './EvidenceTrackPreview.vue';
import { buildCommandView, commandSource } from './evidenceCommandView.js';
const props = defineProps({ detail: { type: Object, required: true } });
const router = useRouter();
const entry = computed(() => props.detail.entry);
const command = computed(() => props.detail.command);
const commandView = computed(() => buildCommandView(command.value || {}, entry.value.source_mode));
const snapshot = ref(null), loading = ref(false), error = ref('');
const videos = ref(null), videosLoading = ref(false), videoNote = ref('');
let sequence = 0;
const source = computed(() => commandSource(command.value || {}, entry.value.source_mode));
const sourceLabel = computed(() => source.value.label);
const sourceNote = computed(() => source.value.note);
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
/* 轨迹关联的目标/事项上挂着的光电录像，供回放时同步播放；只读列表，录像本身在播放到时才读取。 */
async function loadVideos(own) {
  videos.value = null; videoNote.value = ''; videosLoading.value = false;
  const subjects = (props.detail.links || []).filter(link => ['TARGET', 'EVENT'].includes(link.subject_kind) && link.subject_id);
  if (!subjects.length) { videoNote.value = '这份轨迹没有关联目标或事项，无法查找录像'; return; }
  if (!hasPermission('evidence:read')) { videoNote.value = '当前账号没有查看录像的权限'; return; }
  videosLoading.value = true;
  try {
    const pages = await Promise.all(subjects.map(link => listEvidenceFiles({ kind_code: 'EO_VIDEO',
      subject_kind: link.subject_kind, subject_id: link.subject_id, size: 50 })));
    if (own !== sequence) return;
    const found = new Map();
    pages.flatMap(page => page?.items || []).forEach(item => found.set(item.evidence_id, {
      id: item.evidence_id, no: item.evidence_no, capturedAt: item.captured_at ?? item.stored_at, status: item.status }));
    videos.value = [...found.values()];
  } catch { if (own === sequence) videoNote.value = '录像列表读取失败，可到证据管理查看'; }
  finally { if (own === sequence) videosLoading.value = false; }
}
watch(() => entry.value.source_id, async () => {
  await loadTrack();
  if (entry.value.source_kind === 'TRACK') loadVideos(sequence);
}, { immediate: true });
function go(link) {
  const destination = evidenceSubjectLocation(link.subject_kind, link.subject_id);
  if (destination) router.push(destination);
}
function accessChanged() { sequence += 1; snapshot.value = null; loading.value = false; error.value = '访问权限已变化，请重新打开当前记录'; }
window.addEventListener('auth-access-change', accessChanged);
onBeforeUnmount(() => { sequence += 1; window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <section class="record-detail">
    <span v-if="entry.source_kind !== 'TRACK'" class="tag t-gray">{{ sourceLabel }}</span>
    <template v-if="entry.source_kind === 'TRACK'">
      <p v-if="loading" role="status">正在读取当前轨迹</p>
      <p v-else-if="error" role="alert">{{ error }} <button class="btn" @click="loadTrack">重新读取</button></p>
      <EvidenceTrackPreview v-else-if="snapshot" :key="entry.source_id" :snapshot="snapshot" :videos="videos" :videos-loading="videosLoading" :video-note="videoNote" details />
      <dl class="kv"><dt>轨迹分层</dt><dd>{{ { RAW: '原始观测', FUSED: '融合轨迹' }[entry.layer] || '未记录' }}</dd><dt>开始时间</dt><dd>{{ fmtEvidenceTime(entry.started_at) }}</dd><dt>结束时间</dt><dd>{{ fmtEvidenceTime(entry.ended_at) }}</dd></dl>
    </template>
    <template v-else-if="command">
      <section class="command-overview">
        <h4>{{ COMMAND_TYPE_LABEL[command.command_type] || '设备操作记录' }}</h4>
        <p>{{ commandView.action }}</p>
        <p v-if="sourceNote" class="source-note">{{ sourceNote }}</p>
      </section>
      <section class="command-result" :class="`result-${commandView.tone}`" aria-label="执行结果">
        <strong>{{ commandView.status }}</strong>
        <p>{{ commandView.explanation }}</p>
      </section>
      <section class="sect"><h4>操作信息</h4><dl class="kv">
        <dt>执行设备</dt><dd :title="command.device_no">{{ command.device_name || displayDeviceNo(command.device_no) || '设备未记录' }}</dd>
        <dt>发起原因</dt><dd>{{ commandView.reason }}</dd>
        <dt>发起时间</dt><dd>{{ fmtEvidenceTime(command.created_at) }}</dd>
        <dt>下发时间</dt><dd>{{ command.issued_at == null ? (command.status === 'QUEUED' ? '尚未下发' : '未记录下发时间') : fmtEvidenceTime(command.issued_at) }}</dd>
        <dt v-if="command.completed_at != null">最近更新时间</dt><dd v-if="command.completed_at != null">{{ fmtEvidenceTime(command.completed_at) }}</dd>
      </dl></section>
      <section v-if="commandView.receipts.length" class="sect"><h4>设备反馈记录</h4>
        <article v-for="(receipt, index) in commandView.receipts" :key="receipt.id || index" class="receipt">
          <b>{{ receipt.text }}</b><span>{{ fmtEvidenceTime(receipt.time) }}</span>
        </article>
      </section>
      <details :key="command.command_id || entry.source_id"><summary>查看指令编号、原始报文和关联日志</summary>
        <dl class="kv raw-facts">
          <dt>指令编号</dt><dd>{{ command.command_no || '未记录' }}</dd>
          <dt>原始指令类型</dt><dd>{{ command.command_type }}</dd>
          <dt>原始操作说明</dt><dd>{{ command.reason || '未记录' }}</dd>
          <dt>平台记录状态</dt><dd>{{ COMMAND_STATE_LABEL[command.status] || '未知状态' }}（{{ command.status }}）</dd>
        </dl>
        <h4>原始结果说明</h4><pre>{{ command.result_detail || '未记录' }}</pre>
        <h4>原始设备回执</h4><pre>{{ JSON.stringify(command.receipts || [], null, 2) }}</pre>
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
.record-detail>.tag{align-self:flex-start}.command-overview h4{margin:0 0 6px;font-size:16px;color:var(--txt)}.command-overview p{color:var(--txt-2)}.command-overview .source-note{margin-top:6px;color:var(--orange)}.command-result{padding:12px 14px;border:1px solid var(--line);border-left:3px solid var(--blue);border-radius:6px;background:var(--surface-1);overflow-wrap:anywhere}.command-result strong{display:block;margin-bottom:5px;font-size:14px}.command-result p{color:var(--txt-2)}.result-warning{border-left-color:var(--orange)}.result-warning strong{color:var(--orange)}.result-success{border-left-color:var(--green)}.result-success strong{color:var(--green)}.result-danger{border-left-color:var(--red)}.result-danger strong{color:var(--red)}.record-detail .kv{grid-template-columns:100px minmax(0,1fr)}.record-detail .kv dd{min-width:0}.raw-facts{margin-top:12px}.receipt b{overflow-wrap:anywhere}summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
</style>
