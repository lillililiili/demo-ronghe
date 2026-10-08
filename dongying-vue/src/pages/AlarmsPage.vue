<script>
/* 模块级状态：跨导航保持（legacy 约定）。
   level/status 映射为服务端契约的 severity/state；kind/region 为类别、区域筛选（阶段 15 契约）；
   sort/order 随列表与导出请求一起发给服务端（阶段 15 契约白名单四个键），页面不做假排序。
   默认 priority：接收不满 5 分钟的未处理告警置顶（2026-10-05 用户确认），其余未处理在前（等级高、等得久的在前），已处理在后（2026-10-04 用户确认）。 */
const S = {
  st: { page: 1, size: 10, level: '全部', status: '全部', kind: '全部', region: '全部', sel: null, selId: null,
    sort: 'priority', order: 'desc' }
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
import { refreshFailureText, shouldRetryRefresh, useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { patchHtml } from '@/ui/domPatch.js';
import UPagination from '@/components/UPagination.vue';
import UPanel from '@/components/UPanel.vue';
import UKpis from '@/components/UKpis.vue';
import { handoffApi } from '@/services/handoffApi.js';
import { toast } from '@/ui/nv.js';
import { exportAlarmsCsv, getAlarm, getUavEvent, listAlarmDistricts, listAlarmEscalations, listAlarms, listUavVerifications } from '@/services/alarmApi.js';
import { escalationBrief, escalationRecords, reasonListText } from '@/ui/alarmEscalation.js';
import { ruleReasonText } from '@/ui/legalityReviewModal.js';
import { NO_PILOT_LOCATION, pilotLocationText } from '@/services/pilotLocation.js';
import { getEvidenceChain } from '@/services/evidenceApi.js';
import { openUavVerification } from '@/ui/uavVerificationModal.js';
import { targetApi } from '@/services/targetApi.js';
import { mapPool } from '@/services/apiClient.js';
import { ALARM_PROGRESS_LABEL, ALARM_PROGRESS_TAG, ALARM_TYPE_LABEL, classChangeText, CONCLUSION_LABEL, DISPOSAL_ACTION_LABEL, labelOf, LEGALITY_LABEL, readableNo, sourceDescription, SOURCE_MODE_LABEL as MODE_TEXT, targetTypeLabel } from '@/ui/labels.js';
import { openEvidenceFileModal } from '@/ui/evidenceFileDetail.js';
import { openEvidenceChainTypeModal, renderEvidenceChainHtml } from '@/ui/evidenceChainView.js';
import { disposalApi, isDisposalUnavailable } from '@/services/disposalApi.js';
import { DISPOSAL_UNAVAILABLE_TEXT } from '@/ui/disposalAuthModal.js';
import { hasPermission } from '@/services/accessControl.js';
import { openTrackReplay, trackPointsOf } from '@/ui/trackReplayModal.js';
import EmergencyStopPanel from '@/components/disposal/EmergencyStopPanel.vue';
import UavAdvisoryPanel from '@/components/disposal/UavAdvisoryPanel.vue';
import CounterLaunch from '@/pages/alarms/CounterLaunch.vue';
import TargetTrackingPanel from '@/components/video/TargetTrackingPanel.vue';
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
let evidenceEventSequence = 0;
async function openEvidenceEvent() {
  const id = typeof route.query.event === 'string' ? route.query.event : '';
  if (!id || route.query.tab === 'authorizations' || route.query.authorization) return false;
  const own = ++evidenceEventSequence;
  activeTab.value = 'alarms';
  try {
    const event = await getUavEvent(id);
    if (!authorizationPageActive || own !== evidenceEventSequence || route.query.event !== id) return true;
    await selectAlarm(event.alarm_id);
  } catch (error) {
    if (!authorizationPageActive || own !== evidenceEventSequence || route.query.event !== id) return true;
    ++detailSeq; st.selId = null; cur = emptyDetail(); cur.error = error.message || '关联告警不可见'; paintDetail();
  }
  return true;
}
watch(() => route.query.event, () => { if (root.value) openEvidenceEvent(); });
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
/* 待处置：已核实属实、处置还没结束（关注分组不是"历史"）。与列表分组同一个后端口径，不在前端另算。 */
const PENDING_DISPOSAL_QUERY = { state: 'CONFIRMED', attention_group: 'CURRENT,AWAITING_CONFIRMATION' };
/* 状态筛选按办理阶段分四项（2026-10-07）：待处置、已处理完与"待处置"卡片同一个后端分组口径，导出同样按它筛。 */
const STATUS_FILTER = {
  PENDING_VERIFICATION: { t: '待核实', q: { state: 'PENDING_VERIFICATION' } },
  PENDING_DISPOSAL: { t: '待处置', q: PENDING_DISPOSAL_QUERY },
  DISPOSAL_ENDED: { t: '已处理完', q: { state: 'CONFIRMED', attention_group: 'HISTORY' } },
  FALSE_POSITIVE: { t: '误报', q: { state: 'FALSE_POSITIVE' } }
};
const NO_EVENT = { t: '未建事件', c: 't-gray', color: '#8ca0be' };
const NOTIFY_PHASE = {
  AUTO_SMS: { t: '自动短信', c: 't-cyan', color: '#22d3ee' },
  WATCHING: { t: '观察中', c: 't-amber', color: '#f1a43a' },
  AUTO_CALL: { t: '自动电话', c: 't-cyan', color: '#22d3ee' },
  /* 通知已发完（或发不出去）、无人机还在：等人决定反制还是不反制。不叫"待处置决策"，免得和"待处置"统计看混。 */
  AWAIT_COUNTER: { t: '待定是否反制', c: 't-orange', color: '#fb923c' }
};
const SOURCE_MODE = { mock: { t: MODE_TEXT.mock, c: 't-purple' }, replay: { t: MODE_TEXT.replay, c: 't-amber' }, live: { t: MODE_TEXT.live, c: 't-green' } };
/* 类别按违规原因筛（2026-10-07）：平台自己产生的告警都是"飞行违规"，按告警类型筛只有一项筛得出东西。
   可选项是规则引擎会写进告警的违规原因（与后端 violation_reason 白名单同一组），文字与列表里的原因一致；
   区域来自本页的区域字典接口，读不到就把下拉标成"不可用"并在 title 说明原因。 */
const VIOLATION_REASON_CODES = ['NO_AUTHORIZATION', 'INSIDE_RESTRICTED_AIRSPACE', 'AIRSPACE_ALTITUDE_EXCEEDED',
  'TEMPORARY_RESTRICTION_ACTIVE', 'ROUTE_DEVIATION', 'TIME_WINDOW_OVERRUN', 'PLAN_ALTITUDE_EXCEEDED', 'NIGHT_FLIGHT', 'BVLOS_EXCEEDED'];
const KIND_OPTS = [{ v: '全部', t: '全部' }, ...VIOLATION_REASON_CODES.map(v => ({ v, t: ruleReasonText(v) }))];
const districts = ref([]);
const districtError = ref('');
const regionOpts = () => (districtError.value
  ? [{ v: '全部', t: '全部' }, { v: '', t: '不可用', disabled: true }]
  : [{ v: '全部', t: '全部' }, ...districts.value.map(d => ({ v: d.district_id, t: d.name }))]);

const LEVEL_OPTS = [{ v: '全部', t: '全部' }, { v: 'CRITICAL', t: '紧急' }, { v: 'HIGH', t: '高' }, { v: 'MEDIUM', t: '中' }, { v: 'LOW', t: '低' }];
const STATUS_OPTS = [{ v: '全部', t: '全部' }, ...Object.entries(STATUS_FILTER).map(([v, s]) => ({ v, t: s.t }))];
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
  const noCounter = advisorySummaries.get(a.event_id)?.no_counter;
  if (noCounter?.decision_active === true) return { t: '不反制 · 处置已结束', c: 't-cyan', color: '#22d3ee' };
  if (noCounter?.review_required === true) return { t: '风险变化待决策', c: 't-amber', color: '#f1a43a' };
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
  if (advisoryLive.value?.no_counter?.decision_active === true) return false;
  if (advisoryLive.value?.counter_launch_visible !== true || !cur.alarm?.event_id) return false;
  const key = deriveAlarmProgress(Object.values(disposal.byAction), disposal.handoff ? [disposal.handoff] : [])
    || pageProgress[cur.alarm.event_id];
  return !['JAMMING_DONE', 'COUNTER_STOPPED', 'HANDED_OFF'].includes(key);
}
function eventHandedOff() {
  const eventId = cur.alarm?.event_id;
  if (!eventId) return false;
  const autoHandoff = advisoryLive.value?.auto_handoff;
  if (autoHandoff?.handoff_id && !['FAILED', 'DISABLED', 'BLOCKED', 'WAITING'].includes(autoHandoff.status)) return true;
  const key = deriveAlarmProgress(Object.values(disposal.byAction), disposal.handoff ? [disposal.handoff] : [])
    || pageProgress[eventId];
  return key === 'HANDED_OFF';
}
const typeOf = a => ALARM_TYPE_LABEL[a.alarm_type] || esc(a.alarm_type || '—');
/* 只上屏业务编号；引擎标识（例如 eval 前缀）不是编号，列里显示 —，内部 ID 留在 title。 */
const noOf = a => readableNo(a.alarm_no) || '—';
const modeOf = a => SOURCE_MODE[a.source_mode] || { t: esc(a.source_mode || '—'), c: 't-gray' };
const sevTag = a => U.tag(sevOf(a).t, sevOf(a).c);
const OBSERVATION_LABEL = { CURRENT: '观测有效', EXPIRED: '观测已过期', UNKNOWN: '观测待确认' };
const ATTENTION_LABEL = { CURRENT: '当前事项', AWAITING_CONFIRMATION: '状态待确认', HISTORY: '历史记录' };
const stateTag = a => U.tag(displayState(a).t, displayState(a).c);
const observationTag = a => a.attention_group !== 'HISTORY' && ['EXPIRED', 'UNKNOWN'].includes(a.observation_status)
  ? U.tag(OBSERVATION_LABEL[a.observation_status], 't-gray') : '';
const detailStateTags = a => `${U.tag(displayState(a).t, displayState(a).c)}${observationTag(a)}`;
/* 告警升级（2026-10-06，BUG-11/BUG-16）：同一架无人机再次违规时服务端升级原告警，不再另起一条。
   severity 已是升级后的当前等级；违规原因按出现顺序累计（偏航写“偏航”）；升级经过另读升级记录。 */
const severityText = code => SEVERITY[code]?.t || (code === 'UNKNOWN' ? '未定级' : '');
const reasonsOf = a => reasonListText(a?.violation_reasons, ruleReasonText);
const briefOf = a => escalationBrief(a, severityText);
function escalationTag(a) {
  const brief = briefOf(a);
  if (!brief) return '';
  const title = `${brief.level}，共升级 ${brief.count} 次${brief.at ? `，最近 ${fmt(brief.at)}` : ''}`;
  return `<span class="tag ${brief.raised ? 't-red' : 't-amber'}" title="${esc(title)}">${brief.raised ? `已升级 ${esc(brief.level)}` : '新增原因'}</span>`;
}
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
const list = { rows: [], loading: false, error: '', refreshError: '' };
let listSeq = 0, detailSeq = 0;
const emptyDetail = () => ({ alarm: null, event: null, loading: false, error: '',
  target: null, targetLoading: false, targetError: '', track: null, trackError: '',
  chain: null, chainLoading: false, chainError: '', chainUnavailable: '',
  escalations: [], escalationsTotal: 0, escalationsLoading: false, escalationsError: '',
  verifications: [], verificationsLoaded: false, verificationsLoading: false, verificationsError: ''
  });
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
let progressReloadFor = '';

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

/** 打开的告警跟着后台自动核实、反制和通知更新，不清空当前进度。 */
async function refreshEventDisposals(eventId) {
  const seq = ++disposalSeq;
  const isCurrent = () => seq === disposalSeq && eventId === cur.alarm?.event_id;
  if (!eventId || eventId !== cur.alarm?.event_id) return;
  try {
    const page = await disposalApi.list({ subject_kind: 'UAV_EVENT', subject_id: eventId, page: 1, size: 50 });
    if (!isCurrent()) return;
    const next = {};
    for (const row of page?.items || []) {
      const prev = next[row.action_type];
      if (!prev || Number(row.requested_at || 0) >= Number(prev.requested_at || 0)) next[row.action_type] = row;
    }
    disposal.byAction = next;
    disposal.unavailable = false;
    disposal.error = '';
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
  if (!isCurrent()) return;
  pageProgress[eventId] = deriveAlarmProgress(Object.values(disposal.byAction), disposal.handoff ? [disposal.handoff] : []);
  setSubject(advisorySubject, advisoryProps(cur.alarm, cur.event));
  paintList();
  paintDetailContent();
}

/* 子组件（急停、处置进度、视频）的输入只在内容真的变了时才换新对象，刷新时不连带它们重画。 */
function setSubject(target, value) {
  if (JSON.stringify(target.value) !== JSON.stringify(value)) target.value = value;
}


const KPI_DEFS = [
  { label: '今日告警总数', caption: '按发生时间统计', color: 'blue', icon: 'alert' },
  { label: '今日待核实', caption: '按发生时间统计', color: 'amber', icon: 'alert' },
  { label: '待处置', caption: '实时，不限日期', color: 'pink', icon: 'alert' },
  { label: '当前反制中', caption: '实时状态', color: 'orange', icon: 'radar' },
  { label: '已反制', caption: '累计完成', color: 'green', icon: 'check' },
  { label: '当前干扰中', caption: '实时状态', color: 'red', icon: 'radar' },
  { label: '今日已确认', caption: '按发生时间统计', color: 'cyan', icon: 'alert' },
  { label: '今日误报', caption: '按发生时间统计', color: 'blue', icon: 'check' }
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
  // 告警按今日发生时间统计；待处置、执行中按实时状态统计（不限日期），已反制按累计完成记录统计。
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(Date.now()).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const from = Date.UTC(parts.year, parts.month - 1, parts.day) - 8 * 60 * 60_000;
  const to = from + 86400000;
  const day = { occurred_from: from, occurred_to: to };
  const r = await Promise.allSettled([
    count(day),
    count({ ...day, state: 'PENDING_VERIFICATION' }),
    count({ ...day, state: 'CONFIRMED' }),
    count({ ...day, state: 'FALSE_POSITIVE' }),
    disposalCount('COUNTERMEASURE'), disposalCount('JAMMING'),
    disposalApi.list({ action_type: 'COUNTERMEASURE', status: 'COMPLETED', page: 1, size: 1 })
      .then(p => ({ completed: Number(p && p.total) || 0 })),
    count(PENDING_DISPOSAL_QUERY),
    /* 新-2（D-4）：今日四张卡和大屏同一口径，系统自带的演示告警（来源标“模拟”）不算；
       演示告警另数一遍，卡片上写明有几条没算进来。r[8]~r[11] 依次对应 r[0]~r[3]。 */
    count({ ...day, source_mode: 'mock' }),
    count({ ...day, state: 'PENDING_VERIFICATION', source_mode: 'mock' }),
    count({ ...day, state: 'CONFIRMED', source_mode: 'mock' }),
    count({ ...day, state: 'FALSE_POSITIVE', source_mode: 'mock' })
  ]);
  const v = r.map(x => x.status === 'fulfilled' ? x.value : null);
  const num = x => x == null ? '—' : U.num(x);
  /* 处置授权读不到时如实说明原因，不写 0——“没有在执行”与“读不到”是两件事。 */
  const disposalKpi = (def, settled, value) => {
    if (!value) {
      const unavailable = settled?.reason && isDisposalUnavailable(settled.reason);
      return { ...def, value: unavailable ? '尚未接入' : '—', desc: unavailable ? DISPOSAL_UNAVAILABLE_TEXT : '读取失败：' + esc(messageOf(settled?.reason)) };
    }
    if (value.completed != null) {
      return { ...def, value: U.num(value.completed), desc: '当前权限范围内累计执行完成的反制记录数，不包含干扰及执行失败的记录' };
    }
    return { ...def, value: U.num(value.executing), desc: `另有 ${U.num(value.approved)} 起已批准待执行` };
  };
  const fail = i => v[i] == null ? '读取失败：' + esc(messageOf(r[i].reason)) : null;
  /* 今日卡 = 全部来源 − 演示告警。演示告警数读不到时先按全部来源显示，卡片上写明可能含演示告警，不冒充已扣除。 */
  const todayKpi = (def, i, text) => {
    if (v[i] == null) return { ...def, value: '—', desc: fail(i) };
    const demo = v[i + 8];
    if (demo == null) {
      return { ...def, value: num(v[i]), caption: '可能含演示告警', desc: `${text}；演示告警数读取失败（${esc(messageOf(r[i + 8].reason))}），这里暂按全部来源计数` };
    }
    return { ...def, value: num(Math.max(0, v[i] - demo)), caption: demo > 0 ? `另有演示告警 ${U.num(demo)} 条未计入` : def.caption,
      desc: `${text}；和大屏同一口径：设备模拟器产生的告警（来源标“回放”）照算，系统自带的演示告警（来源标“模拟”）不算` };
  };
  kpiList.value = [
    todayKpi(KPI_DEFS[0], 0, '北京时间今天发生的告警数量；发生时间未知者不计'),
    todayKpi(KPI_DEFS[1], 1, '北京时间今天发生且待人工核实的告警数量'),
    { ...KPI_DEFS[2], value: num(v[7]), desc: fail(7) || '已核实属实、处置还没结束的告警数量，不限日期；正在反制、干扰或急停核查中的也算在内，设备反制或干扰完成后不再计入' },
    disposalKpi(KPI_DEFS[3], r[4], v[4]),
    disposalKpi(KPI_DEFS[4], r[6], v[6]),
    disposalKpi(KPI_DEFS[5], r[5], v[5]),
    todayKpi(KPI_DEFS[6], 2, '北京时间今天发生且已确认属实的告警数量，包含处置已结束的记录'),
    todayKpi(KPI_DEFS[7], 3, '北京时间今天发生且人工核实后已排除的告警数量')
  ];
}

/* ---------- 工具条：只暴露契约支持的过滤；不支持的保留控件但禁用并说明 ---------- */
const disabledSelect = (name, reason) =>
  `<select class="sel" data-f="${name}" disabled aria-disabled="true" title="${reason}"><option value="全部" selected>全部</option></select>`;
const listPanelBody = `<div class="toolbar alarm-filter-toolbar">
    <div class="toolbar-fields">
      ${U.field('等级', U.select('level', LEVEL_OPTS, st.level))}
      ${U.field('违规原因', U.select('kind', KIND_OPTS, st.kind))}
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
  const q = { page: st.page, size: st.size, sort: st.sort };
  if (st.sort !== 'priority') q.order = st.order;
  if (st.level !== '全部') q.severity = st.level;
  if (STATUS_FILTER[st.status]) Object.assign(q, STATUS_FILTER[st.status].q);
  if (VIOLATION_REASON_CODES.includes(st.kind)) q.violation_reason = st.kind;
  if (st.region !== '全部') q.district_id = st.region;
  return q;
}

/* 违规原因单独成列，列名与"违规原因"筛选一致；没有原因码的告警（演示告警等）显示告警类型。
   原因定宽折行、最多两行，不把列撑宽挤掉"状态"列；全文在悬停提示与详情里。 */
function reasonCell(a) {
  const reasons = reasonsOf(a);
  const text = reasons ? esc(reasons) : typeOf(a);
  return U.cell(U.tag(modeOf(a).t, modeOf(a).c),
    `<span style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal;width:9em">${text}</span>`,
    { title: reasons ? esc(reasons) : '' });
}

/* 来源和发生时间分两行：挤在一行时这一列最宽，整张表被撑过面板，"状态"列要横向滚动才看得到。 */
function summaryOf(a) {
  const tag = escalationTag(a);
  return `<div style="white-space:normal;line-height:1.5;overflow-wrap:anywhere">${tag ? `<div>${tag}</div>` : ''}<div>来源 ${esc(sourceDescription(a.source_name, a.source_code, a.source_mode, '—'))}</div><div class="cell-sub">发生 ${fmt(a.occurred_at) || '未知'}</div></div>`;
}

function listHtml() {
  if (list.loading && !list.rows.length) return `<div class="empty">正在读取告警列表</div>`;
  if (list.error) return `<div class="empty">${esc(list.error)}<br><button class="btn" data-al="retry" style="margin-top:10px">重试</button></div>`;
  // 自动刷新失败时保留上次读到的列表，说明正在重试，不把列表换成错误页。
  const note = list.refreshError
    ? `<div id="alRefreshNote" class="alarm-refresh-note" role="status">自动刷新失败（${esc(list.refreshError)}），正在重试；下面是上次读到的列表。</div>`
    : '';
  return note + U.table([
    {
      t: sortTh('ts', '编号 / 时间'), w: '108px', cls: 'num',
      render: a => U.cell(esc(noOf(a)), clock(a.received_at), { mono: true, title: esc(a.alarm_id) })
    },
    { t: sortTh('level', '等级'), w: '52px', align: 'center', render: sevTag },
    { t: sortTh('kind', '违规原因'), w: '136px', render: reasonCell },
    { t: sortTh('district', '关联目标 / 区域'), w: '146px', render: a => U.cell(a.target_id ? esc(a.target_no || a.target_id) : '—', esc(a.district_name || a.district_id || '—'), { mono: true, title: a.target_id ? esc(a.target_id) : '无关联目标或无目标读取权限' }) },
    { t: '告警内容', render: summaryOf },
    { t: sortTh('status', '状态'), w: '86px', render: stateTag }
  ], list.rows, { rowId: a => a.alarm_id, activeId: st.selId });
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
/* 处置进度面板每秒读一次通知摘要。只有本页用到的字段（通知阶段、反制入口、不反制决定、自动移送）
   变了才重画列表和详情、重读处置记录；没变就不动页面，免得每秒重画、按钮点不中（BUG-06）。 */
const advisoryPageKey = s => JSON.stringify([s.event_version, s.notify_phase || '', s.counter_launch_visible === true,
  s.no_counter?.decision_active === true, s.no_counter?.review_required === true,
  s.auto_handoff?.handoff_id || '', s.auto_handoff?.status || '']);
const advisoryContent = s => JSON.stringify({ ...s, _fetchedAt: undefined });
function updateAdvisory(summary) {
  if (!summary?.event_id) return;
  const fetchedAt = summary._fetchedAt || Date.now();
  const current = advisorySummaries.get(summary.event_id);
  if (current && (summary.event_version < current.event_version || (current._fetchedAt && fetchedAt < current._fetchedAt))) return;
  summary = { ...summary, _fetchedAt: fetchedAt };
  advisorySummaries.set(summary.event_id, summary);
  const pageChanged = !current || advisoryPageKey(current) !== advisoryPageKey(summary);
  if (summary.event_id !== cur.alarm?.event_id) {
    if (pageChanged) paintList();
    return;
  }
  if (!advisoryLive.value || advisoryContent(advisoryLive.value) !== advisoryContent(summary)) advisoryLive.value = summary;
  if (cur.event) cur.event.version = summary.event_version;
  if (!pageChanged) return;
  paintList();
  paintDetailContent();
  const stillPending = cur.alarm.state !== 'CONFIRMED' && cur.alarm.state !== 'FALSE_POSITIVE';
  if (summary.notify_phase && stillPending) {
    const mark = `${summary.event_id}:${summary.event_version}`;
    if (progressReloadFor !== mark) {
      progressReloadFor = mark;
      // 后台已经核实并开始通知：静默重读列表和当前告警，不清空正在看的详情。
      void Promise.all([loadList({ quiet: true }), refreshSelected(), loadKpis()]).catch(() => {});
    }
    return;
  }
  void refreshEventDisposals(summary.event_id);
}
async function refreshOpenAdvisory(eventId) {
  if (!eventId) return;
  try { updateAdvisory(await uavAdvisoryApi.get(eventId)); } catch { /* 列表回读仍会补上通知阶段 */ }
}
function updateNoCounter(status) {
  if (!status?.event_id || status.event_id !== cur.alarm?.event_id) return;
  const previous = advisorySummaries.get(status.event_id);
  if (previous && status.event_version < previous.event_version) return;
  updateAdvisory({ ...previous, event_id: status.event_id, event_version: status.event_version, no_counter: status, _fetchedAt: Date.now() });
  void refreshOpenAdvisory(status.event_id);
}

/* ZT-04：目标类别中途变化（未分类→无人机、无人机→鸟类）如实写出，最多三条、新的在前。
   告警、通知与研判保留产生时的结论，不删除不改写；告警之后才改的类别单独提示。 */
function classChangeRow(t, a) {
  const changes = Array.isArray(t?.class_changes) ? t.class_changes.filter(change => change?.to_class_code) : [];
  if (!changes.length) return null;
  const lines = changes.slice(0, 3).map(change => esc(classChangeText(change, value => fmt(value) || '时间未知')));
  const occurredAt = Number(a.occurred_at);
  const afterAlarm = Number.isFinite(occurredAt) && occurredAt > 0 && changes.some(change => Number(change.changed_at) > occurredAt);
  return ['类别变化', lines.join('<br>') + (afterAlarm ? '<br>告警产生后目标类别已变更；本告警及其通知按产生时的类别保留。' : ''),
    afterAlarm ? { tone: 'warn' } : {}];
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
  const reasons = reasonsOf(a), brief = briefOf(a);
  return `${U.detailHero({
    icon: 'alert', subtitle: '告警事件', title: typeOf(a), id: esc(noOf(a)),
    tags: [sevTag(a), detailStateTags(a)]
  })}
    ${U.sect('告警信息', U.kv([
    ['触发时间', fmt(a.occurred_at) || '未知'], ['接收时间', fmt(a.received_at) || '—'],
    ...(a.observation_status ? [['观测状态', esc(OBSERVATION_LABEL[a.observation_status] || '观测待确认')]] : []),
    ...(a.attention_group ? [['关注分组', esc(ATTENTION_LABEL[a.attention_group] || '状态待确认')]] : []),
    ...(reasons ? [['违规原因', esc(reasons)]] : []),
    ...(brief ? [['告警升级', esc(`${brief.level}，共 ${brief.count} 次${brief.at ? `，最近 ${fmt(brief.at)}` : ''}`)]] : []),
    ['所在区域', esc(a.district_name || a.district_id || '—')], ['所属机构', esc(a.owner_org_name || a.owner_org_id || '—')],
    ['关联目标', a.target_id ? `<span class="mono" title="${esc(a.target_id)}">${esc(a.target_no || a.target_id)}</span>` : '无关联目标或无目标读取权限'],
    ['目标类型', targetType],
    ...(cur.targetLoading || cur.targetError ? [] : [classChangeRow(t, a)].filter(Boolean)),
    ['高度/速度', altSpeed],
    ['遥控器位置', !a.target_id ? NO_PILOT_LOCATION : cur.targetLoading ? '读取中' : cur.targetError ? '读取失败'
      : esc(pilotLocationText(ls && ls.pilot_location))],
    ['数据来源', `${esc(sourceDescription(a.source_name, a.source_code, a.source_mode, '—'))}`]
  ], { surface: true, density: 'compact' }), { icon: 'alert', className: 'alarm-info-sect' })}
    ${verificationHtml()}
    ${escalationHtml(brief)}
    ${renderEvidenceChainHtml(cur.chain, {
      loading: cur.chainLoading, error: cur.chainError, unavailable: cur.chainUnavailable
    })}`;
}

/* 核实记录（确认书 3-1、流程 1 第②步，新-18）：按先后列出结论、时间和说明。系统按核实规则自动核实的没有核实人，
   写“系统自动核实 · 无核实人”；人工核实的写核实人。还没有核实事件的告警不显示这一块。 */
function verificationHtml() {
  const a = cur.alarm;
  if (!a?.event_id) return '';
  let body;
  if (cur.verificationsLoading) body = '<div class="empty">正在读取核实记录</div>';
  else if (cur.verificationsError) {
    body = `<div class="empty">${esc(cur.verificationsError)}<br><button class="btn" data-al="verifications-retry" style="margin-top:8px">重试</button></div>`;
  } else if (!cur.verifications.length) {
    body = `<div class="empty">${cur.event?.state === 'PENDING_VERIFICATION' ? '还没有核实' : '暂未读到核实记录'}</div>`;
  } else {
    body = `<ol class="alarm-escalation-list">${cur.verifications.map(v => `<li>
        <div class="alarm-escalation-head"><b>${esc(labelOf(CONCLUSION_LABEL, v.conclusion, '结论未知'))}</b></div>
        ${v.note ? `<div>说明：${esc(v.note)}</div>` : ''}
        <div class="alarm-escalation-meta">${esc(v.actor_id ? `人工核实 · 核实人 ${v.actor_name || '未知'}` : '系统自动核实 · 无核实人')} · ${esc(fmt(v.created_at) || '时间未知')}</div>
      </li>`).join('')}</ol>`;
  }
  return U.sect('核实记录', body, { icon: 'check' });
}

/* 升级记录：按升级先后列出每一次是系统研判还是人工转告警、等级怎么变、新增了什么原因、谁在什么时候做的。 */
function escalationHtml(brief) {
  if (!brief) return '';
  let body;
  if (cur.escalationsLoading) body = '<div class="empty">正在读取升级记录</div>';
  else if (cur.escalationsError) {
    body = `<div class="empty">${esc(cur.escalationsError)}<br><button class="btn" data-al="escalations-retry" style="margin-top:8px">重试</button></div>`;
  } else {
    const rows = escalationRecords(cur.escalations, { severityText, reasonText: ruleReasonText, fmt });
    body = !rows.length ? '<div class="empty">暂未读到升级记录</div>'
      : `<ol class="alarm-escalation-list">${rows.map(r => `<li>
          <div class="alarm-escalation-head"><b>${esc(r.title)}</b>${U.tag(esc(r.level), r.raised ? 't-red' : 't-gray')}</div>
          <div>${esc(r.added)}</div>
          ${r.note ? `<div>说明：${esc(r.note)}</div>` : ''}
          <div class="alarm-escalation-meta">${esc(r.actor)} · ${esc(r.time)}</div>
        </li>`).join('')}</ol>${cur.escalationsTotal > rows.length
        ? `<p class="alarm-escalation-meta">共升级 ${cur.escalationsTotal} 次，这里列出前 ${rows.length} 次。</p>` : ''}`;
  }
  return U.sect('升级记录', body, { icon: 'trend', badge: `${brief.count} 次` });
}

function detailActionsHtml() {
  const a = cur.alarm, ev = cur.event;
  if (!a) return '';
  const replayN = replayPointCount();
  return `<div class="alarm-observation-actions">
      <button class="btn" data-al="replay" ${replayN > 1 ? '' : 'disabled '}title="${replayN > 1 ? '按实测轨迹回放，有光电录像时同步播放' : '没有足够的轨迹点'}">${U.icon('trend')} 轨迹回放</button>
      ${disposalActions(a, ev)}</div>
    ${ev?.state === 'PENDING_VERIFICATION' ? '<p class="alarm-action-note">事件事实尚待核实。核实属实后自动发送飞手短信。</p>' : ''}`;
}

/* 详情和动作区就地更新：内容没变不动节点，“核实”等按钮在刷新时保持原节点，点得中。 */
function paintDetailContent() {
  setSubject(videoSubject, cur.alarm ? { targetId: cur.alarm.target_id || '', eventId: cur.alarm.event_id || '', label: noOf(cur.alarm) } : null);
  patchHtml(el('alDetail'), detailHtml());
  patchHtml(el('alDetailActions'), detailActionsHtml());
}

let listQueryKey = '';
function paintList() {
  const host = el('alList');
  if (!host) return;
  const queryKey = JSON.stringify(queryOf());
  const resetScroll = queryKey !== listQueryKey;
  listQueryKey = queryKey;
  // 就地更新：没变的行保持原节点，滚动位置不丢；换了筛选、排序或页码才回到顶部。
  patchHtml(host, listHtml());
  const scroll = resetScroll && host.querySelector('.table-scroll');
  if (scroll) { scroll.scrollTop = 0; scroll.scrollLeft = 0; }
}
function paintDetail() {
  const eventId = cur.alarm?.event_id || null;
  if (emergencyEvent.value?.id !== eventId) emergencyInfo.value = null;
  setSubject(emergencyEvent, eventId ? { id: eventId, label: noOf(cur.alarm) } : null);
  setSubject(advisorySubject, advisoryProps(cur.alarm, cur.event));
  if (advisoryLive.value?.event_id !== eventId) advisoryLive.value = null;
  paintDetailContent();
}
function updateEmergency(data) {
  if (data && data.event_id !== emergencyEvent.value?.id) return;
  emergencyInfo.value = data;
  setSubject(advisorySubject, advisoryProps(cur.alarm, cur.event));
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
async function loadList({ quiet = false, progress = true } = {}) {
  const my = ++listSeq;
  const previousEvents = list.rows.map(row => row.event_id).join();
  // 实时刷新静默重读：保留当前列表直到新数据到达，不闪加载状态。
  if (!quiet) { list.loading = true; list.error = ''; paintList(); }
  try {
    const page = await listAlarms(queryOf());
    if (my !== listSeq) return;
    list.rows = Array.isArray(page && page.items) ? page.items : [];
    totalCount.value = Number(page && page.total) || 0;
    list.loading = false; list.error = ''; list.refreshError = '';
    if (!list.rows.length && st.page > 1 && totalCount.value) {
      st.page = Math.max(1, Math.ceil(totalCount.value / st.size));
      return loadList();
    }
    // 先呈现列表并允许选中详情，逐行补充信息不占用列表加载状态。
    // 实时刷新只在处置、移送变化或本页事件换了时重读逐行进度，告警本身变化不连带每行再读两三次。
    if (progress || list.rows.map(row => row.event_id).join() !== previousEvents) {
      void loadPageProgress(list.rows, my).then(() => { if (my === listSeq) paintList(); });
    }
  } catch (e) {
    if (my !== listSeq) return;
    if (quiet && list.rows.length && !list.error) {
      // 自动刷新失败：保留上次读到的列表并注明，错误抛给实时刷新按退避重试。
      list.refreshError = refreshFailureText(e);
      paintList();
      throw e;
    }
    // API 失败只显示错误并允许重试，绝不回退 Mock 列表。
    list.rows = []; totalCount.value = 0; list.loading = false; list.error = messageOf(e); list.refreshError = '';
    paintList();
    if (quiet) throw e;
    return;
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
  if (briefOf(cur.alarm)) cur.escalationsLoading = true;
  if (cur.alarm?.event_id) cur.verificationsLoading = true;
  cur.loading = false;
  paintDetail(); focusMap();
  await Promise.all([loadTarget(my), loadChain(my), loadEscalations(my), loadVerifications(my)]);
}

/* 升级记录只在告警升级过时读取；读不到只影响这一块，可单独重试，不影响告警详情与处置。 */
const ESCALATION_PAGE_SIZE = 50;
/* quiet：打开的告警又升级了（实时刷新），已显示的记录保留到新记录读到为止，读取失败也不清掉。 */
async function loadEscalations(my, { quiet = false } = {}) {
  const a = cur.alarm;
  if (!a || my !== detailSeq || !briefOf(a)) return;
  const keep = quiet && cur.escalations.length > 0;
  if (!keep) { cur.escalationsLoading = true; cur.escalationsError = ''; paintDetailContent(); }
  try {
    const page = await listAlarmEscalations(a.alarm_id, { page: 1, size: ESCALATION_PAGE_SIZE });
    if (my !== detailSeq) return;
    cur.escalations = Array.isArray(page?.items) ? page.items : [];
    cur.escalationsTotal = Number(page?.total) || cur.escalations.length;
    cur.escalationsError = '';
  } catch (e) {
    if (my !== detailSeq) return;
    if (!keep) {
      cur.escalations = []; cur.escalationsTotal = 0;
      cur.escalationsError = e?.status === 403 ? '当前账号没有查看升级记录的权限' : messageOf(e);
    }
  }
  cur.escalationsLoading = false;
  paintDetailContent();
}

/* 核实记录随事件状态读取；quiet：打开的告警刚被核实（自动或人工），已显示的记录保留到新记录读到为止，读取失败也不清掉。 */
const VERIFICATION_PAGE_SIZE = 20;
async function loadVerifications(my, { quiet = false } = {}) {
  const a = cur.alarm;
  if (!a?.event_id || my !== detailSeq) return;
  const keep = quiet && cur.verificationsLoaded;
  if (!keep) { cur.verificationsLoading = true; cur.verificationsError = ''; paintDetailContent(); }
  try {
    const page = await listUavVerifications(a.event_id, { page: 1, size: VERIFICATION_PAGE_SIZE });
    if (my !== detailSeq) return;
    cur.verifications = Array.isArray(page?.items) ? page.items : [];
    cur.verificationsLoaded = true;
    cur.verificationsError = '';
  } catch (e) {
    if (my !== detailSeq) return;
    if (!keep) {
      cur.verifications = [];
      cur.verificationsError = e?.status === 403 ? '当前账号没有查看核实记录的权限' : messageOf(e);
    }
  }
  cur.verificationsLoading = false;
  paintDetailContent();
}

async function loadChain(my) {
  const a = cur.alarm;
  if (!a || my !== detailSeq) return;
  cur.chainLoading = true; cur.chainError = ''; cur.chainUnavailable = ''; cur.chain = null;
  paintDetail();
  /* 没有证据查看权限就不发这个请求（15-19②）：每选中一条告警都发一次注定被拒的请求，
     服务端留下一串无意义的拒绝记录，页面上还会显示成“读取失败”，而不是真正的原因。
     判断口径与后端证据链接口一致，是“查看证据”动作（evidence:read），不是证据管理菜单的模块等级：
     值班员没有证据管理菜单，但能看告警的证据链（OBS-03）。 */
  if (!hasPermission('evidence:read')) {
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

/* quiet：告警有变化时静默重读目标和轨迹，新数据到达前保留已显示的内容，读取失败也不清掉已显示的目标。 */
async function loadTarget(my, { quiet = false } = {}) {
  const a = cur.alarm;
  if (!a || !a.target_id) return;
  if (!quiet) { cur.targetLoading = true; focusMap(); }
  try {
    const t = await targetApi.detail(a.target_id);
    if (my !== detailSeq) return;
    cur.target = t;
    cur.targetError = '';
    try {
      const tracks = await targetApi.tracks(a.target_id, { page: 1, size: 1 });
      if (my !== detailSeq) return;
      const track = tracks && Array.isArray(tracks.items) ? tracks.items[0] : null;
      if (track) {
        // 点位按时序读取全部分页，不能用最后一页的余数替代完整轨迹。
        const points = await targetApi.pointsAll(track.track_id);
        if (my !== detailSeq) return;
        cur.track = { id: track.track_id, source_mode: track.source_mode, points: Array.isArray(points && points.items) ? points.items : [] };
        cur.trackError = '';
      }
    } catch (e) { if (my !== detailSeq) return; if (!quiet || !cur.track) cur.trackError = messageOf(e); }
  } catch (e) {
    if (my !== detailSeq) return;
    if (!quiet || !cur.target) cur.targetError = messageOf(e);
  }
  if (my !== detailSeq) return;
  cur.targetLoading = false;
  paintDetail(); focusMap();
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

/* 静默重读当前打开的告警：新数据到达前保留已显示的详情，内容没变就不重画；关联目标换了才重读目标和轨迹，
   急停、处置进度和视频面板不卸载重建。读取暂时失败（断网、超时、5xx）时保留原详情并抛出，由实时刷新退避重试；
   告警已不可见（403/404 等）时如实显示原因。详情还没读出来（上次失败）时按正常选中重读。 */
async function refreshSelected(id = st.selId) {
  if (!id || id !== st.selId || cur.loading) return;
  if (!cur.alarm) { await selectAlarm(id); return; }
  const my = detailSeq;
  const isCurrent = () => my === detailSeq && st.selId === id;
  let alarm, event = null;
  try {
    alarm = await getAlarm(id);
    if (!isCurrent()) return;
    if (alarm.event_id) {
      try { event = await getUavEvent(alarm.event_id); } catch (e) { if (shouldRetryRefresh(e)) throw e; }
      if (!isCurrent()) return;
    }
  } catch (e) {
    if (!isCurrent()) return;
    if (shouldRetryRefresh(e)) throw e;
    ++detailSeq; ++disposalSeq;
    cur = emptyDetail(); cur.error = messageOf(e);
    paintDetail(); focusMap();
    return;
  }
  const before = cur.alarm, beforeEvent = cur.event;
  const targetChanged = alarm.target_id !== before.target_id;
  // 打开着的告警被升级（同一架无人机的新违规并入，BUG-16/BUG-11）时，升级记录跟着重读。
  const escalationChanged = (alarm.escalation_count ?? 0) !== (before.escalation_count ?? 0) || alarm.escalated_at !== before.escalated_at;
  const chainChanged = targetChanged || alarm.event_id !== before.event_id || JSON.stringify(event) !== JSON.stringify(beforeEvent);
  // 事件被核实（自动或人工）后状态会变，核实记录跟着重读；处置面板可能已先把版本号改成新的，所以也比状态。
  const verificationChanged = alarm.event_id !== before.event_id || event?.state !== beforeEvent?.state
    || event?.version !== beforeEvent?.version || (!!alarm.event_id && !cur.verificationsLoaded && !cur.verificationsLoading);
  cur.alarm = alarm; cur.event = event;
  if (alarm.event_id) await refreshEventDisposals(alarm.event_id);
  else { ++disposalSeq; disposal.byAction = {}; disposal.handoff = null; disposal.error = ''; disposal.unavailable = false; }
  if (!isCurrent()) return;
  paintList();
  paintDetail();
  if (targetChanged) {
    cur.target = null; cur.track = null; cur.targetError = ''; cur.trackError = '';
    await loadTarget(my);
  } else if (alarm.target_id && JSON.stringify(alarm) !== JSON.stringify(before)) {
    await loadTarget(my, { quiet: true });
  }
  if (chainChanged && isCurrent()) await refreshChain(my);
  if (escalationChanged && isCurrent()) await loadEscalations(my, { quiet: true });
  if (verificationChanged && isCurrent()) await loadVerifications(my, { quiet: alarm.event_id === before.event_id });
}

/* 证据链静默重读：读到新内容再替换，读取失败保留已显示的证据链；原来就没读出来的按正常流程重读。 */
async function refreshChain(my) {
  const a = cur.alarm;
  if (!a || my !== detailSeq) return;
  if (!cur.chain || cur.chainError || cur.chainUnavailable || !hasPermission('evidence.read')) return loadChain(my);
  try {
    const chain = a.event_id ? await getEvidenceChain('EVENT', a.event_id) : await getEvidenceChain('TARGET', a.target_id);
    if (my !== detailSeq || cur.alarm?.alarm_id !== a.alarm_id) return;
    if (JSON.stringify(chain) !== JSON.stringify(cur.chain)) { cur.chain = chain; paintDetailContent(); }
  } catch { /* 保留已显示的证据链，下次变化再读 */ }
}

/* ---------- 人工核实：共享弹窗（与工作台同一实现，幂等键保留与 409/超时回读在弹窗内处理） ---------- */
/* 核实依据随目标数据时效变化：打开前重读事件，弹窗按当前依据提示能否核实为属实。 */
let verifyOpening = false;
async function verifyModal() {
  const a = cur.alarm, ev = cur.event, my = detailSeq;
  if (!a || !ev) return toast('尚未创建核实事件，无法核实', 'err');
  if (verifyOpening) return;
  verifyOpening = true;
  let latest;
  try { latest = await getUavEvent(ev.event_id); }
  catch (error) { return toast(error.message || '读取核实事件失败，请稍后重试', 'err'); }
  finally { verifyOpening = false; }
  if (my !== detailSeq || cur.alarm?.alarm_id !== a.alarm_id) return;
  cur.event = latest;
  if (latest.version !== ev.version || latest.state !== ev.state) paintDetail();
  openUavVerification({
    alarm: a,
    event: latest,
    refresh: async () => { await refreshAfterWrite(); return cur.event; }
  });
}

/* 实时刷新：告警、处置或移送变化后静默重读列表，两次至少间隔 2 秒，内容没变就不动页面。
   统计卡片 9 个计数请求，最多每 10 秒重读一次；逐行处置进度每行要读两三个接口，信号密集时也最多每 10 秒一次，
   到点自动补上。当前打开的告警：本行变了、重连补读（"*"）时静默重读详情；处置或移送变化时重读它的处置记录，
   反制做完后进度和详情马上跟着变（BUG-08）。读取失败抛给实时刷新，按退避重试。 */
const KPI_MIN_INTERVAL_MS = 10_000;
const PROGRESS_MIN_INTERVAL_MS = 10_000;
let kpiAt = 0, kpiTimer = null, progressAt = 0, progressTimer = null;
function realtimeKpis() {
  if (kpiTimer) return;
  const wait = kpiAt + KPI_MIN_INTERVAL_MS - Date.now();
  kpiTimer = setTimeout(() => { kpiTimer = null; kpiAt = Date.now(); void loadKpis(); }, Math.max(0, wait));
}
function takeProgress(wanted) {
  if (!wanted) return false;
  const wait = progressAt + PROGRESS_MIN_INTERVAL_MS - Date.now();
  if (wait <= 0) { progressAt = Date.now(); return true; }
  if (!progressTimer) progressTimer = setTimeout(() => { progressTimer = null; realtime.trigger(['disposal']); }, wait);
  return false;
}
onUnmounted(() => { clearTimeout(kpiTimer); clearTimeout(progressTimer); });
async function realtimeRefresh(topics) {
  if (list.loading) return;
  const all = topics.includes('*');
  const disposalChanged = all || topics.some(topic => topic === 'disposal' || topic === 'punishment');
  const selId = st.selId;
  const rowKey = () => JSON.stringify(list.rows.find(row => row.alarm_id === selId) || null);
  const before = rowKey();
  realtimeKpis();
  await loadList({ quiet: true, progress: takeProgress(disposalChanged) });
  if (!selId || st.selId !== selId || cur.loading) return;
  const after = rowKey();
  const rowChanged = after !== before && after !== 'null';
  const observationChanged = topics.includes('target') || topics.includes('observation-expiry');
  if (all || rowChanged || (after === 'null' && observationChanged)) await refreshSelected(selId);
  else if (disposalChanged && cur.alarm?.event_id) await refreshEventDisposals(cur.alarm.event_id);
}
const realtime = useRealtimeRefresh(['alarm', 'target', 'disposal', 'punishment'], realtimeRefresh, { minIntervalMs: 2_000 });
// 时间经过不会产生数据库变化事件；只定时重读服务端，不在页面计算过期或修改业务状态。
let observationRefreshTimer = null;
onMounted(() => { observationRefreshTimer = setInterval(() => realtime.trigger(['observation-expiry']), 5_000); });
onUnmounted(() => clearInterval(observationRefreshTimer));

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
    // 同一列依次：倒序 → 正序 → 回到默认次序（当前事项优先）。
    if (st.sort === field && st.order === 'asc') { st.sort = 'priority'; st.order = 'desc'; }
    else if (st.sort === field) st.order = 'asc';
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
    else if (k === 'escalations-retry' && st.selId) loadEscalations(detailSeq);
    else if (k === 'verifications-retry' && st.selId) loadVerifications(detailSeq);
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
  if (await openEvidenceEvent()) return;
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
      <UKpis :list="kpiList" class-name="alarm-kpis" />
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
            body-style="overflow:auto;display:flex;flex-direction:column;padding:0">
            <div class="alarm-action-bar">
              <CounterLaunch v-if="advisorySubject" :key="`counter-${advisorySubject.id}`"
                :event-id="advisorySubject.id" :event-label="advisorySubject.label" :active="activeTab === 'alarms'"
                :show-launch="showCounterLaunch()" :handed-off="eventHandedOff()" :confirmed="advisorySubject.confirmed" :summary="advisoryLive"
                @decision="updateNoCounter"
                @records="openAuthorizations" />
              <div id="alDetailActions" class="alarm-observation"></div>
            </div>
            <div class="alarm-detail-content">
              <EmergencyStopPanel v-if="emergencyEvent" :key="`emergency-${emergencyEvent.id}`" :event-id="emergencyEvent.id"
                @updated="updateEmergency" @changed="refreshEmergency" />
              <TargetTrackingPanel v-if="videoSubject" :key="videoSubject.label" :target-id="videoSubject.targetId"
                :event-id="videoSubject.eventId" :context-label="videoSubject.label" :active="activeTab === 'alarms'"
                begin-reason="告警详情人工补充光电追踪" />
              <div id="alDetail" style="padding:12px"></div>
              <UavAdvisoryPanel v-if="advisorySubject" :key="`advisory-${advisorySubject.id}`"
                :event-id="advisorySubject.id" :confirmed="advisorySubject.confirmed"
                :handoff-id="advisorySubject.handoffId" :interval="1000"
                @updated="updateAdvisory" />
            </div>
          </UPanel>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.alarms-page :deep(.detail-hero-tags) {
  align-items: flex-start;
}
.alarms-page :deep(.detail-hero-auto .detail-hero-tags .tag:nth-child(n+3)) {
  display: inline-block;
}
.alarms-page :deep(.alarm-kpis) {
  grid-template-columns: repeat(8, minmax(0, 1fr));
  flex: none;
}
@media (max-width: 1439px) {
  .alarms-page :deep(.alarm-kpis) {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}
@media (max-width: 900px) {
  .alarms-page :deep(.alarm-kpis) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
/* 按列表面板的实际宽度排布，避免整页断点与下拉桥接层的最小宽度互相挤压。 */
.alarms-page :deep(.alarm-filter-toolbar) {
  container: alarm-filters / inline-size;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  flex: none;
  gap: 12px;
  padding: 14px 16px;
}
.alarms-page :deep(.alarm-filter-toolbar .toolbar-fields) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.65fr) minmax(0, 1fr);
  gap: 12px 16px;
  align-items: start;
}
.alarms-page :deep(.alarm-filter-toolbar .field) {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  gap: 6px;
}
.alarms-page :deep(.alarm-filter-toolbar .field > label) {
  line-height: 20px;
  color: var(--txt-2);
}
.alarms-page :deep(.alarm-filter-toolbar .field .naive-control-bridge:not(.is-check)) {
  flex: none;
  width: 100%;
  /* 桥接层将菜单最小宽度写在行内；触发器应服从网格，菜单仍完整展示。 */
  min-width: 0 !important;
  max-width: none;
}
.alarms-page :deep(.alarm-filter-toolbar .toolbar-actions) {
  gap: 8px;
  flex-wrap: wrap;
  margin-left: 0;
}
@container alarm-filters (max-width: 760px) {
  .alarms-page :deep(.alarm-filter-toolbar .toolbar-fields) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container alarm-filters (max-width: 460px) {
  .alarms-page :deep(.alarm-filter-toolbar .toolbar-fields) {
    grid-template-columns: minmax(0, 1fr);
  }
}
.alarm-action-bar { position:sticky; top:0; z-index:10; display:flex; flex-direction:column; align-items:stretch; gap:10px; margin:0; padding:10px 12px; border-bottom:1px solid var(--line); background:var(--panel); box-shadow:0 4px 12px color-mix(in srgb, var(--bg-1) 22%, transparent); }
.alarm-action-bar:has([data-al="replay"]) { position:static; top:auto; z-index:auto; }
.alarm-action-bar:not(:has(.btn, .tag)) { display:none; }
.alarm-observation { order:2; flex:0 0 auto; min-width:0; }
.alarm-observation:empty { display:none; }
.alarm-observation :deep(.alarm-observation-actions) { display:flex; align-items:center; justify-content:flex-start; flex-wrap:wrap; gap:10px; }
.alarm-observation :deep(.btn) { min-height:40px; height:auto; padding:8px 14px; white-space:normal; }
.alarm-observation :deep(.alarm-action-note) { margin:8px 0 0; font-size:12px; line-height:1.65; color:var(--txt-2); }
.alarm-detail-content { min-width:0; }
.alarm-detail-content :deep(.alarm-escalation-list) { list-style:none; margin:0; padding:0; }
.alarm-detail-content :deep(.alarm-escalation-list li) { padding:8px 0; font-size:12px; line-height:1.65; color:var(--txt-2); overflow-wrap:anywhere; }
.alarm-detail-content :deep(.alarm-escalation-list li + li) { border-top:1px solid var(--line-2); }
.alarm-detail-content :deep(.alarm-escalation-head) { display:flex; align-items:center; flex-wrap:wrap; gap:8px; color:var(--txt); }
.alarm-detail-content :deep(.alarm-escalation-meta) { margin:0; color:var(--txt-3); }
.alarms-page :deep(.alarm-info-sect .kv.kv-surface) {
  background: color-mix(in srgb, var(--blue) 5%, var(--panel-2));
  border-color: color-mix(in srgb, var(--blue) 20%, var(--line-2));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--blue) 7%, transparent);
}
.alarms-page :deep(.alarm-refresh-note) { flex:none; margin:0 16px 8px; padding:6px 10px; border:1px solid var(--line); border-radius:6px; font-size:12px; line-height:1.6; color:var(--amber); overflow-wrap:anywhere; }
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
