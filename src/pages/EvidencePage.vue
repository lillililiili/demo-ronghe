<script>
/* 模块级状态：跨导航保持（legacy 约定）。 */
const S = {
  st: {
    page: 1, size: 10, kind: '全部', status: '全部', refKind: '全部',
    kw: '', sel: null, sort: 'captured', dir: -1, mod: '全部'
  }
};
export default {};
</script>

<script setup>
/* 证据存储管理 —— 第四个转换页（源：legacy pages/evidence.js）。
   ⚠ COM-03 参数登记（U.regParams EVID）在 legacy evidence.js 的模块加载期
   执行，legacy script 仍在 index.html 里加载 —— 这里绝不能再注册一次，
   否则参数总览会出现两份同 key 条目。
   doRead/destroyModal 在 legacy 里已无到达路径（调阅/销毁入口按 2026-08-28
   裁定删除），转换时不带入。 */
import { ref, reactive, computed, onMounted } from 'vue';
import { NPagination } from 'naive-ui';
import { usePageChrome } from '../shell/usePageChrome.js';
import UPanel from '../ui/UPanel.vue';
import { toast } from '../ui/nv.js';

const M = window.MOCK, U = window.UI;
usePageChrome('evidence');
const root = ref(null);
/* reactive 代理同一份模块级状态：n-pagination 需要响应式，底层仍是 S.st */
const st = reactive(S.st);
const totalCount = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(totalCount.value / st.size)));

const ALL = '全部';
const REF_LABEL = { case: '处罚案件', target: '感知目标', alarm: '告警', riskEvent: '空间安全风险事件', authLog: '反制/干扰授权', commTask: '调测任务', device: '设备', airspace: '空域' };
const SC = { '在库': 't-green', '临近到期': 't-amber', '已到期待清理': 't-orange', '已销毁': 't-gray' };
const moduleOf = f => f.srcModule;
const MODULES = () => [...new Set(M.evidenceFiles.map(f => f.srcModule))];

function daysLeft(f) {
  const d1 = new Date(f.retainUntil);
  return Math.round((d1 - M.CONF.demoTime) / 864e5);
}
function retainSane(f) { return f.retainUntil >= f.capturedAt.slice(0, 10); }

const SORTERS = {
  captured: f => f.capturedAt,
  kind: f => M.EVIDENCE_KINDS.indexOf(f.kind),
  size: f => f.sizeMB,
  status: f => M.EVIDENCE_STATUS.indexOf(f.status),
  refs: f => f.refs.length,
  access: f => f.accessCount
};
const SORT_NOTE = { status: '（在库→已销毁）', kind: '（按类型枚举顺序）' };
function sortTh(key, label) {
  const on = st.sort === key;
  return `<span class="lnk" data-sort="${key}" role="button" tabindex="0" title="点击按「${label}」排序${SORT_NOTE[key] || ''}"
    style="color:inherit;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;text-decoration-color:rgba(156,198,255,.5)"
    >${label}${on ? `<span style="font-size:10px;margin-left:2px">${st.dir < 0 ? '▼' : '▲'}</span>` : ''}</span>`;
}

function rows() {
  const kw = st.kw.toLowerCase();
  const f = M.evidenceFiles.filter(x =>
    (st.kind === ALL || x.kind === st.kind) &&
    (st.status === ALL || x.status === st.status) &&
    (st.refKind === ALL || x.refs.some(r => r.kind === st.refKind)) &&
    (st.mod === ALL || moduleOf(x) === st.mod) &&
    (!kw || (x.id + ' ' + x.name + ' ' + x.srcName + ' ' + x.kind + ' ' + x.srcModule + ' ' +
      (x.originAction || '') + ' ' +
      x.refs.map(r => r.id).join(' ')).toLowerCase().indexOf(kw) >= 0));
  const gt = SORTERS[st.sort];
  if (!gt) return f;
  return f.sort((a, b) => { const x = gt(a), y = gt(b); return (x < y ? -1 : x > y ? 1 : 0) * st.dir; });
}

/* 深链上下文（UI.goto('evidence',{id}) → 选中该证据并清筛选），与 legacy render() 同构 */
const ctx = U.consume('evidence');
if (ctx && ctx.id) {
  const hit = M.evidenceFiles.find(f => f.id === ctx.id);
  if (hit) {
    st.sel = hit;
    st.kind = st.status = st.refKind = st.mod = ALL;
    st.kw = '';
  }
}
st.sel = st.sel || M.evidenceFiles[0];

const ledgerBody = `<div class="toolbar">
  ${U.field('类型', U.select('kind', [ALL, ...M.EVIDENCE_KINDS], st.kind))}
  ${U.field('保管状态', U.select('status', [ALL, ...M.EVIDENCE_STATUS], st.status))}
  ${U.field('来源模块', U.select('mod', [ALL, ...MODULES()], st.mod))}
  ${U.field('关联对象', U.select('refKind', [ALL, ...Object.keys(REF_LABEL).map(k => ({ v: k, t: REF_LABEL[k] }))], st.refKind))}
  <input class="ip" id="evKw" style="width:180px" placeholder="编号 / 名称 / 关联对象编号" value="${st.kw}">
  <span style="flex:1"></span>
</div>
<div id="evList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

function list() {
  const all = rows(), page = all.slice((st.page - 1) * st.size, st.page * st.size);
  totalCount.value = all.length;
  return U.table([
    {
      t: sortTh('kind', '证据编号 / 类型'), w: '132px', cls: 'num',
      render: f => `<div>${f.id}</div><div style="font-size:11px;color:var(--txt-3)">${f.kind}</div>`
    },
    {
      t: '文件 / 来源', render: f => `<div title="${f.name}" style="white-space:normal;line-height:1.4;
        max-height:31px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${f.name}</div>
        <div style="font-size:11px;color:var(--txt-3)">${f.srcKind === 'device' ? '设备 ' : f.srcKind === 'page' ? '页面 ' : '系统 '}${f.srcName}</div>`
    },
    {
      t: sortTh('captured', '取证时刻'), w: '124px', cls: 'num',
      render: f => `<div>${f.capturedAt.slice(5, 16)}</div>
        <div style="font-size:11px;color:var(--txt-3)">入库 +${Math.max(0, Math.round((new Date(f.ingestAt) - new Date(f.capturedAt)) / 1000))}s</div>`
    },
    { t: sortTh('size', '大小'), w: '72px', align: 'right', cls: 'num', render: f => f.sizeMB.toFixed(1) + ' MB' },
    { t: sortTh('status', '保管'), w: '86px', render: f => U.tag(f.status, SC[f.status]) },
    {
      t: '冻结', w: '62px',
      render: f => f.legalHold
        ? '<span class="tag t-purple" title="关联案件未结案，冻结中">冻结中</span>'
        : '<span style="color:var(--txt-3)">—</span>'
    },
    {
      t: sortTh('refs', '引用'), w: '58px', align: 'right', cls: 'num',
      render: f => f.refs.length
    }
  ], page, { rowId: f => f.id, activeId: st.sel && st.sel.id });
}

function detail() {
  return window.EVIDENCE_VIEW
    ? window.EVIDENCE_VIEW.renderDetail(st.sel)
    : '<div class="empty">证据详情模块未加载</div>';
}

function paint() {
  document.getElementById('evList').innerHTML = list();
  document.getElementById('evDetail').innerHTML = detail();
}

function doDownload() {
  if (st.sel && window.EVIDENCE_VIEW) window.EVIDENCE_VIEW.download(st.sel);
}

function onPage(p2) { st.page = p2; paint(); }
function onPageSize(s2) { st.size = s2; st.page = 1; paint(); }

onMounted(() => {
  const view = root.value;
  paint();
  U.on(view, '[data-row]', 'click', (e, el) => {
    st.sel = M.evidenceFiles.find(f => f.id === el.dataset.row) || st.sel;
    U.selectRow(document.getElementById('evList'), el.dataset.row);
    document.getElementById('evDetail').innerHTML = detail();      // 只刷详情，不重建列表
  });
  /* 分页交互已由模板层 <n-pagination> 受控接管（P2），[data-pg]/[data-size] 委托删除 */
  U.on(view, '[data-f]', 'change', (e, el) => { st[el.dataset.f] = el.value; st.page = 1; paint(); });

  const doSort = key => {
    if (st.sort === key) st.dir = -st.dir;
    else { st.sort = key; st.dir = (key === 'captured' || key === 'size' || key === 'refs') ? -1 : 1; }
    st.page = 1; paint();
    const sc = document.querySelector('#evList .scroll');
    if (sc) sc.scrollTop = 0;
  };
  U.on(view, '[data-sort]', 'click', (e, el) => doSort(el.dataset.sort));
  U.on(view, '[data-sort]', 'keydown', (e, el) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(el.dataset.sort); }
  });

  U.on(view, '[data-ev-go]', 'click', (e, el) => {
    const [kind, id] = el.dataset.evGo.split('|');
    if (window.SEARCH && window.SEARCH.goEntity) window.SEARCH.goEntity(kind, id);
    else toast('检索模块未加载，无法直达', 'err');
  });

  U.on(view, '[data-evact]', 'click', (e, el) => {
    if (el.disabled) return;
    const k = el.dataset.evact;
    if (k === 'download') return doDownload();
  });

  document.getElementById('evKw').oninput = e => { st.kw = e.target.value.trim(); st.page = 1; paint(); };
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <!-- 操作引导（用户裁定 2026-08-30：多处补黄字引导）。主行 flex:1，自适应不需高度补偿 -->
      <div class="warnbox" style="margin:0 0 12px;padding:8px 11px;font-size:12px;flex:none">
        演示动线：用顶部筛选（<b>类型 / 保管状态 / 来源模块 / 关联对象</b>）收敛台账 →
        点任一行，右侧查看证据详情、保管信息与关联对象。</div>
      <div class="row" style="flex:1;min-height:0;padding-bottom:6px">
        <UPanel title="证据文件台账" panel-style="flex:1;min-width:0" nopad>
          <div style="display:contents" v-html="ledgerBody"></div>
          <!-- P2：分页器换 n-pagination（受控），容器样式内联复刻旧 .pager 观感 -->
          <div style="display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;min-height:42px;
            background:rgba(8,19,32,.54);border-top:1px solid rgba(130,174,218,.10);flex:none">
            <n-pagination :page="st.page" :page-size="st.size" :item-count="totalCount"
              show-size-picker :page-sizes="[10, 20, 50]"
              @update:page="onPage" @update:page-size="onPageSize">
              <template #prefix>共 {{ totalCount.toLocaleString() }} 条</template>
              <template #suffix>共 {{ pageCount }} 页</template>
            </n-pagination>
          </div>
        </UPanel>
        <UPanel title="证据详情" panel-style="width:452px;flex:none" nopad
          body-html='<div id="evDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
      </div>
    </div>
  </div>
</template>
