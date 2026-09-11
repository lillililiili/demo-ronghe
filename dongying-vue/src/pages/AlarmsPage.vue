<script>
/* 模块级状态：跨导航保持（legacy 约定）。
   level/status 映射为服务端契约的 severity/state；kind/region 为类别、区域筛选（阶段 15 契约）；
   sort/order 随列表与导出请求一起发给服务端（阶段 15 契约白名单四个键），页面不做假排序。 */
const S = {
  st: { page: 1, size: 10, level: '全部', status: '全部', kind: '全部', region: '全部', sel: null, selId: null,
    sort: 'received_at', order: 'desc' }
};
export default {};
</script>

<script setup>
/* 异常飞行与告警中心 —— 转换页（源：legacy pages/alarms.js）。
   阶段 4：数据真源全部改为 alarmApi.js（apiRequest 唯一入口）。本流程不再读写
   window.MOCK / window.EVT；API 失败显示错误并允许重试，不回退 Mock。
   页面骨架（KPI / 工具条 / 列头 / 列表 + 分页 / 地图 / 详情 / 处置步骤与动作区）
   沿用 HEAD 版本的 DOM 结构与 class 名，只替换数据源与状态口径。
   地图（MapView）在 onUnmounted 销毁；usePageChrome 先注册，故卸载顺序
   与旧版 route() 一致：CH.disposeAll → map.destroy → closeModal。 */
import { ref, reactive, onMounted, onUnmounted } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import { handoffApi } from '@/services/handoffApi.js';
import { openFormModal } from '@/ui/formModal.js';
import { closeModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import { exportAlarmsCsv, getAlarm, getUavEvent, listAlarmDistricts, listAlarms } from '@/services/alarmApi.js';
import { getEvidenceChain } from '@/services/evidenceApi.js';
import { openUavVerification } from '@/ui/uavVerificationModal.js';
import { targetApi } from '@/services/targetApi.js';
import { ALARM_PROGRESS_LABEL, ALARM_PROGRESS_TAG, ALARM_TYPE_LABEL, DISPOSAL_ACTIVE_STATUSES, DISPOSAL_ACTION_LABEL, disposalMainlineCompleted, disposalStatusText, labelOf, LEGALITY_LABEL, readableNo, SOURCE_MODE_LABEL as MODE_TEXT, targetTypeLabel } from '@/ui/labels.js';
import { openEvidenceFileModal } from '@/ui/evidenceFileDetail.js';
import { openEvidenceChainTypeModal, renderEvidenceChainHtml } from '@/ui/evidenceChainView.js';
import { disposalApi, isDisposalUnavailable } from '@/services/disposalApi.js';
import { DISPOSAL_UNAVAILABLE_TEXT, openDisposalRequest } from '@/ui/disposalAuthModal.js';
import { canRouteAction, hasPermission } from '@/services/accessControl.js';
import { deviceApi } from '@/services/deviceApi.js';
import { openTrackReplay, trackPointsOf } from '@/ui/trackReplayModal.js';

const U = window.UI;
usePageChrome('alarms');
const root = ref(null);
/* reactive 代理同一份模块级状态：n-pagination 的 :page/:page-size 需要响应式，
   底层对象仍是 S.st，跨导航记忆不变 */
const st = reactive(S.st);
const totalCount = ref(0);
let map = null;
onUnmounted(() => { if (map) map.destroy(); map = null; });

/* ---------- 契约词典（阶段 4 固定） ---------- */
const SEVERITY = {
  CRITICAL: { t: '紧急', c: 't-red', tone: 'bad' }, HIGH: { t: '高', c: 't-red', tone: 'bad' },
  MEDIUM: { t: '中', c: 't-amber', tone: 'warn' }, LOW: { t: '低', c: 't-blue', tone: 'info' }
};
/* CONFIRMED 仍是核实结论。列表「状态」列在已核实后按处置进度改写展示，不改 uav_event.state。 */
const STATE = {
  PENDING_VERIFICATION: { t: '待核实', c: 't-amber', color: '#ffb020' },
  CONFIRMED: { t: '已核实，待处置', c: 't-cyan', color: '#22d3ee' },
  FALSE_POSITIVE: { t: '误报', c: 't-blue', color: '#8fbaff' }
};
const STATE_FILTER = { ...STATE, CONFIRMED: { ...STATE.CONFIRMED, t: '已核实（含处置中）' } };
const NO_EVENT = { t: '未建事件', c: 't-gray', color: '#8ca0be' };
const SOURCE_MODE = { mock: { t: MODE_TEXT.mock, c: 't-purple' }, replay: { t: MODE_TEXT.replay, c: 't-amber' }, live: { t: MODE_TEXT.live, c: 't-green' } };
/* 类别来自共享字典；区域来自本页的区域字典接口，读不到就把下拉标成"不可用"并在 title 说明原因。 */
const KIND_OPTS = [{ v: '全部', t: '全部' }, ...Object.keys(ALARM_TYPE_LABEL).map(v => ({ v, t: ALARM_TYPE_LABEL[v] }))];
const districts = ref([]);
const districtError = ref('');
const regionOpts = () => (districtError.value
  ? [{ v: '全部', t: '全部' }, { v: '', t: '不可用', disabled: true }]
  : [{ v: '全部', t: '全部' }, ...districts.value.map(d => ({ v: d.district_id, t: d.name }))]);

const LEVEL_OPTS = [{ v: '全部', t: '全部' }, { v: 'CRITICAL', t: '紧急' }, { v: 'HIGH', t: '高' }, { v: 'MEDIUM', t: '中' }, { v: 'LOW', t: '低' }];
const STATUS_OPTS = [{ v: '全部', t: '全部' }, ...Object.entries(STATE_FILTER).map(([v, s]) => ({ v, t: s.t }))];
const pageProgress = {};

/* ---------- 通用小工具：服务端字符串一律转义后才进 innerHTML ---------- */
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const el = id => document.getElementById(id);
function fmt(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const clock = ms => fmt(ms).slice(11) || '—';
const sevOf = a => SEVERITY[a.severity] || { t: esc(a.severity || '—'), c: 't-gray', tone: 'info' };
const stateOf = a => a.event_id ? (STATE[a.state] || { t: esc(a.state || '状态未知'), c: 't-gray', color: '#8ca0be' }) : NO_EVENT;
function deriveAlarmProgress(auths, handoffs) {
  if ((handoffs || []).some(h => !h.handoff_type || h.handoff_type === 'UAV_PUNISHMENT')) return 'HANDED_OFF';
  const latest = type => {
    const rows = (auths || []).filter(row => row.action_type === type);
    if (!rows.length) return null;
    return rows.reduce((a, b) => (Number(b.requested_at || 0) >= Number(a.requested_at || 0) ? b : a));
  };
  const jam = latest('JAMMING'), cm = latest('COUNTERMEASURE');
  const live = status => status === 'APPROVED' || status === 'EXECUTING';
  if (jam && live(jam.status)) return 'JAMMING_ACTIVE';
  if (jam && jam.status === 'COMPLETED') return 'JAMMING_DONE';
  if (jam && jam.status === 'REQUESTED') return 'PENDING_APPROVAL';
  if (cm && live(cm.status)) return 'COUNTERMEASURE_ACTIVE';
  if (cm && cm.status === 'COMPLETED') return 'COUNTERMEASURE_DONE';
  if (cm && cm.status === 'REQUESTED') return 'PENDING_APPROVAL';
  return null;
}
function displayState(a) {
  if (!a || a.state !== 'CONFIRMED' || !a.event_id) return stateOf(a);
  let key = pageProgress[a.event_id];
  if (cur.alarm && cur.alarm.alarm_id === a.alarm_id) {
    const fromDetail = deriveAlarmProgress(Object.values(disposal.byAction), disposal.handoff ? [disposal.handoff] : []);
    if (fromDetail) key = fromDetail;
  }
  if (!key || !ALARM_PROGRESS_LABEL[key]) return stateOf(a);
  return { t: ALARM_PROGRESS_LABEL[key], c: ALARM_PROGRESS_TAG[key] || 't-cyan', color: '#22d3ee' };
}
const typeOf = a => ALARM_TYPE_LABEL[a.alarm_type] || esc(a.alarm_type || '—');
/* 只上屏业务编号；引擎标识（eval:…）不是编号，列里显示 —，内部 ID 留在 title。 */
const noOf = a => readableNo(a.alarm_no) || '—';
const modeOf = a => SOURCE_MODE[a.source_mode] || { t: esc(a.source_mode || '—'), c: 't-gray' };
const sevTag = a => U.tag(sevOf(a).t, sevOf(a).c);
const stateTag = a => U.tag(displayState(a).t, displayState(a).c);
function messageOf(e) {
  if (!e) return '请求失败，请稍后重试';
  if (e.status === 401) return '登录已失效，请重新登录';
  if (e.status === 403) return '当前账号没有相应权限';
  if (e.code === 'TIMEOUT' || e.code === 'NETWORK_ERROR') return e.message || '服务不可用，请稍后重试';
  return e.message || '请求失败，请稍后重试';
}
/* 只信任 WGS84 且数值在合法区间的坐标；未知/不可信不画点，也不以 (0,0) 补位。 */
function coord(loc, issues, field) {
  if (!loc || loc.coordinate_system !== 'WGS84') return null;
  if (field && Array.isArray(issues) && issues.some(i => i && i.field === field)) return null;
  const lon = Number(loc.longitude), lat = Number(loc.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) return null;
  return { lon, lat };
}

/* ---------- 页面数据（服务端事实的一次性快照，不作为状态机真源） ---------- */
const list = { rows: [], loading: false, error: '' };
let listSeq = 0, detailSeq = 0;
const emptyDetail = () => ({ alarm: null, event: null, loading: false, error: '',
  target: null, targetLoading: false, targetError: '', track: null, trackError: '',
  chain: null, chainLoading: false, chainError: '', chainUnavailable: '',
  eoTask: null, eoTaskError: '' });
let cur = emptyDetail();
/* 深链（sessionStorage alarm.sel）—— 与 legacy render() 同构：mount 后按 ID 直接向服务端取详情 */
const deepId = sessionStorage.getItem('alarm.sel');
sessionStorage.removeItem('alarm.sel');

/* ---------- KPI：全部由服务端 total 得出；无法由后端得出的指标显示「尚未接入」 ---------- */
/* 当前选中事件的处置授权：按动作类型取最新一条，供流程步骤与按钮显示真实状态。
   读不到（13.1 未落地时是 404）就记下原因并显示“尚未接入”，绝不假装“无授权”。 */
const disposal = reactive({ byAction: {}, unavailable: false, error: '', handoff: null });
const DISPOSAL_ACTIVE = ['APPROVED', 'EXECUTING'];

async function loadEventDisposals(eventId) {
  disposal.byAction = {}; disposal.unavailable = false; disposal.error = ''; disposal.handoff = null;
  if (!eventId) return;
  try {
    const page = await disposalApi.list({ subject_kind: 'UAV_EVENT', subject_id: eventId, page: 1, size: 50 });
    // 同一动作可能申请过多次：按申请时间取最新一条代表当前状态。
    for (const row of page?.items || []) {
      const prev = disposal.byAction[row.action_type];
      if (!prev || Number(row.requested_at || 0) >= Number(prev.requested_at || 0)) disposal.byAction[row.action_type] = row;
    }
  } catch (error) {
    disposal.unavailable = isDisposalUnavailable(error);
    disposal.error = disposal.unavailable ? DISPOSAL_UNAVAILABLE_TEXT : messageOf(error);
  }
  try {
    const page = await handoffApi.listHandoffs({ source_kind: 'UAV_EVENT', source_id: eventId, page: 1, size: 5 });
    disposal.handoff = (page?.items || []).find(row => row.handoff_type === 'UAV_PUNISHMENT') || (page?.items || [])[0] || null;
  } catch { disposal.handoff = null; }
}

const KPI_DEFS = [
  { label: '今日告警总数', color: 'blue', icon: 'alert' },
  { label: '待核实', color: 'amber', icon: 'alert' },
  { label: '反制中', color: 'orange', icon: 'radar' },
  { label: '干扰中', color: 'red', icon: 'radar' },
  { label: '待处置', color: 'green', icon: 'check' },
  { label: '误报', color: 'purple', icon: 'check' }
];
const kpiList = ref(KPI_DEFS.map(k => ({ ...k, value: '…', desc: '' })));
/* 区域字典：读不到就只留"全部"，并在筛选项 title 说明——不能凭当前页的数据拼一份看着像全量的区域列表。 */
async function loadDistricts() {
  try {
    const rows = await listAlarmDistricts();
    districts.value = (Array.isArray(rows) ? rows : rows?.items || []).filter(d => d.enabled !== false);
    paintRegionOptions();
  } catch (error) {
    districtError.value = messageOf(error);
    paintRegionOptions();
  }
}

/* 工具条是一次性拼好的 HTML，区域选项在字典读回来之前就定型了；读回后补进去，
   读失败就只留"全部"并在 title 说明，不留一个看着能用其实是空的下拉。 */
function paintRegionOptions() {
  const select = document.querySelector('select[data-f="region"]');
  if (!select) return;
  const current = st.region;
  select.innerHTML = regionOpts()
    .map(o => `<option value="${esc(o.v)}"${o.disabled ? ' disabled' : ''}${o.v === current ? ' selected' : ''}>${esc(o.t)}</option>`).join('');
  select.title = districtError.value
    ? `暂时读不到区域字典：${districtError.value}`
    : (districts.value.length ? '' : '当前没有可选区域');
}

/* 导出：与列表同参（含排序与筛选），走 apiDownload 取 blob 后交浏览器保存，
   与统计页、证据台账、审计日志三处既有导出同一写法。 */
async function exportCsv() {
  try {
    const file = await exportAlarmsCsv(queryOf());
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;      // 文件名由服务端的 Content-Disposition 决定
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已开始下载告警列表', 'ok');
  } catch (error) {
    toast(error?.code === 'EXPORT_TOO_LARGE'
      ? '导出行数超过上限（5000 行），请缩小筛选范围后重试'
      : messageOf(error) || '导出失败', 'err');
  }
}

async function loadKpis() {
  const count = q => listAlarms({ ...q, page: 1, size: 1 }).then(p => Number(p && p.total) || 0);
  /* “反制中 / 干扰中”问的是当前有多少处置在进行，因此按状态计数（契约的列表接口没有日期过滤，
     跨页在前端数日期会数错）。EXECUTING 是正在执行，APPROVED 是已批准待执行，两者分开报。 */
  const disposalCount = actionType => Promise.all(DISPOSAL_ACTIVE.map(status =>
    disposalApi.list({ action_type: actionType, status, page: 1, size: 1 }).then(p => Number(p && p.total) || 0)
  )).then(([approved, executing]) => ({ approved, executing }));
  // 非展示用：算 KPI 查询窗口（今日 / 近 30 天）的时间戳边界，只当查询参数发给服务端。
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = from + 86400000, d30 = from - 29 * 86400000;
  const r = await Promise.allSettled([
    count({ occurred_from: from, occurred_to: to }), count({ occurred_from: d30, occurred_to: to }),
    count({ state: 'PENDING_VERIFICATION' }),
    count({ state: 'CONFIRMED' }), count({ state: 'FALSE_POSITIVE' }),
    disposalCount('COUNTERMEASURE'), disposalCount('JAMMING')
  ]);
  const v = r.map(x => x.status === 'fulfilled' ? x.value : null);
  const num = x => x == null ? '—' : U.num(x);
  /* 处置授权读不到时如实说明原因，不写 0——“没有在执行”与“读不到”是两件事。 */
  const disposalKpi = (def, settled, value) => {
    if (!value) {
      const unavailable = settled?.reason && isDisposalUnavailable(settled.reason);
      return { ...def, value: unavailable ? '尚未接入' : '—', desc: unavailable ? DISPOSAL_UNAVAILABLE_TEXT : '读取失败：' + esc(messageOf(settled?.reason)) };
    }
    return { ...def, value: U.num(value.executing), desc: `另有 ${U.num(value.approved)} 起已批准待执行` };
  };
  const fail = i => v[i] == null ? '读取失败：' + esc(messageOf(r[i].reason)) : null;
  kpiList.value = [
    { ...KPI_DEFS[0], value: num(v[0]), desc: fail(0) || `近30天 ${num(v[1])} 起（按发生时间统计，发生时间未知者不计）` },
    { ...KPI_DEFS[1], value: num(v[2]), desc: fail(2) || '待人工核实的事件数' },
    disposalKpi(KPI_DEFS[2], r[5], v[5]),
    disposalKpi(KPI_DEFS[3], r[6], v[6]),
    { ...KPI_DEFS[4], value: num(v[3]), desc: fail(3) || '已核实、待处置的事件数；反制与处罚交接见详情动作' },
    { ...KPI_DEFS[5], value: num(v[4]), desc: fail(4) || '人工核实后已排除' }
  ];
}

/* ---------- 工具条：只暴露契约支持的过滤；不支持的保留控件但禁用并说明 ---------- */
const disabledSelect = (name, reason) =>
  `<select class="sel" data-f="${name}" disabled aria-disabled="true" title="${reason}"><option value="全部" selected>全部</option></select>`;
const listPanelBody = `<div class="toolbar">
    <div class="toolbar-fields">
      ${U.field('等级', U.select('level', LEVEL_OPTS, st.level))}
      ${U.field('类别', U.select('kind', KIND_OPTS, st.kind))}
      ${U.field('状态', U.select('status', STATUS_OPTS, st.status))}
      ${U.field('区域', U.select('region', regionOpts(), st.region))}
    </div>
    <div class="toolbar-actions">
      <button class="btn" type="button" id="alExp" title="按当前筛选与排序导出 CSV（上限 5000 行）">导出 CSV</button>
    </div>
  </div>
  <div id="alList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
const mapExtra = `<span id="alMapSrc" style="font-size:11px;color:var(--txt-3);white-space:nowrap"></span>
  <button class="btn" id="alLoc" style="height:24px;font-size:11.5px;flex:none" title="重新定位到当前告警的关联目标">${U.icon('location')} 定位</button>`;
const mapBody = `<div id="alMap" style="flex:1;min-height:0"></div>
    <div id="alMapInfo" style="flex:none;height:19px;line-height:19px;padding:2px 2px 0;font-size:10.5px;
      color:var(--txt-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>`;

/* 列头排序走服务端 sort/order（契约只支持这四个键）；不支持的列保持禁用并说明——
   在前端对当前一页重排会得出一个与全局顺序不符的假名次。 */
const SORT_KEYS = { ts: 'received_at', occurred: 'occurred_at', level: 'severity', status: 'state' };
const SORT_NOT_SUPPORTED = '服务端不支持按该列排序；在前端对当前一页重排会给出与全局顺序不符的名次';
function sortTh(key, label) {
  const field = SORT_KEYS[key];
  if (!field) {
    return `<span class="lnk" data-sort="${key}" role="button" tabindex="0" aria-disabled="true" title="${SORT_NOT_SUPPORTED}"
      style="color:inherit;cursor:not-allowed;text-decoration:underline dotted;text-underline-offset:3px;text-decoration-color:rgba(156,198,255,.3)"
      >${label}</span>`;
  }
  const on = st.sort === field;
  const arrow = on ? `<span style="font-size:10px;margin-left:2px">${st.order === 'asc' ? '▲' : '▼'}</span>` : '';
  return `<span class="lnk" data-sort="${key}" role="button" tabindex="0" title="按${label}排序"
    style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px">${label}${arrow}</span>`;
}

function queryOf() {
  const q = { page: st.page, size: st.size, sort: st.sort, order: st.order };
  if (st.level !== '全部') q.severity = st.level;
  if (st.status !== '全部') q.state = st.status;
  if (st.kind !== '全部') q.alarm_type = st.kind;
  if (st.region !== '全部') q.district_id = st.region;
  return q;
}

function summaryOf(a) {
  const text = `${typeOf(a)} · 来源 ${esc(a.source_name || a.source_code || '—')}（${modeOf(a).t}）· 发生 ${fmt(a.occurred_at) || '未知'}`;
  return `<div title="${text}" style="white-space:normal;line-height:1.5;
        max-height:34px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${text}</div>`;
}

function listHtml() {
  if (list.loading && !list.rows.length) return `<div class="empty">正在读取告警列表…</div>`;
  if (list.error) return `<div class="empty">${esc(list.error)}<br><button class="btn" data-al="retry" style="margin-top:10px">重试</button></div>`;
  return U.table([
    {
      t: sortTh('ts', '告警编号 / 时间'), w: '108px', cls: 'num',
      render: a => U.cell(esc(noOf(a)), clock(a.received_at), { mono: true, title: esc(a.alarm_id) })
    },
    { t: sortTh('level', '等级'), w: '52px', align: 'center', render: sevTag },
    { t: sortTh('kind', '类别 / 类型'), w: '128px', render: a => U.cell(U.tag(modeOf(a).t, modeOf(a).c), typeOf(a)) },
    { t: sortTh('district', '关联目标 / 区域'), w: '146px', render: a => U.cell(a.target_id ? esc(a.target_no || a.target_id) : '—', esc(a.district_name || a.district_id || '—'), { mono: true, title: a.target_id ? esc(a.target_id) : '无关联目标或无目标读取权限' }) },
    { t: '告警内容', render: summaryOf },
    { t: sortTh('status', '状态'), w: '86px', render: stateTag }
  ], list.rows, { rowId: a => a.alarm_id, activeId: cur.alarm && cur.alarm.alarm_id });
}

/* ---------- 处置流程与动作：只有人工核实接入；其余节点/按钮保留位置但禁用并说明 ---------- */
function disposalSteps(a, ev) {
  const trigger = { n: '告警触发', t: clock(a.received_at), done: true, act: false };
  /* 反制 / 信号干扰按该事件的最新授权显示状态；读不到时说“尚未接入”，没有授权时说“尚无授权”，
     两者不能混为一谈。处置是处罚交接：有交接且反制或干扰已完成才标完成，避免种子直插交接时跳过中间两步。 */
  const step = actionType => {
    const name = labelOf(DISPOSAL_ACTION_LABEL, actionType);
    if (disposal.unavailable || disposal.error) return { n: name, t: disposal.error || DISPOSAL_UNAVAILABLE_TEXT, done: false, act: false, applicable: false };
    const auth = disposal.byAction[actionType];
    if (!auth) return { n: name, t: '尚无授权', done: false, act: false, applicable: true };
    return {
      n: name,
      t: disposalStatusText(auth),
      done: auth.status === 'COMPLETED',
      act: DISPOSAL_ACTIVE_STATUSES.includes(auth.status),
      applicable: true
    };
  };
  const cm = step('COUNTERMEASURE');
  const jam = step('JAMMING');
  const punish = disposal.handoff;
  const authUnknown = !!(disposal.unavailable || disposal.error);
  const mainlineDone = authUnknown || disposalMainlineCompleted(disposal.byAction.COUNTERMEASURE, disposal.byAction.JAMMING);
  const tail = [cm, jam, {
    n: '处置',
    t: punish ? (mainlineDone ? '已移送' : '已移送（未完成反制/干扰）') : '待移送',
    done: !!punish && mainlineDone,
    act: false,
    applicable: true
  }];
  if (!ev) return [trigger, { n: '人工核实', t: '未建事件', done: false, act: false }, ...tail];
  if (ev.state === 'FALSE_POSITIVE') return [trigger, { n: '人工核实', t: '误报', done: true, act: false }];
  if (ev.state === 'CONFIRMED') return [trigger, { n: '人工核实', t: '属实', done: true, act: false }, ...tail];
  return [trigger, { n: '人工核实', t: '', done: false, act: true }, ...tail];
}

function disposalActions(a, ev) {
  const dis = (key, label, reason, cls) => `<button class="btn ${cls || ''}" data-al="${key}" disabled title="${reason}">${label}</button>`;
  if (!ev) return dis('verify', '人工核实', '尚未创建核实事件，无法核实');
  if ((ev.allowed_actions || []).includes('VERIFY')) return `<button class="btn pri" data-al="verify">人工核实</button>`;
  if (ev.state === 'CONFIRMED') {
    /* 已核实的事件可以发起联动反制申请：按钮本身只负责“提申请”，能不能执行由审批与时限决定。 */
    /* 已有未了结的反制或干扰时服务端会拒绝再发起同类授权，按钮直接禁用。 */
    const cm = disposal.byAction.COUNTERMEASURE, jam = disposal.byAction.JAMMING;
    const active = [cm, jam].find(row => row && DISPOSAL_ACTIVE_STATUSES.includes(row.status));
    const completed = [cm, jam].some(row => row && row.status === 'COMPLETED');
    const jamLive = jam && DISPOSAL_ACTIVE_STATUSES.includes(jam.status);
    const activeText = active ? `已有处置申请（${labelOf(DISPOSAL_ACTION_LABEL, active.action_type)} ${disposalStatusText(active)}），了结前不能再次发起` : '';
    const counter = disposal.unavailable || disposal.error
      ? dis('counter', `${U.icon('bolt')} 发起联动反制`, esc(disposal.error || DISPOSAL_UNAVAILABLE_TEXT), 'danger')
      : activeText
        ? dis('counter', `${U.icon('bolt')} 发起联动反制`, esc(activeText), 'danger')
        : `<button class="btn danger" data-al="counter">${U.icon('bolt')} 发起联动反制</button>`;
    const punish = disposal.handoff
      ? dis('punish', '提交处罚交接', '已提交处罚交接')
      : jamLive
        ? dis('punish', '提交处罚交接', '信号干扰尚未完成')
        : !completed
          ? dis('punish', '提交处罚交接', '需先完成反制或干扰')
          : `<button class="btn" data-al="punish">提交处罚交接</button>`;
    return counter + ` ${punish}`;
  }
  if (ev.state === 'FALSE_POSITIVE') return '';
  return dis('verify', '人工核实', '当前账号缺少核实权限（alarm:verify），或事件不在可核实状态');
}

function detailHtml() {
  const a = cur.alarm, stEl = el('alSt');
  if (!a) {
    if (stEl) stEl.innerHTML = '';
    if (cur.loading) return '<div class="empty">正在读取告警详情…</div>';
    if (cur.error) return `<div class="empty">${esc(cur.error)}<br><button class="btn" data-al="retry-detail" style="margin-top:10px">重试</button></div>`;
    return '<div class="empty">请选择告警</div>';
  }
  if (stEl) stEl.innerHTML = stateTag(a);
  const ev = cur.event, t = cur.target, ls = t && t.latest_state;
  const replayN = replayPointCount();
  const targetType = !a.target_id ? '—' : cur.targetLoading ? '读取中…' : cur.targetError ? '读取失败' : esc(t ? targetTypeLabel(t.subtype, t.object_type_code) : '—');
  const altSpeed = ls ? `${ls.altitude_amsl_m == null ? '—' : esc(ls.altitude_amsl_m)} m / ${ls.speed_mps == null ? '—' : esc(ls.speed_mps)} m/s` : '— m / — m/s';
  return `${U.detailHero({
    icon: 'alert', subtitle: '告警事件', title: typeOf(a), id: esc(noOf(a)),
    tags: [sevTag(a), stateTag(a)],
    meta: [['区域', esc(a.district_name || a.district_id || '—')], ['时间', clock(a.received_at)]]
  })}
    ${U.metricStrip([
      { label: '告警等级', value: sevOf(a).t, tone: sevOf(a).tone, icon: 'alert' },
      { label: '处置状态', value: displayState(a).t, tone: a.state === 'CONFIRMED' || a.state === 'FALSE_POSITIVE' ? 'info' : 'warn', icon: 'play' },
      { label: '目标类型', value: targetType, icon: 'plane' }
    ], { compact: true })}
    ${U.sect('处置流程', U.steps(disposalSteps(a, ev)), { icon: 'trend' })}
    ${U.sect('告警信息', U.kv([
    ['告警类型', typeOf(a)], ['告警等级', sevTag(a)],
    ['触发时间', fmt(a.occurred_at) || '未知'], ['接收时间', fmt(a.received_at) || '—'],
    ['所在区域', esc(a.district_name || a.district_id || '—')], ['所属机构', esc(a.owner_org_name || a.owner_org_id || '—')],
    ['关联目标', a.target_id ? `<span class="mono" title="${esc(a.target_id)}">${esc(a.target_no || a.target_id)}</span>` : '无关联目标或无目标读取权限'],
    ['目标类型', targetType],
    ['高度/速度', altSpeed],
    ['数据来源', `${esc(a.source_name || a.source_code || '—')}（${modeOf(a).t}）`]
  ], { surface: true, density: 'compact' }), { icon: 'alert' })}
    ${renderEvidenceChainHtml(cur.chain, {
      loading: cur.chainLoading, error: cur.chainError, unavailable: cur.chainUnavailable
    })}
    ${U.detailActions(`
      <button class="btn" data-al="video" disabled title="协议未提供实时视频流">${U.icon('video')} 实时视频</button>
      <button class="btn" data-al="replay" ${replayN > 1 ? '' : 'disabled '}title="${replayN > 1 ? '按实测轨迹在地图上走航线回放，不是视频' : '没有足够的轨迹点'}">${U.icon('trend')} 轨迹回放</button>
      ${eoTrackActions(a)}
      ${disposalActions(a, ev)}`)}`;
}

function eoTrackActions(a) {
  const open = cur.eoTask && (cur.eoTask.status === 'OPEN' || cur.eoTask.status === 'ENDING');
  // 跟踪由后台自动启停。误报结束处置后不再提供人工启动入口。
  if (a.state === 'FALSE_POSITIVE') {
    return open ? U.tag('正在自动结束', 't-blue') : '';
  }
  const canEo = canRouteAction('devices', 'op');
  if (!canEo) {
    return `<button class="btn" data-al="eo-track" disabled title="需要设备管理的操作权限">人工补跟踪</button>`;
  }
  if (!a.target_id) {
    return `<button class="btn" data-al="eo-track" disabled title="该告警没有关联目标，无法引导光电设备">人工补跟踪</button>`;
  }
  if (open) {
    return U.tag(cur.eoTask.status === 'ENDING' ? '正在自动结束' : '自动跟踪中', 't-cyan');
  }
  return `<button class="btn" data-al="eo-track" title="自动跟踪未启动时，手动补发跟踪指令">人工补跟踪</button>`;
}

function paintList() { const host = el('alList'); if (host) host.innerHTML = listHtml(); }
function paintDetail() { const host = el('alDetail'); if (host) host.innerHTML = detailHtml(); }

/* ---------- 地图：只有响应含 target_id（服务端已按 target:read 与范围元组裁剪）才读目标/轨迹 ---------- */
function focusMap() {
  if (!map) return;
  const info = el('alMapInfo'), srcEl = el('alMapSrc'), a = cur.alarm;
  const setInfo = (html, title) => { if (info) { info.innerHTML = html; info.title = title || ''; } };
  const warn = text => `<span class="inline-icon" style="color:#ffd07a">${U.icon('warning')} ${text}</span>`;
  map.sel = null;
  map.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
  if (srcEl) srcEl.textContent = '';
  if (!a) return setInfo(cur.loading ? '正在读取告警…' : '请选择告警');
  if (!a.target_id) return setInfo(warn('无关联目标或无目标读取权限，无法定位'));
  if (cur.targetLoading) return setInfo('正在读取关联目标…');
  if (cur.targetError) return setInfo(warn(`关联目标 ${esc(a.target_no || a.target_id)} 读取失败：${esc(cur.targetError)}`));
  const t = cur.target, ls = t && t.latest_state;
  const pos = ls ? coord(ls.location, ls.field_issues, 'location') : null;
  const pts = ((cur.track && cur.track.points) || []).map(p => {
    const c = coord(p.location);
    return c ? { lon: c.lon, lat: c.lat, alt: p.altitude_amsl_m == null ? null : Number(p.altitude_amsl_m), t: p.sort_time, kind: 'meas' } : null;
  }).filter(Boolean);
  const last = pos || (pts.length ? pts[pts.length - 1] : null);
  if (!t || !last) return setInfo(warn(`关联目标 ${esc(t?.target_no || a.target_no || a.target_id)} 坐标未知或不可信，不以 (0,0) 补位，无法定位`));
  const subtype = targetTypeLabel(t.subtype, t.object_type_code, '目标');
  const target = {
    id: t.target_no || t.target_id, lon: last.lon, lat: last.lat,
    alt: ls && ls.altitude_amsl_m != null ? Number(ls.altitude_amsl_m) : null,
    speed: ls && ls.speed_mps != null ? Number(ls.speed_mps) : null,
    heading: ls && ls.heading_deg != null ? Number(ls.heading_deg) : 0,
    // 合法性判定阶段 4 未接入：不向 MapView 传任何结论词（'待确认' 等），maptip 与信息栏同文案。
    type: targetTypeLabel(null, t.object_type_code, '目标'), subtype,
    legal: t.legality_summary && t.legality_summary.legal_status
      ? labelOf(LEGALITY_LABEL, t.legality_summary.legal_status, t.legality_summary.legal_status) : '—',
    risk: t.risk_summary && t.risk_summary.severity ? esc(t.risk_summary.severity) : '—', tracked: true,
    track: pts.length > 1 ? pts : []
  };
  map.sel = target.id;
  map.setData({
    airspaces: [], devices: [], targets: [target],
    alarms: [{ id: a.alarm_id, targetId: target.id, type: typeOf(a), level: sevOf(a).t, time: fmt(a.received_at), status: displayState(a).t }]
  });
  if (map.w) map.centerAt(last.lon, last.lat);
  const trackNote = pts.length > 1 ? `实测轨迹 · ${pts.length} 点` : cur.trackError ? `轨迹读取失败：${esc(cur.trackError)}` : '仅最新位置，无可信轨迹点';
  if (srcEl) srcEl.innerHTML = pts.length > 1
    ? `<span class="tag t-amber" title="/api/v1/targets/{id}/tracks 最新一条轨迹的最近点位（WGS84）">实测轨迹</span> <span style="color:#8fbaff">实${pts.length}</span>`
    : `<span class="tag t-gray" title="${cur.trackError ? esc(cur.trackError) : '该目标暂无可信轨迹点'}">无轨迹</span>`;
  setInfo(`<span class="mono" style="color:var(--txt-2)" title="${esc(t.target_id)}">${esc(t.target_no || t.target_id)}</span> · ${esc(subtype)} · 合法性 ${esc(target.legal)} · 高度 ${target.alt == null ? '—' : esc(target.alt) + ' m'} · ${trackNote}`,
    `${t.target_no || t.target_id}｜${subtype}｜高度 ${target.alt == null ? '—' : target.alt + ' m'}\n${trackNote}`);
}

/* ---------- 数据加载 ---------- */
async function loadList() {
  const my = ++listSeq;
  list.loading = true; list.error = '';
  paintList();
  try {
    const page = await listAlarms(queryOf());
    if (my !== listSeq) return;
    list.rows = Array.isArray(page && page.items) ? page.items : [];
    totalCount.value = Number(page && page.total) || 0;
    list.loading = false;
    if (!list.rows.length && st.page > 1 && totalCount.value) {
      st.page = Math.max(1, Math.ceil(totalCount.value / st.size));
      return loadList();
    }
    await loadPageProgress(list.rows, my);
    if (my !== listSeq) return;
  } catch (e) {
    if (my !== listSeq) return;
    // API 失败只显示错误并允许重试，绝不回退 Mock 列表。
    list.rows = []; totalCount.value = 0; list.loading = false; list.error = messageOf(e);
  }
  paintList();
}

async function loadPageProgress(rows, seq) {
  const ids = [...new Set((rows || []).map(row => row.event_id).filter(Boolean))];
  const next = {};
  await Promise.all(ids.map(async id => {
    try {
      const [disp, hands] = await Promise.all([
        disposalApi.list({ subject_kind: 'UAV_EVENT', subject_id: id, page: 1, size: 50 }),
        handoffApi.listHandoffs({ source_kind: 'UAV_EVENT', source_id: id, page: 1, size: 5 }).catch(() => ({ items: [] }))
      ]);
      next[id] = deriveAlarmProgress(disp?.items || [], hands?.items || []);
    } catch { next[id] = null; }
  }));
  if (seq !== listSeq) return;
  Object.keys(pageProgress).forEach(key => { delete pageProgress[key]; });
  Object.assign(pageProgress, next);
}

async function selectAlarm(id) {
  const my = ++detailSeq;
  st.selId = id; st.sel = null;
  cur = emptyDetail(); cur.loading = true;
  const listEl = el('alList');
  if (listEl) U.selectRow(listEl, id);
  paintDetail(); focusMap();
  try {
    const alarm = await getAlarm(id);
    if (my !== detailSeq) return;
    cur.alarm = alarm;
    if (alarm.event_id) {
      try {
        cur.event = await getUavEvent(alarm.event_id);
        if (my !== detailSeq) return;
        await loadEventDisposals(alarm.event_id);
        if (my !== detailSeq) return;
      } catch { if (my !== detailSeq) return; }
    }
  } catch (e) {
    if (my !== detailSeq) return;
    cur.error = messageOf(e);
  }
  if (cur.alarm && (cur.alarm.event_id || cur.alarm.target_id)) cur.chainLoading = true;
  cur.loading = false;
  paintDetail(); focusMap();
  await Promise.all([loadTarget(my), loadChain(my)]);
}

async function loadChain(my) {
  const a = cur.alarm;
  if (!a || my !== detailSeq) return;
  cur.chainLoading = true; cur.chainError = ''; cur.chainUnavailable = ''; cur.chain = null;
  paintDetail();
  /* 没有证据查看权限就不发这个请求（15-19②）：每选中一条告警都发一次注定被拒的请求，
     服务端留下一串无意义的拒绝记录，页面上还会显示成“读取失败”，而不是真正的原因。 */
  if (!hasPermission('evidence.read')) {
    cur.chainUnavailable = '当前账号没有证据查看权限，无法汇总证据链。';
    cur.chainLoading = false;
    paintDetail();
    return;
  }
  try {
    if (a.event_id) cur.chain = await getEvidenceChain('EVENT', a.event_id);
    else if (a.target_id) cur.chain = await getEvidenceChain('TARGET', a.target_id);
    else cur.chainUnavailable = '无核实事件且无关联目标，无法汇总证据链。';
  } catch (e) {
    if (my !== detailSeq) return;
    cur.chainError = e.status === 403 ? '当前账号没有证据查看权限，无法读取证据链' : messageOf(e);
  }
  if (my !== detailSeq) return;
  cur.chainLoading = false;
  paintDetail();
}

async function loadTarget(my) {
  const a = cur.alarm;
  if (!a || !a.target_id) return;
  cur.targetLoading = true;
  focusMap();
  try {
    const t = await targetApi.detail(a.target_id);
    if (my !== detailSeq) return;
    cur.target = t;
    try {
      const tracks = await targetApi.tracks(a.target_id, { page: 1, size: 1 });
      const track = tracks && Array.isArray(tracks.items) ? tracks.items[0] : null;
      if (track) {
        // 点位按时间升序分页：先取第一页得到 total，再取最后一页即最近 ≤100 个点位。
        let points = await targetApi.points(track.track_id, { page: 1, size: 100 });
        const total = Number(points && points.total) || 0;
        if (total > 100) points = await targetApi.points(track.track_id, { page: Math.ceil(total / 100), size: 100 });
        if (my !== detailSeq) return;
        cur.track = { id: track.track_id, points: Array.isArray(points && points.items) ? points.items : [] };
      }
    } catch (e) { if (my !== detailSeq) return; cur.trackError = messageOf(e); }
  } catch (e) {
    if (my !== detailSeq) return;
    cur.targetError = messageOf(e);
  }
  if (my !== detailSeq) return;
  cur.targetLoading = false;
  await loadEoTask(my);
  paintDetail(); focusMap();
}

async function loadEoTask(my) {
  const a = cur.alarm;
  cur.eoTask = null; cur.eoTaskError = '';
  if (!a || !a.target_id || !canRouteAction('devices', 'op')) return;
  try {
    cur.eoTask = await deviceApi.currentEoTrack(a.target_id);
  } catch (e) {
    if (my !== detailSeq) return;
    if (e.status !== 404) cur.eoTaskError = messageOf(e);
  }
}

async function beginEoTrack() {
  const a = cur.alarm;
  if (!a || !a.target_id) return toast('该告警没有关联目标', 'err');
  if (a.state === 'FALSE_POSITIVE') return toast('该告警已判定为误报，不能再启动跟踪', 'err');
  try {
    cur.eoTask = await deviceApi.beginEoTrack(a.target_id, { reason: '自动跟踪未启动，值班员人工补发' });
    toast('已补发光电跟踪指令', 'ok');
    paintDetail();
  } catch (e) { toast(e.message || '光电跟踪失败', 'err'); }
}

function replayPointCount() {
  return trackPointsOf((cur.track && cur.track.points) || []).length;
}

async function replayLoadedTrack() {
  await openTrackReplay({
    target: cur.target,
    trackId: cur.track && cur.track.id,
    points: (cur.track && cur.track.points) || [],
    alarm: cur.alarm
  });
}

async function refreshAfterWrite() {
  const id = cur.alarm && cur.alarm.alarm_id;
  await Promise.all([loadList(), id ? selectAlarm(id) : Promise.resolve(), loadKpis()]);
}

/* ---------- 人工核实：共享弹窗（与工作台同一实现，幂等键保留与 409/超时回读在弹窗内处理） ---------- */
function verifyModal() {
  const a = cur.alarm, ev = cur.event;
  if (!a || !ev) return toast('尚未创建核实事件，无法核实', 'err');
  openUavVerification({
    alarm: a,
    event: ev,
    refresh: async () => { await refreshAfterWrite(); return cur.event; }
  });
}

/* 发起联动反制申请：主体是这条已核实的无人机事件，策略与时限由服务端返回，前端不预设。 */
async function counterModal() {
  const a = cur.alarm, ev = cur.event;
  if (!a || !ev) return toast('尚未创建核实事件，无法发起处置申请', 'err');
  let policy = null;
  try { policy = await disposalApi.policies(); } catch { policy = null; }   // 策略读不到只影响提示文字，不阻断申请
  /* 决策 13-19：信号干扰与联动反制共用这一个入口，动作类型在弹窗里选，不给页面新增按钮。 */
  openDisposalRequest({
    actionType: 'COUNTERMEASURE',
    actionOptions: ['COUNTERMEASURE', 'JAMMING'],
    subjectKind: 'UAV_EVENT',
    subjectId: ev.event_id,
    subjectText: readableNo(a.alarm_no) || typeOf(a),
    policy,
    // refreshAfterWrite 会重读列表、详情（内含授权）与 KPI，详情重读后步骤与按钮即反映新状态。
    refresh: async () => {
      await refreshAfterWrite();
      return disposal.byAction.COUNTERMEASURE || disposal.byAction.JAMMING || null;
    }
  });
}

let handoffKey = '';
function newHandoffKey() {
  if (!handoffKey) handoffKey = `handoff-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  return handoffKey;
}

/* 提交处罚交接：选接收方后提交，expected_version 取当前事件版本（缺它服务端回 400，不是 409）。 */
async function punishModal() {
  const a = cur.alarm, ev = cur.event;
  if (!a || !ev) return toast('尚未创建核实事件，无法移送处罚', 'err');
  let recipients = [];
  try {
    const page = await handoffApi.listHandoffRecipients('UAV_PUNISHMENT');
    recipients = page?.items || page || [];
  } catch (error) {
    return toast(messageOf(error) || '读取处罚接收方失败', 'err');
  }
  if (!recipients.length) return toast('没有可用的处罚接收方，请先在系统管理里配置', 'err');
  openFormModal({
    title: '提交处罚交接',
    width: '560px',
    warning: '移送后由处罚部门在处罚页立案；提交成功只表示材料入库，不表示已发送或已立案。',
    fields: [{ key: 'recipient_id', label: '接收方', type: 'select', required: true,
      options: recipients.map(r => ({ value: r.recipient_id, label: r.display_name || r.recipient_id })) }],
    initial: { recipient_id: recipients[0].recipient_id },
    confirmText: '提交移送',
    validate: m => (m.recipient_id ? null : '请选择接收方'),
    onSubmit: async ({ recipient_id: recipientId }) => {
      try {
        await handoffApi.createHandoff({
          source_kind: 'UAV_EVENT', source_id: ev.event_id, handoff_type: 'UAV_PUNISHMENT',
          recipient_id: recipientId, expected_version: Number(ev.version)
        }, newHandoffKey());
        closeModal();
        handoffKey = '';                 // 明确成功后丢弃幂等键
        toast('已移送，可到处罚页立案', 'ok');
        await refreshAfterWrite();
      } catch (error) {
        // 服务端按码回：未核实 / 无已完成授权 / 已存在，都如实转述，不在前端预判。
        throw new Error(messageOf(error) || '提交处罚交接失败');
      }
    }
  });
}

function onPage(p2) { st.page = p2; loadList(); }
function onPageSize(s2) { st.size = s2; st.page = 1; loadList(); }

onMounted(async () => {
  const view = root.value;
  paintList(); paintDetail();
  map = new window.MapView(el('alMap'), {
    zoom: 2.2, maxDev: 0, maxAlarm: 1, legend: false, layers: { device: false }
  });
  focusMap();
  requestAnimationFrame(focusMap);

  U.on(view, '[data-row]', 'click', (e, row) => { if (row.dataset.row) selectAlarm(row.dataset.row); });
  /* 分页交互已由模板层 <n-pagination> 受控接管（P2），[data-pg]/[data-size] 委托删除 */
  U.on(view, '[data-f]', 'change', (e, ctl) => {
    if (ctl.disabled) return;
    st[ctl.dataset.f] = ctl.value; st.page = 1; loadList();
  });
  /* 点列头切 asc/desc；不支持的列（aria-disabled）只说明为什么不能排。 */
  const toggleSort = (btn) => {
    const field = SORT_KEYS[btn.dataset.sort];
    if (!field) return toast(SORT_NOT_SUPPORTED, 'err');
    if (st.sort === field) st.order = st.order === 'asc' ? 'desc' : 'asc';
    else { st.sort = field; st.order = 'desc'; }
    st.page = 1;
    loadList();
  };
  U.on(view, '[data-sort]', 'click', (e, btn) => toggleSort(btn));
  U.on(view, '[data-sort]', 'keydown', (e, btn) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(btn); } });
  U.on(view, '[data-al]', 'click', (e, btn) => {
    if (btn.disabled) return;
    const k = btn.dataset.al;
    if (k === 'verify') verifyModal();
    else if (k === 'counter') counterModal();
    else if (k === 'punish') punishModal();
    else if (k === 'retry') loadList();
    else if (k === 'retry-detail' && st.selId) selectAlarm(st.selId);
    else if (k === 'chain-retry' && st.selId) loadChain(detailSeq);
    else if (k === 'eo-track') beginEoTrack();
    else if (k === 'replay') replayLoadedTrack();
  });
  U.on(view, '[data-ev-file]', 'click', (e, btn) => {
    if (btn.dataset.evFile) openEvidenceFileModal(btn.dataset.evFile);
  });
  U.on(view, '[data-ev-chain-type]', 'click', (e, btn) => {
    if (btn.dataset.evChainType) openEvidenceChainTypeModal({ chain: cur.chain, type: btn.dataset.evChainType });
  });
  el('alLoc').onclick = () => { if (map) map.resetView(2.2); focusMap(); };
  const expBtn = el('alExp');
  if (expBtn) expBtn.onclick = () => exportCsv();
  loadDistricts();

  loadKpis();
  await loadList();
  // safe-default：深链 > 上次选中 > 当前页首条；用户可见可改
  const id = deepId || st.selId || (list.rows[0] && list.rows[0].alarm_id) || null;
  if (id) {
    selectAlarm(id);
    // 深链/默认选中的行可能落在列表滚动区外：把选中行滚到列表可视区中部。
    const selTr = document.querySelector('#alList tr.on');
    if (selTr && selTr.scrollIntoView) selTr.scrollIntoView({ block: 'center' });
  }
});
</script>

<template>
  <div class="view" id="view" ref="root" style="overflow:hidden">
    <div class="alarms-page" style="height:100%;min-height:0;display:flex;flex-direction:column">
      <UKpis :list="kpiList" />
      <div class="row" style="margin-top:12px;flex:1;min-height:0">
        <UPanel title="告警列表" panel-style="flex:6;min-width:0" nopad>
          <div style="display:contents" v-html="listPanelBody"></div>
          <div class="pager">
            <UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount"
              :prefix="`共 ${totalCount.toLocaleString()} 条`" @update:page="onPage" @update:page-size="onPageSize" />
          </div>
        </UPanel>
        <div class="col" style="flex:4;min-width:0">
          <UPanel title="关联目标定位与轨迹" panel-style="height:244px;max-height:50%;flex:none" nopad
            body-style="padding:6px" :extra="mapExtra" :body-html="mapBody" />
          <UPanel title="告警详情与处置" panel-style="flex:1;min-height:0" nopad
            extra='<span id="alSt"></span>' body-html='<div id="alDetail" style="flex:1;overflow:auto;padding:12px"></div>' />
        </div>
      </div>
    </div>
  </div>
</template>
