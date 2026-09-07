<script>
const S = {
  st: { page: 1, size: 10, kind: '', status: '', refKind: '', kw: '', selId: null }
};
export default {};
</script>

<script setup>
/* 证据文件台账：只读协作者 A 的证据关联服务。不展示 C07 证据链，不回退 mock.js。
   legacy evidence.js 仍会在 index.html 注册 COM-03 参数，这里不再登记。 */
import { ref, reactive, onMounted } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import { toast } from '@/ui/nv.js';
import { openFormModal } from '@/ui/formModal.js';
import {
  downloadEvidenceContent, exportEvidenceCsv, getEvidenceFile, holdEvidenceFile,
  ingestEvidenceFile, listEvidenceFiles, releaseEvidenceHold, verifyEvidenceFile
} from '@/services/evidenceApi.js';
import {
  EVIDENCE_KIND_LABEL, EVIDENCE_STATUS_LABEL, EVIDENCE_SUBJECT_LABEL, labelOf
} from '@/ui/labels.js';

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
  COMMAND: 'monitor', COMMISSION: 'commission'
};

const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function fmt(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function sizeText(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
function idem() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const ledgerBody = `<div class="toolbar">
  ${U.field('类型', U.select('kind', KIND_OPTS, st.kind))}
  ${U.field('保管状态', U.select('status', STATUS_OPTS, st.status))}
  ${U.field('关联对象', U.select('refKind', REF_OPTS, st.refKind))}
  <input class="ip" id="evKw" style="width:180px" placeholder="编号 / 文件名" value="${esc(st.kw)}">
  <span style="flex:1"></span>
  <button class="btn" type="button" data-evact="export">导出 CSV</button>
  <button class="btn pri" type="button" data-evact="ingest">入库</button>
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
    el.innerHTML = '<div class="empty">暂无证据文件。入库后才会出现在台账中；未关联文件仅对入库权限可见。</div>';
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
    { t: '大小', w: '72px', align: 'right', cls: 'num', render: f => sizeText(f.size_bytes) },
    { t: '保管', w: '86px', render: f => U.tag(labelOf(EVIDENCE_STATUS_LABEL, f.status, f.status), SC[f.status] || 't-gray') },
    { t: '冻结', w: '62px', render: f => f.held ? '<span class="tag t-purple">冻结中</span>' : '<span style="color:var(--txt-3)">—</span>' },
    { t: '引用', w: '58px', align: 'right', cls: 'num', render: f => String(f.link_count || 0) }
  ], items.value, { rowId: f => f.evidence_id, activeId: st.selId });
}

function paintDetail() {
  const el = document.getElementById('evDetail');
  if (!el) return;
  const f = detailRow.value;
  if (!f) {
    el.innerHTML = '<div class="empty">请选择证据文件</div>';
    return;
  }
  const kind = labelOf(EVIDENCE_KIND_LABEL, f.kind_code, f.kind_code);
  const status = labelOf(EVIDENCE_STATUS_LABEL, f.status, f.status);
  const links = f.links || [];
  const holds = f.holds || [];
  const activeHold = holds.find(h => !h.released_at);
  const ingestSec = f.captured_at != null && f.stored_at != null
    ? Math.max(0, Math.round((f.stored_at - f.captured_at) / 1000)) : null;
  el.innerHTML = `${U.detailHero({
    icon: 'file', subtitle: '证据文件', title: f.original_name, id: f.evidence_no,
    tags: [U.tag(status, SC[f.status] || 't-gray')],
    meta: [['类型', kind], ['大小', sizeText(f.size_bytes)]]
  })}
  ${U.sect('文件信息', U.kv([
    ['类型', U.tag(kind, 't-cyan')],
    ['MIME / 大小', `${esc(f.content_type)} · ${sizeText(f.size_bytes)}`],
    ['SHA-256', `<span class="mono" style="word-break:break-all">${esc(f.sha256 || '—')}</span>`],
    ['取证时刻', fmt(f.captured_at)],
    ['入库时刻', fmt(f.stored_at) + (ingestSec != null ? `　<span style="color:var(--txt-3);font-size:11px">链路时延 ${ingestSec}s</span>` : '')],
    ['来源模式', esc(f.source_mode || '—')]
  ]))}
  ${U.sect('保管', U.kv([
    ['保管状态', U.tag(status, SC[f.status] || 't-gray')],
    ['法律冻结', f.held ? `<span class="tag t-purple">冻结中</span> ${esc(activeHold?.reason || '')}` : '<span class="tag t-gray">未冻结</span>'],
    ['到期日', f.retain_until ? fmt(f.retain_until) : '未设置（Q7 未确认，空不表示立即过期）']
  ]))}
  ${U.sect(`被引用（${links.length} 处）`, links.length
    ? links.map(r => `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(64,158,255,.08);font-size:12px">
        <span class="tag t-gray">${esc(labelOf(EVIDENCE_SUBJECT_LABEL, r.subject_kind, r.subject_kind))}</span>
        <span class="mono lnk" data-ev-go="${esc(r.subject_kind)}|${esc(r.subject_id)}">${esc(r.subject_no || r.subject_id)}</span>
      </div>`).join('')
    : '<div style="color:var(--txt-3);font-size:12px">无引用。未关联文件仅入库权限可见，不进入证据链汇总（C07 由协作者 B 建设）。</div>')}
  ${U.sect('操作', `<button class="btn pri" style="width:100%;justify-content:center" data-evact="download">${U.icon('download')} 下载</button>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn" style="flex:1" data-evact="verify">校验哈希</button>
      ${f.held
        ? `<button class="btn" style="flex:1" data-evact="release" data-hold="${esc(activeHold?.hold_id || '')}">解除冻结</button>`
        : `<button class="btn" style="flex:1" data-evact="hold">冻结</button>`}
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--txt-3);line-height:1.8">下载须经服务端鉴权并记入访问记录。销毁策略未确认（Q7），本页不提供销毁。</div>`)}`;
}

function onPage(p2) { st.page = p2; load(); }
function onPageSize(s2) { st.size = s2; st.page = 1; load(); }

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function doDownload() {
  if (!st.selId) return;
  try {
    const file = await downloadEvidenceContent(st.selId);
    if (!file) return;
    saveBlob(file.blob, file.filename);
    toast('已开始下载', 'ok');
  } catch (e) { toast(e.message || '下载失败', 'err'); }
}

async function doVerify() {
  if (!st.selId) return;
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
    fields: [{ name: 'reason', label: '原因', type: 'textarea', required: true }],
    validate: values => {
      const reason = String(values.reason || '').trim();
      if (reason.length < 1 || reason.length > 500) return '原因须为 1 至 500 字';
    },
    onSubmit: async values => {
      await holdEvidenceFile(st.selId, String(values.reason).trim(), idem());
      toast('已冻结', 'ok');
      await load();
    }
  });
}

async function doRelease(holdId) {
  if (!st.selId || !holdId) return;
  try {
    await releaseEvidenceHold(st.selId, holdId, idem());
    toast('已解除冻结', 'ok');
    await load();
  } catch (e) { toast(e.message || '解冻失败', 'err'); }
}

function doIngest() {
  openFormModal({
    title: '入库证据文件',
    warning: '服务端按文件内容计算 SHA-256，不接受客户端哈希。留存期限未确认，不会按演示年限销毁。',
    fields: [
      { name: 'kind_code', label: '种类', type: 'select', required: true, options: KIND_OPTS.filter(o => o.v) },
      { name: 'owner_org_id', label: '组织 ID', required: true },
      { name: 'district_id', label: '区域 ID', required: true }
    ],
    onSubmit: async values => {
      const input = document.createElement('input');
      input.type = 'file';
      const file = await new Promise(resolve => {
        input.onchange = () => resolve(input.files && input.files[0]);
        input.click();
      });
      if (!file) throw new Error('未选择文件');
      const created = await ingestEvidenceFile({
        file,
        kindCode: values.kind_code,
        ownerOrgId: values.owner_org_id,
        districtId: values.district_id,
        idempotencyKey: idem()
      });
      st.selId = created.evidence_id;
      toast('已入库 ' + created.evidence_no, 'ok');
      await load();
    }
  });
}

async function doExport() {
  try {
    const blob = await exportEvidenceCsv(query());
    if (!blob) return;
    saveBlob(blob, 'evidence-files.csv');
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
    if (k === 'ingest') return doIngest();
    if (k === 'export') return doExport();
    if (k === 'retry') return load();
  });
  const kw = document.getElementById('evKw');
  if (kw) kw.oninput = e => { st.kw = e.target.value.trim(); st.page = 1; load(); };
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <div class="warnbox" style="margin:0 0 12px;padding:8px 11px;font-size:12px;flex:none">
        本页是<strong>证据文件底座</strong>（入库、哈希、关联、授权下载、冻结）。
        八类记录汇总成证据链（C07）由另一位开发者建设，这里只引用文件、不自存一份。
        销毁与留存年限待业务确认，页面不提供销毁、也不按演示年限清理。
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
        <UPanel title="证据详情" panel-style="width:452px;flex:none" nopad
          body-html='<div id="evDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
      </div>
    </div>
  </div>
</template>
