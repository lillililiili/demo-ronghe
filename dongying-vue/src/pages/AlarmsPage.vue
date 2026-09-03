<script>
/* 模块级状态：跨导航保持（legacy 约定）。 */
const S = {
  /* 表格顶栏下拉默认「全部」，由用户再收窄。 */
  st: { page: 1, size: 20, level: '全部', status: '全部', kind: '全部', region: '全部', sel: null,
    sort: 'ts', dir: -1 }
};
export default {};
</script>

<script setup>
/* 异常飞行与告警中心 —— 转换页（源：legacy pages/alarms.js）。
   ⚠ 模块加载期副作用（addPendingVerificationAlarm 注入待核实告警、
   U.regParams F0605 参数登记）仍由 legacy script 执行，这里不重复。
   地图（MapView）在 onUnmounted 销毁；usePageChrome 先注册，故卸载顺序
   与旧版 route() 一致：CH.disposeAll → map.destroy → closeModal。 */
import { ref, reactive, computed, h, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { sliceLocal } from '@/hooks/pagedList.js';
import { usePagedList } from '@/hooks/usePagedList.js';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import PagePager from '@/components/PagePager.vue';
import PageQueryShell from '@/components/PageQueryShell.vue';
import { toast } from '@/ui/nv.js';
import { openModal, closeModal } from '@/ui/modal.js';
import { openFormModal } from '@/ui/formModal.js';
import AlarmNotifyModal from '@/components/modals/AlarmNotifyModal.vue';

const M = window.MOCK, U = window.UI, CH = window.CH;
usePageChrome('alarms');
const root = ref(null);
/* reactive 代理同一份模块级状态，筛选与分页口径跨导航记忆不变。 */
const st = reactive(S.st);
const query = usePagedList({ page: st.page, size: st.size });
const queryStatus = computed(() => query.status.value);
const queryError = computed(() => query.errorMessage.value);
let mounted = false;
let map = null;

const FLOW_STATUS = ['待核实', '反制中', '干扰中', '待处置', '已处置', '误报'];
const LEGACY_FLOW_STATUS = { '新建': '待核实', '已确认': '待核实', '处置中': '反制中', '已关闭': '待处置', '误报': '误报' };
const statusOf = a => {
  if (a.flowStatus) return a.flowStatus;
  if (a.status === '已关闭' && window.EVT) {
    const ctx = window.EVT.of(a.targetId);
    if (ctx && ctx.stage >= window.EVT.FLOW.length) return '已处置';
  }
  return LEGACY_FLOW_STATUS[a.status] || '待核实';
};

const LV_RANK = { '高': 3, '中': 2, '低': 1 };
const SORTERS = {
  ts: a => a.ts,
  level: a => LV_RANK[a.level] || 0,
  kind: a => a.kind + '\u0000' + a.type,
  district: a => M.DISTRICTS.findIndex(d => d.name === a.district),
  status: a => FLOW_STATUS.indexOf(statusOf(a))
};
const SORT_NOTE = { district: '（按行政区既定顺序）', status: '（按处置流程顺序）', level: '（高→低）' };
function sortTh(key, label) {
  const on = st.sort === key;
  return `<span class="lnk" data-sort="${key}" role="button" tabindex="0" title="点击按「${label}」排序${SORT_NOTE[key] || ''}"
    style="color:inherit;cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;text-decoration-color:rgba(156,198,255,.5)"
    >${label}${on ? `<span style="font-size:10px;margin-left:2px">${st.dir < 0 ? '▼' : '▲'}</span>` : ''}</span>`;
}

function rows() {
  if (!Array.isArray(M.alarms)) throw new TypeError('Mock 告警数据源无效：alarms 必须是数组');
  const f = M.alarms.filter(a =>
    (st.level === '全部' || a.level === st.level) &&
    (st.status === '全部' || statusOf(a) === st.status) &&
    (st.kind === '全部' || a.kind === st.kind) &&
    (st.region === '全部' || a.district === st.region));
  const g = SORTERS[st.sort];
  if (!g) return f;
  return f.sort((x, y) => { const a = g(x), b = g(y); return (a < b ? -1 : a > b ? 1 : 0) * st.dir; });
}

/* 深链在首次成功载入时定位；无效数据源不得在 setup 阶段伪装为成功。 */
let pendingDeepId = sessionStorage.getItem('alarm.sel');
sessionStorage.removeItem('alarm.sel');
if (pendingDeepId) {
  st.level = st.status = st.kind = st.region = '全部';
}
st.sel = null;

const T = M.todayAlarms;
const c = s => T.filter(a => statusOf(a) === s).length;
const kpiList = [
  { label: '今日告警总数', value: U.num(T.length), color: 'blue', icon: 'alert', desc: `近30天 ${U.num(M.alarms.length)} 起` },
  { label: '待核实', value: U.num(c('待核实')), color: 'amber', icon: 'alert', desc: '待人工确认属实或误报' },
  { label: '反制中', value: U.num(c('反制中')), color: 'orange', icon: 'radar', desc: '待发起联动反制' },
  { label: '干扰中', value: U.num(c('干扰中')), color: 'red', icon: 'radar', desc: '反制信号干扰执行中' },
  { label: '待处置', value: U.num(c('待处置')), color: 'green', icon: 'check', desc: '待通知处罚部门' },
  { label: '误报', value: U.num(c('误报')), color: 'purple', icon: 'check', desc: '人工核实后已排除' }
];

const listToolbarHtml = `<div class="toolbar">
    ${U.field('等级', U.select('level', ['全部', '高', '中', '低'], st.level))}
    ${U.field('类别', U.select('kind', ['全部', '飞行违规', '空间安全'], st.kind))}
    ${U.field('状态', U.select('status', ['全部', ...FLOW_STATUS], st.status))}
    ${U.field('区域', U.select('region', ['全部', ...M.DISTRICTS.map(d => d.name)], st.region))}
    <span style="flex:1"></span>
    <span style="font-size:11px;color:var(--txt-3);white-space:nowrap">Mock 演示数据 · 未接入后端告警查询接口</span>
  </div>`;
const mapExtra = `<span id="alMapSrc" style="font-size:11px;color:var(--txt-3);white-space:nowrap"></span>
  <button class="btn" id="alLoc" style="height:24px;font-size:11.5px;flex:none" title="重新定位到当前告警的关联目标">${U.icon('location')} 定位</button>`;
const mapBody = `<div id="alMap" style="flex:1;min-height:0"></div>
    <div id="alMapInfo" style="flex:none;height:19px;line-height:19px;padding:2px 2px 0;font-size:10.5px;
      color:var(--txt-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>`;

function list() {
  const page = query.items.value;
  return U.table([
    {
      t: sortTh('ts', '告警编号 / 时间'), w: '108px', cls: 'num',
      render: a => U.cell(a.id.slice(-9), a.time.slice(11), { mono: true })
    },
    { t: sortTh('level', '等级'), w: '52px', align: 'center', render: a => U.tag(a.level, a.level === '高' ? 't-red' : a.level === '中' ? 't-amber' : 't-blue') },
    {
      t: sortTh('kind', '类别 / 类型'), w: '128px', render: a => U.cell(U.tag(a.kind, a.kind === '空间安全' ? 't-purple' : 't-orange'), a.type)
    },
    { t: sortTh('district', '关联目标 / 区域'), w: '146px', render: a => U.cell(a.targetId, a.district, { mono: true }) },
    {
      t: '告警内容', render: a => `<div title="${a.detail}" style="white-space:normal;line-height:1.5;
        max-height:34px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${a.detail}</div>`
    },
    { t: sortTh('status', '状态'), w: '86px', render: a => U.tag(statusOf(a)) }
  ], page, { rowId: a => a.id, activeId: st.sel && st.sel.id });
}

function disposalSteps(a) {
  const s = statusOf(a);
  const trigger = { n: '告警触发', t: a.time.slice(11), done: true, act: false };
  const ctx = window.EVT && window.EVT.of(a.targetId);
  if (s !== '误报' && ctx) return window.EVT.steps(ctx).map((step, i) => ({
    n: step.n, t: i === 0 ? a.time.slice(11) : step.t, done: step.done, act: step.act
  }));
  if (s === '待核实') return [trigger,
    { n: '人工核实', t: '', done: false, act: true },
    { n: '反制', t: '', done: false, act: false },
    { n: '信号干扰', t: '', done: false, act: false },
    { n: '处置', t: '', done: false, act: false }];
  if (s === '误报') return [trigger,
    { n: '人工核实', t: '误报', done: true, act: false }];
  if (s === '反制中') return [trigger,
    { n: '人工核实', t: '属实', done: true, act: false },
    { n: '反制', t: '待授权', done: false, act: true },
    { n: '信号干扰', t: '', done: false, act: false },
    { n: '处置', t: '', done: false, act: false }];
  if (s === '干扰中') return [trigger,
    { n: '人工核实', t: '属实', done: true, act: false },
    { n: '反制', t: '已授权', done: true, act: false },
    { n: '信号干扰', t: '干扰中', done: false, act: true },
    { n: '处置', t: '', done: false, act: false }];
  return [trigger,
    { n: '人工核实', t: '属实', done: true, act: false },
    { n: '反制', t: '已授权', done: true, act: false },
    { n: '信号干扰', t: '干扰完成', done: true, act: false },
    { n: '处置', t: s === '已处置' ? '已通知' : '待通知', done: s === '已处置', act: s === '待处置' }];
}

function disposalActions(a) {
  const s = statusOf(a);
  if (s === '待核实') return `<button class="btn pri" data-al="verify">人工核实</button>`;
  if (s === '反制中') return `<button class="btn danger" data-al="counter">${U.icon('bolt')} 发起联动反制</button>`;
  if (s === '待处置') {
    const ctx = window.EVT && window.EVT.of(a.targetId);
    if (ctx && ctx.kase && ctx.stage === window.EVT.FLOW.length - 1)
      return `<button class="btn pri" data-al="punish">通知处罚部门</button>`;
  }
  return '';
}

function detail() {
  const a = st.sel;
  if (!a) return '<div class="empty">请选择告警</div>';
  const statusEl = document.getElementById('alSt');
  if (statusEl) statusEl.innerHTML = U.tag(statusOf(a));
  const t = M.allTargets.find(x => x.id === a.targetId) || {};
  return `${U.detailHero({
    icon: 'alert', subtitle: '告警事件', title: a.type, id: a.id,
    tags: [U.tag(a.level, a.level === '高' ? 't-red' : a.level === '中' ? 't-amber' : 't-blue'), U.tag(statusOf(a))],
    meta: [['区域', a.district], ['时间', a.time.slice(11)]]
  })}
    ${U.metricStrip([
      { label: '告警等级', value: a.level, tone: a.level === '高' ? 'bad' : a.level === '中' ? 'warn' : 'info', icon: 'alert' },
      { label: '处置状态', value: statusOf(a), tone: statusOf(a) === '待核实' ? 'warn' : 'info', icon: 'play' },
      { label: '目标类型', value: t.subtype || t.type || '—', icon: 'plane' },
      { label: '来源置信', value: U.confPct(a.source_confidence), tone: 'good', icon: 'radar' }
    ], { compact: true })}
    ${U.sect('处置流程', U.steps(disposalSteps(a)), { icon: 'trend' })}
    ${U.sect('告警信息', U.kv([
    ['告警类型', a.type], ['告警等级', U.tag(a.level, a.level === '高' ? 't-red' : 't-amber')],
    ['触发时间', a.time], ['所在区域', a.district],
    ['关联目标', `<span class="mono">${a.targetId}</span>`],
    ['目标类型', t.subtype || t.type || '—'],
    ['高度/速度', (t.alt || '—') + ' m / ' + (t.speed || '—') + ' m/s'],
    ['数据来源', a.source + `（置信度 ${U.confPct(a.source_confidence)}）`],
    ['告警内容', a.detail]
  ], { surface: true, density: 'compact' }), { icon: 'alert' })}
    ${/* 「关联目标 ID 变更历史（B02）」区块已按用户裁定删除（2026-08-30）：
         合并/分裂谱系是证据链回溯用的技术事实，演示告警详情不需要它。
         M.idLineage 数据与合并快照仍在数据层（日志归档可查），删的只是本页展示。 */''}
    ${U.detailActions(`
      <button class="btn" data-al="video">${U.icon('video')} 实时视频</button>
      <button class="btn" data-al="replay">${U.icon('trend')} 轨迹回放</button>
      ${disposalActions(a)}`)}`;
}

function paint() {
  if (query.status.value !== 'ready') return;
  const listEl = document.getElementById('alList');
  const detailEl = document.getElementById('alDetail');
  if (!listEl || !detailEl) return;
  listEl.innerHTML = list();
  detailEl.innerHTML = detail();
}

function failQuery(err) {
  query.items.value = [];
  query.total.value = 0;
  st.sel = null;
  query.setError(err);
  disposeMap();
}

function applyAlarmPage(preferredId = null) {
  try {
    const all = rows();
    let selectedId = preferredId;
    if (pendingDeepId) {
      const index = all.findIndex(item => item.id === pendingDeepId);
      if (index >= 0) {
        query.setPage(Math.ceil((index + 1) / query.size.value));
        selectedId = pendingDeepId;
      } else {
        query.setPage(1);
      }
      pendingDeepId = null;
    }
    const previousStatus = query.status.value;
    const parsed = query.applyPayload(sliceLocal(all, query.page.value, query.size.value));
    if (!parsed) {
      st.sel = null;
      disposeMap();
      return null;
    }
    st.page = parsed.page;
    st.size = parsed.size;
    if (query.status.value === 'empty') {
      st.sel = null;
      return parsed;
    }
    selectedId = selectedId || (st.sel && st.sel.id);
    // safe-default: 只在当前可见页内选首条，用户可见且可点击任一行改选。
    st.sel = parsed.items.find(item => item.id === selectedId) || parsed.items[0] || null;
    if (previousStatus === 'ready') {
      paint();
      focusMap();
      scrollSelectedRow();
    }
    return parsed;
  } catch (err) {
    failQuery(err);
    return null;
  }
}

async function reloadAlarms() {
  query.setLoading();
  query.items.value = [];
  query.total.value = 0;
  st.sel = null;
  disposeMap();
  await nextTick();
  return applyAlarmPage();
}

function trackFor(t, a) {
  const lv = M.liveTargets.find(x => x.id === t.id);
  if (lv && lv.track && lv.track.length > 1)
    return { pts: lv.track, src: '实时跟踪轨迹（/api/v1/target/track 实时流）', live: true };
  const rs = CH.seeded('altrk' + t.id);
  const n = 22, hd = (t.heading || 0) * Math.PI / 180;
  const lon0 = t.lon - Math.sin(hd) * 0.055, lat0 = t.lat - Math.cos(hd) * 0.046;
  const dl = (t.lon - lon0) / (n - 1), da = (t.lat - lat0) / (n - 1);
  const hasBridge = rs(0, 9) < 6;
  const b0 = Math.floor(n * 0.4), b1 = b0 + 2;
  const open = !a || ['待核实', '反制中', '干扰中'].includes(statusOf(a));
  const p0 = open ? n - 3 : n;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const kind = i >= p0 ? 'pred' : (hasBridge && i >= b0 && i <= b1 ? 'bridge' : 'meas');
    pts.push({
      lon: +(lon0 + dl * i + rs(-55, 55) / 1e4).toFixed(6),
      lat: +(lat0 + da * i + rs(-45, 45) / 1e4).toFixed(6),
      alt: t.alt, t: t.ts - (n - 1 - i) * 12000, kind
    });
  }
  return { pts, src: '历史归档轨迹（Demo 按归档点位还原，正式版取 /api/v1/target/track）', live: false };
}
const kindStat = pts => pts.reduce((m, p) => { const k = p.kind || 'meas'; m[k] = (m[k] || 0) + 1; return m; }, {});

function centerOn(lon, lat) {
  if (!map || !map.w) return;
  map.centerAt(lon, lat);
}

function focusMap() {
  if (!map) return;
  const a = st.sel, info = document.getElementById('alMapInfo'), srcEl = document.getElementById('alMapSrc');
  if (!a) return;
  const t = M.allTargets.find(x => x.id === a.targetId);
  if (!t) {
    map.sel = null;
    map.setData({ airspaces: M.airspaces, devices: [], targets: [], alarms: [] });
    if (srcEl) srcEl.textContent = '';
    if (info) info.innerHTML = `<span class="inline-icon" style="color:#ffd07a" title="历史告警的关联目标可能已被 B02 合并">${U.icon('warning')} 关联目标 ${a.targetId} 不在目标库中，无法定位</span>`;
    return;
  }
  const tk = trackFor(t, a);
  map.sel = t.id;
  map.setData({
    airspaces: M.airspaces, devices: [],
    targets: [Object.assign({}, t, { track: tk.pts, tracked: true })],
    alarms: [a]
  });
  const last = tk.pts[tk.pts.length - 1];
  centerOn(last.lon, last.lat);
  const ks = kindStat(tk.pts);
  if (srcEl) srcEl.innerHTML =
    `${tk.live ? `<span class="tag t-green" title="${tk.src}">实时轨迹</span>`
      : `<span class="tag t-amber" title="${tk.src}">归档轨迹</span>`}
     <span title="实测 / 弥合(A03) / 预测(A04) 三种点型按 §6.8 分线型绘制：实测=动画虚线，弥合=橙色宽隙虚线，预测=青色点线">
       <span style="color:#8fbaff">实${ks.meas || 0}</span><span
         style="color:#ff8b3d">/弥${ks.bridge || 0}</span><span
         style="color:#22d3ee">/预${ks.pred || 0}</span></span>`;
  if (info) {
    const lc = t.legal === '非法' ? '#ff8b95' : t.legal === '异常' ? '#ffb083' : t.legal === '待确认' ? '#ffd07a' : t.legal === '不适用' ? '#8ca0be' : '#79e5a5';
    info.innerHTML =
      `<span class="mono" style="color:var(--txt-2)">${t.id}</span> · ${t.subtype || t.type} ·
       合法性 <span style="color:${lc}">${t.legal}</span> · 高度 ${t.alt} m ·
       ${tk.live ? '实时轨迹' : '历史归档轨迹'}`;
    info.title = `${t.id}｜${t.subtype || t.type}｜合法性 ${t.legal}｜高度 ${t.alt} m\n轨迹来源：${tk.src}\n`
      + `点型：实测 ${ks.meas || 0}（动画虚线）/ 弥合 A03 ${ks.bridge || 0}（橙色宽隙虚线）/ 预测 A04 ${ks.pred || 0}（青色点线）`;
  }
}

function disposeMap() {
  if (map) map.destroy();
  map = null;
}

function scrollSelectedRow() {
  const selectedRow = document.querySelector('#alList tr.on');
  if (selectedRow && selectedRow.scrollIntoView) selectedRow.scrollIntoView({ block: 'center' });
}

function initReadyView() {
  if (!mounted || query.status.value !== 'ready') return;
  paint();
  scrollSelectedRow();
  const mapEl = document.getElementById('alMap');
  if (!mapEl) return;
  disposeMap();
  map = new window.MapView(mapEl, {
    zoom: 2.2, maxDev: 0, maxAlarm: 1, legend: false, layers: { device: false }
  });
  const activeMap = map;
  const locate = document.getElementById('alLoc');
  if (locate) locate.onclick = () => { if (map) map.resetView(2.2); focusMap(); };
  focusMap();
  requestAnimationFrame(() => {
    if (mounted && query.status.value === 'ready' && map === activeMap) focusMap();
  });
}

function remount() { window.APP.rerender(); }

function startInterference(a) {
  const ctx = window.EVT && window.EVT.of(a.targetId);
  if (!ctx) return toast('未找到该告警的共享事件记录', 'err');
  const result = window.EVT.startLinkedCounter(ctx, {
    note: '告警页完成反制授权并发起联动处置',
    onStart: remount,
    onComplete: () => { if (location.hash === '#/alarms') remount(); }
  });
  if (!result.ok) return toast(result.msg, 'err');
  toast(result.msg, 'ok');
}

function notifyPunishment(a) {
  const ctx = window.EVT && window.EVT.of(a.targetId);
  if (!ctx) return toast('未找到该告警的共享事件记录', 'err');
  return window.EVT.confirmPunish(ctx, {
    note: '告警事件页确认通知处罚部门',
    onResult: result => {
      if (!result.ok) return toast(result.msg, 'err');
      remount();
      toast(result.msg, 'ok');
    }
  });
}

function verifyModal() {
  const a = st.sel;
  if (!a) return;
  if (statusOf(a) !== '待核实') return toast('当前告警无需重复核实', 'err');
  const t = M.allTargets.find(x => x.id === a.targetId) || {};
  openFormModal({
    title: '人工核实 · ' + a.id, width: '600px',
    warning: `核实是状态机的必经环节（待核实 → 反制中 / 误报）。
        结论为「误报」时告警进入终态，样本计入误报率统计与 C06 规则优化；
        结论为「属实」时直接进入反制节点，可在本页发起联动处置。`,
    introHtml: U.kv([
      ['告警类型', a.type], ['告警等级', U.tag(a.level, a.level === '高' ? 't-red' : a.level === '中' ? 't-amber' : 't-blue')],
      ['关联目标', `<span class="mono">${a.targetId}</span>　${t.subtype || t.type || '—'}`],
      ['合法性判定', t.legal_status || t.legal || '—'],
      ['触发时间 / 区域', a.time + '　' + a.district],
      ['告警内容', a.detail]
    ]),
    fields: [
      { key: 'real', label: '核实结论', type: 'radio', required: true, options: [
        { value: '1', html: '<b>属实</b> —— 告警成立，状态推进至「反制中」' },
        { value: '0', html: '<b>误报</b> —— 告警不成立，状态置为「误报」（终态），并计入误报率统计' }
      ] },
      { key: 'note', label: '核实说明', required: true, placeholder: '必填：核实依据（如现场确认、轨迹复核、飞手联系结果）' }
    ],
    initial: { real: '1', note: '' },
    confirmText: '提交核实结论',
    validate: m => !(m.note || '').trim() ? '核实说明为必填 —— 状态变更必须能回答"依据是什么"' : '',
    onSubmit: ({ real, note }) => {
      const from = statusOf(a);
      const ctx = window.EVT && window.EVT.of(a.targetId);
      const result = ctx ? window.EVT.verify(ctx, { real: real === '1', note: (note || '').trim() }) : { ok: false, msg: '事件聚合服务不可用' };
      if (!result.ok) return toast(result.msg, 'err');
      closeModal();
      remount();
      toast(`核实完成：${from} → ${a.flowStatus}${real === '1' ? '' : '（流程在人工核实节点终止）'}`, 'ok');
    }
  });
}

function sendModal() {
  const a = st.sel;
  const on = M.notifyChannels.filter(c2 => c2.on);
  openModal({
    title: '发送告警通知 · ' + a.id, width: '620px', footer: false,
    render: () => h(AlarmNotifyModal, {
      alarm: a,
      channels: on,
      onSent: () => { const el = document.getElementById('alDetail'); if (el) el.innerHTML = detail(); }
    })
  });
}

function onPage(p2) {
  query.setPage(p2);
  applyAlarmPage();
}

function onPageSize(s2) {
  query.setSize(s2);
  st.page = query.page.value;
  st.size = query.size.value;
  applyAlarmPage();
}

watch(queryStatus, async (status, previous) => {
  if (!mounted) return;
  if (previous === 'ready' && status !== 'ready') {
    st.sel = null;
    disposeMap();
  }
  if (status !== 'ready' || previous === 'ready') return;
  await nextTick();
  if (mounted && query.status.value === 'ready') initReadyView();
}, { flush: 'pre' });

onUnmounted(() => {
  mounted = false;
  disposeMap();
});

onMounted(() => {
  mounted = true;
  const view = root.value;

  U.on(view, '[data-row]', 'click', (e, el) => {
    st.sel = query.items.value.find(a => a.id === el.dataset.row) || null;
    U.selectRow(document.getElementById('alList'), el.dataset.row);
    const detailEl = document.getElementById('alDetail');
    if (detailEl) detailEl.innerHTML = detail();
    focusMap();
  });
  U.on(view, '[data-f]', 'change', (e, el) => {
    st[el.dataset.f] = el.value;
    query.setPage(1);
    st.page = 1;
    applyAlarmPage();
  });
  const doSort = key => {
    if (st.sort === key) st.dir = -st.dir;
    else { st.sort = key; st.dir = key === 'ts' ? -1 : 1; }
    query.setPage(1);
    st.page = 1;
    applyAlarmPage();
    const sc = document.querySelector('#alList .scroll');
    if (sc) sc.scrollTop = 0;
  };
  U.on(view, '[data-sort]', 'click', (e, el) => doSort(el.dataset.sort));
  U.on(view, '[data-sort]', 'keydown', (e, el) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(el.dataset.sort); }
  });
  U.on(view, '[data-al]', 'click', (e, el) => {
    const k = el.dataset.al;
    if (k === 'counter') {
      const a = st.sel;
      const t = a && M.allTargets.find(x => x.id === a.targetId);
      if (!a || statusOf(a) !== '反制中') return toast('当前告警不在反制节点', 'err');
      if (!t) return toast('未找到该告警的关联目标', 'err');
      if (!window.TARGET_ACTIONS) return toast('反制授权组件尚未加载', 'err');
      window.TARGET_ACTIONS.openCounterAuth(t, () => startInterference(a));
    }
    else if (k === 'punish') {
      const a = st.sel;
      if (!a || statusOf(a) !== '待处置') return toast('当前告警无需通知处罚部门', 'err');
      notifyPunishment(a);
    }
    else if (k === 'video' || k === 'replay') {
      const a = st.sel;
      const t = a && M.allTargets.find(x => x.id === a.targetId);
      if (!t) return toast('未找到该告警的关联目标', 'err');
      if (!window.TARGET_MEDIA) return toast('媒体查看组件尚未加载', 'err');
      const tk = trackFor(t, a);
      const target = Object.assign({}, t, { track: tk.pts });
      if (k === 'video') window.TARGET_MEDIA.openVideo(target);
      else window.TARGET_MEDIA.openReplay(target, a);
    }
    else if (k === 'notify') sendModal();
    else if (k === 'verify') verifyModal();
  });
  reloadAlarms();
});
</script>

<template>
  <div class="view" id="view" ref="root" style="overflow:hidden">
    <div class="alarms-page" style="height:100%;min-height:0;display:flex;flex-direction:column">
      <UKpis :list="kpiList" />
      <div class="row" style="margin-top:12px;flex:1;min-height:0">
        <UPanel title="告警列表" panel-style="flex:6;min-width:0" nopad>
          <div style="display:contents" v-html="listToolbarHtml"></div>
          <PageQueryShell
            :status="queryStatus"
            loading-text="正在加载 Mock 告警演示数据…"
            empty-title="暂无符合条件的告警"
            empty-description="请调整上方筛选条件。当前列表仍为 Mock 演示数据。"
            error-title="告警列表加载失败"
            :error-message="queryError || '加载失败，且不会回退显示旧数据。'"
            @retry="reloadAlarms">
            <div id="alList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>
            <PagePager
              :page="query.page.value"
              :size="query.size.value"
              :total="query.total.value"
              :page-sizes="[20, 50, 100]"
              @update:page="onPage"
              @update:size="onPageSize"
            />
          </PageQueryShell>
        </UPanel>
        <div v-if="queryStatus === 'ready'" class="col" style="flex:4;min-width:0">
          <!-- 操作引导（用户裁定 2026-08-30：多处补黄字引导） -->
          <div class="warnbox" style="margin:0;padding:8px 11px;font-size:12px;flex:none">
            演示动线：点左侧<b>告警列表</b>任一行 → 地图定位关联目标 → 下方详情底部点
            「<b>人工核实 / 发起联动反制</b>」推进处置，「实时视频 / 轨迹回放」查看证据。</div>
          <UPanel title="关联目标定位与轨迹" panel-style="height:244px;max-height:50%;flex:none" nopad
            body-style="padding:6px" :extra="mapExtra" :body-html="mapBody" />
          <UPanel title="告警详情与处置" panel-style="flex:1;min-height:0" nopad
            extra='<span id="alSt"></span>' body-html='<div id="alDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
        </div>
      </div>
    </div>
  </div>
</template>
