<script>
/* 模块级状态：跨导航保持（legacy 约定）。 */
const S = {
  st: {
    page: 1, size: 10, kind: '全部', verify: '全部', status: '全部', refKind: '全部',
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
import { ref, onMounted } from 'vue';
import { usePageChrome } from '../shell/usePageChrome.js';
import UPanel from '../ui/UPanel.vue';

const M = window.MOCK, U = window.UI;
usePageChrome('evidence');
const root = ref(null);
const st = S.st;

const ALL = '全部';
const REF_LABEL = { case: '处罚案件', target: '感知目标', alarm: '告警', riskEvent: '空间安全风险事件', authLog: '反制/干扰授权', commTask: '调测任务', device: '设备', airspace: '空域' };
const VC = { '完好': 't-green', '哈希不一致': 't-red', '文件缺失': 't-red', '待校验': 't-amber' };
const SC = { '在库': 't-green', '临近到期': 't-amber', '已到期待清理': 't-orange', '已销毁': 't-gray' };
const isBad = f => f.verifyState !== '完好';
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
  verify: f => M.EVIDENCE_VERIFY.indexOf(f.verifyState),
  status: f => M.EVIDENCE_STATUS.indexOf(f.status),
  refs: f => f.refs.length,
  access: f => f.accessCount
};
const SORT_NOTE = { verify: '（完好→异常）', status: '（在库→已销毁）', kind: '（按类型枚举顺序）' };
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
    (st.verify === ALL || x.verifyState === st.verify) &&
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
    st.kind = st.verify = st.status = st.refKind = st.mod = ALL;
    st.kw = '';
  }
}
st.sel = st.sel || M.evidenceFiles[0];

const ledgerBody = `<div class="toolbar">
  ${U.field('类型', U.select('kind', [ALL, ...M.EVIDENCE_KINDS], st.kind))}
  ${U.field('完整性', U.select('verify', [ALL, ...M.EVIDENCE_VERIFY], st.verify))}
  ${U.field('保管状态', U.select('status', [ALL, ...M.EVIDENCE_STATUS], st.status))}
  ${U.field('来源模块', U.select('mod', [ALL, ...MODULES()], st.mod))}
  ${U.field('关联对象', U.select('refKind', [ALL, ...Object.keys(REF_LABEL).map(k => ({ v: k, t: REF_LABEL[k] }))], st.refKind))}
  <input class="ip" id="evKw" style="width:180px" placeholder="编号 / 名称 / 关联对象编号" value="${st.kw}">
  <span style="flex:1"></span>
</div>
<div id="evList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;

function list() {
  const all = rows(), page = all.slice((st.page - 1) * st.size, st.page * st.size);
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
    { t: sortTh('verify', '完整性'), w: '92px', render: f => U.tag(f.verifyState, VC[f.verifyState]) },
    {
      t: sortTh('status', '保管'), w: '108px',
      render: f => `${U.tag(f.status, SC[f.status])}${f.legalHold ? ' <span class="tag t-purple" title="关联案件未结案，冻结中">冻</span>' : ''}`
    },
    {
      t: sortTh('refs', '引用'), w: '58px', align: 'right', cls: 'num',
      render: f => f.refs.length
    }
  ], page, { rowId: f => f.id, activeId: st.sel && st.sel.id })
    + U.pager({ total: all.length, page: st.page, size: st.size });
}

function detail() {
  const f = st.sel;
  if (!f) return '<div class="empty">请选择证据文件</div>';
  const refs = M.evidenceRefs(f.id);
  const left = daysLeft(f), sane = retainSane(f);
  const ingestSec = Math.max(0, Math.round((new Date(f.ingestAt) - new Date(f.capturedAt)) / 1000));
  return `${U.detailHero({
    icon: 'file', subtitle: '证据文件', title: f.name, id: f.id,
    tags: [U.tag(f.verifyState, VC[f.verifyState]), U.tag(f.status, SC[f.status])],
    meta: [['格式', f.ext.toUpperCase()], ['大小', f.sizeMB.toFixed(2) + ' MB']]
  })}
    ${U.metricStrip([
      { label: '完整性', value: f.verifyState, tone: isBad(f) ? 'bad' : 'good', icon: 'shield' },
      { label: '保管状态', value: f.status, tone: f.status === '在库' ? 'good' : 'warn', icon: 'archive' },
      { label: '引用次数', value: refs.length, unit: '处', tone: refs.length ? 'info' : 'warn', icon: 'link' },
      { label: '入库时差', value: ingestSec, unit: 's', tone: ingestSec <= 60 ? 'good' : 'warn', icon: 'clock' }
    ], { compact: true })}

    ${U.sect('文件信息', U.kv([
    ['类型', U.tag(f.kind, 't-cyan')],
    ['格式 / 大小', `${f.ext.toUpperCase()} · ${f.sizeMB.toFixed(2)} MB`],
    ['存储方式', f.storage],
    ['产生者', `${f.srcKind === 'device' ? '设备' : f.srcKind === 'page' ? '页面' : '系统'} · ${f.srcName}
      ${f.srcKind === 'device' ? `<span class="mono lnk" data-ev-go="device|${f.srcId}">${f.srcId}</span>` : ''}`],
    ['归属模块', U.tag(f.srcModule, 't-blue')],
    ['产生动作', `<span style="line-height:1.6">${f.originAction}</span>`],
    ['取证时刻', f.capturedAt],
    ['入库时刻', `${f.ingestAt}　<span style="color:var(--txt-3);font-size:11px">链路时延 ${Math.max(0, Math.round((new Date(f.ingestAt) - new Date(f.capturedAt)) / 1000))}s</span>`]
  ]))}

    ${U.sect('完整性校验', U.kv([
    ['算法', f.hashAlgo],
    ['哈希', `<span class="mono" style="font-size:11px;word-break:break-all">${f.hash}</span>`],
    ['上次校验', f.verifyAt],
    ['校验结果', U.tag(f.verifyState, VC[f.verifyState])]
  ]) + (isBad(f)
    ? `<div class="warnbox" style="border-color:rgba(255,77,94,.45);margin-top:8px;line-height:1.85">
         <b>处置流程</b><br>${f.verifyNote || U.icon('warning') + ' 未记录处置说明 —— 校验异常必须写明发现时间、处置流程与责任人'}</div>`
    : `<div style="font-size:11px;color:var(--txt-3);margin-top:6px;line-height:1.7">
         每 ${M.EVID_PARAMS.verifyCycleDays} 天全量比对一次入库哈希。校验只做比对与记录，
         <b>不会自动"修复"</b> —— 异常必须人工判定来源并留痕。</div>`))}

    ${U.sect('保管与留存', U.kv([
    ['留存期', f.retainYears + ' 年　<span class="tag t-amber">待业务方确认</span>'],
    ['到期日', `${f.retainUntil}${sane
      ? `　<span style="color:${left < 0 ? '#ff8b95' : left < 60 ? '#ffd07a' : 'var(--txt-3)'}">${left < 0 ? '已过期 ' + (-left) + ' 天' : '剩余 ' + left + ' 天'}</span>`
      : `　<span class="tag t-red" title="到期日早于取证时刻，该记录的时间线不成立">数据异常</span>`}`],
    ['保管状态', U.tag(f.status, SC[f.status])],
    ['法律冻结', f.legalHold
      ? `<span class="tag t-purple">冻结中</span> <span style="font-size:11.5px;color:var(--txt-3)">${f.holdReason || ''}</span>`
      : '<span class="tag t-gray">未冻结</span>']
  ]) + (sane ? '' : `<div class="warnbox" style="border-color:rgba(255,77,94,.45);margin-top:8px;line-height:1.8">
      <b class="inline-icon">${U.icon('warning')} 该记录到期日（${f.retainUntil}）早于取证时刻（${f.capturedAt.slice(0, 10)}）</b>，时间线不成立。
      本页不替数据层修正这类矛盾 —— 兜住了就再也没人会发现它是错的。已登记给数据层修正。</div>`)
    + (f.status === '已销毁' ? U.kv([
      ['销毁时间', f.destroyAt], ['销毁执行人', f.destroyBy],
      ['销毁审批号', `<span class="mono">${f.destroyApproval}</span>`],
      ['销毁说明', f.destroyNote]
    ]) + `<div style="font-size:11px;color:var(--txt-3);margin-top:-6px;line-height:1.7">
        文件实体已销毁，<b>元数据与销毁记录永久保留</b> —— 台账里查得到"曾经有过、谁在何时依何审批销毁"。</div>` : ''))}

    ${U.sect(`被引用（${refs.length} 处）`, refs.length
    ? refs.map(r => `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;
          border-bottom:1px solid rgba(64,158,255,.08);font-size:12px">
          <span class="tag t-gray" style="flex:none">${r.label}</span>
          <span class="mono ${r.exists ? 'lnk' : ''}" ${r.exists ? `data-ev-go="${r.kind}|${r.id}"` : ''}
            style="flex:none">${r.id}</span>
          <span style="flex:1;min-width:0;color:var(--txt-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.name || ''}</span>
          ${r.exists ? '' : '<span class="tag t-red" title="引用指向的对象已不存在">悬空</span>'}
        </div>`).join('')
    : '<div style="color:var(--txt-3);font-size:12px">无引用 —— 孤儿证据，应核实来源后归档或清理</div>')
    + `<div style="font-size:11px;color:var(--txt-3);margin-top:6px;line-height:1.7">
        一份证据可同时被案件、告警、授权记录引用。点编号可直达对应页面并选中该条。</div>`}

    ${U.sect('操作', `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <button class="btn pri" data-evact="download">${U.icon('download')} 下载</button>
      <button class="btn" data-evact="verify">${U.icon('check')} 立即校验</button>
    </div>
    <div style="margin-top:8px;font-size:11px;color:var(--txt-3);line-height:1.8">
      Demo 下载仅演示操作入口，不包含真实文件；正式环境须经审批并逐次记入调阅审计。</div>`)}`;
}

function paint() {
  document.getElementById('evList').innerHTML = list();
  document.getElementById('evDetail').innerHTML = detail();
}

function doDownload() {
  if (!st.sel) return;
  U.toast('已下载 ' + st.sel.name, 'ok');
}
function doVerify() {
  const f = st.sel;
  f.verifyAt = M.util.fmtDT(M.CONF.demoTime);
  document.getElementById('evDetail').innerHTML = detail();
  paint();
  U.toast(isBad(f)
    ? `已重新比对 ${f.id}：仍为「${f.verifyState}」。校验只比对不修复，须按处置流程人工闭环`
    : `已重新比对 ${f.id}：哈希与入库值一致，结果「完好」`, isBad(f) ? 'err' : 'ok');
}

onMounted(() => {
  const view = root.value;
  paint();
  U.on(view, '[data-row]', 'click', (e, el) => {
    st.sel = M.evidenceFiles.find(f => f.id === el.dataset.row) || st.sel;
    U.selectRow(document.getElementById('evList'), el.dataset.row);
    document.getElementById('evDetail').innerHTML = detail();      // 只刷详情，不重建列表
  });
  U.on(view, '[data-pg]', 'click', (e, el) => { if (el.dataset.pg) { st.page = +el.dataset.pg; paint(); } });
  U.on(view, '[data-size]', 'change', (e, el) => { st.size = parseInt(el.value); st.page = 1; paint(); });
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
    else U.toast('检索模块未加载，无法直达', 'err');
  });

  U.on(view, '[data-evact]', 'click', (e, el) => {
    if (el.disabled) return;
    const k = el.dataset.evact;
    if (k === 'download') return doDownload();
    if (k === 'verify') return doVerify();
  });

  document.getElementById('evKw').oninput = e => { st.kw = e.target.value.trim(); st.page = 1; paint(); };
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <!-- 操作引导（用户裁定 2026-08-30：多处补黄字引导）。主行 flex:1，自适应不需高度补偿 -->
      <div class="warnbox" style="margin:0 0 12px;padding:8px 11px;font-size:12px;flex:none">
        演示动线：用顶部筛选（<b>类型 / 完整性 / 保管状态 / 来源模块</b>）收敛台账 →
        点任一行，右侧查看证据详情、完整性校验与关联对象。</div>
      <div class="row" style="flex:1;min-height:0;padding-bottom:6px">
        <UPanel title="证据文件台账" panel-style="flex:1;min-width:0" nopad :body-html="ledgerBody" />
        <UPanel title="证据详情" panel-style="width:452px;flex:none" nopad
          body-html='<div id="evDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
      </div>
    </div>
  </div>
</template>
