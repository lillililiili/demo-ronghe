<script>
const S = {
  st: { page: 1, size: 10, kind: '', status: '', custody: '', refKind: '', kw: '', selId: null }
};
export default {};
</script>

<script setup>
/* 证据文件台账：只读证据关联服务。八类证据链在告警/处罚详情汇总，本页不自存第二份文件。
   legacy evidence.js 仍会在 index.html 注册 COM-03 参数，这里不再登记。 */
import { computed, nextTick, ref, reactive, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import ModuleStatistics from '@/components/ModuleStatistics.vue';
import { useModuleStatistics } from '@/hooks/useModuleStatistics.js';
import { getEvidenceStatistics } from '@/services/evidenceApi.js';
import EvidencePreview from '@/components/evidence/EvidencePreview.vue';
import EvidenceTrackDetail from '@/pages/evidence/components/EvidenceTrackDetail.vue';
import { hasPermission } from '@/services/accessControl.js';
import { toast } from '@/ui/nv.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
import { openConfirm } from '@/ui/confirm.js';
/* 会改状态的动作先问一句；openConfirm 的 onConfirm 回调改成 Promise 便于顺序写。 */
function confirmAction(options) { return new Promise(resolve => openConfirm({ ...options, onConfirm: () => { resolve(true); return true; }, onCancel: () => resolve(false) })); }
import {
  destroyEvidenceFile, downloadEvidenceContent, exportEvidenceCsv, getEvidenceFile, holdEvidenceFile,
  listEvidenceFiles, releaseEvidenceHold, verifyEvidenceFile
} from '@/services/evidenceApi.js';
import { EVIDENCE_CUSTODY_LABEL, EVIDENCE_KIND_LABEL, EVIDENCE_STATUS_LABEL, EVIDENCE_SUBJECT_LABEL, labelOf } from '@/ui/labels.js';
import { custodyTag, renderEvidenceFileDetail, saveEvidenceBlob, sizeText } from '@/ui/evidenceFileDetail.js';

const U = window.UI;
usePageChrome('evidence');
const route = useRoute();
const router = useRouter();
const root = ref(null);
const st = reactive(S.st);
const totalCount = ref(0);
const loading = ref(false);
const error = ref('');
const items = ref([]);
const statistics = useModuleStatistics(getEvidenceStatistics, [
  { key: 'by_status', title: '证据文件状态分布', type: 'bar', labels: EVIDENCE_STATUS_LABEL, colors: { PENDING: 'gray', AVAILABLE: 'green', MISSING: 'orange', CORRUPT: 'red', DESTROYED: 'gray' } },
  { key: 'by_kind', title: '证据类型占比', type: 'donut', labels: EVIDENCE_KIND_LABEL, colors: { EO_VIDEO: 'blue', EO_STILL: 'green', TRACK_SNAPSHOT: 'cyan', NOTICE_RECEIPT: 'amber', COMMISSION_REPORT: 'purple', COMMAND_LOG: 'orange', SCENE_PHOTO: 'pink', PENALTY_DOCUMENT: 'red' } },
  { key: 'by_custody', title: '证据保管状态分布', type: 'bar', labels: EVIDENCE_CUSTODY_LABEL, colors: { KEPT: 'green', NEARING: 'amber', DUE: 'orange', HELD: 'purple' } }
]);
const detailRow = ref(null);
const detailLoading = ref(false);
const detailError = ref('');
let detailSequence = 0;
let listSequence = 0;
let mounted = false;
const queryText = value => typeof value === 'string' ? value.trim() : '';
const fileRequested = computed(() => Object.prototype.hasOwnProperty.call(route.query, 'file'));
const requestedFile = computed(() => queryText(route.query.file));
const trackRequested = computed(() => ['track', 'subjectKind', 'subjectId'].some(key => Object.prototype.hasOwnProperty.call(route.query, key)));
const trackQueryError = computed(() => fileRequested.value || ['track', 'subjectKind', 'subjectId'].some(key => !queryText(route.query[key]))
  ? '证据定位信息不完整或冲突，请从原事项重新打开这份轨迹。' : '');
const kpis = ref({ total: 0, available: 0, held: 0, broken: 0 });

const KIND_OPTS = [{ v: '', t: '全部' }, ...Object.entries(EVIDENCE_KIND_LABEL).map(([v, t]) => ({ v, t }))];
const STATUS_OPTS = [{ v: '', t: '全部' }, ...Object.entries(EVIDENCE_STATUS_LABEL).map(([v, t]) => ({ v, t }))];
const REF_OPTS = [{ v: '', t: '全部' }, ...Object.entries(EVIDENCE_SUBJECT_LABEL).map(([v, t]) => ({ v, t }))];
const CUSTODY_OPTS = [{ v: '', t: '全部' }, ...Object.entries(EVIDENCE_CUSTODY_LABEL).map(([v, t]) => ({ v, t }))];
const SC = {
  PENDING: 't-gray', AVAILABLE: 't-green', MISSING: 't-orange', CORRUPT: 't-red', DESTROYED: 't-gray'
};
const SUBJECT_ROUTE = {
  EVENT: 'alarms', TARGET: 'situation', PLAN: 'flights', CASE: 'punish', AUTHORIZATION: 'alarms'
};

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function fmt(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function idem() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const ledgerBody = `<div class="toolbar">
  <div class="toolbar-fields">
    ${U.field('类型', U.select('kind', KIND_OPTS, st.kind))}
    ${U.field('文件状态', U.select('status', STATUS_OPTS, st.status))}
    ${U.field('保管状态', U.select('custody', CUSTODY_OPTS, st.custody))}
    ${U.field('关联对象', U.select('refKind', REF_OPTS, st.refKind))}
    <input class="ip" id="evKw" placeholder="编号 / 文件名" value="${esc(st.kw)}">
  </div>
  <div class="toolbar-actions">
    <button class="btn" type="button" data-evact="export">导出 CSV</button>
  </div>
</div>
<div id="evList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

function query() {
  const values = { page: st.page, size: st.size };
  if (st.kind) values.kind_code = st.kind;
  if (st.status) values.status = st.status;
  if (st.custody) values.custody = st.custody;
  if (st.kw) values.q = st.kw;
  return values;
}

async function load() {
  const own = ++listSequence;
  if (!mounted || trackRequested.value) return;
  const filters = query();
  statistics.begin();
  loading.value = true;
  error.value = '';
  if (!hasPermission('evidence:read')) {
    items.value = []; detailRow.value = null; totalCount.value = 0;
    detailSequence += 1; detailLoading.value = false;
    error.value = '当前账号没有查看证据的权限'; detailError.value = error.value;
    statistics.fail(error.value);
    loading.value = false; paintList(); paintDetail(); return;
  }
  // 精确详情不依赖分页结果；当前筛选未返回该文件也不能改选第一份。
  const exactDetail = fileRequested.value ? loadDetail() : null;
  try {
    const page = await listEvidenceFiles(filters);
    if (own !== listSequence || !mounted) return;
    items.value = page.items || [];
    totalCount.value = page.total || 0;
    void statistics.load(filters);
    if (!fileRequested.value) {
      if (!items.value.some(row => row.evidence_id === st.selId)) st.selId = items.value[0]?.evidence_id || null;
      await loadDetail();
    } else await exactDetail;
    if (own !== listSequence || !mounted) return;
    paintList();
    const all = page;
    kpis.value = {
      total: all.total || 0,
      available: items.value.filter(r => r.status === 'AVAILABLE').length,
      held: items.value.filter(r => r.held).length,
      broken: items.value.filter(r => r.status === 'MISSING' || r.status === 'CORRUPT').length
    };
  } catch (e) {
    if (own !== listSequence || !mounted) return;
    items.value = [];
    if (!fileRequested.value) { detailSequence += 1; detailRow.value = null; detailLoading.value = false; paintDetail(); }
    error.value = e.message || '证据台账加载失败';
    statistics.fail(e);
    paintList();
  } finally {
    if (own === listSequence && mounted) loading.value = false;
  }
}

async function loadDetail() {
  const own = ++detailSequence;
  const selected = st.selId;
  detailRow.value = null;
  detailLoading.value = false;
  detailError.value = fileRequested.value && !requestedFile.value ? '证据定位信息无效，请从原事项重新打开这份证据。' : '';
  paintDetail();
  if (!selected || detailError.value) return;
  if (!hasPermission('evidence:read')) { detailError.value = '当前账号没有查看证据的权限'; paintDetail(); return; }
  detailLoading.value = true;
  paintDetail();
  try {
    const file = await getEvidenceFile(selected);
    if (own !== detailSequence || selected !== st.selId || !mounted) return;
    if (file?.evidence_id !== selected) throw new Error('返回的证据与当前选择不一致，请重新读取');
    detailRow.value = file;
  } catch (e) {
    if (own !== detailSequence || !mounted) return;
    detailRow.value = null;
    detailError.value = e.status === 404 ? '这份证据不存在或不在当前账号的可见范围内。'
      : e.status === 403 ? '当前账号没有查看这份证据的权限。' : e.message || '证据详情加载失败';
  } finally {
    if (own === detailSequence && mounted) { detailLoading.value = false; paintDetail(); }
  }
}

function paintList() {
  const el = document.getElementById('evList');
  if (!el) return;
  if (error.value) {
    el.innerHTML = `<div class="empty">证据列表暂不可用 <button class="btn" type="button" data-evact="retry">重试</button></div>`;
    return;
  }
  if (!items.value.length) {
    el.innerHTML = '<div class="empty">还没有证据文件。录像、抓拍、文书等由告警、处置等业务过程写入本台账，本页只查阅与保管。</div>';
    return;
  }
  el.innerHTML = U.table([
    {
      t: '证据编号 / 类型', w: '148px', cls: 'num',
      render: f => `<div>${esc(f.evidence_no)}</div><div style="font-size:11px;color:var(--txt-3)">${esc(labelOf(EVIDENCE_KIND_LABEL, f.kind_code, f.kind_code))}</div>`
    },
    {
      t: '文件',
      render: f => `<div style="white-space:normal;line-height:1.4;overflow-wrap:anywhere">${esc(f.original_name)}</div>
        <div style="font-size:11px;color:var(--txt-3)">${esc(f.content_type || '')}</div>`
    },
    { t: '取证时刻', w: '124px', cls: 'num', render: f => `<div>${esc(fmt(f.captured_at).slice(5, 16))}</div>` },
    { t: '大小', w: '72px', align: 'right', cls: 'num', render: f => (f.status === 'DESTROYED' ? '—' : sizeText(f.size_bytes)) },
    { t: '文件状态', w: '86px', render: f => U.tag(labelOf(EVIDENCE_STATUS_LABEL, f.status, f.status), SC[f.status] || 't-gray') },
    {
      t: '留存', w: '118px',
      render: f => `<div class="num">${esc((fmt(f.retain_until) || '—').slice(0, 10))}</div>
        <div>${custodyTag(f)}</div>`
    }
  ], items.value, { rowId: f => f.evidence_id, activeId: st.selId });
}

function paintDetail() {
  const el = document.getElementById('evDetail');
  if (!el) return;
  el.innerHTML = detailLoading.value ? '<div class="empty" role="status">正在读取这份证据</div>'
    : detailError.value ? `<div class="empty" role="alert">${esc(detailError.value)} <button class="btn" type="button" data-evact="detail-retry">重新读取</button></div>`
    : renderEvidenceFileDetail(detailRow.value, { mode: 'page', embeddedPreview: true });
}

function returnToLedger() { router.replace({ path: '/evidence' }); }
async function syncLocation(reloadList = false) {
  listSequence += 1; detailSequence += 1;
  detailRow.value = null; detailError.value = ''; detailLoading.value = false; loading.value = false;
  paintDetail();
  if (trackRequested.value) return;
  if (fileRequested.value) st.selId = requestedFile.value || null;
  await nextTick();
  if (!mounted || trackRequested.value) return;
  if (reloadList || !items.value.length || !fileRequested.value) return load();
  paintList();
  return loadDetail();
}
watch(() => route.fullPath, (_next, previous) => {
  if (!mounted) return;
  closeModal();
  syncLocation(previous.includes('track=') || previous.includes('subjectKind='));
}, { flush: 'sync' });
function accessChanged() {
  listSequence += 1; detailSequence += 1;
  items.value = []; detailRow.value = null; detailLoading.value = false; loading.value = false;
  error.value = '登录状态或访问权限已变化，请重新读取证据台账';
  detailError.value = '登录状态或访问权限已变化，请重新打开这份证据';
  paintList(); paintDetail();
}

function onPage(p2) { st.page = p2; load(); }
function onPageSize(s2) { st.size = s2; st.page = 1; load(); }

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
  openFormModal({
    title: '冻结证据',
    fields: [{ key: 'reason', label: '原因', type: 'textarea', required: true }],
    validate: values => {
      const reason = String(values.reason || '').trim();
      if (reason.length < 1 || reason.length > 500) return '原因须为 1 至 500 字';
    },
    onSubmit: async values => {
      await holdEvidenceFile(st.selId, String(values.reason).trim(), idem());
      closeModal();
      toast('已冻结', 'ok');
      await load();
    }
  });
}

function doDestroy() {
  if (!st.selId) return;
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
      await destroyEvidenceFile(st.selId, String(values.reason).trim(), String(values.approvalNo || '').trim(), idem());
      closeModal();
      toast('文件已销毁，台账记录保留', 'ok');
      await load();
    }
  });
}

async function doRelease(holdId) {
  if (!st.selId || !holdId) return;
  const ok = await confirmAction({ title: '解除冻结', message: '解除法律冻结后，该文件到期即可被清理。是否确认解除？', confirmText: '解除冻结', positiveType: 'warning' });
  if (!ok) return;
  try {
    await releaseEvidenceHold(st.selId, holdId, idem());
    toast('已解除冻结', 'ok');
    await load();
  } catch (e) { toast(e.message || '解冻失败', 'err'); }
}

async function doExport() {
  try {
    const blob = await exportEvidenceCsv(query());
    if (!blob) return;
    saveEvidenceBlob(blob, 'evidence-files.csv');
    toast('已导出 CSV', 'ok');
  } catch (e) { toast(e.message || '导出失败', 'err'); }
}

onMounted(() => {
  mounted = true;
  const view = root.value;
  syncLocation(true);
  window.addEventListener('auth-access-change', accessChanged);
  U.on(view, '[data-row]', 'click', (e, el) => {
    if (fileRequested.value) {
      router.replace({ path: '/evidence', query: { file: el.dataset.row } });
      return;
    }
    st.selId = el.dataset.row;
    loadDetail();
    U.selectRow(document.getElementById('evList'), el.dataset.row);
  });
  U.on(view, '[data-f]', 'change', (e, el) => { st[el.dataset.f] = el.value; st.page = 1; load(); });
  U.on(view, '[data-ev-go]', 'click', (e, el) => {
    const [kind, id] = el.dataset.evGo.split('|');
    const page = SUBJECT_ROUTE[kind];
    if (!page) return toast(['DEVICE', 'COMMAND', 'COMMISSION'].includes(kind) ? '该功能已迁移至后台管理系统' : '该对象没有页面入口', 'err');
    if (kind === 'EVENT' && id) sessionStorage.setItem('alarm.sel', id);
    if (kind === 'AUTHORIZATION' && id) {
      location.hash = `#/alarms?tab=authorizations&authorization=${encodeURIComponent(id)}`;
      return;
    }
    if (kind === 'PLAN' && id) {
      location.hash = `#/flights?plan=${encodeURIComponent(id)}`;
      return;
    }
    location.hash = '#/' + page;
  });
  U.on(view, '[data-evact]', 'click', (e, el) => {
    if (el.disabled) return;
    const k = el.dataset.evact;
    if (k === 'download') return doDownload();
    if (k === 'verify') return doVerify();
    if (k === 'hold') return doHold();
    if (k === 'release') return doRelease(el.dataset.hold);
    if (k === 'destroy') return doDestroy();
    if (k === 'export') return doExport();
    if (k === 'retry') return load();
    if (k === 'detail-retry') return loadDetail();
  });
  U.on(view, '#evKw', 'input', e => { st.kw = e.target.value.trim(); st.page = 1; load(); });
});
onBeforeUnmount(() => {
  mounted = false; listSequence += 1; detailSequence += 1;
  window.removeEventListener('auth-access-change', accessChanged);
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <EvidenceTrackDetail v-if="trackRequested" :subject-kind="queryText(route.query.subjectKind)"
      :subject-id="queryText(route.query.subjectId)" :track-id="queryText(route.query.track)"
      :query-error="trackQueryError" @return="returnToLedger" />
    <div v-else style="height:100%;min-height:600px;display:flex;flex-direction:column">
      <div v-if="fileRequested" class="evidence-located-toolbar">
        <span>指定证据记录{{ detailRow && !items.some(item => item.evidence_id === detailRow.evidence_id) ? '，当前证据不在本页列表中' : '' }}</span>
        <button class="btn" type="button" @click="returnToLedger">返回证据台账</button>
      </div>
      <div v-if="error" class="warnbox" style="margin:0 0 12px" role="alert">{{ error }}</div>
      <div class="row" style="flex:1;min-height:0;padding-bottom:6px">
        <UPanel :title="loading ? '证据文件台账（加载中）' : `证据文件台账（${totalCount}）`" panel-style="flex:1;min-width:0" nopad>
          <div style="display:contents" v-html="ledgerBody"></div>
          <div class="pager">
            <UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount"
              :prefix="`共 ${totalCount.toLocaleString()} 条`" @update:page="onPage" @update:page-size="onPageSize" />
          </div>
        </UPanel>
        <UPanel title="证据详情" panel-style="width:452px;max-width:45%;flex:none" nopad>
          <div style="flex:1;min-height:0;overflow:auto;padding:12px">
            <EvidencePreview v-if="detailRow" :key="detailRow.evidence_id" :file="detailRow" details compact embedded :show-captured-time="!items.some(item => item.evidence_id === detailRow.evidence_id)" />
            <div id="evDetail"></div>
          </div>
        </UPanel>
      </div>
      <ModuleStatistics :state="statistics.state" @retry="load" />
    </div>
  </div>
</template>

<style scoped>
.evidence-located-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; color: var(--txt-2); font-size: 12px; line-height: 1.6; }
.evidence-located-toolbar > button { margin-left: auto; }
#evDetail :deep(.detail-hero-title), #evDetail :deep(.detail-hero-id) {
  display: block; white-space: normal; overflow: visible; overflow-wrap: anywhere;
  text-overflow: unset; -webkit-line-clamp: unset; -webkit-box-orient: initial;
}
</style>
