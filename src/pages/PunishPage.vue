<script>
/* 模块级状态：跨导航保持（legacy 约定）。
   noticed / rvOutcome / rvCaseOps 有 sessionStorage 持久化；
   还原逻辑在 setup 模块作用域执行（legacy script 加载期已对共享 M.cases
   应用过一次，这里按同一份存储重放，结果幂等）。 */
const S = {
  /* 通知状态默认「待通知」（用户裁定 2026-08-30：把要处理的先选出来）；深链跳入的既有逻辑重置为全部 */
  st: { page: 1, size: 10, status: '待通知', region: '全部区域', vio: '全部类型', partner: '全部合作方', days: 30, sel: null, tab: 'case', rvFilter: '全部案件' }
};
export default {};
</script>

<script setup>
/* 处置处罚管理 —— 转换页（源：legacy pages/punish.js）。
   三条 U.regParams 仍由 legacy script 模块加载期登记，这里不重复。
   auth/review/pend 三个页签在上游已删除页签条、当前不可达，代码按 legacy
   原样保留（deep-state 途径仍可进入，行为一致）。    分页器（U.pager）本页暂保留：列表区在命令式 innerHTML 重刷区内（页签/整页字符串渲染），
   模板层 n-pagination 放不进去；待该区块结构化后随 P5 迁移。
*/
import { ref, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '../shell/usePageChrome.js';
import UKpis from '../ui/UKpis.vue';
import { toast } from '../ui/nv.js';
import { openModal, closeModal } from '../ui/modal.js';

const M = window.MOCK, U = window.UI, CH = window.CH, EVT = window.EVT;
usePageChrome('punish');
const root = ref(null);
const st = S.st;
let map = null;
onUnmounted(() => { if (map) map.destroy(); map = null; });

const NOTICE_KEY = 'punish.notice.v1';
let noticed = {};
try { noticed = JSON.parse(sessionStorage.getItem(NOTICE_KEY) || '{}') || {}; } catch (e) { noticed = {}; }
const noticeStatus = c => noticed[c.id] || (c.status === '已结案' ? '已通知' : '待通知');
function saveNotice() {
  try { sessionStorage.setItem(NOTICE_KEY, JSON.stringify(noticed)); } catch (e) { }
}

const RV_RESULTS = [
  { k: '维持原定性', desc: '复核后认为立案定性成立，案件按原流程继续', c: 't-green' },
  { k: '撤销案件', desc: '定性依据不成立，案件退回待核实重新走流程', c: 't-red' },
  { k: '补充证据后重判', desc: '证据要件不齐，退回已立案环节补证后重新判定', c: 't-amber' }
];
const RV_KEY = 'punish.review.v1';
let rvOutcome = {};
let rvCaseOps = {};
function rvSave() {
  try { sessionStorage.setItem(RV_KEY, JSON.stringify({ rvOutcome, rvCaseOps })); } catch (e) { }
}
(function rvRestore() {
  try {
    const v = JSON.parse(sessionStorage.getItem(RV_KEY) || 'null');
    if (!v) return;
    rvOutcome = v.rvOutcome || {}; rvCaseOps = v.rvCaseOps || {};
    Object.keys(rvCaseOps).forEach(id => {
      const c = M.cases.find(x => x.id === id); if (!c) return;
      const o = rvCaseOps[id];
      if (o.targetId && o.targetId !== c.targetId) { delete rvCaseOps[id]; return; }
      c.stage = o.stage; c.docReady = o.docReady;
      M.rebuildCaseSteps(c);
    });
    M.reviewRequests.forEach(r => { if (rvOutcome[r.id]) r.status = '已办结'; });
  } catch (e) { }
})();

const MY_MODULE = '处置处罚管理';
const mine = stp => stp.owner === MY_MODULE;

function judgeDiff(c) {
  const t = M.allTargets.find(x => x.id === c.targetId || x.target_id === c.targetId);
  const snap = c.filingSnapshot || {};
  if (!t) return { lost: true, snap, items: [] };
  const cur = {
    legal: t.legal_status || t.legal,
    vio: ((t.violation_reasons || []).join('、')) || t.violation || '',
    risk: t.risk_level || t.risk,
    conf: t.source_confidence
  };
  const sv = (snap.violation_reasons || []).join('、');
  const items = [];
  if (snap.legal_status !== cur.legal) items.push(['定性', snap.legal_status, cur.legal]);
  if (sv !== cur.vio) items.push(['违规事由', sv || '—', cur.vio || '—']);
  if (snap.risk_level !== cur.risk) items.push(['风险等级', snap.risk_level, cur.risk]);
  return { lost: false, snap, cur, items, legalChanged: snap.legal_status !== cur.legal };
}
const rvPending = () => M.reviewRequests.filter(r => r.status !== '已办结');
const rvMismatch = () => M.cases.filter(c => judgeDiff(c).items.length);

function rvAudit(action, target, by, result) {
  M.auditLogs.unshift({
    id: 'AU' + M.util.p3(M.auditLogs.length + 1), time: M.util.fmtDT(M.CONF.demoTime),
    user: by, role: '处置授权人', module: '处置处罚管理', action, target,
    result: result || '成功', ip: '10.20.5.15', term: '终端-01'
  });
}
const snapOf = c => c.filingSnapshot || {};

const SORT = { key: null, dir: 'asc' };
const SORT_KEYS = {
  id: c => c.id,
  targetId: c => c.targetId,
  model: c => (c.model === '未识别' ? '\uFFFF' : c.model) + c.partner,
  violation: c => c.violation || '',
  ts: c => c.ts,
  status: c => ['待通知', '已通知'].indexOf(noticeStatus(c)),
  penalty: c => ['警告', '驱离', '罚款'].indexOf(c.penalty),
  fine: c => c.penalty === '罚款' ? c.fine : -1
};
function sortTh(label, key) {
  const on = SORT.key === key;
  return `<span data-sort="${key}" title="点击排序" style="cursor:pointer;user-select:none;white-space:nowrap;
    border-bottom:1px dotted ${on ? '#8fbaff' : 'rgba(159,182,217,.45)'};${on ? 'color:#8fbaff' : ''}">${label}${on ? (SORT.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>`;
}
function sorted(rows) {
  const f = SORT.key && SORT_KEYS[SORT.key];
  if (!f) return rows;
  const d = SORT.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : 0) * d; });
}
function filtered() {
  const from = M.CONF.demoTime.getTime() - st.days * 864e5;
  return M.cases.filter(c =>
    c.ts >= from &&
    (st.status === '全部状态' || noticeStatus(c) === st.status) &&
    (st.region === '全部区域' || c.district === st.region) &&
    (st.vio === '全部类型' || c.violation === st.vio) &&
    (st.partner === '全部合作方' || c.partner === st.partner))
    /* 未结案排前面（用户裁定 2026-08-30：把要处理的先选出来）；filter 已给新数组，
       sort 不动 M.cases。同档内保持时间倒序。 */
    .sort((a, b) => ((a.status === '已结案') - (b.status === '已结案')) || b.ts - a.ts);
}

/* ---- 首屏（与 legacy render() 同构：深链消费 + KPI） ---- */
const ctx = U.consume('punish');
if (ctx && ctx.caseId) {
  const hit = M.cases.find(c => c.id === ctx.caseId);
  if (hit) {
    st.sel = hit;
    Object.assign(st, { status: '全部状态', region: '全部区域', vio: '全部类型', partner: '全部合作方', days: 30 });
    st.tab = 'case';
    const idx = sorted(filtered()).findIndex(c => c.id === hit.id);
    if (idx >= 0) st.page = Math.max(1, Math.ceil((idx + 1) / st.size));
  }
}
// safe-default: 默认选中项跟随当前筛选（待通知视图选首条待通知案件），用户可见可改
st.sel = st.sel || filtered()[0] || M.cases[0];
const all0 = M.cases;
const pendingNotice0 = all0.filter(c => noticeStatus(c) === '待通知').length;
const notified0 = all0.filter(c => noticeStatus(c) === '已通知').length;
const kpiList = [
  {
    label: '处罚案件总数', value: U.num(all0.length), color: 'blue', icon: 'gavel',
    desc: `待通知 ${pendingNotice0} 件 · 已通知 ${notified0} 件`
  },
  {
    label: '待通知案件', value: U.num(pendingNotice0), color: 'amber', icon: 'alert',
    desc: `等待通知处罚部门 · 占比 ${U.pct(pendingNotice0, all0.length)}`
  },
  {
    label: '已通知案件', value: U.num(notified0), color: 'green', icon: 'check',
    desc: `通知完成率 ${U.pct(notified0, all0.length)}`
  }
];

function tabCase() {
  return `<div class="row" style="height:100%;min-height:0;padding-bottom:6px">
    ${U.panel({
    title: '处罚案件管理', style: 'flex:6;min-width:0', nopad: true,
    body: `<div class="toolbar">
        ${U.field('时间', U.select('days', [{ v: 7, t: '近7天' }, { v: 30, t: '近30天' }], st.days))}
        ${U.field('区域', U.select('region', ['全部区域', ...M.DISTRICTS.map(d => d.name)], st.region))}
        ${U.field('违法类型', U.select('vio', ['全部类型', ...M.VIOLATIONS], st.vio))}
        ${U.field('合作方', U.select('partner', ['全部合作方', ...M.PARTNERS.map(p => p.name)], st.partner))}
        ${U.field('通知状态', U.select('status', ['全部状态', '待通知', '已通知'], st.status))}
        <button class="btn" id="pnR">重置筛选</button>
        <span style="flex:1"></span><button class="btn" id="pnExp">${U.icon('download')} 导出</button>
      </div>
      <div id="pnList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`
  })}
    ${U.panel({
    title: '案件详情', style: 'flex:4;min-width:0', nopad: true,
    extra: `<span id="pnSt"></span>`,
    body: `<div id="pnDetail" style="flex:1;overflow:auto;padding:12px"></div>`
  })}
  </div>`;
}

function tabAuth() {
  const A = M.authLogs;
  const jam = A.filter(a => a.type.includes('公安'));
  const estop = A.filter(a => a.estop !== '未触发');
  const eff = A.filter(a => a.result !== '无效');
  return `<div class="row" style="height:200px;margin-bottom:12px">
    ${U.panel({
    title: '授权概览', style: 'width:430px',
    body: U.kv([
      ['授权总次数', `<b class="mono" style="font-size:15px">${A.length}</b> 次`],
      ['公安信号干扰', `<b class="mono" style="color:#ff8b95">${jam.length}</b> 次（需公安审批文号）`],
      ['反制处置', `<b class="mono" style="color:#ffb083">${A.length - jam.length}</b> 次`],
      ['处置有效率', `<b class="mono" style="color:#79e5a5">${U.pct(eff.length, A.length)}</b>（迫降/返航/退出）`],
      ['触发急停', `<b class="mono" style="color:#ffd07a">${estop.length}</b> 次`],
      ['审计完整性', `<span class="tag t-green">100% 完整</span>`]
    ])
  })}
    ${U.panel({ title: '处置结果分布', style: 'flex:1', body: `<div id="pnAuthRes" style="height:100%"></div>` })}
    ${U.panel({ title: '授权类型与联动单位', style: 'flex:1.2', body: `<div id="pnAuthUnit" style="height:100%"></div>` })}
  </div>
  ${U.panel({
    title: '反制与公安信号干扰授权记录', sub: '全过程审计（§11.1）· 不可修改、不可删除',
    style: 'height:calc(100vh - 482px);min-height:410px;margin-bottom:12px', nopad: true,
    extra: `<button class="btn" id="pnAuthExp">${U.icon('download')} 导出审计</button>
      <button class="btn danger" id="pnJam">发起公安授权信号干扰</button>`,
    body: `<div id="pnAuth" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`
  })}`;
}

function tabReview() {
  const pend = rvPending(), all = M.reviewRequests;
  const closedCase = pend.filter(r => r.caseStatus === '已结案').length;
  const mm = rvMismatch();
  const gate = M.evidenceGateLog || [];
  const gateFiled = gate.filter(x => M.cases.some(c => c.targetId === x.targetId)).length;
  return `<div class="row" style="height:200px;margin-bottom:12px">
    ${U.panel({
    title: '复核概览', style: 'width:420px',
    body: U.kv([
      ['待复核请求', `<b class="mono" style="font-size:15px;color:${pend.length ? '#ff8b95' : '#79e5a5'}">${pend.length}</b> 条`
        + (all.length ? `<span style="color:var(--txt-3)">（累计 ${all.length} 条）</span>` : '')],
      ['其中已结案案件', `<b class="mono" style="color:${closedCase ? '#ff8b95' : 'var(--txt-2)'}">${closedCase}</b> 件`
        + (closedCase ? '　<span class="tag t-red">须走 §11 复核流程</span>' : '')],
      ['已办结复核', `<b class="mono">${Object.keys(rvOutcome).length}</b> 条`],
      ['立案判定一致性', mm.length
        ? `<span class="tag t-red">${mm.length} / ${M.cases.length} 件不一致</span>`
        : `<span class="tag t-green">${M.cases.length} 件全部一致</span>`],
      ['证据门禁降级', `<b class="mono">${gate.length}</b> 个目标（其中已立案 <b class="mono">${gateFiled}</b> 个）`]
    ])
  })}
    ${U.panel({
    title: '定性依据复核队列',
    sub: `设计 §11 · 受理 → 比对立案与当前判定 → 出具结论 → 真实改案件状态并写审计`,
    style: 'flex:1', nopad: true,
    body: `<div id="pnRvList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`
  })}
  </div>
  ${U.panel({
    title: '立案判定一致性核查', sub: `覆盖全部 ${M.cases.length} 件案件 · 已立案案件是历史事实，快照不因后续重新判定而消失`,
    style: 'height:calc(100vh - 482px);min-height:410px;margin-bottom:12px', nopad: true,
    extra: U.select('rvf', ['全部案件', '仅看不一致', '仅已结案'], st.rvFilter),
    body: `<div id="pnRvChk" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`
  })}`;
}

function rvList() {
  const rows = M.reviewRequests;
  if (!rows.length) {
    const gate = M.evidenceGateLog || [];
    const noCase = gate.filter(x => !M.cases.some(c => c.targetId === x.targetId));
    return `<div style="padding:22px 20px;color:var(--txt-2);font-size:12.5px;line-height:1.95">
      <div style="font-size:14px;color:var(--txt);margin-bottom:8px">当前无待复核请求</div>
      复核请求由证据充分性门禁产生，且<b>仅当被降级的目标已立案</b>时才需要复核 ——
      未立案的目标由判定页直接改判即可，不涉及案件状态，也就不需要走 §11。<br>
      当前证据门禁共降级 <b class="mono">${gate.length}</b> 个目标，其中 <b class="mono">${noCase.length}</b> 个未关联案件：
      <div style="margin-top:8px">${gate.length ? gate.map(x => `<div style="padding:6px 9px;border:1px solid var(--line-2);border-radius:5px;margin-bottom:6px">
          <span class="mono">${x.targetId}</span>　${U.legal(x.from)} <span style="color:var(--txt-3)">→</span> ${U.legal('待确认')}
          ${M.cases.some(c => c.targetId === x.targetId) ? U.tag('已立案', 't-red') : U.tag('未立案 · 无需复核', 't-gray')}
          <div style="color:var(--txt-3);font-size:11.5px;margin-top:3px;white-space:normal">${x.reasons.join('；')}</div>
        </div>`).join('') : '<span style="color:var(--txt-3)">门禁未降级任何目标</span>'}</div>
      <div style="color:var(--txt-3);margin-top:6px">一旦出现「已立案后被降级」的目标，请求会自动进入本队列，本页无需改动。</div>
    </div>`;
  }
  return U.table([
    { t: '请求编号', w: '76px', cls: 'num', render: r => r.id },
    { t: '提出时间', w: '92px', cls: 'num', render: r => `<div>${r.at.slice(0, 10)}</div><div>${r.at.slice(11)}</div>` },
    {
      t: '目标 / 案件', w: '140px', render: r => `<div class="mono" style="font-size:11.5px">${r.targetId}</div>
        <div class="mono" style="font-size:11.5px;color:var(--txt-3)">${r.caseId}</div>${U.tag(r.caseStatus)}`
    },
    { t: '拟改判', w: '128px', render: r => `${U.legal(r.from)} <span style="color:var(--txt-3)">→</span> ${U.legal(r.to)}` },
    { t: '降级理由', render: r => `<div style="white-space:normal;font-size:11.5px">${r.reason}</div>
        <div style="white-space:normal;font-size:11px;color:var(--txt-3);margin-top:2px">${r.raisedBy}</div>` },
    {
      t: '状态 / 结论', w: '132px', render: r => {
        const o = rvOutcome[r.id];
        return U.tag(r.status, r.status === '已办结' ? 't-green' : 't-amber') +
          (o ? `<div style="white-space:normal;font-size:11px;color:var(--txt-3);margin-top:3px">
            ${(RV_RESULTS.find(x => x.k === o.result) || {}).k || o.result}<br>${o.by} · ${o.at.slice(5, 16)}</div>` : '');
      }
    },
    { t: '操作', w: '58px', align: 'center', render: r => `<span class="lnk" data-rv="${r.id}">${rvOutcome[r.id] ? '查看' : '受理'}</span>` }
  ], rows, { rowId: r => r.id });
}

function rvCheck() {
  let rows = M.cases;
  if (st.rvFilter === '仅看不一致') rows = rvMismatch();
  else if (st.rvFilter === '仅已结案') rows = rows.filter(c => c.status === '已结案');
  const mm = rvMismatch();
  const head = `<div style="padding:7px 12px;font-size:12px;border-bottom:1px solid var(--line-2);
      background:${mm.length ? 'rgba(255,77,94,.08)' : 'rgba(47,208,110,.07)'};white-space:normal">
    ${mm.length
      ? `<b style="color:#ff96a0">${mm.length} 件</b>案件的立案快照与当前判定不一致，需按 §11 复核`
      : `<b style="color:#79e5a5">全部 ${M.cases.length} 件</b>案件的立案快照与当前判定一致，暂无需复核`}
    <span style="color:var(--txt-3)">　· 差异只认「定性 / 违规事由 / 风险等级」三项；置信度随融合权重调整而变（F0210），不计为定性差异</span>
  </div>`;
  return head + U.table([
    { t: '案件编号', w: '118px', cls: 'num', render: c => c.id },
    { t: '状态', w: '74px', render: c => U.tag(c.status) },
    {
      t: '立案时判定', w: '150px', render: c => {
        const d = judgeDiff(c), s2 = d.snap;
        return `<div>${U.legal(s2.legal_status)} ${(s2.violation_reasons || []).join('、')}</div>
          <div style="font-size:11px;color:var(--txt-3);white-space:normal">${s2.risk_level} · 置信 ${U.confPct(s2.confidence)} · ${(s2.at || '').slice(5, 16)}</div>`;
      }
    },
    {
      t: '当前判定', w: '150px', render: c => {
        const d = judgeDiff(c);
        if (d.lost) return `<span class="tag t-purple">目标已合并/分裂</span>`;
        return `<div>${U.legal(d.cur.legal)} ${d.cur.vio}</div>
          <div style="font-size:11px;color:var(--txt-3);white-space:normal">${d.cur.risk} · 置信 ${U.confPct(d.cur.conf)}</div>`;
      }
    },
    {
      t: '差异', render: c => {
        const d = judgeDiff(c);
        if (d.lost) return `<span style="font-size:11.5px;color:var(--txt-3);white-space:normal">目标 ID 发生过变更，见案件详情的 ID 变更回溯</span>`;
        return d.items.length
          ? `<div style="white-space:normal">${d.items.map(x => `${U.tag(x[0], 't-red')} <span style="font-size:11.5px">${x[1]} → <b>${x[2]}</b></span>`).join('<br>')}</div>`
          : '<span class="tag t-green">一致</span>';
      }
    }
  ], rows, { rowId: c => c.id, activeId: st.sel && st.sel.id });
}

let _tgt = null;
function tgtOf(id) {
  if (!_tgt) { _tgt = new Map(); M.allTargets.forEach(t => { _tgt.set(t.id, t); if (t.target_id) _tgt.set(t.target_id, t); }); }
  return _tgt.get(id);
}
function pendStat() {
  const D = M.illegalDisposition;
  const PS = M.pendingSubjects || [];
  const by = {};
  PS.forEach(p => { by[p.blockedBy] = (by[p.blockedBy] || 0) + 1; });
  if (D) return {
    illegal: D.illegalNow, filed: D.caseTotal, filedIllegal: D.filed,
    revised: D.downgraded, revisedCases: D.downgradedCases || [], pend: D.pending, by
  };
  return { illegal: NaN, filed: M.cases.length, filedIllegal: NaN, revised: NaN, revisedCases: [], pend: PS.length, by, fallback: true };
}

function tabPend() {
  const S2 = pendStat();
  return `<div class="warnbox" style="margin-bottom:12px;border-color:rgba(255,176,32,.5);line-height:1.85">
      <b>本页签的 ${(M.pendingSubjects || []).length} 条不是案件，也没有发起任何处罚处置。</b>
      它们是<b>案源</b> —— 违法事实成立、但尚不具备立案条件的目标（编号 <span class="mono">PS…</span>，
      与案件编号 <span class="mono">CF…</span> 不同一序列）。<br>
      本屏<b>不提供立案入口</b>，也不产生文书、罚款与处置流程；这些只存在于「处罚案件管理」页签的
      <b>${M.cases.length}</b> 件案件里。补齐认定路径后，由数据层重新派生为案件，届时才会出现在那一侧。
    </div>
    <div class="row" style="height:200px;margin-bottom:12px">
    ${U.panel({
    title: '违法目标去向', sub: '口径实时派生',
    style: 'width:430px',
    body: U.kv([
      ['当前判定非法', `<b class="mono" style="font-size:15px">${S2.illegal}</b> 个目标`],
      ['├ 已立案', `<b class="mono" style="color:#79e5a5">${S2.filedIllegal}</b> 件`],
      ['├ 待办案源', `<b class="mono" style="color:#ffd07a">${S2.pend}</b> 条（${Object.entries(S2.by).map(x => x[0] + ' ' + x[1]).join(' · ')}）`],
      ['└ 合计核对', S2.filedIllegal + S2.pend === S2.illegal
        ? `<span class="tag t-green inline-icon">${S2.filedIllegal} + ${S2.pend} = ${S2.illegal} ${U.icon('check')}</span>`
        : `<span class="tag t-red">${S2.filedIllegal} + ${S2.pend} ≠ ${S2.illegal}</span>`],
      ['另计', S2.revised
        ? `<b class="mono">${S2.revised}</b> 件已立案案件的目标经事实修订降级为「待确认」，已进入 §11 复核
           <div style="font-size:11px;color:var(--txt-3);white-space:normal">
             ${(S2.revisedCases || []).map(x => `${x.id}（${x.status}）立案为 ${x.filedAs} → 现 ${x.nowIs}`).join('；')}
             <br>立案是历史事实，不因今天重新判定而消失，故不计入当前非法目标</div>`
        : '—']
    ])
  })}
    ${U.panel({
    title: '为什么这些目标不立案', sub: '闸门在责任主体，不在机型', style: 'flex:1',
    body: `<div class="warnbox" style="margin-bottom:8px;line-height:1.75">
        能把一个目标绑定到具体人或单位的只有四条路：<b>计划报备匹配 / 实名 SN / 遥控源定位 / 协议破解·RemoteID</b>。
        一条都没有时<b>不得具名</b> —— 处罚决定书是对着当事人开的，主体认错了，整份文书就是错的。
        机型未识别不作为闸门：它只影响文书里的描述项与罚则分级，不影响违法事实成立。</div>
      <div style="font-size:12.5px;color:var(--txt-2);line-height:1.95">
        本屏<b>不提供立案入口</b> —— 条件不满足时没有入口，这本身就是闸门。
        补齐任一条认定路径（调证 / 现场查获 / 布控）后，由数据层重新派生为案件。<br>
        <span style="color:var(--txt-3)">「证据待补强」是另一类：主体可认定，但证据要件不足以支撑定性，需补证后再判。</span>
      </div>`
  })}
  </div>
  ${U.panel({
    title: '待办案源（未立案，非案件）', sub: `${(M.pendingSubjects || []).length} 条 · 违法事实成立但尚不具备立案条件`,
    style: 'height:calc(100vh - 482px);min-height:410px;margin-bottom:12px', nopad: true,
    extra: `<button class="btn" id="pnPendExp">${U.icon('download')} 导出待办清单</button>`,
    body: `<div id="pnPendList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`
  })}`;
}

function pendList() {
  const PS = M.pendingSubjects || [];
  if (!PS.length) return `<div class="empty">当前没有待办案源：全部违法目标均已具备立案条件</div>`;
  return U.table([
    {
      t: '案源编号', w: '96px', cls: 'num',
      render: p => `<span title="案源编号（PS 序列），不是案件编号（CF 序列）">${p.id}</span>`
    },
    { t: '时间', w: '92px', cls: 'num', render: p => `<div>${p.date}</div><div>${(p.time || '').slice(11)}</div>` },
    {
      t: '目标 / 区域', w: '138px', render: p => `<div class="mono" style="font-size:11.5px">${p.targetId}</div>
        <div style="font-size:11px;color:var(--txt-3)">${p.district}</div>`
    },
    { t: '违法类型', w: '100px', render: p => U.tag(p.violation, 't-orange') },
    { t: '机型', w: '146px', render: p => U.modelTag(p.model, p.modelSource, true) },
    {
      t: '来源 / 置信', w: '100px', render: p => `<div>${p.source}</div>
        <div style="font-size:11px;color:var(--txt-3)">${U.confPct(p.source_confidence)} · ${p.track_status}</div>`
    },
    { t: '阻断原因', w: '104px', render: p => U.tag(p.blockedBy, p.blockedBy === '责任主体待认定' ? 't-red' : 't-amber') },
    {
      t: '缺什么', w: '230px', render: p => `<div style="white-space:normal;font-size:11.5px">
        ${(p.missing || []).map(x => '· ' + x).join('<br>')}</div>`
    },
    { t: '下一步', render: p => `<div style="white-space:normal;font-size:11.5px;color:#ffd07a">${p.nextStep}</div>` },
    { t: '', w: '46px', align: 'center', render: p => `<span class="lnk" data-ps="${p.id}">详情</span>` }
  ], PS, { rowId: p => p.id });
}

function pendModal(p) {
  if (!p) return;
  const t = tgtOf(p.targetId);
  openModal({
    title: '待办案源 · ' + p.id, width: '720px',
    body: `<div class="warnbox">本条<b>不是案件</b>：违法事实成立，但${p.blockedBy === '责任主体待认定'
      ? '责任主体没有任何认定路径，依法不得具名当事人' : '证据要件不足以支撑定性'}，
      因此未进入处罚流程，也没有处罚文书与罚款。</div>
      ${U.kv([
      ['目标编号', `<span class="mono">${p.targetId}</span>`],
      ['发生时间 / 区域', p.time + ' · ' + p.district],
      ['违法事实', (p.violation_reasons || [p.violation]).map(x => U.tag(x, 't-orange')).join(' ')],
      ['机型', U.modelTag(p.model, p.modelSource)],
      ['感知来源', `${p.source} · 置信度 ${U.confPct(p.source_confidence)} · 轨迹${p.track_status}`],
      ['主体认定路径', p.subjectSource
        ? `<span class="tag t-cyan">${p.subjectSource}</span>`
        : `<span class="tag t-red">无</span> <span style="color:var(--txt-3)">四条路径均未命中</span>`],
      ['阻断原因', U.tag(p.blockedBy, p.blockedBy === '责任主体待认定' ? 't-red' : 't-amber')]
    ])}
      ${U.sect('认定缺口', `<div style="font-size:12.5px;line-height:2">
        ${(p.missing || []).map(x => `<div class="inline-icon">${U.icon('cross')} ${x}</div>`).join('')}</div>`)}
      ${U.sect('下一步', `<div style="font-size:12.5px;color:#ffd07a">${p.nextStep}</div>
        <div style="font-size:11.5px;color:var(--txt-3);margin-top:6px;white-space:normal">
          补齐任一条认定路径后由数据层重新派生为案件；本页不提供直接立案入口 —— 条件不满足时没有入口，这本身就是闸门。</div>`)}
      ${t ? U.sect('目标当前判定', U.kv([['定性', U.legal(t.legal_status || t.legal)],
      ['风险等级', U.tag(t.risk_level || t.risk)],
      ['来源可信度', U.confPct(t.source_confidence)]])) : ''}`,
    footer: `<button class="btn" data-close>关闭</button>`
  });
}

function list() {
  const rows = sorted(filtered());
  const page = rows.slice((st.page - 1) * st.size, st.page * st.size);
  return U.table([
    { t: sortTh('案件编号', 'id'), k: 'id', w: '134px', cls: 'num' },
    {
      t: sortTh('目标编号', 'targetId'), w: '106px', cls: 'num',
      render: c => `<span title="${c.targetId}" style="font-size:11.5px">${c.targetId}</span>`
    },
    {
      t: sortTh('机型 / 主体', 'model'), w: '128px',
      render: c => `<div style="white-space:normal;line-height:1.4">${U.modelTag(snapOf(c).model || c.model, snapOf(c).model_source, true)}</div>
        <div title="${(snapOf(c).subject || c.partner) + ' · ' + c.pilot}" style="font-size:11px;color:var(--txt-3);
          white-space:normal;line-height:1.4;max-height:31px;overflow:hidden;display:-webkit-box;
          -webkit-line-clamp:2;-webkit-box-orient:vertical">${snapOf(c).subject || c.partner} · ${c.pilot}</div>`
    },
    {
      t: sortTh('违法类型', 'violation'), w: '84px',
      render: c => `<div style="white-space:normal;line-height:1.5"><span class="tag t-orange"
        style="white-space:normal;display:inline">${c.violation}</span></div>`
    },
    { t: sortTh('发生时间 / 区域', 'ts'), w: '128px', render: c => `<div class="mono" style="font-size:11.5px">${c.time.slice(5, 16)}</div><div style="font-size:11px;color:var(--txt-3)">${c.district}</div>` },
    { t: sortTh('通知状态', 'status'), w: '86px', render: c =>
      U.tag(noticeStatus(c), noticeStatus(c) === '待通知' ? 't-amber' : 't-green') },
  ], page, { rowId: c => c.id, activeId: st.sel && st.sel.id })
    + U.pager({ total: rows.length, page: st.page, size: st.size });
}

function noticeDetail() {
  const c = st.sel;
  if (!c) return '<div class="empty">请选择案件</div>';
  const nStatus = noticeStatus(c);
  const t = M.allTargets.find(x => x.id === c.targetId) || {};
  const auth = M.authLogs.find(a => a.caseId === c.id);
  const caseNo = M.cases.findIndex(x => x.id === c.id) + 1;
  const authNo = auth ? auth.id
    : `AUTH${String(c.date || '').slice(0, 7).replace(/-/g, '')}${M.util.p3(caseNo)}`;
  const device = (M.devices.find(d => d.region === c.district) || {}).name || '东营区雷达03号';
  const fs2 = M.evidenceOf ? M.evidenceOf('case', c.id) : [];
  const ICON = { '光电录像': 'video', '光电抓拍图': 'camera', '雷达轨迹快照': 'trend', '现场照片': 'image',
    '处罚文书': 'file', '指令报文与回执': 'receipt', '通报单回执': 'mail', '调测报告': 'tool' };
  const evidence = !fs2.length
    ? '<div class="warnbox" style="border-color:rgba(255,77,94,.45)">本案在证据台账中无关联材料，事实认定缺少可溯源证据。</div>'
    : `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px">
        ${fs2.slice(0, 8).map(f => `<div style="height:54px;border:1px solid var(--line);
          border-radius:4px;background:linear-gradient(135deg,rgba(61,139,255,.22),rgba(4,12,32,.9));
          display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;cursor:pointer"
          data-ev="${f.id}" title="${f.name}　${f.sizeMB.toFixed(1)}MB">
          <span style="font-size:14px">${U.icon(ICON[f.kind] || 'folder')}</span>
          <span style="font-size:10px;color:var(--txt-2)">${f.kind}</span>
        </div>`).join('')}
      </div>
      ${fs2.length > 8 ? `<div style="font-size:11px;color:var(--txt-3);margin-bottom:6px">另有 ${fs2.length - 8} 份，点任一份可进证据台账查看全部</div>` : ''}
      <div id="pnTrack" style="height:130px;border:1px solid var(--line-2);border-radius:6px"></div>`;

  document.getElementById('pnSt').innerHTML =
    U.tag(nStatus, nStatus === '待通知' ? 't-amber' : 't-green');
  return `${U.detailHero({
    icon: 'gavel', subtitle: '处置处罚案件', title: snapOf(c).model || c.model || t.subtype || '低空安全案件', id: c.id,
    tags: [U.tag(nStatus, nStatus === '待通知' ? 't-amber' : 't-green'), t.legal ? U.legal(t.legal) : ''],
    meta: [['目标', c.targetId], ['区域', c.district]]
  })}
    ${U.metricStrip([
      { label: '通知状态', value: nStatus, tone: nStatus === '待通知' ? 'warn' : 'good', icon: 'bell' },
      { label: '违法类型', value: c.violation, tone: 'bad', icon: 'alert' },
      { label: '证据数量', value: fs2.length, unit: '项', tone: fs2.length ? 'good' : 'bad', icon: 'folder' },
      { label: '处置结果', value: auth ? auth.result : '待执行', tone: auth && auth.result !== '无效' ? 'good' : 'warn', icon: 'shield' }
    ], { compact: true })}
    ${U.sect('违法事实', U.kv([
      ['目标编号', `<span class="mono lnk" data-goto="target">${c.targetId}</span>`],
      ['违法类型', U.tag(c.violation, 't-orange')],
      ['发生时间', c.time], ['发生区域', c.district],
      ['飞行高度', (t.alt || '—') + ' m'], ['飞行速度', (t.speed || '—') + ' m/s'],
      ['机型', U.modelTag(snapOf(c).model || c.model, snapOf(c).model_source)],
      ['责任主体', snapOf(c).subject || c.partner],
      ['认定依据', snapOf(c).basis || '空域规则 C02 + 计划匹配 C01']
    ], { surface: true, density: 'compact' }), { icon: 'alert' })}
    ${U.sect(`证据链（${fs2.length} 项）`, evidence, { icon: 'folder' })}
    ${U.sect('关联设备与处置', U.kv([
      ['遥控器 SN', `<span class="mono">${c.rcSn}</span>`],
      ['发现设备', device],
      ['处置方式', '已发起反制'],
      ['授权编号', `<span class="mono">${authNo}</span>`],
      ['执行结果', '返航']
    ], { surface: true, density: 'compact' }), { icon: 'device' })}
    ${nStatus === '待通知' ? U.detailActions(`<button class="btn pri" data-notify="${c.id}">通知处罚部门</button>`) : ''}`;
}

function paintDetail() {
  document.getElementById('pnDetail').innerHTML = noticeDetail();
  drawTrack();
}
function drawTrack() {
  const box = document.getElementById('pnTrack');
  if (box) {
    if (map) map.destroy();
    const t = M.allTargets.find(x => x.id === st.sel.targetId);
    map = new window.MapView(box, { zoom: 2.6, layers: { device: false, alarm: false }, legend: false });
    map.setData({
      airspaces: M.airspaces, devices: [], alarms: [],
      targets: t ? [Object.assign({}, t, {
        tracked: true,
        track: Array.from({ length: 18 }, (_, i) => ({ lon: t.lon - .06 + i * .007, lat: t.lat - .05 + i * .006, alt: t.alt }))
      })] : []
    });
    const t2 = t || { lon: 118.6, lat: 37.45 };
    setTimeout(() => { if (map) map.centerAt(t2.lon, t2.lat); }, 30);
  }
}
function paint() {
  document.getElementById('pnList').innerHTML = list();
  paintDetail();
}
function paintReview() {
  const a = document.getElementById('pnRvList'), b = document.getElementById('pnRvChk');
  if (a) a.innerHTML = rvList();
  if (b) b.innerHTML = rvCheck();
  const badge = document.querySelector('[data-pt="review"] .tag');
  if (badge) { badge.textContent = rvPending().length; badge.className = 'tag ' + (rvPending().length ? 't-red' : 't-gray'); }
}

function paintTab() {
  const body = document.getElementById('pnBody');
  CH.disposeAll();
  if (map) { map.destroy(); map = null; }
  if (st.tab === 'case') {
    body.innerHTML = tabCase();
    paint();
    requestAnimationFrame(() => { if (st.tab === 'case') paintCaseCharts(); });
  } else if (st.tab === 'review') {
    body.innerHTML = tabReview();
    paintReview();
  } else if (st.tab === 'pend') {
    body.innerHTML = tabPend();
    document.getElementById('pnPendList').innerHTML = pendList();
    const ex = document.getElementById('pnPendExp');
    if (ex) ex.onclick = () => toast('已导出「待办案源清单.xlsx」共 ' + (M.pendingSubjects || []).length + ' 条（含认定缺口与下一步）', 'ok');
  } else {
    body.innerHTML = tabAuth();
    document.getElementById('pnAuth').innerHTML = authTable();
    requestAnimationFrame(() => { if (st.tab === 'auth') paintAuthCharts(); });
  }
  const jam = document.getElementById('pnJam');
  if (jam) jam.onclick = jamModal;
}

function paintCaseCharts() {
  if (document.getElementById('pnType')) {
    CH.hbar(document.getElementById('pnType'), {
      y: M.stats.byViolation.map(v => v.name), data: M.stats.byViolation.map(v => v.value)
    });
    const d = M.stats.days;
    CH.line(document.getElementById('pnTrend'), {
      x: d.map(x => x.md), yName: '案件数', y2: '金额(元)',
      series: [{ name: '案件数量', data: d.map(x => x.punish), color: CH.C.blue, area: true },
      { name: '罚款金额', data: d.map(x => x.punish * 4200), color: CH.C.red, yAxisIndex: 1 }]
    });
  }
}

function paintAuthCharts() {
  {
    const A = M.authLogs;
    const RC = { '迫降': '#2fd06e', '返航': '#3d8bff', '退出管制区': '#ffb020', '无效': '#ff4d5e' };
    const rc = M.util.groupCount(A, a => a.result);
    CH.donut(document.getElementById('pnAuthRes'), {
      data: [...rc.entries()].map(([n, v]) => ({ name: n, value: v, c: RC[n] })), center: ['32%', '50%']
    });
    const uc = M.util.groupCount(A, a => a.unit);
    const top = [...uc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    CH.hbar(document.getElementById('pnAuthUnit'), {
      y: top.map(t => t[0].replace('东营市', '')), data: top.map(t => t[1]),
      colors: top.map(t => t[0].includes('公安') ? '#ff4d5e' : '#a97bff')
    });
    const exp = document.getElementById('pnAuthExp');
    if (exp) exp.onclick = () => toast('已导出「反制与干扰授权审计.csv」共 ' + A.length + ' 条；导出行为本身已记入审计', 'ok');
  }
}

function authTable() {
  return U.table([
    { t: '授权编号', k: 'id', w: '140px', cls: 'num' },
    { t: '类型', w: '132px', render: a => U.tag(a.type, a.type.includes('公安') ? 't-red' : 't-orange') },
    { t: '目标', k: 'targetId', w: '128px', cls: 'num' },
    { t: '联动单位', w: '150px', render: a => a.unit.replace('东营市', '') },
    { t: '审批 / 操作人', w: '116px', render: a => `${a.approver} <span style="color:var(--txt-3)">/ ${a.operator}</span>` },
    { t: '设备', k: 'device', w: '112px' },
    { t: '频段 / 作用范围', w: '196px', render: a => { const nt = M.bandNote(a); return `<div style="font-size:11.5px">${
      a.band ? a.band + (a.gnssJam ? ` <b style="color:var(--red)">含卫星导航</b>` : '')
             : `<span style="color:${nt.pending ? 'var(--orange)' : 'var(--txt-3)'}">${nt.txt}</span>`
    }</div><div style="font-size:11px;color:var(--txt-3)">${a.range}</div>`; } },
    { t: '时长', w: '58px', align: 'right', cls: 'num', render: a => a.durationS + 's' },
    { t: '开始时间', k: 'start', w: '142px', cls: 'num' },
    { t: '执行结果', w: '88px', render: a => U.tag(a.result, a.result === '无效' ? 't-red' : 't-green') },
    {
      t: '回执 / 急停 / 审计', w: '168px', render: a => `${U.tag(a.ack, 't-green')}
        ${U.tag(a.estop === '未触发' ? '无急停' : '急停', a.estop === '未触发' ? 't-gray' : 't-red')}
        ${U.tag(a.audit, 't-green')}`
    }
  ], M.authLogs, { rowId: a => a.id });
}

/* ---- 弹窗族（与 legacy 同构） ---- */
function cmpBlock(c) {
  const d = judgeDiff(c), s2 = d.snap;
  if (d.lost) return `<div class="warnbox">本案引用的目标 <span class="mono">${c.targetId}</span> 已发生合并/分裂，
    当前判定需按 ID 变更回溯还原（见案件详情「目标 ID 变更回溯」）。立案快照仍完整保留：
    ${U.legal(s2.legal_status)} ${(s2.violation_reasons || []).join('、')} · ${s2.risk_level} · ${s2.at}</div>`;
  const row = (lb, a, b, diff) => `<tr>
    <td style="width:88px;color:var(--txt-3)">${lb}</td>
    <td style="width:44%">${a}</td>
    <td style="width:44%">${diff ? `<b style="color:#ffd07a">${b}</b>` : b}</td></tr>`;
  const isDiff = k => d.items.some(x => x[0] === k);
  return `<div style="display:flex;gap:8px;margin-bottom:6px;font-size:12px;color:var(--txt-3)">
      <span style="width:88px"></span><span style="width:44%">立案时判定（${(s2.at || '').slice(5, 16)}）</span>
      <span style="width:44%">当前判定</span></div>
    <table class="tb" style="font-size:12.5px"><tbody>
      ${row('定性', U.legal(s2.legal_status), U.legal(d.cur.legal), isDiff('定性'))}
      ${row('违规事由', (s2.violation_reasons || []).join('、') || '—', d.cur.vio || '—', isDiff('违规事由'))}
      ${row('风险等级', U.tag(s2.risk_level), U.tag(d.cur.risk), isDiff('风险等级'))}
      ${row('置信度', U.confPct(s2.confidence), U.confPct(d.cur.conf), false)}
      ${row('来源', s2.source_type || '—', '—', false)}
    </tbody></table>
    <div style="margin-top:8px;font-size:12px;color:var(--txt-2);white-space:normal">
      <b>立案依据：</b>${s2.basis || '—'}</div>
    <div style="margin-top:6px">${d.items.length
      ? `<span class="tag t-red">${d.items.length} 项差异</span>
         <span style="font-size:11.5px;color:var(--txt-3)">${d.items.map(x => x[0]).join('、')}发生变化，须按 §11 复核后才能改动案件状态</span>`
      : `<span class="tag t-green">立案快照与当前判定一致</span>
         <span style="font-size:11.5px;color:var(--txt-3)">已立案案件是历史事实，即使后续重新判定，快照也不会被覆盖</span>`}</div>`;
}

function snapModal(c) {
  if (!c) return;
  const rr = M.reviewRequests.find(r => r.caseId === c.id);
  openModal({
    title: '立案判定核查 · ' + c.id, width: '680px',
    body: `${U.kv([['案件状态', U.tag(c.status)], ['目标编号', `<span class="mono">${c.targetId}</span>`],
    ['违法类型', U.tag(c.violation, 't-orange')], ['发生时间', c.time]])}
      <div style="margin-top:12px">${cmpBlock(c)}</div>
      ${rvOutcome[rr && rr.id] ? outcomeBox(rvOutcome[rr.id]) : ''}`,
    footer: `<button class="btn" data-close>关闭</button>
      ${rr && !rvOutcome[rr.id] ? `<button class="btn pri" data-act="rv">受理复核</button>` : ''}`,
    on: { rv: () => reviewModal(rr) }
  });
}

function outcomeBox(o) {
  const meta = RV_RESULTS.find(x => x.k === o.result) || {};
  return `<div style="margin-top:12px;padding:9px 11px;border:1px solid var(--line-2);border-radius:6px;
      background:rgba(61,139,255,.06)">
    <div style="margin-bottom:5px">复核结论：${U.tag(o.result, meta.c || 't-gray')}
      <span style="color:var(--txt-3);font-size:11.5px">${o.by} · ${o.at}
      ${o.approvalNo ? ' · §11 复核审批文号 ' + o.approvalNo : ''}</span></div>
    <div style="font-size:12px;color:var(--txt-2);white-space:normal">${o.opinion}</div>
  </div>`;
}

function reviewModal(r) {
  if (!r) return;
  const c = M.cases.find(x => x.id === r.caseId);
  const done = rvOutcome[r.id];
  const closed = c && c.status === '已结案';
  if (done) {
    return openModal({
      title: '复核记录 · ' + r.id, width: '680px',
      body: `${U.kv([['关联案件', `<span class="mono">${r.caseId}</span> ${U.tag(c ? c.status : r.caseStatus)}`],
      ['目标编号', `<span class="mono">${r.targetId}</span>`],
      ['拟改判', `${U.legal(r.from)} → ${U.legal(r.to)}`],
      ['降级理由', `<div style="white-space:normal">${r.reason}</div>`]])}
        ${outcomeBox(done)}
        <div style="margin-top:12px">${c ? cmpBlock(c) : ''}</div>`,
      footer: `<button class="btn" data-close>关闭</button>`
    });
  }
  const reviewers = M.users.filter(u => u.roleName === '处置授权人' || u.roleName === '超级管理员');
  openModal({
    title: '定性依据复核 · ' + r.id, width: '720px',
    body: `${closed ? `<div class="warnbox" style="border-color:rgba(255,77,94,.45);background:rgba(255,77,94,.10)">
        <b>本案已结案。</b>已结案案件不允许直接改动状态 —— 依设计 §11，须先取得<b>复核审批文号</b>方可作出
        「撤销案件」或「补充证据后重判」的结论；仅出具「维持原定性」意见时不改动案件状态，可直接提交。</div>`
      : `<div class="warnbox">本案在办（${c ? c.status : r.caseStatus}），复核结论将<b>真实改动案件状态与流程环节</b>，并记入平台操作审计。</div>`}
      ${U.kv([['关联案件', `<span class="mono">${r.caseId}</span> ${U.tag(c ? c.status : r.caseStatus)}`],
      ['目标编号', `<span class="mono">${r.targetId}</span>`],
      ['拟改判', `${U.legal(r.from)} <span style="color:var(--txt-3)">→</span> ${U.legal(r.to)}`],
      ['提出方', r.raisedBy], ['提出时间', r.at],
      ['降级理由', `<div style="white-space:normal">${r.reason}</div>`],
      ['数据层备注', `<div style="white-space:normal;color:var(--txt-3)">${r.note}</div>`]])}
      ${U.sect('立案时判定 vs 当前判定', c ? cmpBlock(c) : '<span style="color:var(--txt-3)">未找到关联案件</span>')}
      ${U.sect('复核结论', `<div style="display:flex;flex-direction:column;gap:6px">
        ${RV_RESULTS.map((x, i) => `<label class="chk" style="margin:0"><input type="radio" name="rvr" value="${x.k}" ${i === 0 ? 'checked' : ''}>
          <span>${U.tag(x.k, x.c)} <span style="color:var(--txt-3)">${x.desc}</span></span></label>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px">
        ${U.field('复核人', `<select class="sel" data-f="rvby" style="flex:1">
          ${reviewers.map(u => `<option>${u.name}</option>`).join('')}</select>`)}
        ${U.field('§11 复核审批文号', `<input class="ip" data-f="apn" style="flex:1"
          placeholder="${closed ? '已结案改状态必填，如 FH-2026-0826-01' : '选填'}">`)}
      </div>
      ${U.field('复核意见', `<input class="ip" data-f="rvop" style="flex:1;margin-top:10px" placeholder="必填，写明依据与结论理由">`)}
      ${closed ? `<label class="chk" style="margin-top:10px"><input type="checkbox" data-f="rvack">
        我确认本次复核已按设计 §11 案件复核流程报批，审批文号如上，操作将记入平台操作审计。</label>` : ''}`)}`,
    footer: `<button class="btn" data-close>取消</button><button class="btn pri" data-act="ok">提交复核结论</button>`,
    on: {
      ok: el => {
        const result = (el.querySelector('input[name="rvr"]:checked') || {}).value;
        const opinion = el.querySelector('[data-f="rvop"]').value.trim();
        const by = el.querySelector('[data-f="rvby"]').value;
        const apn = el.querySelector('[data-f="apn"]').value.trim();
        if (!opinion) return toast('请填写复核意见', 'err');
        const changesCase = result !== '维持原定性';
        if (closed && changesCase) {
          if (!apn) return toast('本案已结案，作出改变案件状态的结论必须填写 §11 复核审批文号', 'err');
          const ack = el.querySelector('[data-f="rvack"]');
          if (!ack || !ack.checked) return toast('请确认已按 §11 案件复核流程报批', 'err');
        }
        applyReview(r, { result, by, opinion, approvalNo: apn, at: M.util.fmtDT(M.CONF.demoTime) });
        closeModal();
        paintTab();
        toast(`复核已办结：${r.caseId} · ${result}` + (changesCase && c ? `，案件状态已变更为「${c.status}」` : '，案件状态不变')
          + '，已记入平台操作审计', changesCase ? 'err' : 'ok');
      }
    }
  });
}

function applyReview(r, o) {
  const c = M.cases.find(x => x.id === r.caseId);
  if (c) {
    const why = `定性依据复核：${o.result}` + (o.approvalNo ? `（文号 ${o.approvalNo}）` : '');
    if (o.result === '撤销案件') M.setCaseStage(c, 1, why, MY_MODULE);
    else if (o.result === '补充证据后重判' && c.stage > 2) M.setCaseStage(c, 2, why, MY_MODULE);
    if (o.result !== '维持原定性') {
      rvCaseOps[c.id] = { targetId: c.targetId, status: c.status, stage: c.stage, docReady: c.docReady, note: o.result + '（' + r.id + '）' };
    }
  }
  r.status = '已办结';
  rvOutcome[r.id] = o;
  rvAudit('定性依据复核 · ' + o.result + (o.approvalNo ? '（文号 ' + o.approvalNo + '）' : ''),
    r.caseId + ' / ' + r.targetId, o.by);
  rvSave();
}

function docModal() {
  const c = st.sel;
  openModal({
    title: '《行政处罚决定书》预览', width: '680px',
    body: `<div class="warnbox" style="border-color:rgba(255,77,94,.45);background:rgba(255,77,94,.10);margin-bottom:12px">
      <b>本文书为 Demo 生成样例，不具法律效力。</b>三处出处需在正式实施前落实：
      <div style="margin-top:5px;line-height:1.9;font-size:12px">
        ① <b>金额档位</b>：法规给的是罚款区间而非逐项定额，本文书金额所依据的档位表<b>尚未经业务方确认</b>
           （见「用户与权限 → 参数总览 → 罚则金额档位」）<br>
        ② <b>处罚主体与出具授权</b>：会议纪要未授权平台直接出具处罚文书，主体亦未确定<br>
        ③ <b>证据材料</b>：正文所列证据<b>逐份取自证据台账</b>（证据存储管理页可溯源），
           不是固定文案；校验异常的材料会在正文中单独标出<br>
        ④ <b>责任主体认定</b>：本案主体的认定路径为
           ${snapOf(c).subject_source ? '<span class="mono">' + snapOf(c).subject_source + '</span>' : '<b style="color:#ff96a0">未记录</b>'}
      </div></div>
    <div style="position:relative;overflow:hidden;background:#f6f8fc;color:#1a2b45;padding:26px 30px;border-radius:6px;font-size:13px;line-height:2">
      <div style="position:absolute;inset:0;pointer-events:none;display:flex;flex-direction:column;justify-content:space-around">
        ${Array.from({ length: 5 }, () => `<div style="transform:rotate(-24deg);text-align:center;white-space:nowrap;
          color:rgba(190,40,55,.12);font-size:21px;font-weight:700;letter-spacing:3px">Demo 样例 · 不具法律效力 · Demo 样例 · 不具法律效力</div>`).join('')}
      </div>
      <div style="text-align:center;font-size:19px;font-weight:700;margin-bottom:6px">行政处罚决定书</div>
      <div style="text-align:center;color:#5b6b85;margin-bottom:18px">${c.docNo}</div>
      <p>当事人：${c.pilot}（${c.partner}）</p>
      <p>经查，当事人于 ${c.time} 在${c.district}使用 ${c.model === '未识别' ? '型号未识别的' : c.model} 无人驾驶航空器实施「${c.violation}」行为，
      由无人机融合感知与低空安全管理平台通过多源融合感知发现并固定证据（目标编号 ${c.targetId}）。</p>
      ${(function () {
        const fs2 = M.evidenceOf ? M.evidenceOf('case', c.id) : [];
        if (!fs2.length) return `<p>本案<b>在证据台账中未检索到关联证据材料</b>，
          事实认定所依据的材料需在正式出具前补充固定。</p>`;
        const byKind = {};
        fs2.forEach(f => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });
        const parts = Object.keys(byKind).map(k => `${k} ${byKind[k].length} 份`);
        const bad = fs2.filter(f => f.verifyState !== '完好');
        return `<p>上述事实有下列证据证实：${parts.join('、')}，共 ${fs2.length} 份，
          均存于证据台账并可溯源（编号 ${fs2.slice(0, 3).map(f => f.id).join('、')}${fs2.length > 3 ? ' 等' : ''}）。</p>`
          + (bad.length ? `<p style="color:#b3402d"><b>其中 ${bad.length} 份完整性校验异常</b>
            （${bad.map(f => f.id + ' ' + f.verifyState).join('；')}），
            依《证据保管办法》，该部分在结论作出前不得作为定案依据。</p>` : '');
      })()}
      <p>依据相关法规，决定给予：<b>${c.penalty}${c.penalty === '罚款' ? '人民币 ' + U.num(c.fine) + ' 元' : ''}</b>。</p>
      <div style="text-align:right;margin-top:24px">东营市公安局<br>${c.date}</div>
    </div>`,
    /* P4b：原为内联 onclick="UI.toast(...)"（走 legacy toast），改 data-act 走桥接层统一出口 */
    footer: `<button class="btn" data-close>关闭</button><button class="btn pri" data-close data-act="dl">${U.icon('download')} 下载 PDF</button>`,
    on: { dl: () => toast('文书已下载（Demo 样例，不具法律效力；金额档位表未经业务方确认）', 'err') }
  });
}

function authModal(a) {
  openModal({
    title: '授权与执行审计 · ' + a.id, width: '640px',
    body: U.kv([['授权类型', a.type], ['关联案件', a.caseId], ['目标编号', a.targetId],
    ['联动单位', a.unit], ['审批人', a.approver], ['操作人', a.operator],
    ['处置设备', a.device],
    ['干扰通道', a.channels
      ? a.channels.map(n => `<span class="mono">ch${n}</span> ${M.JAM_CH[n].key} <span style="color:var(--txt-3)">${M.JAM_CH[n].range} · ${M.JAM_CH[n].powerW}W</span>`).join('<br>')
      : (() => { const nt = M.bandNote(a); return nt.pending ? `<span style="color:var(--orange)">${nt.txt}</span>` : nt.txt; })()],
    ['卫星导航链路干扰', a.gnssJam == null ? (M.bandNote(a).pending ? '待确认（通道组合未定义）' : '不适用')
      : a.gnssJam ? `<b style="color:var(--red)">是</b> —— 干扰 GPS / GLONASS / 北斗，法律后果区别于遥控图传干扰`
      : '否'],
    ['通道依据', a.bandSource || '—'],
    ['作用范围', a.range],
    ['开始时间', a.start], ['结束时间', a.end], ['持续时长', a.durationS + ' 秒'],
    ['执行结果', a.result], ['回执状态', a.ack], ['急停记录', a.estop], ['审计完整性', a.audit]])
      + `<div class="warnbox" style="margin-top:12px">审计记录不可修改、不可删除，保留期与案件卷宗一致。</div>`
  });
}

function processModal() {
  const c = st.sel;
  const nextStep = M.DISPOSAL_FLOW[c.stage];
  const cur = c.steps[c.stage - 1];
  const probe = M.canAdvanceCase(c, MY_MODULE);
  const blocked = probe.ok === false;

  openModal({
    title: '推进案件流程 · ' + c.id, width: '580px',
    body: `${U.kv([
      ['当前环节', cur ? `${cur.n}　<span style="color:var(--txt-3);font-size:11.5px">（${cur.owner}）</span>` : '已完成'],
      ['下一环节', nextStep ? `${nextStep.n}　<span style="color:var(--txt-3);font-size:11.5px">（${nextStep.owner}）</span>` : '已到末环'],
      ['违法类型', c.violation],
      ['拟处罚', c.penalty + (c.penalty === '罚款' ? '（' + U.money(c.fine) + '）' : '')]
    ])}
      ${blocked ? `<div class="warnbox" style="margin-top:12px;border-color:rgba(255,176,32,.45);
          background:rgba(255,176,32,.08);line-height:1.85">
          注意：<b>本环节不由处置处罚管理执行，无法在本页推进。</b><br>
          ${probe.reason}<br>
          <span style="color:var(--txt-3)">六环节横跨三个模块，本页只负责<b>立案</b>与<b>结案归档</b>；
          其余环节在此处只作为既有事实展示，不由本页产生。</span></div>`
      : `<div style="margin-top:12px">${U.field('办理意见', `<input class="ip" style="flex:1;min-width:0" placeholder="请输入办理意见">`)}</div>
         <label class="chk"><input type="checkbox" checked>同步至上级管控平台（/api/v1/dispatch/sync）</label>
         <label class="chk"><input type="checkbox" checked>生成/更新处罚文书</label>`}`,
    footer: blocked
      ? `<button class="btn" data-close>知道了</button>`
      : `<button class="btn" data-close>取消</button><button class="btn pri" data-act="ok">确认推进</button>`,
    on: {
      ok: () => {
        closeModal();
        const r = M.advanceCase(c, MY_MODULE);
        if (!r || r.ok === false) {
          paint();
          return toast(r && r.reason ? r.reason : '本页无法推进该环节', 'err');
        }
        if (r.status === '已结案' || c.stage >= 3) c.docReady = true;
        paint();
        toast(`案件已推进至「${r.step}」，状态 ${r.status}，操作记入审计日志`, 'ok');
      }
    }
  });
}

function jamModal() {
  const u = (M.users && M.users[0]) || { name: '值班员', roleName: '值班员' };
  const cases = M.cases.filter(c => c.status !== '已结案');
  openModal({
    title: '发起公安授权信号干扰', width: '680px',
    body: `<div class="warnbox">注意：信号干扰为公安受控手段。必须填写<b>审批/授权编号、联动单位、作用范围、执行时长</b>，
      执行期间支持启停与急停，全过程审计（纪要 §6.3 / §11.1）。平台不代替公安做审批。</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${U.field('关联案件', `<select class="sel" data-jcase style="flex:1">
          ${cases.map(c => `<option value="${c.id}" ${st.sel && st.sel.id === c.id ? 'selected' : ''}>${c.id} · ${c.violation}</option>`).join('')}
        </select>`)}
        ${U.field('目标编号', `<input class="ip" data-jtarget style="flex:1" value="${st.sel ? st.sel.targetId : ''}" readonly>`)}
        ${U.field('审批编号 <span style="color:#ff8b95">*</span>', `<input class="ip" data-japp style="flex:1" placeholder="公安审批文号（必填）">`)}
        ${U.field('联动单位', `<select class="sel" data-junit style="flex:1">
          ${['东营市公安局特警支队', '东营市公安局东营分局', '东营市公安局广饶分局'].map(x => `<option>${x}</option>`).join('')}</select>`)}
        ${U.field('干扰设备', `<select class="sel" data-jdev style="flex:1">
          ${['公安干扰车-01', '公安干扰车-02', '便携干扰终端-03'].map(x => `<option>${x}</option>`).join('')}</select>`)}
        ${U.field('干扰通道', `<div style="flex:1">
          ${Object.values(M.JAM_CH).map(c => `<label class="chk" style="margin:0 0 4px">
            <input type="checkbox" data-jch="${c.ch}"${c.gnss ? '' : ' checked'}>
            <span class="mono">ch${c.ch}</span> ${c.key}
            <span style="color:var(--txt-3);font-size:11px">${c.range} · ${c.powerW}W</span>
            ${c.gnss ? `<b style="color:var(--red);font-size:11px">卫星导航链路</b>` : ''}
          </label>`).join('')}
          <div id="jamGnssWarn" class="warnbox" style="display:none;margin-top:6px;font-size:11.5px">
            <b>ch2 将干扰 GPS / GLONASS / 北斗卫星导航链路。</b>
            其法律后果与干扰遥控、图传链路不同，且影响范围不限于目标无人机。
            开启前须确认公安授权文书已明确载明卫星导航链路干扰。</div>
        </div>`)}
        ${U.field('作用范围', `<input class="ip" data-jrange style="flex:1" value="1500 m 扇区 60°">`)}
        ${U.field('执行时长(秒)', `<input class="ip" data-jsec style="flex:1" value="120">`)}
      </div>
      <label class="chk" style="margin-top:10px"><input type="checkbox" data-j="1">已取得公安机关书面/系统授权，授权编号真实有效</label>
      <label class="chk"><input type="checkbox" data-j="2">已评估作用范围内通信、导航与其他合法飞行影响</label>
      <label class="chk"><input type="checkbox" data-j="3">知悉本次操作全程录音录像并纳入审计，可随时急停</label>
      <div style="margin-top:8px;font-size:11.5px;color:var(--txt-3);line-height:1.8">
        提交后立即在<b>「反制与干扰授权审计」</b>生成一条授权记录（本页签），并写入平台操作审计。
        通道与频段/功率取自设备一手资料（${M.JAM_SOURCE}）。</div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn danger" data-act="go" disabled id="jamGo">提交并执行</button>`,
    mounted: el => {
      const upd = () => el.querySelector('#jamGo').disabled = [...el.querySelectorAll('[data-j]')].filter(x => x.checked).length < 3;
      el.querySelectorAll('[data-j]').forEach(c => c.onchange = upd);
      const gn = el.querySelector('[data-jch="2"]'), warn = el.querySelector('#jamGnssWarn');
      if (gn && warn) gn.onchange = () => warn.style.display = gn.checked ? '' : 'none';
    },
    on: {
      go: el => {
        const app = (el.querySelector('[data-japp]').value || '').trim();
        if (!app) {
          toast('公安审批文号为必填 —— 没有文号，这条授权记录无法回答"谁批准的"', 'err');
          el.querySelector('[data-japp]').focus();
          return;
        }
        const sec = parseInt(el.querySelector('[data-jsec]').value, 10);
        if (!sec || sec <= 0) { toast('执行时长须为正整数（秒）', 'err'); return; }
        const chs = [...el.querySelectorAll('[data-jch]')].filter(x => x.checked)
          .map(x => +x.dataset.jch).sort();
        if (!chs.length) { toast('至少选择一路干扰通道 —— 一路不开等于没有实施干扰', 'err'); return; }
        const caseId = el.querySelector('[data-jcase]').value;
        const c = M.cases.find(x => x.id === caseId);
        const t0 = M.CONF.demoTime;
        const rec = {
          id: 'AUTH' + M.util.ymd(t0) + M.util.p3(M.authLogs.length + 1),
          caseId, targetId: (c && c.targetId) || (st.sel ? st.sel.targetId : '—'),
          type: '公安授权信号干扰',
          unit: el.querySelector('[data-junit]').value,
          approver: app,
          operator: u.name,
          device: el.querySelector('[data-jdev]').value,
          channels: chs,
          band: chs.map(n => M.JAM_CH[n].key).join(' / '),
          bandSource: M.JAM_SOURCE,
          gnssJam: chs.includes(2),
          range: el.querySelector('[data-jrange]').value.trim(),
          durationS: sec,
          start: M.util.fmtDT(t0),
          end: M.util.fmtDT(new Date(t0.getTime() + sec * 1000)),
          result: '执行中',
          ack: '待回执', audit: '完整', estop: '未触发',
          approvalNo: app
        };
        M.authLogs.unshift(rec);
        rvAudit(`公安授权信号干扰下发（审批文号 ${app}）`, rec.targetId, u.name);
        closeModal();
        st.tab = 'auth';
        window.APP.rerender();
        toast(`干扰任务已下发并留痕：授权编号 ${rec.id}，可在本页「反制与干扰授权审计」中查看`, 'ok');
      }
    }
  });
}

onMounted(() => {
  const view = root.value;
  paintTab();

  U.on(view, '[data-row]', 'click', (e, el) => {
    const c = M.cases.find(x => x.id === el.dataset.row);
    if (st.tab === 'pend') {
      return pendModal((M.pendingSubjects || []).find(p => p.id === el.dataset.row));
    }
    if (st.tab === 'review') {
      if (c) { st.sel = c; U.selectRow(document.getElementById('pnRvChk'), c.id); snapModal(c); }
      return;
    }
    if (c) {
      st.sel = c;
      U.selectRow(document.getElementById('pnList'), c.id);
      paintDetail();
    }
    else { const a = M.authLogs.find(x => x.id === el.dataset.row); if (a) authModal(a); }
  });
  U.on(view, '[data-notify]', 'click', (e, el) => {
    const c = M.cases.find(x => x.id === el.dataset.notify);
    if (!c || noticeStatus(c) === '已通知') return;
    noticed[c.id] = '已通知';
    saveNotice();
    window.APP.rerender();
    toast('通知成功', 'ok');
  });
  U.on(view, '[data-cop]', 'click', (e, el) => {
    e.stopPropagation();
    const [op, id] = el.dataset.cop.split('|');
    st.sel = M.cases.find(c => c.id === id); paint();
    if (op === 'do') processModal();
  });
  U.on(view, '[data-pg]', 'click', (e, el) => { if (el.dataset.pg) { st.page = +el.dataset.pg; paint(); } });
  U.on(view, '[data-size]', 'change', (e, el) => { st.size = parseInt(el.value); st.page = 1; paint(); });
  U.on(view, '[data-f]', 'change', (e, el) => {
    const k = el.dataset.f; if (k === 'rvf') return;
    st[k] = k === 'days' ? +el.value : el.value; st.page = 1; paint();
  });
  U.on(view, '[data-jam]', 'click', (e, el) => {
    const [op, id] = el.dataset.jam.split('|');
    const rec = M.authLogs.find(x => x.id === id);
    if (!rec || rec.result !== '执行中') return;
    const u = (M.users && M.users[0]) || { name: '值班员' };
    const t0 = M.CONF.demoTime;
    rec.end = M.util.fmtDT(t0);
    rec.result = op === 'estop' ? '急停终止' : '人工停止';
    rec.ack = '已回执';
    if (op === 'estop') rec.estop = '触发过急停';
    rvAudit(`公安授权信号干扰${op === 'estop' ? '急停' : '停止'}（${rec.id}）`, rec.targetId, u.name);
    window.APP.rerender();
    toast(op === 'estop' ? `已触发急停：${rec.id}，设备立即停止发射，已记入审计`
      : `已停止干扰：${rec.id}，回执已接收，已记入审计`, op === 'estop' ? 'err' : 'ok');
  });
  U.on(view, '[data-doc]', 'click', (e, el) => {
    if (el.dataset.doc === 'prev') docModal();
    else if (el.dataset.doc === 'down') toast('已下载《行政处罚决定书》' + st.sel.docNo
      + '（Demo 样例，不具法律效力；金额依据的档位表未经业务方确认）', 'err');
    else processModal();
  });
  U.on(view, '[data-ev]', 'click', () => {
    if (!st.sel) return;
    const fs2 = M.evidenceOf ? M.evidenceOf('case', st.sel.id) : [];
    if (!fs2.length) return toast(`案件 ${st.sel.id} 在证据台账中暂无关联材料`, 'err');
    if (window.SEARCH && window.SEARCH.goEntity) { U.goto('evidence', { id: fs2[0].id }); }
    else toast(`本案关联证据 ${fs2.length} 份，可在「证据存储管理」中查看`, 'ok');
  });
  U.on(view, '[data-goto]', 'click', () => U.goto('legality', { target: st.sel.targetId }));
  U.on(view, '[data-goparam]', 'click', () => { location.hash = '#/users'; toast('参数总览 → 罚则金额档位（待业务方确认）'); });
  U.on(view, '[data-sort]', 'click', (e, el) => {
    const k = el.dataset.sort;
    if (SORT.key === k) SORT.dir = SORT.dir === 'asc' ? 'desc' : 'asc';
    else { SORT.key = k; SORT.dir = 'asc'; }
    st.page = 1;
    document.getElementById('pnList').innerHTML = list();
  });
  U.on(view, '#pnR', 'click', () => {
    Object.assign(st, { status: '全部状态', region: '全部区域', vio: '全部类型', partner: '全部合作方', days: 30, page: 1 });
    paintTab(); toast('筛选条件已重置');
  });
  U.on(view, '#pnExp', 'click', () => toast('已导出「处罚案件明细.xlsx」共 ' + filtered().length + ' 条', 'ok'));
  U.on(view, '[data-ps]', 'click', (e, el) => {
    e.stopPropagation();
    pendModal((M.pendingSubjects || []).find(p => p.id === el.dataset.ps));
  });
  U.on(view, '[data-rv]', 'click', (e, el) => {
    e.stopPropagation();
    reviewModal(M.reviewRequests.find(r => r.id === el.dataset.rv));
  });
  U.on(view, '[data-f="rvf"]', 'change', (e, el) => { st.rvFilter = el.value; paintReview(); });
  U.on(view, '[data-jd]', 'click', (e, el) => { snapModal(M.cases.find(c => c.id === el.dataset.jd)); });
});
</script>

<template>
  <div class="view" id="view" ref="root" style="overflow:hidden">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <UKpis :list="kpiList" />
      <div id="pnBody" style="margin-top:12px;flex:1;min-height:0"></div>
    </div>
  </div>
</template>
