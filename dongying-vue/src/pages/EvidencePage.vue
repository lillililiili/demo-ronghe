<script>
const S = {
  st: { page: 1, size: 10, kind: '', status: '', refKind: '', kw: '', selId: null }
};
export default {};
</script>

<script setup>
/* 证据文件台账：只读证据关联服务。八类证据链在告警/处罚详情汇总，本页不自存第二份文件。
   legacy evidence.js 仍会在 index.html 注册 COM-03 参数，这里不再登记。 */
import { ref, reactive, onMounted } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import { toast } from '@/ui/nv.js';
import { closeModal, openFormModal } from '@/ui/formModal.js';
import { openConfirm } from '@/ui/confirm.js';
/* 会改状态的动作先问一句；openConfirm 的 onConfirm 回调改成 Promise 便于顺序写。 */
function confirmAction(options) { return new Promise(resolve => openConfirm({ ...options, onConfirm: () => { resolve(true); return true; }, onCancel: () => resolve(false) })); }
import {
  destroyEvidenceFile, downloadEvidenceContent, exportEvidenceCsv, getEvidenceFile, holdEvidenceFile,
  linkEvidenceFile, listEvidenceFiles, releaseEvidenceHold, verifyEvidenceFile
} from '@/services/evidenceApi.js';
import {
  EVIDENCE_KIND_LABEL, EVIDENCE_STATUS_LABEL, EVIDENCE_SUBJECT_LABEL, labelOf
} from '@/ui/labels.js';
import { custodyTag, renderEvidenceFileDetail, saveEvidenceBlob, sizeText } from '@/ui/evidenceFileDetail.js';

const U = window.UI;
usePageChrome('evidence');
const root = ref(null);
const st = reactive(S.st);
const totalCount = ref(0);
const loading = ref(false);
const error = ref('');
const items = ref([]);
const detailRow = ref(null);
const kpis = ref({ total: 0, available: 0, held: 0, broken: 0 });

const KIND_OPTS = [{ v: '', t: '全部' }, ...Object.entries(EVIDENCE_KIND_LABEL).map(([v, t]) => ({ v, t }))];
const STATUS_OPTS = [{ v: '', t: '全部' }, ...Object.entries(EVIDENCE_STATUS_LABEL).map(([v, t]) => ({ v, t }))];
const REF_OPTS = [{ v: '', t: '全部' }, ...Object.entries(EVIDENCE_SUBJECT_LABEL).map(([v, t]) => ({ v, t }))];
const SC = {
  PENDING: 't-gray', AVAILABLE: 't-green', MISSING: 't-orange', CORRUPT: 't-red', DESTROYED: 't-gray'
};
const SUBJECT_ROUTE = {
  EVENT: 'alarms', DEVICE: 'devices', TARGET: 'situation', PLAN: 'flights',
  COMMAND: 'monitor', COMMISSION: 'commission', CASE: 'punish', AUTHORIZATION: 'punish'
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
  if (st.kw) values.q = st.kw;
  return values;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const page = await listEvidenceFiles(query());
    items.value = page.items || [];
    totalCount.value = page.total || 0;
    if (st.selId && !items.value.some(row => row.evidence_id === st.selId)) st.selId = items.value[0]?.evidence_id || null;
    else if (!st.selId) st.selId = items.value[0]?.evidence_id || null;
    await loadDetail();
    paintList();
    const all = page;
    kpis.value = {
      total: all.total || 0,
      available: items.value.filter(r => r.status === 'AVAILABLE').length,
      held: items.value.filter(r => r.held).length,
      broken: items.value.filter(r => r.status === 'MISSING' || r.status === 'CORRUPT').length
    };
  } catch (e) {
    items.value = [];
    detailRow.value = null;
    error.value = e.message || '证据台账加载失败';
    paintList();
  } finally {
    loading.value = false;
  }
}

async function loadDetail() {
  if (!st.selId) { detailRow.value = null; paintDetail(); return; }
  try {
    detailRow.value = await getEvidenceFile(st.selId);
  } catch (e) {
    detailRow.value = null;
    toast(e.message || '证据详情加载失败', 'err');
  }
  paintDetail();
}

function paintList() {
  const el = document.getElementById('evList');
  if (!el) return;
  if (error.value) {
    el.innerHTML = `<div class="empty">${esc(error.value)} <button class="btn" type="button" data-evact="retry">重试</button></div>`;
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
      render: f => `<div title="${esc(f.original_name)}" style="white-space:normal;line-height:1.4;max-height:31px;overflow:hidden">${esc(f.original_name)}</div>
        <div style="font-size:11px;color:var(--txt-3)">${esc(f.content_type || '')}</div>`
    },
    { t: '取证时刻', w: '124px', cls: 'num', render: f => `<div>${esc(fmt(f.captured_at).slice(5, 16))}</div>` },
    { t: '大小', w: '72px', align: 'right', cls: 'num', render: f => (f.status === 'DESTROYED' ? '—' : sizeText(f.size_bytes)) },
    { t: '文件状态', w: '86px', render: f => U.tag(labelOf(EVIDENCE_STATUS_LABEL, f.status, f.status), SC[f.status] || 't-gray') },
    {
      t: '留存', w: '118px',
      render: f => `<div class="num">${esc((fmt(f.retain_until) || '—').slice(0, 10))}</div>
        <div>${custodyTag(f)}</div>`
    },
    { t: '冻结', w: '62px', render: f => f.held ? '<span class="tag t-purple">冻结中</span>' : '<span style="color:var(--txt-3)">—</span>' },
    { t: '引用', w: '58px', align: 'right', cls: 'num', render: f => String(f.link_count || 0) }
  ], items.value, { rowId: f => f.evidence_id, activeId: st.selId });
}

function paintDetail() {
  const el = document.getElementById('evDetail');
  if (!el) return;
  el.innerHTML = renderEvidenceFileDetail(detailRow.value, { mode: 'page' });
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
  const ok = await confirmAction({ title: '校验哈希', message: '将按台账记录的哈希重新读取文件并比对；比对结果会更新文件状态（可能变为"文件缺失"或"哈希不符"）并记入审计。是否继续？', confirmText: '开始校验' });
  if (!ok) return;
  try {
    const result = await verifyEvidenceFile(st.selId, idem());
    toast(result.matches ? '哈希一致' : `校验结果：${labelOf(EVIDENCE_STATUS_LABEL, result.status, result.status)}`, result.matches ? 'ok' : 'warn');
    await load();
  } catch (e) { toast(e.message || '校验失败', 'err'); }
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
    warning: '只删除文件内容，台账编号、哈希和销毁记录会留下。此操作不可恢复下载。',
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

function doLink() {
  if (!st.selId) return;
  const kinds = Object.entries(EVIDENCE_SUBJECT_LABEL).map(([value, label]) => ({ value, label }));
  openFormModal({
    title: '关联业务对象',
    confirmText: '关联',
    warning: '对象必须已经存在且当前账号可见；案件需要处罚查看权限，处置授权需要处置查看权限。',
    fields: [
      { key: 'subject_kind', label: '对象类型', type: 'select', required: true, options: kinds },
      { key: 'subject_id', label: '对象 ID', type: 'text', required: true, placeholder: '业务对象的 ID' }
    ],
    validate: values => {
      if (!String(values.subject_kind || '').trim()) return '请选择对象类型';
      if (!String(values.subject_id || '').trim()) return '请填写对象 ID';
    },
    onSubmit: async values => {
      await linkEvidenceFile(st.selId, String(values.subject_kind).trim(), String(values.subject_id).trim(), idem());
      closeModal();
      toast('已关联', 'ok');
      await load();
    }
  });
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
  const view = root.value;
  load();
  U.on(view, '[data-row]', 'click', (e, el) => {
    st.selId = el.dataset.row;
    loadDetail();
    U.selectRow(document.getElementById('evList'), el.dataset.row);
  });
  U.on(view, '[data-f]', 'change', (e, el) => { st[el.dataset.f] = el.value; st.page = 1; load(); });
  U.on(view, '[data-ev-go]', 'click', (e, el) => {
    const [kind, id] = el.dataset.evGo.split('|');
    const page = SUBJECT_ROUTE[kind];
    if (!page) return toast('该对象没有页面入口', 'err');
    location.hash = '#/' + page;
    void id;
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
    if (k === 'link') return doLink();
    if (k === 'retry') return load();
  });
  const kw = document.getElementById('evKw');
  if (kw) kw.oninput = e => { st.kw = e.target.value.trim(); st.page = 1; load(); };
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <div v-if="error" class="warnbox" style="margin:0 0 12px" role="alert">{{ error }}</div>
      <div class="row" style="flex:1;min-height:0;padding-bottom:6px">
        <UPanel :title="loading ? '证据文件台账（加载中）' : `证据文件台账（${totalCount}）`" panel-style="flex:1;min-width:0" nopad>
          <div style="display:contents" v-html="ledgerBody"></div>
          <div class="pager">
            <UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount"
              :prefix="`共 ${totalCount.toLocaleString()} 条`" @update:page="onPage" @update:page-size="onPageSize" />
          </div>
        </UPanel>
        <UPanel title="证据详情" panel-style="width:452px;flex:none" nopad
          body-html='<div id="evDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
      </div>
    </div>
  </div>
</template>
