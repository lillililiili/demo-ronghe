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
import { useRoute } from 'vue-router';
import AuthorizationQueue from '@/pages/alarms/AuthorizationQueue.vue';
import { measuredMapPoints } from '@/services/trackPoints.js';
import { ref, reactive, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import { handoffApi } from '@/services/handoffApi.js';
import { toast } from '@/ui/nv.js';
import { exportAlarmsCsv, getAlarm, getUavEvent, listAlarmDistricts, listAlarms } from '@/services/alarmApi.js';
import { getEvidenceChain } from '@/services/evidenceApi.js';
import { openUavVerification } from '@/ui/uavVerificationModal.js';
import { targetApi } from '@/services/targetApi.js';
import { mapPool } from '@/services/apiClient.js';
import { ALARM_PROGRESS_LABEL, ALARM_PROGRESS_TAG, ALARM_TYPE_LABEL, DISPOSAL_ACTION_LABEL, labelOf, LEGALITY_LABEL, readableNo, sourceDescription, SOURCE_MODE_LABEL as MODE_TEXT, targetTypeLabel } from '@/ui/labels.js';
import { openEvidenceFileModal } from '@/ui/evidenceFileDetail.js';
import { openEvidenceChainTypeModal, renderEvidenceChainHtml } from '@/ui/evidenceChainView.js';
import { disposalApi, isDisposalUnavailable } from '@/services/disposalApi.js';
import { DISPOSAL_UNAVAILABLE_TEXT } from '@/ui/disposalAuthModal.js';
import { hasModuleAction, hasPermission } from '@/services/accessControl.js';
import { deviceApi } from '@/services/deviceApi.js';
import { openTrackReplay, trackPointsOf } from '@/ui/trackReplayModal.js';
import EmergencyStopPanel from '@/components/disposal/EmergencyStopPanel.vue';
import UavAdvisoryPanel from '@/components/disposal/UavAdvisoryPanel.vue';
import CounterLaunch from '@/pages/alarms/CounterLaunch.vue';
import TargetLiveVideo from '@/components/video/TargetLiveVideo.vue';
import { uavAdvisoryApi } from '@/services/uavAdvisoryApi.js';

const U = window.UI;
usePageChrome('alarms');
const root = ref(null);
const route = useRoute();
const activeTab = ref('alarms');
const authorizationScope = ref({ eventId: '', authorizationId: '', status: '' });
let authorizationKey = 0;
function openAuthorizations(value = {}) {
  authorizationScope.value = { eventId: value.eventId || '', authorizationId: value.authorizationId || '', status: value.status || '', key: ++authorizationKey };
  activeTab.value = 'authorizations';
}
watch(() => [route.query.tab, route.query.authorization, route.query.event], ([tab, id, event]) => {
  if (tab === 'authorizations' || id) openAuthorizations({ authorizationId: typeof id === 'string' ? id : '', eventId: typeof event === 'string' ? event : '' });
}, { immediate: true });
/* reactive 代理同一份模块级状态：n-pagination 的 :page/:page-size 需要响应式，
   底层对象仍是 S.st，跨导航记忆不变 */
const st = reactive(S.st);
let authorizationEventRequest = 0, authorizationPageActive = true;
onUnmounted(() => { authorizationPageActive = false; ++authorizationEventRequest; });
async function showAuthorizationEvent(eventId) {
  const request = ++authorizationEventRequest, scope = authorizationScope.value;
  try {
    const event = await getUavEvent(eventId);
    if (!authorizationPageActive || request !== authorizationEventRequest || activeTab.value !== 'authorizations' || scope !== authorizationScope.value) return;
    activeTab.value = 'alarms';
    await selectAlarm(event.alarm_id);
  } catch (error) { toast(error.message || '读取关联告警失败', 'err'); }
}
const totalCount = ref(0);
const emergencyEvent = ref(null);
const emergencyInfo = ref(null);
const advisorySubject = ref(null);
const advisoryLive = ref(null);
const videoSubject = ref(null);
const advisorySummaries = new Map();
let map = null;
onUnmounted(() => { ++listSeq; ++detailSeq; ++disposalSeq; if (map) map.destroy(); map = null; });

/* ---------- 契约词典（阶段 4 固定） ---------- */
const SEVERITY = {
  CRITICAL: { t: '紧急', c: 't-red', tone: 'bad' }, HIGH: { t: '高', c: 't-red', tone: 'bad' },
  MEDIUM: { t: '中', c: 't-amber', tone: 'warn' }, LOW: { t: '低', c: 't-blue', tone: 'info' }
};
/* 通知阻断不覆盖核实结论；有现场、授权或移送事实时再展示对应处置进度。 */
const STATE = {
  PENDING_VERIFICATION: { t: '待核实', c: 't-amber', color: '#ffb020' },
  CONFIRMED: { t: '告警已确认', c: 't-cyan', color: '#22d3ee' },
  FALSE_POSITIVE: { t: '误报', c: 't-blue', color: '#8fbaff' }
};
const STATE_FILTER = { ...STATE, CONFIRMED: { ...STATE.CONFIRMED, t: '告警已确认（含处置中）' } };
const NO_EVENT = { t: '未建事件', c: 't-gray', color: '#8ca0be' };
const NOTIFY_PHASE = {
  AUTO_SMS: { t: '自动短信', c: 't-cyan', color: '#22d3ee' },
  WATCHING: { t: '观察中', c: 't-amber', color: '#f1a43a' },
  AUTO_CALL: { t: '自动电话', c: 't-cyan', color: '#22d3ee' },
  AWAIT_COUNTER: { t: '待反制', c: 't-orange', color: '#fb923c' }
};
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
const pendingProgress = new Set();

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
  if ((handoffs || []).some(h => h.handoff_type === 'UAV_PUNISHMENT' && h.delivery_status && h.delivery_status !== 'FAILED')) {
    return 'HANDED_OFF';
  }
  const rows = (auths || []).filter(row => ['JAMMING', 'COUNTERMEASURE'].includes(row.action_type)
    && !['FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(row.status));
  if (!rows.length) return null;
  const latest = rows.reduce((a, b) => (Number(b.requested_at || 0) >= Number(a.requested_at || 0) ? b : a));
  if (latest.status === 'STOPPED') return 'COUNTER_STOPPED';
  const live = latest.status === 'APPROVED' || latest.status === 'EXECUTING';
  if (latest.action_type === 'JAMMING') {
    if (live) return 'JAMMING_ACTIVE';
    if (latest.status === 'COMPLETED') return 'JAMMING_DONE';
    if (latest.status === 'REQUESTED') return 'PENDING_APPROVAL';
  } else {
    if (live) return 'COUNTERMEASURE_ACTIVE';
    if (latest.status === 'COMPLETED') return 'COUNTERMEASURE_DONE';
    if (latest.status === 'REQUESTED') return 'PENDING_APPROVAL';
  }
  return null;
}
function displayState(a) {
  if (!a?.event_id || !['CONFIRMED', 'PENDING_VERIFICATION'].includes(a.state)) return stateOf(a);
  const autoHandoff = advisorySummaries.get(a.event_id)?.auto_handoff;
  const autoTransferred = !!autoHandoff?.handoff_id && !['FAILED', 'DISABLED', 'BLOCKED', 'WAITING'].includes(autoHandoff.status);
  const handedOff = autoTransferred || pageProgress[a.event_id] === 'HANDED_OFF';
  if (a.state !== 'CONFIRMED' && !handedOff) return stateOf(a);
  let key = handedOff ? 'HANDED_OFF' : pageProgress[a.event_id];
  if (cur.alarm && cur.alarm.alarm_id === a.alarm_id) {
    const fromDetail = deriveAlarmProgress(Object.values(disposal.byAction), disposal.handoff ? [disposal.handoff] : []);
    if (fromDetail) key = fromDetail;
  }
  if (!key || !ALARM_PROGRESS_LABEL[key]) {
    const summary = advisorySummaries.get(a.event_id);
    if (NOTIFY_PHASE[summary?.notify_phase]) return NOTIFY_PHASE[summary.notify_phase];
    if (!summary && pendingProgress.has(a.event_id)) return { t: '已核实，处置进度读取中', c: 't-gray', color: '#8ca0be' };
    return stateOf(a);
  }
  return { t: ALARM_PROGRESS_LABEL[key], c: ALARM_PROGRESS_TAG[key] || 't-cyan', color: '#22d3ee' };
}
function showCounterLaunch() {
  if (advisoryLive.value?.counter_launch_visible !== true || !cur.alarm?.event_id) return false;
  const key = deriveAlarmProgress(Object.values(disposal.byAction), disposal.handoff ? [disposal.handoff] : [])
    || pageProgress[cur.alarm.event_id];
  return !['JAMMING_DONE', 'COUNTER_STOPPED', 'HANDED_OFF'].includes(key);
}
const typeOf = a => ALARM_TYPE_LABEL[a.alarm_type] || esc(a.alarm_type || '—');
/* 只上屏业务编号；引擎标识（例如 eval 前缀）不是编号，列里显示 —，内部 ID 留在 title。 */
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
let disposalSeq = 0;

async function loadEventDisposals(eventId) {
  const seq = ++disposalSeq;
  const isCurrent = () => seq === disposalSeq && eventId === cur.alarm?.event_id;
  disposal.byAction = {}; disposal.unavailable = false; disposal.error = ''; disposal.handoff = null;
  if (!eventId) return;
  try {
    const page = await disposalApi.list({ subject_kind: 'UAV_EVENT', subject_id: eventId, page: 1, size: 50 });
    if (!isCurrent()) return;
    // 同一动作可能申请过多次：按申请时间取最新一条代表当前状态。
    for (const row of page?.items || []) {
      const prev = disposal.byAction[row.action_type];
      if (!prev || Number(row.requested_at || 0) >= Number(prev.requested_at || 0)) disposal.byAction[row.action_type] = row;
    }
  } catch (error) {
    if (!isCurrent()) return;
    disposal.unavailable = isDisposalUnavailable(error);
    disposal.error = disposal.unavailable ? DISPOSAL_UNAVAILABLE_TEXT : messageOf(error);
  }
  try {
    const page = await handoffApi.listHandoffs({ source_kind: 'UAV_EVENT', source_id: eventId, page: 1, size: 5 });
    if (!isCurrent()) return;
    disposal.handoff = (page?.items || []).find(row => row.handoff_type === 'UAV_PUNISHMENT') || null;
  } catch { if (isCurrent()) disposal.handoff = null; }
  return Object.values(disposal.byAction).sort((a, b) => Number(b.requested_at || 0) - Number(a.requested_at || 0))[0] || null;
}


const KPI_DEFS = [
  { label: '今日告警总数', color: 'blue', icon: 'alert' },
  { label: '待核实', color: 'amber', icon: 'alert' },
  { label: '反制中', color: 'orange', icon: 'radar' },
  { label: '干扰中', color: 'red', icon: 'radar' },
  { label: '待处置', color: 'cyan', icon: 'alert' },
  { label: '误报', color: 'blue', icon: 'check' }
];
const kpiList = ref(KPI_DEFS.map(k => ({ ...k, value: '读取中', desc: '' })));
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
      <button class="btn" type="button" id="alRefresh" title="重新读取当前列表、统计和已打开的告警">刷新</button>
      <button class="btn" type="button" id="alExp" title="按当前筛选与排序导出 CSV（上限 5000 行）">导出 CSV</button>
    </div>
  </div>
  <div id="alList" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>`;
const mapExtra = `<span id="alMapSrc" style="font-size:11px;color:var(--txt-3)"></span>
  <button class="btn" id="alLoc" style="height:24px;font-size:11.5px;flex:none" title="重新显示当前告警的完整轨迹与目标位置">${U.icon('location')} 定位</button>`;
const mapBody = `<div id="alMap" style="flex:1;min-height:80px"></div>
    <div id="alMapInfo" style="flex:none;line-height:1.5;padding:4px 2px 0;font-size:11px;
      color:var(--txt-2);white-space:normal;overflow-wrap:anywhere"></div>`;

/* 列头排序走服务端 sort/order（契约只支持这四个键）；不支持的列保持禁用并说明——
   在前端对当前一页重排会得出一个与全局顺序不符的假名次。 */
const SORT_KEYS = { ts: 'received_at', occurred: 'occurred_at', level: 'severity', status: 'state' };
const SORT_NOT_SUPPORTED = '这一列暂不支持排序，请使用支持排序的列';
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
  const text = `来源 ${esc(sourceDescription(a.source_name, a.source_code, a.source_mode, '—'))}· 发生 ${fmt(a.occurred_at) || '未知'}`;
  return `<div style="white-space:normal;line-height:1.5;overflow-wrap:anywhere">${text}</div>`;
}

function listHtml() {
  if (list.loading && !list.rows.length) return `<div class="empty">正在读取告警列表</div>`;
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

/* 事件事实核实保留原入口；处罚移送由后台调度，处置面板只读取进度。 */
function disposalActions(a, ev) {
  if (!ev) return '<button class="btn" disabled>尚未创建核实事件</button>';
  if ((ev.allowed_actions || []).includes('VERIFY')) return '<button class="btn" data-al="verify">核实事件事实</button>';
  if (ev.state === 'CONFIRMED' || ev.state === 'FALSE_POSITIVE') return '';
  return '<span>当前账号没有事件核实权限</span>';
}
function advisoryProps(a, ev) {
  if (!a?.event_id || !ev) return null;
  return {
    id: a.event_id, label: noOf(a), confirmed: ev.state === 'CONFIRMED',
    handoffId: disposal.handoff?.handoff_type === 'UAV_PUNISHMENT' && disposal.handoff.delivery_status !== 'FAILED'
      ? (disposal.handoff.handoff_id || '') : ''
  };
}
function updateAdvisory(summary) {
  if (!summary?.event_id) return;
  const fetchedAt = summary._fetchedAt || Date.now();
  const current = advisorySummaries.get(summary.event_id);
  if (current && (summary.event_version < current.event_version || (current._fetchedAt && fetchedAt < current._fetchedAt))) return;
  summary = { ...summary, _fetchedAt: fetchedAt };
  advisorySummaries.set(summary.event_id, summary);
  if (summary.event_id !== cur.alarm?.event_id) {
    paintList();
    return;
  }
  advisoryLive.value = summary;
  if (cur.event) cur.event.version = summary.event_version;
  paintList();
  paintDetailContent();
}
async function refreshOpenAdvisory(eventId) {
  if (!eventId) return;
  try { updateAdvisory(await uavAdvisoryApi.get(eventId)); } catch { /* 列表回读仍会补上通知阶段 */ }
}

function detailHtml() {
  const a = cur.alarm;
  if (!a) {
    if (cur.loading) return '<div class="empty">正在读取告警详情</div>';
    if (cur.error) return `<div class="empty">${esc(cur.error)}<br><button class="btn" data-al="retry-detail" style="margin-top:10px">重试</button></div>`;
    return '<div class="empty">请选择告警</div>';
  }
  const t = cur.target, ls = t && t.latest_state;
  const targetType = !a.target_id ? '—' : cur.targetLoading ? '读取中' : cur.targetError ? '读取失败' : esc(t ? targetTypeLabel(t.subtype, t.object_type_code) : '—');
  const altSpeed = ls ? `${ls.altitude_amsl_m == null ? '—' : esc(ls.altitude_amsl_m)} m / ${ls.speed_mps == null ? '—' : esc(ls.speed_mps)} m/s` : '— m / — m/s';
  return `${U.detailHero({
    icon: 'alert', subtitle: '告警事件', title: typeOf(a), id: esc(noOf(a)),
    tags: [sevTag(a), stateTag(a)]
  })}
    ${U.sect('告警信息', U.kv([
    ['触发时间', fmt(a.occurred_at) || '未知'], ['接收时间', fmt(a.received_at) || '—'],
    ['所在区域', esc(a.district_name || a.district_id || '—')], ['所属机构', esc(a.owner_org_name || a.owner_org_id || '—')],
    ['关联目标', a.target_id ? `<span class="mono" title="${esc(a.target_id)}">${esc(a.target_no || a.target_id)}</span>` : '无关联目标或无目标读取权限'],
    ['目标类型', targetType],
    ['高度/速度', altSpeed],
    ['数据来源', `${esc(sourceDescription(a.source_name, a.source_code, a.source_mode, '—'))}`]
  ], { surface: true, density: 'compact' }), { icon: 'alert' })}
    ${renderEvidenceChainHtml(cur.chain, {
      loading: cur.chainLoading, error: cur.chainError, unavailable: cur.chainUnavailable
    })}`;
}

function detailActionsHtml() {
  const a = cur.alarm, ev = cur.event;
  if (!a) return '';
  const replayN = replayPointCount();
  return `${U.detailActions(`
      <button class="btn" data-al="replay" ${replayN > 1 ? '' : 'disabled '}title="${replayN > 1 ? '按实测轨迹在地图上走航线回放，不是视频' : '没有足够的轨迹点'}">${U.icon('trend')} 轨迹回放</button>
      ${eoTrackActions(a)}
      ${disposalActions(a, ev)}`)}
    ${ev?.state === 'PENDING_VERIFICATION' ? '<p style="margin:8px 16px;font-size:12px;line-height:1.65;color:var(--muted)">事件事实尚待核实。核实属实后自动发送飞手短信。</p>' : ''}`;
}

function paintDetailContent() {
  videoSubject.value = cur.alarm ? { targetId: cur.alarm.target_id || '', label: noOf(cur.alarm) } : null;
  const host = el('alDetail');
  if (host) host.innerHTML = detailHtml();
  const actions = el('alDetailActions');
  if (actions) actions.innerHTML = detailActionsHtml();
}

function eoTrackActions(a) {
  const open = cur.eoTask && (cur.eoTask.status === 'OPEN' || cur.eoTask.status === 'ENDING');
  // 跟踪由后台自动启停。误报结束处置后不再提供人工启动入口。
  if (a.state === 'FALSE_POSITIVE') {
    return open ? U.tag('正在自动结束', 't-blue') : '';
  }
  const canEo = hasModuleAction('devices', 'op');
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
function paintDetail() {
  const eventId = cur.alarm?.event_id || null;
  if (emergencyEvent.value?.id !== eventId) emergencyInfo.value = null;
  emergencyEvent.value = eventId ? { id: eventId, label: noOf(cur.alarm) } : null;
  advisorySubject.value = advisoryProps(cur.alarm, cur.event);
  if (advisoryLive.value?.event_id !== eventId) advisoryLive.value = null;
  paintDetailContent();
}
function updateEmergency(data) {
  if (data && data.event_id !== emergencyEvent.value?.id) return;
  emergencyInfo.value = data;
  advisorySubject.value = advisoryProps(cur.alarm, cur.event);
  paintList();
  paintDetailContent();
}
async function refreshEmergency(eventId) {
  if (eventId !== cur.alarm?.event_id) return;
  await Promise.all([loadEventDisposals(eventId), loadList(), loadKpis()]);
  if (eventId === cur.alarm?.event_id) paintDetail();
}

/* ---------- 地图：只有响应含 target_id（服务端已按 target:read 与范围元组裁剪）才读目标/轨迹 ---------- */
function syncAlarmMap() {
  if (activeTab.value !== 'alarms') { map?.destroy(); map = null; return; }
  if (!map && el('alMap')) map = new window.MapView(el('alMap'), {
    zoom: 2.2, maxDev: 0, maxAlarm: 1, legend: false, layers: { device: false }
  });
  focusMap();
}
watch(activeTab, async () => { await nextTick(); if (authorizationPageActive) syncAlarmMap(); });
function focusMap() {
  if (!map) return;
  const info = el('alMapInfo'), srcEl = el('alMapSrc'), a = cur.alarm;
  const setInfo = (html, title) => { if (info) { info.innerHTML = html; info.title = title || ''; } };
  const warn = text => `<span class="inline-icon" style="color:#ffd07a">${U.icon('warning')} ${text}</span>`;
  map.sel = null;
  map.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
  if (srcEl) srcEl.textContent = '';
  if (!a) return setInfo(cur.loading ? '正在读取告警' : '请选择告警');
  if (!a.target_id) return setInfo(warn('无关联目标或无目标读取权限，无法定位'));
  if (cur.targetLoading) return setInfo('正在读取关联目标');
  if (cur.targetError) return setInfo(warn(`关联目标 ${esc(a.target_no || a.target_id)} 读取失败：${esc(cur.targetError)}`));
  const t = cur.target, ls = t && t.latest_state;
  const pos = ls ? coord(ls.location, ls.field_issues, 'location') : null;
  const pts = measuredMapPoints(cur.track?.points || []);
  const last = pos || (pts.length ? pts[pts.length - 1] : null);
  if (!t || !last) return setInfo(warn(`关联目标 ${esc(t?.target_no || a.target_no || a.target_id)} 位置无法确认，暂时无法定位`));
  const subtype = targetTypeLabel(t.subtype, t.object_type_code, '目标');
  const target = {
    id: t.target_no || t.target_id, targetId: t.target_id, lon: last.lon, lat: last.lat,
    objectTypeCode: t.object_type_code, subtypeCode: t.subtype,
    activeRisk: U.abnormalActive(a), historical: !U.abnormalActive(a),
    // 末次观测可能已过期，但未解除告警仍需提示；不据此重写观测位置。
    statusCode: t.status_code || t.track_status?.status || '',
    freshness: t.freshness || '', stale: t.stale === true,
    alt: ls && ls.altitude_amsl_m != null ? Number(ls.altitude_amsl_m) : null,
    speed: ls && ls.speed_mps != null ? Number(ls.speed_mps) : null,
    heading: ls && ls.heading_deg != null ? Number(ls.heading_deg) : 0,
    // 合法性判定阶段 4 未接入：不向 MapView 传任何结论词（'待确认' 等），maptip 与信息栏同文案。
    type: targetTypeLabel(null, t.object_type_code, '目标'), subtype,
    legal: t.legality_summary && t.legality_summary.legal_status
      ? labelOf(LEGALITY_LABEL, t.legality_summary.legal_status, t.legality_summary.legal_status) : '—',
    risk: t.risk_summary && t.risk_summary.severity ? esc(t.risk_summary.severity) : '—', tracked: true,
    track: pts
  };
  map.sel = target.id;
  map.setData({
    airspaces: [], devices: [], targets: [target],
    alarms: [{ id: a.alarm_id, targetId: target.id, state: a.state, eventState: a.state, type: typeOf(a), level: sevOf(a).t, time: fmt(a.received_at), status: displayState(a).t }]
  });
  if (pts.length > 1) map.fitTo([...pts.map(p => [p.lon, p.lat]), [last.lon, last.lat]], 0.18);
  else map.centerAt(last.lon, last.lat);
  const source = labelOf(MODE_TEXT, cur.track?.source_mode || t.source_mode, '来源未知');
  const trackNote = pts.length > 1 ? '黄色表示航线关系未知'
    : cur.trackError ? `轨迹读取失败：${esc(cur.trackError)}`
      : pts.length === 1 ? '仅有一个轨迹点，无法连成飞行轨迹' : '没有可显示的飞行轨迹';
  if (srcEl) srcEl.innerHTML = pts.length > 1
    ? `<span class="tag t-amber">${esc(source)}轨迹</span> <span style="color:#8fbaff">${pts.length} 点</span>`
    : `<span class="tag t-gray" title="${cur.trackError ? esc(cur.trackError) : '暂时没有可显示的飞行轨迹'}">无轨迹</span>`;
  setInfo(`合法性 ${esc(target.legal)} · ${trackNote}`,
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
    // 先呈现列表并允许选中详情，逐行补充信息不占用列表加载状态。
    void loadPageProgress(list.rows, my).then(() => { if (my === listSeq) paintList(); });
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
  const summaries = new Map();
  pendingProgress.clear();
  ids.forEach(id => { if (!advisorySummaries.has(id)) pendingProgress.add(id); });
  await mapPool(ids, 4, async id => {
    if (seq !== listSeq) return;
    try {
      const [disp, hands, advisory] = await Promise.all([
        disposalApi.list({ subject_kind: 'UAV_EVENT', subject_id: id, page: 1, size: 50 }),
        handoffApi.listHandoffs({ source_kind: 'UAV_EVENT', source_id: id, page: 1, size: 5 }).catch(() => ({ items: [] })),
        rows.some(row => row.event_id === id && row.state === 'CONFIRMED') ? uavAdvisoryApi.get(id).catch(() => null) : Promise.resolve(null)
      ]);
      summaries.set(id, advisory ? { ...advisory, _fetchedAt: Date.now() } : null);
      next[id] = deriveAlarmProgress(disp?.items || [], hands?.items || []);
    } catch { next[id] = null; }
  });
  if (seq !== listSeq) return;
  pendingProgress.clear();
  Object.keys(pageProgress).forEach(key => { delete pageProgress[key]; });
  Object.assign(pageProgress, next);
  for (const id of [...advisorySummaries.keys()]) {
    if (!ids.includes(id)) advisorySummaries.delete(id);
  }
  for (const [id, summary] of summaries) {
    const current = advisorySummaries.get(id);
    if (!summary) advisorySummaries.delete(id);
    else if (!current || (summary.event_version >= current.event_version && (!current._fetchedAt || summary._fetchedAt >= current._fetchedAt))) advisorySummaries.set(id, summary);
  }
}

async function selectAlarm(id) {
  const my = ++detailSeq;
  ++disposalSeq;
  disposal.byAction = {}; disposal.handoff = null; disposal.error = ''; disposal.unavailable = false;
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
    const chain = a.event_id ? await getEvidenceChain('EVENT', a.event_id)
      : a.target_id ? await getEvidenceChain('TARGET', a.target_id) : null;
    if (my !== detailSeq) return;
    if (!a.event_id && !a.target_id) cur.chainUnavailable = '还没有核实记录或相关目标，暂时无法汇总证据。';
    else cur.chain = chain;
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
      if (my !== detailSeq) return;
      const track = tracks && Array.isArray(tracks.items) ? tracks.items[0] : null;
      if (track) {
        // 点位按时序读取全部分页，不能用最后一页的余数替代完整轨迹。
        const points = await targetApi.pointsAll(track.track_id);
        if (my !== detailSeq) return;
        cur.track = { id: track.track_id, source_mode: track.source_mode, points: Array.isArray(points && points.items) ? points.items : [] };
      }
    } catch (e) { if (my !== detailSeq) return; cur.trackError = messageOf(e); }
  } catch (e) {
    if (my !== detailSeq) return;
    cur.targetError = messageOf(e);
  }
  if (my !== detailSeq) return;
  cur.targetLoading = false;
  paintDetail(); focusMap();
  await loadEoTask(my);
  if (my !== detailSeq) return;
  paintDetail();
}

async function loadEoTask(my) {
  const a = cur.alarm;
  cur.eoTask = null; cur.eoTaskError = '';
  if (!a || !a.target_id || !hasModuleAction('devices', 'op')) return;
  try {
    const task = await deviceApi.currentEoTrack(a.target_id);
    if (my !== detailSeq) return;
    cur.eoTask = task;
  } catch (e) {
    if (my !== detailSeq) return;
    if (e.status !== 404) cur.eoTaskError = messageOf(e);
  }
}

async function beginEoTrack() {
  const a = cur.alarm;
  const my = detailSeq;
  if (!a || !a.target_id) return toast('该告警没有关联目标', 'err');
  if (a.state === 'FALSE_POSITIVE') return toast('该告警已判定为误报，不能再启动跟踪', 'err');
  try {
    const task = await deviceApi.beginEoTrack(a.target_id, { reason: '自动跟踪未启动，值班员人工补发' });
    if (my !== detailSeq || cur.alarm?.alarm_id !== a.alarm_id) return;
    cur.eoTask = task;
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
  const alarm = cur.alarm;
  const id = alarm && alarm.alarm_id;
  const eventId = alarm?.event_id;
  await Promise.all([
    loadList(),
    id ? selectAlarm(id) : Promise.resolve(),
    loadKpis(),
    refreshOpenAdvisory(eventId)
  ]);
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

function onPage(p2) { st.page = p2; loadList(); }
function onPageSize(s2) { st.size = s2; st.page = 1; loadList(); }

onMounted(async () => {
  const view = root.value;
  paintList(); paintDetail();
  syncAlarmMap();

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
  el('alLoc').onclick = focusMap;
  const expBtn = el('alExp');
  if (expBtn) expBtn.onclick = () => exportCsv();
  const refreshBtn = el('alRefresh');
  if (refreshBtn) refreshBtn.onclick = async () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.textContent = '正在刷新';
    try {
      await Promise.all([loadList(), loadKpis(), st.selId ? selectAlarm(st.selId) : Promise.resolve()]);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '刷新';
    }
  };
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
      <nav class="alarm-workspace-tabs" aria-label="告警事件工作区">
        <button type="button" class="btn" :class="{ pri: activeTab === 'alarms' }" :aria-pressed="activeTab === 'alarms'" @click="activeTab = 'alarms'">告警与处置</button>
        <button type="button" class="btn" :class="{ pri: activeTab === 'authorizations' }" :aria-pressed="activeTab === 'authorizations'" @click="openAuthorizations()">反制办理</button>
        <button v-if="activeTab === 'authorizations' && authorizationScope.eventId" type="button" class="btn" @click="openAuthorizations()">查看全部授权</button>
      </nav>
      <AuthorizationQueue v-if="activeTab === 'authorizations'" :key="authorizationScope.key"
        @event="showAuthorizationEvent" :event-id="authorizationScope.eventId" :initial-authorization-id="authorizationScope.authorizationId" :initial-status="authorizationScope.status" />
      <div v-show="activeTab === 'alarms'" class="row" style="margin-top:12px;flex:1;min-height:0">
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
            body-style="overflow:auto;display:block">
            <EmergencyStopPanel v-if="emergencyEvent" :key="`emergency-${emergencyEvent.id}`" :event-id="emergencyEvent.id"
              @updated="updateEmergency" @changed="refreshEmergency" />
            <TargetLiveVideo v-if="videoSubject" :key="videoSubject.label" :target-id="videoSubject.targetId"
              :context-label="videoSubject.label" :active="activeTab === 'alarms'" />
            <div id="alDetail" style="padding:12px"></div>
            <UavAdvisoryPanel v-if="advisorySubject" :key="`advisory-${advisorySubject.id}`"
              :event-id="advisorySubject.id" :confirmed="advisorySubject.confirmed"
              :handoff-id="advisorySubject.handoffId" :interval="1000"
              @updated="updateAdvisory" />
            <div id="alDetailActions" style="padding:0 12px 12px"></div>
            <CounterLaunch v-if="advisorySubject" :key="`counter-${advisorySubject.id}`"
              :event-id="advisorySubject.id" :event-label="advisorySubject.label" :active="activeTab === 'alarms'"
              :show-launch="showCounterLaunch()"
              @records="openAuthorizations" />
          </UPanel>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.alarm-workspace-tabs { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; flex:none; }
.alarm-workspace-tabs .btn { white-space:normal; height:auto; min-height:34px; }
.alarms-page :deep(.detail-hero-title),
.alarms-page :deep(.detail-hero-id) {
  display: block;
  white-space: normal;
  overflow: visible;
  text-overflow: unset;
  -webkit-line-clamp: unset;
  overflow-wrap: anywhere;
}
</style>
