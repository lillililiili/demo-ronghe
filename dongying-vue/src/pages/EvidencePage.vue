<script>
const S = { st: { page: 1, size: 10, kind: '', status: '', custody: '', refKind: '', kw: '', selId: null, sourceKind: 'FILE' } };
export default {};
</script>
<script setup>
import { computed, nextTick, ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import UField from '@/components/form/UField.vue';
import ModuleStatistics from '@/components/ModuleStatistics.vue';
import { useModuleStatistics } from '@/hooks/useModuleStatistics.js';
import EvidencePreview from '@/components/evidence/EvidencePreview.vue';
import EvidenceRecordDetail from '@/components/evidence/EvidenceRecordDetail.vue';
import { hasPermission } from '@/services/accessControl.js';
import { toast } from '@/ui/nv.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
import { openConfirm } from '@/ui/confirm.js';
import { destroyEvidenceFile, downloadEvidenceContent, getEvidenceFile, holdEvidenceFile, releaseEvidenceHold,
  verifyEvidenceFile, listEvidenceLedger, getEvidenceRecord, getEvidenceLedgerStatistics, exportEvidenceLedger } from '@/services/evidenceApi.js';
import { EVIDENCE_CUSTODY_LABEL, EVIDENCE_STATUS_LABEL, EVIDENCE_SUBJECT_LABEL, labelOf } from '@/ui/labels.js';
import { EVIDENCE_CATEGORY_LABEL, COMMAND_STATE_LABEL, COMMAND_TYPE_LABEL, entryKey, evidenceRecordQuery, evidenceSubjectLocation } from '@/services/evidenceLedger.js';
import { renderEvidenceFileDetail, saveEvidenceBlob, sizeText, fmtEvidenceTime } from '@/ui/evidenceFileDetail.js';
const U = window.UI;
usePageChrome('evidence');
const route = useRoute(), router = useRouter(), root = ref(null), listHost = ref(null), detailHost = ref(null);
const st = reactive(S.st), items = ref([]), totalCount = ref(0), loading = ref(false), error = ref('');
const detailRow = ref(null), recordDetail = ref(null), detailLoading = ref(false), detailError = ref('');
let mounted = false, listSequence = 0, detailSequence = 0, keywordTimer;
const statistics = useModuleStatistics(getEvidenceLedgerStatistics, [
  { key: 'by_status', title: '文件状态（含附件）', type: 'bar', windowed: true, labels: EVIDENCE_STATUS_LABEL, colors: { AVAILABLE: 'green', PENDING: 'gray', MISSING: 'orange', CORRUPT: 'red', DESTROYED: 'gray' } },
  { key: 'by_kind', title: '证据类型占比', type: 'donut', labels: EVIDENCE_CATEGORY_LABEL, colors: { VIDEO: 'blue', TRACK: 'cyan', IMAGE: 'green', COMMAND: 'orange' } },
  { key: 'by_custody', title: '保管状态（含附件）', type: 'bar', windowed: true, labels: EVIDENCE_CUSTODY_LABEL, colors: { KEPT: 'green', NEARING: 'amber', DUE: 'orange', HELD: 'purple' } }
]);
const statsView = computed(() => ({ ...statistics.state, groups: statistics.state.groups.filter(g => g.key === 'by_kind' || g.total > 0) }));
const options = labels => [{ value: '', label: '全部' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))];
const KIND_OPTS = options(EVIDENCE_CATEGORY_LABEL), STATUS_OPTS = options(EVIDENCE_STATUS_LABEL), CUSTODY_OPTS = options(EVIDENCE_CUSTODY_LABEL);
const REF_OPTS = options(EVIDENCE_SUBJECT_LABEL);
const SC = { AVAILABLE: 't-green', PENDING: 't-gray', MISSING: 't-orange', CORRUPT: 't-red', DESTROYED: 't-gray', OBSERVED: 't-green', NO_POINTS: 't-orange', SUCCEEDED: 't-green', FAILED: 't-red', TIMED_OUT: 't-orange' };
const text = v => typeof v === 'string' ? v.trim() : '';
const exactKeys = computed(() => ['file', 'track', 'command'].filter(k => Object.hasOwn(route.query, k)));
const exact = computed(() => exactKeys.value.length > 0);
const hasContext = computed(() => !!text(route.query.subjectKind) && !!text(route.query.subjectId));
const routeError = computed(() => exactKeys.value.length > 1 || exactKeys.value.some(k => !text(route.query[k]))
  || Boolean(route.query.subjectKind) !== Boolean(route.query.subjectId) ? '证据定位信息不完整或冲突，请从原事项重新打开。' : '');
const selectedKey = computed(() => `${st.sourceKind}:${st.selId}`);
const fileDetailHtml = computed(() => detailRow.value ? renderEvidenceFileDetail(detailRow.value, { mode: 'page', embeddedPreview: true }) : '');
const format = ms => fmtEvidenceTime(ms);
function stateLabel(row) { return row.source_kind === 'COMMAND' ? COMMAND_STATE_LABEL[row.status] || '执行结果未知' : row.source_kind === 'TRACK' ? row.status === 'NO_POINTS' ? '暂无观测点' : '可查看' : EVIDENCE_STATUS_LABEL[row.status] || row.status; }
function name(row) { return row.source_kind === 'COMMAND' ? COMMAND_TYPE_LABEL[row.original_name] || row.original_name : row.source_kind === 'TRACK' ? `目标 ${row.original_name} 的轨迹` : row.original_name; }
function shape(row) { return row.source_kind === 'TRACK' ? ({ RAW: '原始观测', FUSED: '融合轨迹' }[row.layer] || '分层未记录') : row.kind_code === 'TRACK_SNAPSHOT' ? '已保存快照' : row.kind_code === 'COMMAND_LOG' ? '历史日志文件' : ''; }
function context() { return hasContext.value ? { subject_kind: text(route.query.subjectKind), subject_id: text(route.query.subjectId) } : {}; }
function query() {
  return { page: st.page, size: st.size, ...(st.kind ? { category: st.kind } : {}), ...(st.status ? { status: st.status } : {}),
    ...(st.custody ? { custody: st.custody } : {}), ...(st.refKind ? { subject_kind: st.refKind } : {}), ...(st.kw ? { q: st.kw } : {}), ...context() };
}
function clearDetail() { detailSequence += 1; detailRow.value = null; recordDetail.value = null; detailLoading.value = false; detailError.value = ''; }
async function loadDetail() {
  clearDetail(); const own = detailSequence, id = st.selId, kind = st.sourceKind;
  if (detailHost.value) detailHost.value.scrollTop = 0;
  if (routeError.value) { detailError.value = routeError.value; return; }
  if (!id) return;
  if (!hasPermission('evidence:read')) { detailError.value = '当前账号没有查看证据的权限'; return; }
  detailLoading.value = true;
  try {
    if (kind === 'FILE') {
      // Exact legacy file links stay readable even for historical types outside the four-category ledger.
      if (hasContext.value) await getEvidenceRecord(kind, id, context());
      const file = await getEvidenceFile(id);
      if (!mounted || own !== detailSequence) return;
      if (file?.evidence_id !== id) throw new Error('返回记录与当前选择不一致');
      detailRow.value = file;
    } else {
      const result = await getEvidenceRecord(kind, id, context());
      if (!mounted || own !== detailSequence) return;
      if (result.entry?.source_id !== id || result.entry?.source_kind !== kind) throw new Error('返回记录与当前选择不一致');
      recordDetail.value = result;
    }
  } catch (e) { if (mounted && own === detailSequence) detailError.value = e.status === 404 ? '记录不存在、关联已变化或不在当前可见范围内。' : e.message || '证据读取失败'; }
  finally { if (mounted && own === detailSequence) detailLoading.value = false; }
}
async function load() {
  const own = ++listSequence;
  if (!mounted) return;
  clearTimeout(keywordTimer); clearDetail(); statistics.begin(); loading.value = true; error.value = '';
  if (!hasPermission('evidence:read') || routeError.value) {
    items.value = []; totalCount.value = 0; clearDetail(); loading.value = false;
    error.value = routeError.value || '当前账号没有查看证据的权限'; statistics.fail(error.value); return;
  }
  const detail = exact.value ? loadDetail() : null;
  try {
    const filters = query(), result = await listEvidenceLedger(filters);
    if (!mounted || own !== listSequence) return;
    items.value = result.items || []; totalCount.value = result.total;
    void statistics.load(filters);
    if (!exact.value) {
      const selected = items.value.find(row => entryKey(row) === selectedKey.value) || items.value[0];
      st.selId = selected?.source_id || null; st.sourceKind = selected?.source_kind || 'FILE';
      await loadDetail();
    } else await detail;
    if (listHost.value) listHost.value.scrollTop = 0;
  } catch (e) {
    if (!mounted || own !== listSequence) return;
    items.value = []; totalCount.value = 0; if (!exact.value) clearDetail();
    error.value = e.message || '证据台账读取失败'; statistics.fail(e);
  } finally { if (mounted && own === listSequence) loading.value = false; }
}
async function syncLocation() {
  clearDetail(); listSequence += 1;
  if (exact.value && !routeError.value) { const key = exactKeys.value[0]; st.selId = text(route.query[key]); st.sourceKind = { file: 'FILE', track: 'TRACK', command: 'COMMAND' }[key]; }
  if (Object.hasOwn(route.query, 'category')) st.kind = text(route.query.category);
  await nextTick(); await load();
}
function filterChanged() { st.page = 1; load(); }
function typeChanged() { st.status = ''; st.custody = ''; filterChanged(); }
function keywordChanged() { clearTimeout(keywordTimer); keywordTimer = setTimeout(filterChanged, 250); }
function select(row) {
  closeModal();
  if (exact.value) { const { file, track, command, ...rest } = route.query; router.replace({ path: '/evidence', query: evidenceRecordQuery(row, rest) }); return; }
  st.selId = row.source_id; st.sourceKind = row.source_kind; loadDetail();
}
function returnToLedger() { st.kind = ''; st.refKind = ''; st.status = ''; st.custody = ''; st.page = 1; router.replace({ path: '/evidence' }); }
function accessChanged() { listSequence += 1; clearDetail(); items.value = []; totalCount.value = 0; loading.value = false; error.value = '访问权限已变化，请重新读取'; statistics.fail(error.value); closeModal(); }
function onPage(p) { st.page = p; load(); }
function onPageSize(size) { st.size = size; st.page = 1; load(); }
function idem() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function confirmAction(options) { return new Promise(resolve => openConfirm({ ...options, onConfirm: () => { resolve(true); return true; }, onCancel: () => resolve(false) })); }
async function doDownload() {
  if (!st.selId) return;
  try {
    const file = await downloadEvidenceContent(st.selId);
    if (!file) return;
    saveEvidenceBlob(file.blob, file.filename);
    toast('已开始下载', 'ok');
  } catch (e) { toast(e.message || '下载失败', 'err'); }
}

async function doVerify() {
  if (!st.selId) return;
  const evidenceId = st.selId;
  const ok = await confirmAction({ title: '检查文件完整性', message: '检查当前保存的文件是否与入库时一致。若文件丢失或内容发生变化，系统会更新文件状态并留下检查记录。检查通过仅说明文件与入库时一致，不代表证据内容本身真实。是否开始检查？', confirmText: '开始检查' });
  if (!ok) return;
  try {
    const result = await verifyEvidenceFile(evidenceId, idem());
    toast(result.matches ? '检查通过：文件与入库时一致' : `检查结果：${labelOf(EVIDENCE_STATUS_LABEL, result.status, '结果暂不明确，请重新读取文件状态')}`, result.matches ? 'ok' : 'warn');
    await load();
  } catch (e) { toast(e.message || '文件完整性检查未完成，请重试', 'err'); }
}

function doHold() {
  if (!st.selId) return;
  const evidenceId = st.selId;
  openFormModal({
    title: '冻结证据',
    fields: [{ key: 'reason', label: '原因', type: 'textarea', required: true }],
    validate: values => {
      const reason = String(values.reason || '').trim();
      if (reason.length < 1 || reason.length > 500) return '原因须为 1 至 500 字';
    },
    onSubmit: async values => {
      await holdEvidenceFile(evidenceId, String(values.reason).trim(), idem());
      closeModal();
      toast('已冻结', 'ok');
      await load();
    }
  });
}

function doDestroy() {
  if (!st.selId) return;
  const evidenceId = st.selId;
  const row = detailRow.value;
  if (!row || row.status === 'DESTROYED' || row.held || row.custody !== 'DUE') {
    return toast('只有已到期且未冻结的文件可以销毁', 'err');
  }
  openFormModal({
    title: '销毁证据文件',
    confirmText: '确认销毁',
    danger: true,
    warning: '只删除文件内容，台账编号、完整性检查依据和销毁记录会留下。此操作不可恢复下载。',
    fields: [
      { key: 'reason', label: '原因', type: 'textarea', required: true, minRows: 3 },
      { key: 'approvalNo', label: '审批号（选填）', type: 'text', placeholder: '如有内部审批号可填写' }
    ],
    validate: values => {
      const reason = String(values.reason || '').trim();
      if (reason.length < 1 || reason.length > 500) return '原因须为 1 至 500 字';
      const approval = String(values.approvalNo || '').trim();
      if (approval.length > 64) return '审批号最多 64 字';
    },
    onSubmit: async values => {
      await destroyEvidenceFile(evidenceId, String(values.reason).trim(), String(values.approvalNo || '').trim(), idem());
      closeModal();
      toast('文件已销毁，台账记录保留', 'ok');
      await load();
    }
  });
}

async function doRelease(holdId) {
  if (!st.selId || !holdId) return;
  const evidenceId = st.selId;
  const ok = await confirmAction({ title: '解除冻结', message: '解除法律冻结后，该文件到期即可被清理。是否确认解除？', confirmText: '解除冻结', positiveType: 'warning' });
  if (!ok) return;
  try {
    await releaseEvidenceHold(evidenceId, holdId, idem());
    toast('已解除冻结', 'ok');
    await load();
  } catch (e) { toast(e.message || '解冻失败', 'err'); }
}

async function doExport() {
  try { const blob = await exportEvidenceLedger(query()); if (blob) { saveEvidenceBlob(blob, 'evidence-ledger.csv'); toast('已导出 CSV', 'ok'); } }
  catch (e) { toast(e.message || '导出失败', 'err'); }
}
watch(() => route.fullPath, () => { if (mounted) { closeModal(); syncLocation(); } });
onMounted(() => {
  mounted = true; syncLocation(); window.addEventListener('auth-access-change', accessChanged);
  U.on(root.value, '[data-ev-go]', 'click', (_e, el) => {
    const [kind, id] = el.dataset.evGo.split('|');
    const destination = evidenceSubjectLocation(kind, id);
    if (destination) router.push(destination);
    else if (kind === 'COMMAND') router.push({ path: '/evidence', query: { command: id } });
    else toast('该关联记录保留在原业务系统中', 'warn');
  });
  U.on(root.value, '[data-evact]', 'click', (_e, el) => {
    if (el.disabled || st.sourceKind !== 'FILE' || !detailRow.value) return;
    const actions = { download: doDownload, verify: doVerify, hold: doHold, destroy: doDestroy, release: () => doRelease(el.dataset.hold) };
    actions[el.dataset.evact]?.();
  });
});
onBeforeUnmount(() => { mounted = false; listSequence += 1; detailSequence += 1; clearTimeout(keywordTimer); closeModal(); window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <div id="view" ref="root" class="view"><div class="evidence-root">
    <div v-if="exact || hasContext" class="evidence-located-toolbar"><span>{{ hasContext ? '当前关联事项的证据' : '指定证据记录' }}</span><button class="btn" @click="returnToLedger">返回全部证据</button></div>
    <div v-if="error" class="warnbox" role="alert">{{ error }}</div>
    <div class="row evidence-row">
      <UPanel :title="`证据台账（${loading ? '加载中' : error ? '暂不可用' : totalCount}）`" panel-style="flex:1;min-width:0" nopad>
        <div class="toolbar"><div class="toolbar-fields">
          <UField id="evidence-kind" v-model="st.kind" label="类型" type="select" variant="filter" :options="KIND_OPTS" @update:model-value="typeChanged" />
          <UField v-if="st.kind !== 'COMMAND'" id="evidence-status" v-model="st.status" label="文件状态" type="select" variant="filter" :options="STATUS_OPTS" @update:model-value="filterChanged" />
          <UField v-if="st.kind !== 'COMMAND'" id="evidence-custody" v-model="st.custody" label="保管状态" type="select" variant="filter" :options="CUSTODY_OPTS" @update:model-value="filterChanged" />
          <UField v-if="!hasContext" id="evidence-subject" v-model="st.refKind" label="关联对象" type="select" variant="filter" :options="REF_OPTS" @update:model-value="filterChanged" />
          <UField id="evidence-keyword" v-model="st.kw" label="查找记录" sr-only variant="filter" placeholder="编号 / 名称" @update:model-value="keywordChanged" />
        </div><div class="toolbar-actions"><button class="btn" :disabled="loading || !!error" @click="doExport">导出 CSV</button></div></div>
        <div ref="listHost" class="scroll evidence-list">
          <div v-if="loading" class="empty" role="status">正在读取证据</div>
          <div v-else-if="error" class="empty"><button class="btn" @click="load">重新读取</button></div>
          <div v-else-if="!items.length" class="empty">当前筛选条件下暂无证据</div>
          <table v-else class="tb"><thead><tr><th>证据编号 / 类型</th><th>内容</th><th>取证 / 发生时刻</th><th>大小</th><th>状态</th><th>留存</th></tr></thead>
            <tbody><tr v-for="row in items" :key="entryKey(row)" :class="{ on: entryKey(row) === selectedKey }" @click="select(row)">
              <td class="num"><button class="evidence-record-name" @click.stop="select(row)">{{ row.evidence_no }}</button><div class="cell-sub">{{ EVIDENCE_CATEGORY_LABEL[row.category] }}</div></td>
              <td>{{ name(row) }}<div v-if="shape(row)" class="cell-sub">{{ shape(row) }}</div></td>
              <td class="num">{{ format(row.occurred_at) }}</td><td class="num">{{ row.source_kind === 'FILE' && row.status !== 'DESTROYED' ? sizeText(row.size_bytes) : '—' }}</td>
              <td><span class="tag" :class="SC[row.status] || 't-gray'">{{ stateLabel(row) }}</span></td>
              <td v-if="row.source_kind === 'FILE'"><div class="num">{{ row.retain_until ? format(row.retain_until).split(' ')[0] : '未记录' }}</div><span class="tag" :class="row.custody === 'HELD' ? 't-purple' : 't-gray'">{{ EVIDENCE_CUSTODY_LABEL[row.custody] || '未记录' }}</span></td><td v-else>不适用</td>
            </tr></tbody>
          </table>
        </div>
        <div class="pager"><UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount" :prefix="error ? '数量不可用' : `共 ${totalCount} 条`" @update:page="onPage" @update:page-size="onPageSize" /></div>
      </UPanel>
      <UPanel title="证据详情" panel-style="width:452px;max-width:45%;flex:none" nopad><div ref="detailHost" class="evidence-detail">
        <div v-if="detailLoading" class="empty" role="status">正在读取这份证据</div>
        <div v-else-if="detailError" class="empty" role="alert">{{ detailError }}<button class="btn" @click="loadDetail">重新读取</button></div>
        <template v-else-if="detailRow"><EvidencePreview :key="detailRow.evidence_id" :file="detailRow" details compact embedded :show-captured-time="!items.some(r => r.source_kind === 'FILE' && r.source_id === detailRow.evidence_id)" /><div id="evDetail" v-html="fileDetailHtml"></div></template>
        <EvidenceRecordDetail v-else-if="recordDetail" :key="selectedKey" :detail="recordDetail" />
        <div v-else class="empty">请选择证据记录</div>
      </div></UPanel>
    </div><ModuleStatistics :state="statsView" @retry="load" />
  </div></div>
</template>
<style scoped>
.evidence-root{height:100%;min-height:600px;display:flex;flex-direction:column}.evidence-row{flex:1;min-height:0;padding-bottom:6px}.evidence-list{flex:1;min-height:0;overflow:auto}.evidence-detail{flex:1;min-height:0;overflow:auto;padding:12px}.evidence-located-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px;color:var(--txt-2);font-size:12px;line-height:1.6}.evidence-located-toolbar>button{margin-left:auto}.evidence-record-name{padding:0;background:none;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer;overflow-wrap:anywhere}.cell-sub{font-size:11px;color:var(--txt-3)}.evidence-list td{overflow-wrap:anywhere}.evidence-list th:nth-child(1){width:148px}.evidence-list th:nth-child(3){width:124px}.evidence-list th:nth-child(4){width:72px}.evidence-list th:nth-child(5){width:86px}.evidence-list th:nth-child(6){width:118px}#evDetail :deep(.detail-hero-title),#evDetail :deep(.detail-hero-id){display:block;white-space:normal;overflow:visible;overflow-wrap:anywhere;text-overflow:unset;-webkit-line-clamp:unset;-webkit-box-orient:initial}
</style>
