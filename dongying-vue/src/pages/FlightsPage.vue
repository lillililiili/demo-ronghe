<script>
/* 跨导航只保留筛选、分页与选中 ID；业务事实仍每次从只读 API 重取，不能缓存成 Mock 副本。 */
const S = { filters: { status_code: '' }, page: 1, size: 20, selectedPlanId: null, tab: 'route', tabHash: '',
  /* 风险页签：筛选只收契约允许的字段；目标类型筛选与任意排序契约不支持，只保留禁用控件。 */
  riskFilters: { severity: '', state: '', risk_type: '', plan_id: '', owner_org_id: '', district_id: '', source_mode: '', occurred: null },
  riskPage: 1, riskSize: 10, selectedRiskId: null, riskTab: 'event' };
export default {};
</script>

<script setup>
import { computed, h, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { flightApi } from '@/services/flightApi.js';
import { airspaceApi } from '@/services/airspaceApi.js';
import { riskApi } from '@/services/riskApi.js';
import { openRiskVerification } from '@/ui/riskVerificationModal.js';
import { RULE_REASON_TEXT } from '@/ui/legalityReviewModal.js';
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { openFormModal } from '@/ui/formModal.js';
import { openModal, closeModal } from '@/ui/modal.js';
import { toast } from '@/ui/nv.js';
import {
  ALTITUDE_DATUM_LABEL, ALTITUDE_RELATION_LABEL, HANDOFF_TYPE_LABEL, LEGALITY_LABEL, PLAN_MATCH_TAG, PLAN_ROW_MATCH_LABEL, PLAN_STATUS_LABEL, PLAN_STATUS_TAG, REASON_CODE_LABEL, RECEIPT_RESULT_LABEL, RISK_TYPE_LABEL,
  SECTION_AVAILABILITY_LABEL, SOURCE_MODE_LABEL, sourceDescription, labelOf, OBJECT_TYPE_LABEL, readableNo, RISK_TYPE_OPTIONS } from '@/ui/labels.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { loadTargetPosition, strokePlannedRoute } from '@/services/positionMap.js';
import { hasPermission } from '@/services/accessControl.js';
import { authUser } from '@/services/auth.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import RiskOpticalPanel from '@/pages/flights/components/RiskOpticalPanel.vue';
import PlanVerificationPanel from '@/pages/flights/components/PlanVerificationPanel.vue';
import PlanFilingDetails from '@/pages/flights/components/PlanFilingDetails.vue';
import PlanDeviceMarkers from '@/pages/flights/components/PlanDeviceMarkers.vue';
import PlanRiskRecords from '@/pages/flights/components/PlanRiskRecords.vue';
import PlanWeatherForecast from '@/pages/flights/components/PlanWeatherForecast.vue';
import FlightRecordList from '@/pages/flights/components/FlightRecordList.vue';
import FlightListPager from '@/pages/flights/components/FlightListPager.vue';
import WeatherMapInfo from '@/pages/flights/components/WeatherMapInfo.vue';
import ObjectRiskMapInfo from '@/pages/flights/components/ObjectRiskMapInfo.vue';
import { objectSnapshot, objectTrackPoints, drawObjectRisk } from '@/pages/flights/objectRiskMap.js';
import { weatherPolygon, insideWeather, drawWeatherArea, weatherLayerKind } from '@/pages/flights/weatherMap.js';
import { strokePlanComparison, trustedTrajectoryPoints, trajectoryNoteText } from '@/pages/flights/planTrajectory.js';
import { hasRouteDeviation } from '@/pages/flights/planMatch.js';
import UPagination from '@/components/UPagination.vue';
import UControl from '@/components/form/UControl.vue';

usePageChrome('flights');
const abnormalActive = window.UI.abnormalActive;

const filters = reactive(S.filters);
const page = ref(S.page);
const size = ref(S.size);
const total = ref(0);
const plans = ref([]);
const selected = ref(null);
const routeVersion = ref(null);
const airspaceVersions = ref([]);
const conflicts = ref([]);
const loading = ref(false);
const detailLoading = ref(false);
const routeGeometryLoading = ref(false);
const airspaceLoading = ref(false);
const error = ref('');
const detailError = ref('');
const routeGeometryError = ref('');
const airspaceError = ref('');
function hashPath(raw = location.hash || '') {
  return raw.split('?')[0];
}
function hashWantsEventsTab(raw = location.hash || '') {
  if (hashPath(raw).startsWith('#/risk')) return true;
  const q = raw.indexOf('?');
  if (q < 0) return false;
  return new URLSearchParams(raw.slice(q + 1)).get('tab') === 'events';
}
const activeTab = ref(hashWantsEventsTab() ? 'events' : 'route');
const planDetailTab = ref('plan');
const mapHost = ref(null);
const planDeviceCheck = ref(null);
const deviceMarkers = ref([]);
const mapDevices = computed(() => planDeviceCheck.value?.plan_id === selected.value?.plan_id
  ? (planDeviceCheck.value?.rows || []).filter(row => (abnormalActive(row) || row.incidents?.length) && row.position) : []);
const routeLoaded = ref(false);
/* 全页只允许一个活动 MapView：航线页签与风险页签共用同一变量，切换前先 destroyRouteMap()。 */
let routeMap = null;

/* ---------- 风险页签状态（数据只来自 riskApi，不读 window.MOCK / RISK_IMPL） ---------- */
const EVENT_RISK_TYPES = ['SPACE_OBJECT', 'FOREIGN_OBJECT', 'WEATHER'];
const DISPLAY_RISK_SCOPE = { exclude_demo_samples: true };
const EVENT_RISK_SCOPE = { ...DISPLAY_RISK_SCOPE, risk_types: EVENT_RISK_TYPES.join(',') };
const riskFilters = reactive(S.riskFilters);
if (!EVENT_RISK_TYPES.includes(riskFilters.risk_type)) riskFilters.risk_type = '';
if (riskFilters.target_type === undefined) riskFilters.target_type = '';
/* 列表排序走服务端（契约支持这四个键）；表格里其余列不可排，说明写在 title 上。 */
const riskSort = reactive({ field: 'received_at', order: 'desc' });
const riskSortOptions = [
  { label: '最新接收', value: 'received_at:desc' }, { label: '最早接收', value: 'received_at:asc' },
  { label: '最新发生', value: 'occurred_at:desc' }, { label: '最早发生', value: 'occurred_at:asc' },
  { label: '风险从高到低', value: 'severity:desc' }, { label: '风险从低到高', value: 'severity:asc' },
  { label: '处理状态正序', value: 'state:asc' }, { label: '处理状态倒序', value: 'state:desc' }
];
const riskSortValue = computed(() => `${riskSort.field}:${riskSort.order}`);
function setRiskSort(value) {
  if (!riskSortOptions.some(option => option.value === value)) return;
  [riskSort.field, riskSort.order] = value.split(':');
  applyRiskFilters();
}
function setRiskKind(value) { riskFilters.risk_type = value; applyRiskFilters(); }
const riskPage = ref(S.riskPage);
const riskSize = ref(S.riskSize);
const riskTotal = ref(0);
const risks = ref([]);
const riskTab = ref(S.riskTab);
/* 通报页签：只读 handoffApi.listHandoffs 展示该风险的真实交接记录；页面不生成通报，也不缓存成第二套状态。 */
const notices = ref([]);
const noticesTotal = ref(0);
const noticesLoading = ref(false);
const noticesError = ref('');
let noticesToken = 0;
/* 同一风险的交接幂等键在“结果未知”期间保留；只有服务端给出明确结果后才丢弃或换新。 */
const pendingHandoffKeys = new Map();
const NOTICE_DELIVERY_LABEL = { PENDING_DELIVERY: '等待发送', SUBMITTED: '送达待确认', DELIVERED: '已送达', FAILED: '发送失败' };
const NOTICE_DELIVERY_TAG = { PENDING_DELIVERY: 't-amber', SUBMITTED: 't-blue', DELIVERED: 't-green', FAILED: 't-red' };
const NOTICE_RECEIPT_LABEL = { NOT_EXPECTED: '不需回执', PENDING: '等待回执', ACKNOWLEDGED: '已回执', TIMEOUT: '回执超时' };
/* 回执状态 + 回执结果连起来读："已回执 · 已驱离"。服务端没给结果就只显示状态，不补空位（决策 18-14）。 */
function receiptText(notice) {
  const status = NOTICE_RECEIPT_LABEL[notice.receipt_status] || notice.receipt_status || '未知';
  const result = labelOf(RECEIPT_RESULT_LABEL, notice.receipt_result, '');
  return result ? `${status} · ${result}` : status;
}
const NOTICE_BLOCKED_LABEL = { DELIVERY_OUTCOME_UNKNOWN: '发送结果未知，请先核对原发送记录', CHANNEL_NOT_CONNECTED: '通知渠道未接通' };
const riskLoading = ref(false);
const riskError = ref('');
const selectedRisk = ref(null);
/* 当前请求/选中的风险 ID：详情读取失败时列表仍能高亮该行并提供重试。 */
const activeRiskId = ref(S.selectedRiskId);
const riskDetailLoading = ref(false);
const riskDetailError = ref('');
const riskHistory = ref([]);
const riskHistoryTotal = ref(0);
const riskHistoryPage = ref(1);
const riskHistoryLoading = ref(false);
const riskHistoryError = ref('');
const riskRouteVersion = ref(null);
const riskTarget = ref(null);
const riskTargetNote = ref('');
const objectRiskSelected = computed(() => ['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(selectedRisk.value?.risk_type));
const objectPosition = computed(() => objectSnapshot(selectedRisk.value));
const objectMarker = ref(null);
const objectTrail = computed(() => objectTrackPoints(riskTarget.value));
const objectTrailVisible = ref(false);
const objectTrailIndex = ref(0);
const objectPlaying = ref(false);
const objectHeat = ref(false);
const objectTrackError = ref('');
let objectPlaybackTimer;
const objectHeatPoints = computed(() => risks.value.filter(risk => risk.source_mode === selectedRisk.value?.source_mode
  && risk.district_id === selectedRisk.value?.district_id).map(objectSnapshot).filter(Boolean));
function stopObjectPlayback() { clearInterval(objectPlaybackTimer); objectPlaying.value = false; }
function resetObjectMap() {
  stopObjectPlayback(); objectMarker.value = null; objectHeat.value = false; objectTrailVisible.value = false;
  objectTrailIndex.value = 0; objectTrackError.value = '';
}
function toggleObjectHeat() {
  objectHeat.value = !objectHeat.value;
  if (objectHeat.value && objectHeatPoints.value.length) routeMap?.fitTo([...(riskMapCoords.value || []), ...objectHeatPoints.value.map(p => [p.lon, p.lat]), ...(objectPosition.value ? [[objectPosition.value.lon, objectPosition.value.lat]] : [])]);
}
function toggleObjectTrail() {
  stopObjectPlayback(); objectTrailVisible.value = !objectTrailVisible.value;
  objectTrailIndex.value = Math.max(0, objectTrail.value.length - 1);
  if (objectTrailVisible.value) routeMap?.fitTo([...(riskMapCoords.value || []), ...objectTrail.value.map(p => [p.lon, p.lat]), ...(objectPosition.value ? [[objectPosition.value.lon, objectPosition.value.lat]] : [])]);
}
function stepObjectTrail(step) { stopObjectPlayback(); objectTrailIndex.value = Math.max(0, Math.min(objectTrail.value.length - 1, objectTrailIndex.value + step)); }
function toggleObjectPlayback() {
  if (objectPlaying.value) { stopObjectPlayback(); return; }
  if (objectTrail.value.length < 2) return;
  if (objectTrailIndex.value >= objectTrail.value.length - 1) objectTrailIndex.value = 0;
  objectPlaying.value = true;
  objectPlaybackTimer = setInterval(() => {
    if (document.hidden) return;
    objectTrailIndex.value += 1;
    if (objectTrailIndex.value >= objectTrail.value.length - 1) stopObjectPlayback();
  }, 500);
}
const riskMapLoading = ref(false);
const riskMapError = ref('');
const riskMapHost = ref(null);
const riskWeather = ref(null);
const riskWeatherError = ref('');
const riskWeatherLoading = ref(false);
const weatherVisible = ref(true);
const weatherOpened = ref(false);
const weatherBoundaryVisible = ref(false);
const weatherKind = computed(() => weatherLayerKind(selectedRisk.value?.reason_code));
const simulatedWeather = computed(() => selectedRisk.value?.source_mode === 'mock' && selectedRisk.value?.source_code === 'WEATHER-DEMO'
  && ['WEATHER_STRONG_WIND', 'WEATHER_THUNDERSTORM', 'WEATHER_LOW_VISIBILITY'].includes(selectedRisk.value?.reason_code));
const weatherRing = computed(() => weatherPolygon(riskWeather.value));
const weatherTitle = computed(() => labelOf(REASON_CODE_LABEL, selectedRisk.value?.reason_code));
const weatherColor = computed(() => ({ WEATHER_THUNDERSTORM: '#e15c75', WEATHER_STRONG_WIND: '#cf8418', WEATHER_LOW_VISIBILITY: '#8376cb' }[selectedRisk.value?.reason_code] || '#8376cb'));
const riskKpiTotals = ref({});
const riskKpiFailed = ref({});
/* 涉及航线来自空间安全风险汇总（阶段 9 的 /space-risks/summary）：
   分母为 0 时服务端给 {value:null, availability}，那是"没有可统计的数据"，不是 0。 */
const routesSummary = ref({ state: 'loading', value: null, availability: '', error: '' });
/* 同一风险第一次提交生成的幂等键，直到成功或切换风险前都不换；超时/409 后重试沿用同一键。 */
let riskListToken = 0;
let riskDetailToken = 0;
let riskHistoryToken = 0;
let riskKpiToken = 0;

const RISK_STATE_LABEL = { PENDING_VERIFICATION: '待核验', PENDING_NOTIFICATION: '待通知', NOTIFIED: '已通知', ACKNOWLEDGED: '已回执', EXCLUDED: '已排除' };
const RISK_STATE_TAG = { PENDING_VERIFICATION: 't-amber', PENDING_NOTIFICATION: 't-blue', NOTIFIED: 't-green', ACKNOWLEDGED: 't-green', EXCLUDED: 't-gray' };
const RISK_SEVERITY_LABEL = { CRITICAL: '紧急', HIGH: '高', MEDIUM: '中', LOW: '低' };
const RISK_SEVERITY_TAG = { CRITICAL: 't-red', HIGH: 't-red', MEDIUM: 't-amber', LOW: 't-blue' };
/* 与迁移 022 的 CHECK 枚举一致：UNKNOWN / WITHIN / OUTSIDE；未知不判断安全。 */
const HEIGHT_RELATION_LABEL = { UNKNOWN: '高度关系未知', WITHIN: '在航线高度范围内', OUTSIDE: '超出航线高度范围' };
const HISTORY_PAGE_SIZE = 10;

const riskSeverityOptions = [{ label: '全部', value: '' }, ...Object.keys(RISK_SEVERITY_LABEL).map(value => ({ label: RISK_SEVERITY_LABEL[value], value }))];
const riskStateOptions = [{ label: '全部', value: '' }, ...Object.keys(RISK_STATE_LABEL).map(value => ({ label: RISK_STATE_LABEL[value], value }))];
const riskKindOptions = [{ label: '全部', value: '' }, ...RISK_TYPE_OPTIONS.filter(item => EVENT_RISK_TYPES.includes(item.value))];
/* 阶段 15：契约给了 target_type 筛选。选项值用共享字典的码（中文只做显示），
   不再拿中文当查询值——那样服务端认不出。 */
const riskTypeOptions = [{ label: '全部', value: '' },
  ...Object.keys(OBJECT_TYPE_LABEL).map(code => ({ label: OBJECT_TYPE_LABEL[code], value: code }))];
/* 区域字典按页取（15-22）：读不到时下拉只留"不可用"一项并在 title 说明，
   不把当前页数据里出现过的区域拼成一份看着像全量的字典。 */
const riskDistricts = ref([]);
const riskDistrictError = ref('');
const riskDistrictOptions = computed(() => (riskDistrictError.value
  ? [{ label: '全部', value: '' }, { label: '不可用', value: '__unavailable', disabled: true }]
  : [{ label: '全部', value: '' }, ...riskDistricts.value.map(d => ({ label: d.name || d.district_id, value: d.district_id }))]));
const riskDistrictTitle = computed(() => (riskDistrictError.value
  ? `暂时读不到区域字典：${riskDistrictError.value}`
  : (riskDistricts.value.length ? '' : '当前没有可选区域')));
async function loadRiskDistricts() {
  try {
    const rows = await riskApi.listDistricts();
    riskDistricts.value = (Array.isArray(rows) ? rows : rows?.items || []).filter(d => d.enabled !== false);
    riskDistrictError.value = '';
  } catch (error) {
    riskDistricts.value = [];
    riskDistrictError.value = error?.message || '读取失败';
  }
}

/* /auth/me 的 permission_codes 目前只含模块级 `<module>.read/op/auth`，不含阶段动作码（flight:read 等）。
   只有会话真的暴露了冒号动作码才在前端预判；否则返回 null，交给服务端裁决（关联 ID 是否返回即服务端的权限声明）。 */
const knowsActionCodes = computed(() => (authUser.value?.permission_codes || []).some(code => /^[a-z_]+:[a-z_]+$/.test(code)));
function actionAllowed(code) { return knowsActionCodes.value ? hasPermission(code) : null; }
const canFilterByPlan = computed(() => actionAllowed('flight:read') !== false);
const canReadRoute = computed(() => actionAllowed('route:read') !== false);

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / size.value)));
const sourceModeOptions = [{ label: '全部', value: '' }, ...Object.keys(SOURCE_MODE_LABEL).map(value => ({ label: SOURCE_MODE_LABEL[value], value }))];
const statusOptions = [{ label: '全部状态', value: '' }, ...['PENDING', 'EXECUTING', 'COMPLETED', 'CANCELLED'].map(value => ({ label: PLAN_STATUS_LABEL[value], value }))];
/* 6 个 KPI（决策 15-56）：前四个取服务端 size=1 的 total（今日=计划时段与今天相交；待执行=待执行+已批准），
   后两个只能按本页已读到的对照结论统计（服务端没有跨计划的匹配汇总），desc 里写明"本页"。 */
const planKpis = ref({ today: null, executing: null, pending: null, completed: null, failed: false });
async function loadPlanKpis() {
  // 非展示用：只作"今日"查询窗口的边界，不在界面上显示时刻
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const total = async params => Number((await flightApi.list({ ...params, page: 1, size: 1 })).total) || 0;
  try {
    const [today, executing, pending, approved, completed] = await Promise.all([
      total({ window_from: dayStart.getTime(), window_to: dayStart.getTime() + 86_400_000 }),
      total({ status_code: 'EXECUTING' }), total({ status_code: 'PENDING' }), total({ status_code: 'APPROVED' }), total({ status_code: 'COMPLETED' })
    ]);
    planKpis.value = { today, executing, pending: pending + approved, completed, failed: false };
  } catch { planKpis.value = { today: null, executing: null, pending: null, completed: null, failed: true }; }
}
const pageMatchCounts = computed(() => {
  let unmatched = 0, deviated = 0;
  plans.value.forEach(plan => {
    const section = rowActuals[plan.plan_id];
    if (!section) return;
    if (['EXECUTING', 'COMPLETED'].includes(plan.status_code) && section.availability === 'NO_EVALUATION') unmatched += 1;
    if (['EXECUTING', 'COMPLETED'].includes(plan.status_code) && hasRouteDeviation(section)) deviated += 1;
  });
  return { unmatched, deviated };
});
const kpiList = computed(() => {
  const n = value => (value == null ? (planKpis.value.failed ? '—' : '…') : Number(value).toLocaleString('en-US'));
  const k = planKpis.value, m = pageMatchCounts.value;
  return [
    { label: '今日报备计划', value: n(k.today), color: 'blue', icon: 'plan', caption: '计划时段与今天相交', desc: '计划时段与今天相交的计划数' },
    { label: '执行中', value: n(k.executing), color: 'cyan', icon: 'radar', desc: '状态为执行中' },
    { label: '待执行', value: n(k.pending), color: 'blue', icon: 'plan', desc: '未到计划时段' },
    { label: '已完成', value: n(k.completed), color: 'green', icon: 'check', desc: '状态为已完成' },
    { label: '计划未匹配到目标', value: String(m.unmatched), color: 'amber', icon: 'alert', caption: '仅统计本页计划', desc: '本页执行中或已完成的计划中，还没找到对应飞机的数量' },
    { label: '偏离报备计划', value: String(m.deviated), color: 'red', icon: 'alert', caption: '仅统计本页计划', desc: '本页：研判已记录走廊不匹配' }
  ];
});
const trustedCenterline = computed(() => trustedCoordinates(routeVersion.value));
const trustedAirspaces = computed(() => trustedAirspaceOverlays());
const hasMapContent = computed(() => Boolean(trustedCenterline.value?.length || trustedAirspaces.value.length || trajectoryPoints.value.some(Boolean) || mapDevices.value.length));

/* 6 个 KPI 与原页面同位同色；数值只取服务端 size=1 的 total，后端无法得出的指标显示“尚未接入”。 */
const RISK_KPI_QUERIES = {
  all: {}, high: { severity: 'HIGH' }, pending: { state: 'PENDING_VERIFICATION' },
  /* 气象与异物分别按风险分类读取总数，不要求气象事件关联飞行目标。 */
  bird: { risk_type: 'SPACE_OBJECT' }, weather: { risk_type: 'WEATHER' }
};
const routesInvolved = computed(() => {
  const r = routesSummary.value;
  if (r.state === 'loading') return { text: '…', desc: '正在读取空间安全风险汇总' };
  if (r.state === 'error') return { text: '—', desc: '读取失败：' + r.error };
  if (r.value == null) return { text: '—', desc: r.availability === 'NO_DATA' ? '所选范围内还没有空间安全风险' : '暂无此项统计' };
  return { text: Number(r.value).toLocaleString('en-US'), desc: '空间安全风险涉及的航线数' };
});

const riskKpis = computed(() => {
  const value = key => (riskKpiFailed.value[key] ? '—' : riskKpiTotals.value[key] == null ? '…' : Number(riskKpiTotals.value[key]).toLocaleString('en-US'));
  const desc = (key, text) => (riskKpiFailed.value[key] ? '总数读取失败' : text);
  return [
    { label: '风险事件', value: value('all'), color: 'blue', icon: 'alert', desc: desc('all', '当前权限范围内总数') },
    { label: '高风险事件', value: value('high'), color: 'red', icon: 'alert', desc: desc('high', 'severity=HIGH 的总数') },
    { label: '气象风险', value: value('weather'), color: 'amber', icon: 'alert', desc: desc('weather', '当前权限范围内的气象风险总数') },
    { label: '异物风险', value: value('bird'), color: 'green', icon: 'business:bird', desc: desc('bird', '当前权限范围内的空中异物风险总数') },
    { label: '待核验', value: value('pending'), color: 'amber', icon: 'check', desc: desc('pending', 'state=PENDING_VERIFICATION 的总数') },
    { label: '异物涉及航线', value: routesInvolved.value.text, color: 'purple', icon: 'zone', desc: routesInvolved.value.desc }
  ];
});

const riskMapCoords = computed(() => trustedCoordinates(riskRouteVersion.value));
/* 风险点位：空中异物风险（C04）带位置快照，经纬度在 space_fact 里；标记颜色只表示等级，不表示合法性。
   飞行作业风险与空域风险不产出位置快照，这两类返回 null，图上只有航线。 */
const RISK_SEVERITY_COLOR = { CRITICAL: '#ff4d5e', HIGH: '#ff4d5e', MEDIUM: '#ffb020', LOW: '#3d8bff' };
const riskPoint = computed(() => {
  const fact = selectedRisk.value?.space_fact;
  if (!fact || fact.longitude == null || fact.latitude == null) return null;
  const longitude = Number(fact.longitude), latitude = Number(fact.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return { longitude, latitude, color: RISK_SEVERITY_COLOR[selectedRisk.value?.severity] || '#3d8bff' };
});
/* 三样几何有任意一样就该建图：只有航线、只有风险点、只有关联目标，都不该退化成一块空白。 */
const riskMapDrawable = computed(() => Boolean(riskMapCoords.value || riskPoint.value || riskTarget.value || weatherRing.value));
const riskMapNote = computed(() => {
  if (riskWeatherLoading.value) return '正在读取气象区域…';
  if (riskWeatherError.value) return riskWeatherError.value;
  if (riskMapLoading.value) return '正在加载相关航线…';
  if (riskMapError.value) return riskMapError.value;
  if (!selectedRisk.value) return '选择左侧风险事件后，按它的位置与关联航线绘制。';
  const hasRoute = Boolean(selectedRisk.value.route_version_id);
  if (hasRoute && !canReadRoute.value) return '风险位置未记录，你也没有查看相关航线的权限，暂时无法在地图上显示。';
  if (hasRoute) return '风险位置和相关航线的坐标无法确认，暂时无法在地图上显示。';
  return '这条风险没有记录位置，也没有相关航线，暂时无法在地图上显示。';
});
/* 图上少画了什么要说清楚，不能让人以为"图空=没事"。 */
const riskMapMissingNote = computed(() => {
  if (!selectedRisk.value || !riskMapDrawable.value) return '';
  const missing = [];
  if (selectedRisk.value.risk_type === 'WEATHER') {
    if (riskWeatherLoading.value) missing.push('正在读取气象区域…');
    else if (riskWeatherError.value) missing.push(riskWeatherError.value);
    else if (!weatherRing.value) missing.push('未提供可用的气象影响范围');
  } else if (!riskPoint.value && !objectRiskSelected.value) missing.push('这条风险没有记录位置');
  if (selectedRisk.value.target_id && !riskTarget.value) missing.push(riskTargetNote.value || '尚未获取相关目标的位置');
  if (selectedRisk.value.route_version_id && !riskMapCoords.value) missing.push('相关航线的位置无法确认');
  return missing.join('；');
});
const riskHeroIcon = computed(() => selectedRisk.value?.risk_type === 'WEATHER' ? window.UI.icon('alert') : window.UI.targetIcon(selectedRisk.value));
/* 详情卡网格第一列固定留给图标；没有图标元素时文字会落进 40px 列，所以计划卡也必须输出图标。 */
function riskReasonText(risk) {
  let text = risk.reason_text || '未提供';
  for (const value of [risk.target_no, risk.target_id, risk.plan_no, risk.plan_id, risk.source_risk_id, risk.risk_id]) {
    if (value) text = text.split(value).join('关联对象');
  }
  return text;
}
const canVerifyRisk = computed(() => Boolean(selectedRisk.value?.allowed_actions?.includes('VERIFY')));
/* 通知按钮：服务端 allowed_actions 含 NOTIFY 为准；旧版详情不带 NOTIFY 时按“待通知”放开。
   /auth/me 的 permission_codes 不含 `handoff:create` 动作码，前端不预判权限，由服务端 403 裁决。 */
/* 已提交过通知（未失败）就不能再点：服务端会 409，页面直接禁用并说明（决策 15-50）。 */
const submittedNotice = computed(() => notices.value.find(n => n.delivery_status && n.delivery_status !== 'FAILED') || null);
const canNotifyRisk = computed(() => {
  const risk = selectedRisk.value;
  if (!risk || submittedNotice.value || noticesLoading.value) return false;
  return (risk.allowed_actions || []).includes('NOTIFY') || risk.state === 'PENDING_NOTIFICATION';
});
const notifyBlockReason = computed(() => {
  if (!selectedRisk.value) return '';
  if (submittedNotice.value) {
    // 回执带回了处理结果就一并说出来："已回执 · 已驱离"才是闭环，只有发送情况说明不了这件事办没办（决策 18-14）。
    const result = labelOf(RECEIPT_RESULT_LABEL, submittedNotice.value.receipt_result, '');
    const delivery = NOTICE_DELIVERY_LABEL[submittedNotice.value.delivery_status] || submittedNotice.value.delivery_status;
    return `已提交通知（${delivery}${result ? ` · 回执${result}` : ''}），不能重复提交`;
  }
  if (noticesLoading.value) return '正在读取交接记录';
  if (selectedRisk.value.state === 'PENDING_VERIFICATION') return '人工核验通过后可通知上级';
  if (canNotifyRisk.value) return '将风险情况通知上级，并等待对方回复处理结果';
  return `当前状态「${stateLabel(selectedRisk.value.state)}」不允许通知`;
});
const verifyBlockReason = computed(() => {
  if (!selectedRisk.value) return '';
  if (canVerifyRisk.value) return selectedRisk.value.state === 'PENDING_NOTIFICATION' ? '将已确认的风险改判为排除，保留原核验记录' : '提交核验通过或排除结论';
  if (selectedRisk.value.state !== 'PENDING_VERIFICATION') return `当前状态「${stateLabel(selectedRisk.value.state)}」不允许核验`;
  return '未授予核验权限：缺少 risk:verify 权限或对象不在当前范围';
});

function formatTime(value) {
  if (value === null || value === undefined) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false });
}

function formatClock(value) {
  if (value === null || value === undefined) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDuration(plan) {
  if (plan.start_at == null || plan.end_at == null) return '不可判定';
  return `${Math.max(0, Math.round((plan.end_at - plan.start_at) / 60000))} 分钟`;
}

function stateLabel(state) { return RISK_STATE_LABEL[state] || state || '未知'; }
function stateTag(state) { return RISK_STATE_TAG[state] || 't-gray'; }
function receiptStatusLabel(risk) {
  if (risk?.state === 'ACKNOWLEDGED') return '已回执';
  if (risk?.state === 'NOTIFIED') return '未回执';
  return '—';
}
function receiptStatusTag(risk) {
  if (risk?.state === 'ACKNOWLEDGED') return 't-green';
  if (risk?.state === 'NOTIFIED') return 't-amber';
  return 't-gray';
}
function severityLabel(severity) { return RISK_SEVERITY_LABEL[severity] || severity || '未知'; }
function severityTag(severity) { return RISK_SEVERITY_TAG[severity] || 't-gray'; }
function heightRelationLabel(value) { return value == null ? '高度关系未知' : HEIGHT_RELATION_LABEL[value] || value; }
function altitudeText(risk) {
  if (!risk || risk.observed_altitude_m == null) return '未知';
  return `${risk.observed_altitude_m} m${risk.observed_altitude_datum ? ` ${risk.observed_altitude_datum}` : ' 基准未知'}`;
}
function relatedIdText(id, permissionCode) {
  // 内部 ID 不直接展示；存在即说明已关联，ID 只放在 title 提示里。
  if (id) return '已关联';
  if (actionAllowed(permissionCode) === false) return '你没有查看这项记录的权限';
  return '没有可查看的相关记录';
}

const planRecords = computed(() => plans.value.map(plan => ({
  id: plan.plan_id, title: plan.route?.name || '未命名航线',
  status: labelOf(PLAN_STATUS_LABEL, plan.status_code), statusClass: PLAN_STATUS_TAG[plan.status_code] || 't-gray',
  subtitle: `${formatTime(plan.start_at)} 起`,
  facts: [{ label: '计划时长', value: formatDuration(plan) }, { label: '目标匹配', value: rowMatch(plan).text }],
  note: plan.route?.max_altitude_m == null ? '最大高度未提供' : `最大高度 ${plan.route.max_altitude_m} 米`
})));

function selectPlan(planId) {
  const hash = `#/flights?plan=${encodeURIComponent(planId)}`;
  S.tabHash = hash;
  location.hash = hash;
  if (selected.value?.plan_id === planId && !detailError.value) { routeMap?.refocus(); return; }
  loadDetail(planId);
}
const riskRecords = computed(() => risks.value.map(risk => ({
  id: risk.risk_id, title: risk.risk_type === 'WEATHER' ? labelOf(REASON_CODE_LABEL, risk.reason_code, '气象风险') : riskTitle(risk), status: stateLabel(risk.state), statusClass: stateTag(risk.state),
  subtitle: `${risk.district_name || '区域未提供'} · ${formatTime(risk.occurred_at)}`,
  summary: ['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(risk.risk_type) ? `${corridorText(risk)} · ${altitudeText(risk)}` : risk.risk_type === 'WEATHER' ? '' : labelOf(REASON_CODE_LABEL, risk.reason_code),
  severity: `${severityLabel(risk.severity)}风险`, severityClass: severityTag(risk.severity),
  facts: [{ label: '风险等级', value: severityLabel(risk.severity), className: `tag ${severityTag(risk.severity)}` },
    { label: '回执状态', value: receiptStatusLabel(risk) === '—' ? '暂无回执' : receiptStatusLabel(risk) }],
  note: `${labelOf(SOURCE_MODE_LABEL, risk.source_mode)} · 接收于 ${formatClock(risk.received_at)}`
})));

function riskMessageOf(reason, fallback) {
  if (!reason) return fallback;
  if (reason.status === 401) return '登录已失效，请重新登录。';
  if (reason.status === 403) return '当前账号没有查看飞行风险的权限。';
  if (reason.code === 'TIMEOUT' || reason.code === 'NETWORK_ERROR') return '服务连接超时或不可用，请稍后重试。';
  return reason.message || fallback;
}

let planListToken = 0;
async function loadPlans(nextPage = page.value, requestedId = null) {
  const token = ++planListToken;
  loading.value = true;
  error.value = '';
  try {
    const data = await flightApi.list({
      page: nextPage,
      size: size.value,
      status_code: filters.status_code
    });
    if (token !== planListToken || activeTab.value !== 'route') return;
    page.value = data.page;
    total.value = data.total;
    plans.value = data.items;
    routeLoaded.value = true;
    // 列表已可浏览，详情、轨迹和实际对照各自显示加载状态。
    loading.value = false;
    loadRowActuals(plans.value);
    loadPlanKpis();
    if (requestedId) { await loadDetail(requestedId); return; }
    if (!selected.value || !plans.value.some(item => item.plan_id === selected.value.plan_id)) {
      selected.value = plans.value[0] || null;
      S.selectedPlanId = selected.value?.plan_id || null;
      routeVersion.value = null;
      airspaceVersions.value = [];
      conflicts.value = [];
      routeGeometryError.value = '';
      airspaceError.value = '';
      destroyRouteMap();
      if (selected.value) await loadDetail(selected.value.plan_id);
    }
  } catch (requestError) {
    if (token !== planListToken || activeTab.value !== 'route') return;
    // 请求失败必须保留真实错误，绝不以演示数据伪造一个“正常”列表。
    plans.value = [];
    total.value = 0;
    selected.value = null;
    routeVersion.value = null;
    airspaceVersions.value = [];
    conflicts.value = [];
    routeGeometryError.value = '';
    airspaceError.value = '';
    destroyRouteMap();
    routeLoaded.value = false;
    error.value = requestError.message || '读取飞行计划失败';
  } finally {
    if (token === planListToken) loading.value = false;
  }
}

let planDetailToken = 0;
async function loadDetail(planId) {
  const current = ++planDetailToken;
  S.selectedPlanId = planId;
  trajectoryToken++;
  trajectory.value = null;
  matchedTrackNote.value = '';
  selected.value = null;
  planDeviceCheck.value = null;
  detailLoading.value = true;
  detailError.value = '';
  routeVersion.value = null;
  airspaceVersions.value = [];
  conflicts.value = [];
  routeGeometryError.value = '';
  airspaceError.value = '';
  routeGeometryLoading.value = false;
  actuals.value = null;
  actualsError.value = '';
  matchedTarget.value = null;
  destroyRouteMap();
  let plan = null;
  try {
    plan = await flightApi.detail(planId);
    if (current !== planDetailToken) return;
    selected.value = plan;
    S.selectedPlanId = plan.plan_id;
  } catch (requestError) {
    if (current !== planDetailToken) return;
    detailError.value = requestError.message || '读取计划详情失败';
  } finally {
    if (current === planDetailToken) detailLoading.value = false;
  }
  // 计划详情只要求 flight:read；航线几何另行读取，不能让 route:read 失败掩盖已取得的计划事实。
  if (plan && selected.value?.plan_id === plan.plan_id) {
    await Promise.all([loadRouteGeometry(plan), loadAirspaceContext(plan), loadActuals(plan), loadRouteRisks(plan)]);
  }
}

/* ---------- 计划与实际对照（阶段 9）----------
   各段自带 availability：无权限的段只说"无权限查看"，不显示任何数量；
   有权限但没有数据是空列表或"尚无引擎研判"，两者含义不同，页面不能混为一谈。
   匹配、高度关系、合法性都来自同一次已保存的研判，页面不自行计算几何或换算高度基准。 */
const actuals = ref(null);
const actualsLoading = ref(false);
const actualsError = ref('');

/* 列表"匹配"列：每行各读一次对照聚合（与详情栏同一接口、同一口径）。
   读失败或无权限的行显示 —，不阻塞列表；翻页后旧结果作废。 */
const rowActuals = reactive({});
let rowActualsSeq = 0;
async function loadRowActuals(rows) {
  const seq = ++rowActualsSeq;
  Object.keys(rowActuals).forEach(key => { delete rowActuals[key]; });
  await Promise.all(rows.map(async plan => {
    let section = null;
    if (['EXECUTING', 'COMPLETED'].includes(plan.status_code)) {
      try { section = (await flightApi.actuals(plan.plan_id))?.match || null; } catch { section = null; }
    }
    if (seq === rowActualsSeq) rowActuals[plan.plan_id] = section;
  }));
}
function rowMatch(plan) {
  const section = rowActuals[plan.plan_id];
  if (['PENDING', 'APPROVED'].includes(plan.status_code)) return { text: '暂不判定', tag: '', title: '未执行计划不作实际飞行判定；到期未匹配须人工核实' };
  if (plan.status_code === 'CANCELLED') return { text: '—', tag: '', title: '计划已取消' };
  if (hasRouteDeviation(section)) return { text: '计划偏离', tag: 't-red', title: '研判记录：实际位置偏离计划走廊' };
  if (section && sectionReady(section)) return { text: labelOf(PLAN_ROW_MATCH_LABEL, section.plan_match_code), tag: PLAN_MATCH_TAG[section.plan_match_code] || 't-gray', title: '' };
  if (section === undefined) return { text: '…', tag: 't-gray', title: '正在读取对照结论' };
  if (!section) return { text: '—', tag: '', title: '对照结论读取失败或无权限' };
  if (!sectionReady(section)) return { text: section.availability === 'NO_EVALUATION' ? '未匹配' : '—', tag: section.availability === 'NO_EVALUATION' ? 't-amber' : '', title: matchMetricNote(section) };
  return { text: labelOf(PLAN_ROW_MATCH_LABEL, section.plan_match_code), tag: PLAN_MATCH_TAG[section.plan_match_code] || 't-gray', title: '' };
}

/* 合法性判定（决策 19-1）：研判是拿实际飞行与计划比对出来的，**待执行的计划必然还没有研判**——
   过去这个按钮恰好只在待执行时出现，点过去永远是空的。现在反过来：待执行只留一句说明，
   执行中 / 已完成才给按钮，并把本计划带过去预置筛选（研判页按 plan_id 过滤）。 */
const matchedTargetId = computed(() => actuals.value?.match?.target_id || null);
const planLegalityReady = computed(() => ['EXECUTING', 'COMPLETED'].includes(selected.value?.status_code));
function goLegality() {
  const planId = selected.value?.plan_id;
  const context = planId ? { plan: planId, ...(matchedTargetId.value ? { target: matchedTargetId.value } : {}) } : null;
  if (window.UI?.goto) window.UI.goto('legality', context);
  else location.hash = planId ? `#/legality?plan=${encodeURIComponent(planId)}` : '#/legality';
}

/* 使用后端按计划时段截取的匹配目标实测点；保留轨迹断点，不使用最新位置代替历史。 */
const matchedTarget = ref(null);
const matchedTrackNote = ref('');
const trajectory = ref(null);
const trajectoryPoints = computed(() => trustedTrajectoryPoints(trajectory.value));
let trajectoryToken = 0;
async function loadMatchedTarget(plan) {
  const current = ++trajectoryToken;
  matchedTarget.value = null;
  trajectory.value = null;
  matchedTrackNote.value = '';
  if (!['EXECUTING', 'COMPLETED'].includes(plan?.status_code)) return;
  try {
    const result = await flightApi.trajectory(plan.plan_id);
    if (current !== trajectoryToken || selected.value?.plan_id !== plan.plan_id) return;
    trajectory.value = result;
    matchedTrackNote.value = trajectoryNoteText(result.note);
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (current !== trajectoryToken || selected.value?.plan_id !== plan.plan_id) return;
    matchedTrackNote.value = `匹配目标轨迹读取失败：${requestError?.message || '无目标读取权限'}`;
  }
}

/* ---------- 本航线风险（按 legacy「按航线看」区块）：沿线风险直接给「通知上级」入口，状态机与写入口仍是风险页签那一套 ---------- */
const ROUTE_RISK_DAYS = 7; // 与 legacy 一致的演示缺省值，业务方未确认
const routeRisks = reactive({ loading: false, error: '', items: [], total: 0, loaded: false });
let routeRisksToken = 0;
async function loadRouteRisks(plan) {
  const token = ++routeRisksToken;
  routeRisks.items = []; routeRisks.total = 0; routeRisks.error = ''; routeRisks.loaded = false; routeRisks.loading = false;
  if (!plan?.route?.route_version_id || ['COMPLETED', 'CANCELLED'].includes(plan.status_code)) return;
  routeRisks.loading = true;
  try {
    const now = Date.now();
    // 按计划关联读取所有类型，气象风险不要求关联感知目标或异物空间事实。
    const data = await riskApi.listRisks({ ...DISPLAY_RISK_SCOPE, plan_id: plan.plan_id, occurred_from: now - ROUTE_RISK_DAYS * 86400000, occurred_to: now + 86400000, page: 1, size: 50 });
    if (token !== routeRisksToken || activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    routeRisks.items = data.items || [];
    routeRisks.total = data.total || 0;
    routeRisks.loaded = true;
  } catch (requestError) {
    if (token !== routeRisksToken || activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    routeRisks.error = requestError.message || '读取本航线风险失败';
  } finally {
    if (token === routeRisksToken) routeRisks.loading = false;
  }
}
const routeRiskRecords = computed(() => routeRisks.items.map(item => {
  const fact = item.space_fact;
  const position = [];
  if (fact?.distance_to_route_m != null) position.push(`距航线中心线 ${(fact.distance_to_route_m / 1000).toFixed(2)} km`);
  if (fact?.target_altitude_raw != null) position.push(`高度 ${fact.target_altitude_raw} m`);
  return {
    id: item.risk_id, title: riskTitle(item), severity: item.severity,
    severityLabel: `${severityLabel(item.severity)}风险`, severityClass: severityTag(item.severity),
    stateLabel: stateLabel(item.state), stateClass: stateTag(item.state),
    sourceLabel: labelOf(SOURCE_MODE_LABEL, item.source_mode, '来源未提供'),
    occurredAt: formatTime(item.occurred_at),
    relationText: fact ? corridorText(item) : '', positionText: position.join(' · '),
    reason: item.reason_text || '', canNotify: canNotifyItem(item)
  };
}));
function notifyRouteRisk(riskId) {
  const item = routeRisks.items.find(risk => risk.risk_id === riskId);
  if (item) openRiskNotify(item);
}
// 与服务端展示筛选相同，仅防止旧样例书签重新打开；不依据 mock/replay 模式一概隐藏。
function isDisplayDemoRisk(item) {
  return item?.source_mode === 'mock' && (item.source_code === 'WEATHER-DEMO'
    || String(item.source_risk_id || '').startsWith('pending-plan-notice-demo-'));
}
function corridorText(item) {
  const relation = item.space_fact?.corridor_relation;
  if (relation === 'INSIDE') return '走廊内';
  if (relation === 'NEAR') return '邻近';
  if (relation === 'OUTSIDE') return '走廊外';
  return '走廊关系未确定';
}
function riskTitle(item) {
  const fact = item.space_fact;
  if (item.risk_type === 'WEATHER') return '气象风险 · ' + labelOf(REASON_CODE_LABEL, item.reason_code, '气象预警');
  if (fact?.subtype_name) return fact.object_count ? `${fact.subtype_name} ×${fact.object_count}` : fact.subtype_name;
  return labelOf(RISK_TYPE_LABEL, item.risk_type);
}
/* 行内只放「通知上级」：以服务端 allowed_actions 为准，旧记录不带 NOTIFY 时按「待通知」放开；重复提交由服务端 409 裁决。 */
function canNotifyItem(item) { return (item.allowed_actions || []).includes('NOTIFY') || item.state === 'PENDING_NOTIFICATION'; }
function jumpToRisk(riskId) {
  const planId = selected.value?.plan_id;
  const hash = `#/flights?tab=events&risk=${encodeURIComponent(riskId)}${planId ? `&plan=${encodeURIComponent(planId)}` : ''}`;
  S.tabHash = hash;
  location.hash = hash;
  showEventsTab(riskId, planId);
}

function openRelatedPlan() {
  const planId = selectedRisk.value?.plan_id;
  if (!planId || !canFilterByPlan.value) return;
  const hash = `#/flights?plan=${encodeURIComponent(planId)}`;
  S.tabHash = hash;
  location.hash = hash;
  showRouteTab(planId);
}

function clearRiskPlanScope() {
  riskFilters.plan_id = '';
  S.tabHash = '#/flights?tab=events';
  location.hash = S.tabHash;
  applyRiskFilters();
}

async function loadActuals(plan) {
  actualsLoading.value = true;
  actualsError.value = '';
  try {
    const data = await flightApi.actuals(plan.plan_id);
    if (activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    actuals.value = data;
    loadMatchedTarget(plan);
  } catch (requestError) {
    if (activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    actualsError.value = requestError.message || '读取计划与实际对照失败';
  } finally {
    if (selected.value?.plan_id === plan.plan_id) actualsLoading.value = false;
  }
}

/* 与 legacy 一致：待执行的计划没有"实际"可对照，已结束的计划不再做航线风险预检。 */
const planPending = computed(() => ['PENDING', 'APPROVED'].includes(selected.value?.status_code));
const planEnded = computed(() => ['COMPLETED', 'CANCELLED'].includes(selected.value?.status_code));
/* 没有事实就不摆空分区：待执行/已取消的计划没有实际飞行可对照；已结束或无走廊的计划没有起飞前航线预检。 */
/* 有引擎结论就照实显示（状态字段不随时间流转，已批准的计划也可能早已飞过）；没有结论且计划还没飞或已取消，才不摆空分区。 */
const showComparison = computed(() => ['EXECUTING', 'COMPLETED'].includes(selected.value?.status_code));
const showRouteRisks = computed(() => !planEnded.value && !!selected.value?.route?.route_version_id);
function sectionReady(section) { return section?.availability === 'AVAILABLE'; }
function sectionNote(section) { return labelOf(SECTION_AVAILABILITY_LABEL, section?.availability, '暂不可用'); }
/* 计划时段内没有任何感知目标被引擎匹配到这条计划：对监管者来说是"没飞或没测到"，不是引擎的事，措辞与原版一致。 */
const NO_MATCH_NOTE = '该时段未找到对应飞机';
function matchSectionNote(section) { return section?.availability === 'NO_EVALUATION' ? NO_MATCH_NOTE : sectionNote(section); }
function matchMetricNote(section) { return section?.availability === 'NO_EVALUATION' ? '未找到对应飞机' : sectionNote(section); }

/* 高度关系只在目标高度与计划高度带同基准时才有方向；否则说明为什么判不了，绝不替引擎换算 AGL/AMSL。 */
const planAltitudeText = computed(() => {
  const section = actuals.value?.altitude_relation;
  if (!sectionReady(section)) return sectionNote(section);
  const relation = labelOf(ALTITUDE_RELATION_LABEL, section.relation);
  if (section.relation !== 'UNDETERMINED' || !section.unknown_reason) return relation;
  return `${relation}（${labelOf(RULE_REASON_TEXT, section.unknown_reason)}）`;
});

/* C01 的 message 里带着原始原因码（例如 CORRIDOR_MISMATCH），不能直接上屏；只取 facts 里的原因码翻译。 */
/* 参数状态是规则集版本级的事实：DEMO 版本得出的结论不能被当成已确认口径使用，必须在结论旁边说明。 */
const demoParams = computed(() => actuals.value?.match?.param_status === 'DEMO');

const matchReasonText = computed(() => {
  const reason = actuals.value?.match?.hit_details_c01?.[0]?.facts?.match_reason;
  return reason ? labelOf(RULE_REASON_TEXT, reason) : '';
});

const altitudeBandText = computed(() => {
  const section = actuals.value?.altitude_relation;
  if (!sectionReady(section) || section.min_altitude_m == null || section.max_altitude_m == null) return '';
  return `${section.min_altitude_m} ～ ${section.max_altitude_m} 米（${labelOf(ALTITUDE_DATUM_LABEL, section.datum, '基准未知')}）`;
});

const targetAltitudeText = computed(() => {
  const section = actuals.value?.altitude_relation;
  if (!sectionReady(section) || section.target_altitude_m == null) return '';
  return `${section.target_altitude_m} 米（${labelOf(ALTITUDE_DATUM_LABEL, section.datum, '基准未知')}）`;
});


async function loadRouteGeometry(plan) {
  if (!plan.route?.route_version_id) return;
  routeGeometryLoading.value = true;
  routeGeometryError.value = '';
  try {
    const version = await flightApi.routeVersion(plan.route.route_version_id);
    if (activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    routeVersion.value = version;
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    routeGeometryError.value = requestError.message || '你没有查看航线的权限，或航线位置加载失败';
    destroyRouteMap();
  } finally {
    if (selected.value?.plan_id === plan.plan_id) routeGeometryLoading.value = false;
  }
}

function trustedCoordinates(version) {
  const line = version?.centerline;
  if (line?.type !== 'LineString' || line?.coordinate_system !== 'WGS84'
    || version?.field_issues?.some(issue => issue.field === 'centerline') || !Array.isArray(line.coordinates)) return null;
  const coordinates = line.coordinates.map(point => [Number(point?.[0]), Number(point?.[1])]);
  if (coordinates.length < 2 || coordinates.some(([longitude, latitude]) => !Number.isFinite(longitude)
    || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90)) return null;
  return coordinates;
}

function trustedAirspaceOverlays() {
  const byVersion = new Map(airspaceVersions.value.map(version => [version.airspace_version_id, version]));
  return conflicts.value.flatMap(conflict => {
    const version = byVersion.get(conflict.airspace_version_id);
    const boundary = version?.boundary;
    if (boundary?.type !== 'MultiPolygon' || boundary.coordinate_system !== 'WGS84'
      || version.field_issues?.some(issue => issue.field === 'boundary') || !Array.isArray(boundary.coordinates)) return [];
    const polygons = boundary.coordinates.map(polygon => polygon.map(ring => ring.map(point => [Number(point?.[0]), Number(point?.[1])])))
      .filter(polygon => polygon.length && polygon.every(ring => ring.length >= 4 && ring.every(([longitude, latitude]) => Number.isFinite(longitude)
        && Number.isFinite(latitude) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90)));
    return polygons.length ? [{ conflict, polygons }] : [];
  });
}

function destroyRouteMap() {
  stopObjectPlayback();
  if (routeMap) routeMap.destroy();
  routeMap = null;
  deviceMarkers.value = [];
}

function updatePlanDeviceMap({ planId, check }) {
  if (selected.value?.plan_id !== planId) return;
  const oldPositions = JSON.stringify(mapDevices.value.map(row => [row.device_id, row.position]));
  planDeviceCheck.value = check;
  const newPositions = JSON.stringify(mapDevices.value.map(row => [row.device_id, row.position]));
  // 状态刷新沿用原地图；只有点位变化才重新取景，避免每 30 秒打断用户缩放。
  if (activeTab.value === 'route' && (!routeMap || oldPositions !== newPositions)) renderRouteMap();
}

function syncDeviceMarkers(map) {
  const markers = mapDevices.value.flatMap(row => {
    const [x, y] = map.px(row.position.lon, row.position.lat);
    return x >= 0 && x <= map.w && y >= 0 && y <= map.h
      ? [{ ...row, x: Math.round(x), y: Math.round(y), leftward: x > map.w / 2, downward: y < 130 }] : [];
  });
  if (JSON.stringify(markers) !== JSON.stringify(deviceMarkers.value)) deviceMarkers.value = markers;
}

function renderRouteMap() {
  if (activeTab.value !== 'route') return;
  destroyRouteMap();
  const coordinates = trustedCenterline.value;
  const airspaces = trustedAirspaces.value;
  const target = matchedTarget.value;
  const points = trajectoryPoints.value;
  if (activeTab.value !== 'route' || !mapHost.value || (!coordinates && !airspaces.length && !points.some(Boolean) && !mapDevices.value.length)) return;
  routeMap = new window.MapView(mapHost.value, {
    zoom: 3.2, maxDev: 0, legend: false, layers: { device: false, track: !!target, alarm: false }
  });
  routeMap.setData({ airspaces: [], devices: [], targets: target ? [target] : [], alarms: [] });
  if (target) routeMap.sel = target.id;
  const drawBase = routeMap.draw.bind(routeMap);
  routeMap.draw = function drawRouteCenterline() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    // API 的 WGS-84 坐标顺序固定为 [longitude, latitude]；只画可信几何，不以缺失数据推断空域或合法性。
    context.save();
    airspaces.forEach(({ polygons }) => {
      context.beginPath();
      polygons.forEach(polygon => polygon.forEach(ring => ring.forEach(([longitude, latitude], index) => {
        const point = this.px(longitude, latitude);
        if (index) context.lineTo(point[0], point[1]);
        else context.moveTo(point[0], point[1]);
      })));
      context.fillStyle = '#a97bff18';
      context.fill('evenodd');
      context.setLineDash([6, 4]);
      context.strokeStyle = '#7545c7';
      context.lineWidth = 1.35;
      context.stroke();
      context.setLineDash([]);
    });
    // corridor_width_m 是走廊全宽；未做投影缓冲时不能把全宽误当半径，因此只描中心线样式。
    strokePlanComparison(context, this, coordinates, points);
    context.restore();
    syncDeviceMarkers(this);
  };
  const extent = [...(coordinates || []), ...points.filter(Boolean).map(p => [p.lon, p.lat]),
    ...mapDevices.value.map(row => [row.position.lon, row.position.lat])];
  if (extent.length) routeMap.fitTo(extent, 0.34);
  else {
    const [longitude, latitude] = target ? [target.lon, target.lat] : airspaces[0].polygons[0][0][0];
    routeMap.centerAt(longitude, latitude);
  }
}

async function loadAirspaceContext(plan) {
  airspaceLoading.value = true;
  airspaceError.value = '';
  try {
    const facts = await flightApi.conflicts(plan.plan_id);
    if (activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    const versionIds = [...new Set(facts.map(fact => fact.airspace_version_id).filter(Boolean))];
    const versions = await Promise.all(versionIds.map(id => airspaceApi.version(id)));
    if (activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    conflicts.value = facts;
    airspaceVersions.value = versions;
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (activeTab.value !== 'route' || selected.value?.plan_id !== plan.plan_id) return;
    // 冲突读取需要 airspace:read；无此权限只隐藏空域事实，不能覆盖已有 flight:read 计划详情。
    airspaceError.value = requestError.message || '空域冲突记录加载失败';
    airspaceVersions.value = [];
    conflicts.value = [];
    renderRouteMap();
  } finally {
    if (selected.value?.plan_id === plan.plan_id) airspaceLoading.value = false;
  }
}

function applyFilters() {
  routeLoaded.value = false;
  loadPlans(1);
}

function chooseStatus(value) { filters.status_code = value; applyFilters(); }
// 下拉一改就查（与 legacy 一致）；关键词仍走回车/查询。
watch(() => filters.status_code, () => applyFilters());
function changePage(nextPage) { if (nextPage !== page.value) loadPlans(nextPage); }
function changePageSize(nextSize) { size.value = nextSize; routeLoaded.value = false; loadPlans(1); }

/* 导出：与列表同参（含筛选与排序），文件名取服务端的 Content-Disposition。 */
async function exportRiskCsv() {
  try {
    // 导出取全量（受服务端 5000 行上限约束），不受当前分页限制。
    const file = await riskApi.exportRisksCsv(riskQuery());
    if (!file) return;
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('已开始下载风险列表', 'ok');
  } catch (error) {
    toast(error?.code === 'EXPORT_TOO_LARGE'
      ? '导出行数超过上限（5000 行），请缩小筛选范围后重试'
      : error?.message || '导出失败', 'err');
  }
}

/* ---------- 风险页签：列表 / KPI ---------- */
function riskQuery() {
  const text = value => String(value ?? '').trim();
  const query = { ...EVENT_RISK_SCOPE, severity: riskFilters.severity || '', state: riskFilters.state || '', owner_org_id: text(riskFilters.owner_org_id),
    district_id: text(riskFilters.district_id), source_mode: text(riskFilters.source_mode),
    target_type: riskFilters.risk_type === 'WEATHER' ? '' : riskFilters.target_type || '', risk_type: riskFilters.risk_type || '', sort: riskSort.field, order: riskSort.order };
  // plan_id 筛选另需 flight:read；已知无权限时控件禁用，也不把值带进请求以免换来 403。
  if (canFilterByPlan.value && text(riskFilters.plan_id)) query.plan_id = text(riskFilters.plan_id);
  const range = Array.isArray(riskFilters.occurred) ? riskFilters.occurred : null;
  if (range && range[0] != null && range[1] != null) {
    // 契约要求 [from,to) 且 from < to；不满足时直接报错，不偷偷丢弃筛选。
    if (!(Number(range[0]) < Number(range[1]))) throw new Error('发生时间范围必须满足开始时间早于结束时间。');
    query.occurred_from = Number(range[0]);
    query.occurred_to = Number(range[1]);
  }
  return query;
}

async function loadRisks(nextPage = riskPage.value, requestedId = null) {
  const token = ++riskListToken;
  riskLoading.value = true;
  riskError.value = '';
  let query = {};
  let nextRiskId = null;
  try {
    query = riskQuery();
    const data = await riskApi.listRisks({ ...query, page: nextPage, size: riskSize.value });
    if (token !== riskListToken) return;
    risks.value = data.items || [];
    riskPage.value = data.page;
    riskTotal.value = data.total;
    if (requestedId) {
      // 深链 ID 不在当前分页时仍按精确 ID 读详情；失败必须显式报错，不能默认打开无关风险。
      nextRiskId = requestedId;
    } else {
      const wanted = S.selectedRiskId;
      // safe-default: 普通列表进入时首行会高亮，用户可见且可立即改选；深链路径已在上方严格处理。
      const next = risks.value.find(item => item.risk_id === wanted) || risks.value[0] || null;
      nextRiskId = next?.risk_id || null;
      if (!nextRiskId) clearRiskDetail();
    }
  } catch (requestError) {
    if (token !== riskListToken) return;
    risks.value = [];
    riskTotal.value = 0;
    clearRiskDetail();
    // 风险链路失败不回退 legacy Mock，也不把 403/500 伪装成“暂无风险”。
    riskError.value = requestError.status === 403 && query.plan_id
      ? '按计划 ID 筛选需要 flight:read 权限（或当前账号无 risk:read）；请清空计划 ID 后重试。'
      : riskMessageOf(requestError, '读取飞行风险失败');
  } finally {
    if (token === riskListToken) riskLoading.value = false;
  }
  // 列表完成即展示；详情和地图失败不能清空已成功读取的列表。
  if (token === riskListToken && nextRiskId) await loadRiskDetail(nextRiskId);
}

async function loadRiskKpis() {
  const token = ++riskKpiToken;
  const keys = Object.keys(RISK_KPI_QUERIES);
  const results = await Promise.allSettled(keys.map(key => riskApi.listRisks({ ...EVENT_RISK_SCOPE, ...RISK_KPI_QUERIES[key], page: 1, size: 1 })));
  if (token !== riskKpiToken) return;
  const totals = {};
  const failed = {};
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') totals[keys[index]] = result.value.total;
    else failed[keys[index]] = true;
  });
  riskKpiTotals.value = totals;
  riskKpiFailed.value = failed;
  await loadRoutesInvolved(token);
}

async function loadRoutesInvolved(token) {
  try {
    const summary = await riskApi.spaceRiskSummary(DISPLAY_RISK_SCOPE);
    if (token !== riskKpiToken) return;
    const metric = summary?.routes_involved ?? summary?.metrics?.routes_involved ?? null;
    routesSummary.value = metric && typeof metric === 'object'
      ? { state: 'ok', value: metric.value ?? null, availability: metric.availability || '', error: '' }
      : { state: 'ok', value: metric ?? null, availability: summary?.availability || '', error: '' };
  } catch (error) {
    if (token !== riskKpiToken) return;
    routesSummary.value = { state: 'error', value: null, availability: '', error: error?.message || '读取失败' };
  }
}

function clearRiskDetail() {
  resetObjectMap();
  riskDetailToken += 1;
  riskHistoryToken += 1;
  selectedRisk.value = null;
  resetRiskWeather();
  riskHistory.value = [];
  riskHistoryTotal.value = 0;
  riskHistoryPage.value = 1;
  riskHistoryError.value = '';
  riskRouteVersion.value = null;
  riskTarget.value = null;
  riskTargetNote.value = '';
  riskMapError.value = '';
  riskMapLoading.value = false;
  S.selectedRiskId = null;
  activeRiskId.value = null;
  destroyRouteMap();
}

/* ---------- 风险页签：详情 / 历史 / 地图依据 ---------- */
async function loadRiskDetail(riskId) {
  resetObjectMap();
  const token = ++riskDetailToken;
  riskHistoryToken += 1;
  activeRiskId.value = riskId;
  riskDetailLoading.value = true;
  riskDetailError.value = '';
  selectedRisk.value = null;
  resetRiskWeather();
  riskHistoryError.value = '';
  riskRouteVersion.value = null;
  riskTarget.value = null;
  riskTargetNote.value = '';
  riskMapError.value = '';
  riskMapLoading.value = false;
  destroyRouteMap();
  let detail = null;
  try {
    const [risk, history] = await Promise.all([
      riskApi.getRisk(riskId),
      riskApi.listRiskVerifications(riskId, { page: 1, size: HISTORY_PAGE_SIZE })
    ]);
    if (token !== riskDetailToken) return;
    if (!EVENT_RISK_TYPES.includes(risk.risk_type)) {
      throw new Error('这条记录属于空域或飞行计划风险，不在本列表的展示范围内。');
    }
    if (isDisplayDemoRisk(risk)) {
      throw new Error('这条记录是预设展示样例，已从业务风险展示中移除。');
    }
    detail = risk;
    selectedRisk.value = risk;
    riskHistory.value = history.items || [];
    riskHistoryTotal.value = history.total;
    riskHistoryPage.value = history.page;
    S.selectedRiskId = risk.risk_id;
  } catch (requestError) {
    if (token !== riskDetailToken) return;
    selectedRisk.value = null;
    riskHistory.value = [];
    riskHistoryTotal.value = 0;
    riskHistoryPage.value = 1;
    S.selectedRiskId = riskId;
    riskDetailError.value = riskMessageOf(requestError, '读取风险详情或核验历史失败');
  } finally {
    if (token === riskDetailToken) riskDetailLoading.value = false;
  }
  if (!detail || token !== riskDetailToken) return;
  // 先绘制风险快照；独立位置请求完成后合并当前几何，慢请求不阻挡已取得的数据。
  async function updateMap() {
    await nextTick();
    if (token !== riskDetailToken) return;
    renderRiskMap();
  }
  await updateMap();
  await Promise.allSettled([
    loadRiskTargetPosition(detail, token), loadRiskRouteGeometry(detail, token), loadRiskWeather(detail, token)
  ].map(async request => { await request; await updateMap(); }));
}

function resetRiskWeather() {
  riskWeather.value = null;
  riskWeatherError.value = '';
  riskWeatherLoading.value = false;
  weatherVisible.value = true;
  weatherOpened.value = false;
  weatherBoundaryVisible.value = false;
}

async function loadRiskWeather(risk, token) {
  if (risk.risk_type !== 'WEATHER') return;
  riskWeatherLoading.value = true;
  try {
    const fact = await riskApi.getWeatherFact(risk.risk_id);
    if (token !== riskDetailToken) return;
    // 拒绝模式不一致的数据；真实来源不回退成模拟区域。
    if (fact && fact.source_mode !== risk.source_mode) throw new Error('气象数据来源不一致');
    riskWeather.value = fact;
    if (fact && !weatherPolygon(fact)) riskWeatherError.value = '气象范围坐标不完整，暂时无法绘制';
  } catch (error) {
    if (token !== riskDetailToken) return;
    riskWeatherError.value = `气象区域读取失败：${error?.message || '请重试'}`;
  } finally {
    if (token === riskDetailToken) riskWeatherLoading.value = false;
  }
}

function pickWeatherArea(event) {
  if (!weatherVisible.value || !weatherRing.value || !routeMap || routeMap._dragged
    || Date.now() < (routeMap._suppressClickUntil || 0)
    || event.target.closest('button,a,summary,.mapctl,.maptip,.maplibregl-control-container')) return;
  const rect = riskMapHost.value.getBoundingClientRect();
  const point = [event.clientX - rect.left, event.clientY - rect.top];
  if (insideWeather(point, weatherRing.value.map(p => routeMap.px(...p)))) weatherOpened.value = true;
}

function toggleWeatherLayer() {
  weatherVisible.value = !weatherVisible.value;
  if (!weatherVisible.value) weatherOpened.value = false;
  routeMap?.draw();
}

/** 风险关联的感知目标：风险行里带 target_id，位置要再读一次目标详情才有。 */
async function loadRiskTargetPosition(risk, token) {
  if (!risk.target_id) return;
  try {
    const loaded = await loadTargetPosition(risk.target_id, { risk: severityLabel(risk.severity) });
    if (token !== riskDetailToken) return;
    objectTrackError.value = loaded.trackError ? '轨迹暂时无法读取' : '';
    if (!loaded.mapTarget) { riskTargetNote.value = `相关目标的位置无法确认`; return; }
    riskTarget.value = { ...loaded.mapTarget, id: '关联目标' };
  } catch (requestError) {
    if (token !== riskDetailToken) return;
    riskTargetNote.value = `关联目标位置读取失败：${requestError?.message || '无目标读取权限'}`;
  }
}

async function loadRiskRouteGeometry(risk, token) {
  // 风险本身没有坐标字段；只有服务端返回 route_version_id 且本人具备 route:read 时才读取已保存航线版本几何。
  if (!risk.route_version_id || !canReadRoute.value) return;
  riskMapLoading.value = true;
  riskMapError.value = '';
  try {
    const version = await flightApi.routeVersion(risk.route_version_id);
    if (token !== riskDetailToken) return;
    riskRouteVersion.value = version;
  } catch (requestError) {
    if (token !== riskDetailToken) return;
    riskMapError.value = `航线位置加载失败：${riskMessageOf(requestError, '你没有查看该航线的权限，或航线记录已不存在')}`;
  } finally {
    if (token === riskDetailToken) riskMapLoading.value = false;
  }
}

function renderRiskMap() {
  if (activeTab.value !== 'events') return;
  destroyRouteMap();
  if (activeTab.value !== 'events' || !riskMapHost.value) return;
  const coordinates = riskMapCoords.value;
  const point = riskPoint.value;
  const target = riskTarget.value ? { ...riskTarget.value, activeRisk: abnormalActive(selectedRisk.value) } : null;
  const weather = riskWeather.value;
  const ring = weatherRing.value;
  /* 视野按"这条风险相关的全部几何"收：风险点、关联目标、航线中心线三样有几样算几样。
     只 centerAt 或只按中心线收，都会把另外两样推到视野外，看上去还是一张空图。 */
  const focus = coordinates ? coordinates.slice() : [];
  if (ring) focus.push(...ring);
  if (point) focus.push([point.longitude, point.latitude]);
  if (target && Number.isFinite(target.lon) && Number.isFinite(target.lat)) focus.push([target.lon, target.lat]);
  routeMap = new window.MapView(riskMapHost.value, {
    zoom: focus.length ? 3.2 : 1, maxDev: 0, legend: false,
    layers: { device: false, track: !!target && !objectRiskSelected.value, alarm: false }
  });
  routeMap.setData({ airspaces: [], devices: [], targets: target && !objectRiskSelected.value ? [target] : [], alarms: [] });
  if (target) routeMap.sel = target.id;
  if (!coordinates && !point && !ring && !objectTrail.value.length) { if (focus.length) routeMap.fitTo(focus); return; }
  const version = riskRouteVersion.value;
  const label = '关联航线';
  const drawBase = routeMap.draw.bind(routeMap);
  routeMap.draw = function drawRiskRouteCenterline() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    // 只画已保存航线版本的 WGS-84 中心线与风险自身的位置快照；缺哪样就不画哪样，不以 (0,0) 补位。
    context.save();
    if (objectRiskSelected.value) {
      drawObjectRisk(context, this, { snapshot: objectPosition.value, trail: objectTrail.value, trailIndex: objectTrailIndex.value,
        showTrail: objectTrailVisible.value, heatPoints: objectHeatPoints.value, showHeat: objectHeat.value,
        route: coordinates, corridorWidth: version?.corridor_width_m == null ? null : Number(version.corridor_width_m), color: point?.color || '#ffb020' });
      if (objectPosition.value) {
        const [x, y] = this.px(objectPosition.value.lon, objectPosition.value.lat);
        const leftward = x > this.w - 160;
        if (!objectMarker.value || Math.abs(objectMarker.value.x - x) > .2 || Math.abs(objectMarker.value.y - y) > .2 || objectMarker.value.leftward !== leftward) objectMarker.value = { x, y, leftward };
      }
    }
    if (ring && weatherVisible.value) drawWeatherArea(context, this, weather, ring, coordinates, weatherColor.value, weatherKind.value, simulatedWeather.value, weatherBoundaryVisible.value);
    if (coordinates) strokePlannedRoute(context, this, coordinates, { label });
    if (point && !objectRiskSelected.value) {
      context.save();
      window.UI.applyAlarmGlow(context, selectedRisk.value);
      const at = this.px(point.longitude, point.latitude);
      context.beginPath();
      context.arc(at[0], at[1], 5, 0, Math.PI * 2);
      context.fillStyle = point.color;
      context.fill();
      context.beginPath();
      context.arc(at[0], at[1], 9, 0, Math.PI * 2);
      context.strokeStyle = point.color;
      context.lineWidth = 1.4;
      context.stroke();
      context.restore();
    }
    context.restore();
  };
  if (focus.length) routeMap.fitTo(focus);
}

async function changeRiskHistoryPage(nextPage) {
  const risk = selectedRisk.value;
  if (!risk || nextPage === riskHistoryPage.value) return;
  const token = ++riskHistoryToken;
  riskHistoryLoading.value = true;
  riskHistoryError.value = '';
  try {
    const history = await riskApi.listRiskVerifications(risk.risk_id, { page: nextPage, size: HISTORY_PAGE_SIZE });
    if (token !== riskHistoryToken || selectedRisk.value?.risk_id !== risk.risk_id) return;
    riskHistory.value = history.items || [];
    riskHistoryTotal.value = history.total;
    riskHistoryPage.value = history.page;
  } catch (requestError) {
    if (token !== riskHistoryToken || selectedRisk.value?.risk_id !== risk.risk_id) return;
    riskHistoryError.value = riskMessageOf(requestError, '读取核验历史失败');
  } finally {
    if (token === riskHistoryToken) riskHistoryLoading.value = false;
  }
}

/* ---------- 风险页签：人工核验（共享弹窗，与工作台同一实现） ---------- */
function openRiskVerify() {
  const risk = selectedRisk.value;
  if (!risk || !canVerifyRisk.value) return;
  const riskId = risk.risk_id;
  // 幂等键保留与 409/超时回读都在共享弹窗内处理；页面只负责把最新的风险回读给它。
  openRiskVerification({
    risk,
    refresh: async result => {
      S.selectedRiskId = riskId;
      if (result) await Promise.all([loadRisks(riskPage.value, riskId), loadRiskKpis()]);
      else await loadRiskDetail(riskId);
      return selectedRisk.value?.risk_id === riskId ? selectedRisk.value : null;
    }
  });
}

/* ---------- 风险页签：通知上级（交接提交）与通报记录 ---------- */
function handoffMessageOf(error, fallback) {
  if (!error) return fallback;
  if (error.status === 401) return '登录已失效，请重新登录。';
  if (error.status === 403) return '当前账号没有提交或查看交接的权限。';
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return '服务连接超时或不可用，请稍后重试。';
  return error.message || fallback;
}

async function loadRiskNotices(riskId) {
  const token = ++noticesToken;
  notices.value = []; noticesTotal.value = 0; noticesError.value = '';
  if (!riskId) { noticesLoading.value = false; return; }
  noticesLoading.value = true;
  noticesError.value = '';
  try {
    const data = await handoffApi.listHandoffs({ source_kind: 'RISK', source_id: riskId, page: 1, size: 20 });
    if (token !== noticesToken) return;
    notices.value = data.items || [];
    noticesTotal.value = data.total;
  } catch (requestError) {
    if (token !== noticesToken) return;
    notices.value = [];
    noticesTotal.value = 0;
    noticesError.value = handoffMessageOf(requestError, '读取交接记录失败');
  } finally {
    if (token === noticesToken) noticesLoading.value = false;
  }
}

async function refreshAfterNotify(riskId) {
  S.selectedRiskId = riskId;
  await Promise.all([loadRiskDetail(riskId), loadRiskNotices(riskId)]);
  if (selected.value) loadRouteRisks(selected.value);
}

/* 成功提示只用 Vue 节点渲染服务端 ID，不走 innerHTML；链接指向通知记录详情。
   风险到"通知上级"为止（决策 18-14），所以这里说的是投递与回执，不再提处罚办结。 */
function showHandoffSubmitted(created) {
  const link = `#/punish?handoff=${encodeURIComponent(created.handoff_id)}`;
  openModal({
    title: created.delivery_status === 'DELIVERED' ? '通知已提交并送达' : '通知已提交，尚未发送', width: '520px', footer: false,
    render: () => h('div', { class: 'rk-notify-done' }, [
      h('div', { class: 'warnbox' }, created.delivery_status === 'DELIVERED'
        ? (created.receipt_status === 'ACKNOWLEDGED'
          ? '对方已确认收到通知，请查看对方回复的处理结果。'
          : '通知已送达，正在等待对方确认收到。')
        : '通知材料已保存，但发送功能尚未接通，通知还没有发出去。请查看下方发送情况。'),
      h('dl', { class: 'kv kv-surface' }, [
        h('dt', '通知对象'), h('dd', '上级'),
        h('dt', '发送情况'), h('dd', `${NOTICE_DELIVERY_LABEL[created.delivery_status] || created.delivery_status || '未知'} · ${NOTICE_BLOCKED_LABEL[created.blocked_reason] || created.blocked_reason || '无异常提示'}`)
      ]),
      h('div', { class: 'detail-actions' }, [
        h('button', { class: 'btn', type: 'button', onClick: () => closeModal() }, '关闭'),
        h('a', { class: 'btn pri', href: link, onClick: () => closeModal() }, '查看通知记录')
      ])
    ])
  });
}

async function openRiskNotify(riskOverride = null) {
  const risk = riskOverride || selectedRisk.value;
  if (!risk || (riskOverride ? !canNotifyItem(risk) : !canNotifyRisk.value)) return;
  const riskId = risk.risk_id;
  const expectedVersion = Number(risk.version);
  if (!pendingHandoffKeys.has(riskId)) pendingHandoffKeys.set(riskId, newHandoffIdempotencyKey());
  /* 决策 18-14：风险到"通知上级"为止，回执"已驱离"即闭环，不进处置。
     接收方不再让人选——服务端按默认接收方处理；页面少一个选择，就少一处能选错的地方。 */
  openFormModal({
    title: '通知上级',
    width: '560px',
    warning: '提交后，请在通知记录中查看是否送达，并等待对方回复处理结果。对方回复“已驱离”后，本次风险通知流程完成。',
    fields: [],
    confirmText: '提交通知',
    onSubmit: async () => {
      const key = pendingHandoffKeys.get(riskId);
      const body = { source_kind: 'RISK', source_id: riskId, handoff_type: 'RISK_NOTICE', expected_version: expectedVersion };
      try {
        const created = await handoffApi.createHandoff(body, key);
        pendingHandoffKeys.delete(riskId);
        closeModal();
        await refreshAfterNotify(riskId);
        showHandoffSubmitted(created);
      } catch (requestError) {
        const code = requestError.code;
        if (code === 'HANDOFF_ALREADY_EXISTS' || code === 'IDEMPOTENCY_REPLAY') {
          // 服务端已有这份交接：不重复提交，切到通报记录让用户核对真实记录。
          pendingHandoffKeys.delete(riskId);
          closeModal();
          riskTab.value = 'notice';
          await refreshAfterNotify(riskId);
          toast(code === 'HANDOFF_ALREADY_EXISTS' ? '该风险已经提交过通知，已切换到通报记录。' : '该请求此前已提交，请在通报记录核对。', 'err');
          return;
        }
        if (code === 'VERSION_CONFLICT' || code === 'INVALID_TRANSITION' || code === 'RECIPIENT_NOT_CONFIGURED' || code === 'RECIPIENT_NOT_FOUND') {
          // 明确失败：服务端未落库，换新键并回读风险，避免旧版本再次提交。
          pendingHandoffKeys.set(riskId, newHandoffIdempotencyKey());
          await refreshAfterNotify(riskId);
          throw new Error(`提交被拒绝，已刷新当前状态：${handoffMessageOf(requestError, '请核对后重试')}`);
        }
        if (isUncertainOutcome(requestError)) {
          // 超时 / 断网 / 其他 409：服务端可能已落库。保留原键，先回读风险与交接记录，不自动换键重试、不提示成功。
          await refreshAfterNotify(riskId);
          throw new Error(`提交结果未确认，请刷新核对：${handoffMessageOf(requestError, '未返回明确结果')}`);
        }
        pendingHandoffKeys.set(riskId, newHandoffIdempotencyKey());
        throw new Error(handoffMessageOf(requestError, '提交通知失败'));
      }
    }
  });
}

/* 筛选条一行放不下七个（阶段 18 对照原版：原版只有等级/目标类型/状态三个）：
   常用的四个留在条上，其余三个收进"更多筛选"。收起来的筛选若正在生效，按钮上带数字标出来——
   否则列表被筛过却看不出是被什么筛的。 */
const riskMoreOpen = ref(false);
const riskMoreActiveCount = computed(() => {
  const values = [riskFilters.risk_type === 'WEATHER' ? '' : riskFilters.target_type, riskFilters.source_mode, riskFilters.occurred, riskFilters.district_id, ['', 'SPACE_OBJECT', 'WEATHER'].includes(riskFilters.risk_type) ? '' : riskFilters.risk_type];
  return values.filter(value => (Array.isArray(value) ? value.length > 0 : !!value)).length;
});
const riskMoreTitle = computed(() => (riskMoreActiveCount.value
  ? `另有 ${riskMoreActiveCount.value} 个筛选正在生效：区域 / 目标类型 / 发生时间 / 来源模式 / 风险类型`
  : '展开区域、目标类型、发生时间、来源模式和其他风险类型'));

const riskFilterChips = computed(() => [
  { key: 'district_id', label: riskFilters.district_id ? `区域：${riskDistricts.value.find(d => d.district_id === riskFilters.district_id)?.name || '已选区域'}` : '' },
  { key: 'target_type', label: riskFilters.target_type ? labelOf(OBJECT_TYPE_LABEL, riskFilters.target_type) : '' },
  { key: 'source_mode', label: riskFilters.source_mode ? labelOf(SOURCE_MODE_LABEL, riskFilters.source_mode) : '' },
  { key: 'occurred', label: riskFilters.occurred?.length ? '发生时间已限定' : '' },
  { key: 'risk_type', label: !['', 'SPACE_OBJECT', 'WEATHER'].includes(riskFilters.risk_type) ? labelOf(RISK_TYPE_LABEL, riskFilters.risk_type) : '' }
].filter(chip => chip.label));
function clearRiskFilter(key) { riskFilters[key] = key === 'occurred' ? null : ''; applyRiskFilters(); }

/* ---------- 风险页签：交互 ---------- */
function applyRiskFilters() {
  if (riskFilters.risk_type === 'WEATHER') riskFilters.target_type = '';
  try { riskQuery(); } catch (validation) { riskError.value = validation.message; return; }
  S.selectedRiskId = null;
  loadRisks(1);
}
function changeRiskPage(nextPage) { if (nextPage !== riskPage.value) loadRisks(nextPage); }
function changeRiskPageSize(nextSize) { riskSize.value = nextSize; loadRisks(1); }
function switchRiskTab(tab) {
  if (riskTab.value === tab) return;
  riskTab.value = tab;
}
function selectRisk(riskId) {
  const hash = `#/flights?tab=events&risk=${encodeURIComponent(riskId)}${riskFilters.plan_id ? `&plan=${encodeURIComponent(riskFilters.plan_id)}` : ''}`;
  S.tabHash = hash;
  location.hash = hash;
  if (selectedRisk.value?.risk_id === riskId && !riskDetailError.value) { routeMap?.refocus(); return; }
  loadRiskDetail(riskId);
}
function retryRiskDetail() { if (S.selectedRiskId) loadRiskDetail(S.selectedRiskId); }
function retryRiskList() { loadRiskKpis(); loadRisks(riskPage.value); }

function enterRiskTab(requestedId = null, planId = null) {
  planListToken++;
  planDetailToken++;
  loading.value = false;
  destroyRouteMap();
  // 进页签就先摆出全局底图，不等选中风险（选中后 loadRiskRouteGeometry 会再画一次）。
  nextTick(() => renderRiskMap());
  if (requestedId || planId) {
    // 深链只清筛选与页码，避免选中的那条被当前筛选挡在列表外；详情仍按精确 ID 读取。
    Object.assign(riskFilters, { severity: '', state: '', risk_type: '', plan_id: '', owner_org_id: '', district_id: '', source_mode: '', occurred: null });
    if (planId && canFilterByPlan.value) riskFilters.plan_id = planId;
    riskTab.value = 'event';
    S.selectedRiskId = requestedId;
  }
  loadRiskKpis();
  loadRisks(requestedId || planId ? 1 : riskPage.value, requestedId);
}

/* 阶段 9 曾把 #/risk 拆成独立「空间安全风险」页，已撤回。工作台 / 处罚 / 态势仍可能
   写入深链键 'risk' 或打开 #/risk；本页消费这些上下文，并只在飞行计划里切「全部风险事件」。 */
function consumeRiskDeepLink() {
  const context = window.UI?.consume?.('risk');
  // URL 中的精确 ID 优先，支持刷新/登录恢复；旧的一次性上下文仍兼容。
  const query = new URLSearchParams((location.hash || '').split('?')[1] || '');
  const riskId = query.get('risk');
  if (riskId) return riskId;
  const requested = context?.eventId || context?.riskId || context?.risk_id || context?.risk || null;
  return typeof requested === 'string' && requested ? requested : null;
}

function flightsTabHash(tab) {
  return tab === 'events' ? '#/flights?tab=events' : '#/flights';
}

function showEventsTab(requestedId = null, planId = null) {
  activeTab.value = 'events';
  enterRiskTab(requestedId, planId);
}

function showRouteTab(requestedId = null) {
  riskListToken++;
  riskDetailToken++;
  riskHistoryToken++;
  activeTab.value = 'route';
  destroyRouteMap();
  if (requestedId) {
    filters.status_code = '';
    selected.value = null;
    routeVersion.value = null;
    airspaceVersions.value = [];
    trajectory.value = null;
    planDeviceCheck.value = null;
    S.selectedPlanId = requestedId;
    detailError.value = '';
    loadPlans(1, requestedId);
  }
  else if (!routeLoaded.value && !loading.value) loadPlans();
  else if (selected.value?.plan_id || S.selectedPlanId) loadDetail(selected.value?.plan_id || S.selectedPlanId);
  else nextTick(renderRouteMap);
}

function syncTabByRoute() {
  const raw = location.hash || '';
  if (!['#/flights', '#/risk'].includes(hashPath(raw))) return;
  if (raw === S.tabHash) return;
  if (hashPath(raw).startsWith('#/risk')) {
    S.tabHash = flightsTabHash('events');
    if (raw !== S.tabHash) location.hash = S.tabHash;
    showEventsTab(consumeRiskDeepLink());
    return;
  }
  S.tabHash = raw;
  const query = new URLSearchParams(raw.split('?')[1] || '');
  if (hashWantsEventsTab(raw)) showEventsTab(consumeRiskDeepLink(), query.get('plan'));
  else showRouteTab(query.get('plan') || window.UI?.consume?.('flights')?.plan || (!routeLoaded.value ? S.selectedPlanId : null));
}

function activateTab(tab) {
  const next = flightsTabHash(tab);
  if (location.hash !== next) {
    S.tabHash = next;
    location.hash = next;
  }
  if (tab === 'events') showEventsTab(consumeRiskDeepLink());
  else showRouteTab();
}

onMounted(() => {
  loadRiskDistricts();
  window.addEventListener('hashchange', syncTabByRoute);
  S.tabHash = '';
  syncTabByRoute();
});

watch(page, value => { S.page = value; });
watch(size, value => { S.size = value; });
watch(activeTab, value => { S.tab = value; });
watch(riskPage, value => { S.riskPage = value; });
watch(riskSize, value => { S.riskSize = value; });
watch(riskTab, value => { S.riskTab = value; });
watch(activeRiskId, id => loadRiskNotices(id), { immediate: true });

onUnmounted(() => {
  noticesToken++;
  planListToken++;
  planDetailToken++;
  trajectoryToken++;
  window.removeEventListener('hashchange', syncTabByRoute);
  riskListToken += 1;
  riskDetailToken += 1;
  riskHistoryToken += 1;
  riskKpiToken += 1;
  destroyRouteMap();
});
</script>

<template>
  <section class="view flights-page">
    <div class="tabs" style="margin-bottom:10px">
      <button class="tab" :class="{ on: activeTab === 'route' }" type="button" @click="activateTab('route')">飞行计划</button>
      <button class="tab" :class="{ on: activeTab === 'events' }" type="button" @click="activateTab('events')">全部风险事件</button>
    </div>

    <template v-if="activeTab === 'events'">
      <UKpis :list="riskKpis" />
      <div class="row risk-main">
        <UPanel title="风险列表" class="workspace-list" nopad>
          <div id="rkList" class="rk-list">
            <div class="toolbar risk-toolbar">
                <div v-if="riskFilters.plan_id" class="workspace-scope"><span>只看关联计划的风险</span><button class="btn ghost" type="button" @click="clearRiskPlanScope">查看全部</button></div>
                <div class="risk-kind-tabs" aria-label="风险类别">
                  <button v-for="item in [{ label: '全部', value: '' }, { label: '异物', value: 'SPACE_OBJECT' }, { label: '气象', value: 'WEATHER' }]" :key="item.value" type="button" :class="{ on: riskFilters.risk_type === item.value }" :aria-pressed="riskFilters.risk_type === item.value" :disabled="riskLoading" @click="setRiskKind(item.value)">{{ item.label }}</button>
                </div>
                <div class="risk-quick-fields">
                  <div class="field"><label>等级</label><UControl v-model="riskFilters.severity" type="select" :options="riskSeverityOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div class="field"><label>状态</label><UControl v-model="riskFilters.state" type="select" :options="riskStateOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <button class="btn ghost" type="button" :aria-expanded="riskMoreOpen" :title="riskMoreTitle" @click="riskMoreOpen = !riskMoreOpen">筛选{{ riskMoreActiveCount ? ` (${riskMoreActiveCount})` : '' }}</button>
                </div>
                <div v-if="riskMoreOpen" class="toolbar-fields rk-more">
                  <div class="field"><label>风险类型</label><UControl v-model="riskFilters.risk_type" type="select" :options="riskKindOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div class="field" :title="riskDistrictTitle"><label>区域</label><UControl v-model="riskFilters.district_id" type="select" :options="riskDistrictOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div v-if="riskFilters.risk_type !== 'WEATHER'" class="field"><label>目标类型</label><UControl v-model="riskFilters.target_type" type="select" :options="riskTypeOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div class="field rk-range"><label>发生时间</label><UControl v-model="riskFilters.occurred" type="datetimerange" clearable :disabled="riskLoading" size="small" start-placeholder="开始" end-placeholder="结束" @update:model-value="applyRiskFilters" /></div>
                  <div class="field"><label>来源模式</label><UControl v-model="riskFilters.source_mode" type="select" :options="sourceModeOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                </div>
                <div v-if="riskFilterChips.length" class="risk-filter-chips"><button v-for="chip in riskFilterChips" :key="chip.key" type="button" :disabled="riskLoading" :aria-label="`清除${chip.label}`" @click="clearRiskFilter(chip.key)">{{ chip.label }} · 清除</button></div>
                <div class="risk-list-tools">
                  <UControl :model-value="riskSortValue" type="select" :options="riskSortOptions" :disabled="riskLoading" size="small" aria-label="风险排序" @update:model-value="setRiskSort" />
                  <details class="risk-export-menu"><summary>更多</summary><button class="btn ghost" type="button" :disabled="riskLoading" @click="exportRiskCsv">导出 CSV</button></details>
                </div>

            </div>

              <div v-if="riskError" class="warnbox rk-error">{{ riskError }} <button class="btn" type="button" :disabled="riskLoading" @click="retryRiskList">重试</button></div>
              <p v-if="!riskLoading && selectedRisk && !risks.some(row => row.risk_id === selectedRisk.risk_id)" class="workspace-selection-note">当前详情来自关联入口，不在本页列表中。</p>
              <div v-if="riskLoading" class="empty">正在读取飞行风险…</div>
              <div v-else-if="!riskError && !risks.length" class="empty">当前筛选与权限范围内暂无飞行风险</div>
              <FlightRecordList v-else-if="risks.length" :items="riskRecords" compact :selected-id="activeRiskId" label="风险事件列表" @select="selectRisk" />
              <FlightListPager :page="riskPage" :page-size="riskSize" :total="riskTotal" :loading="riskLoading" @update:page="changeRiskPage" @update:page-size="changeRiskPageSize" />

          </div>
        </UPanel>

        <UPanel title="风险位置与影响范围" class="workspace-map" nopad body-style="padding:6px">
          <div v-if="selectedRisk" class="workspace-map-context"><b>{{ riskTitle(selectedRisk) }}</b><span>{{ selectedRisk.district_name || '区域未提供' }}</span></div>
          <div v-if="riskMapDrawable" class="rk-map-shell" @click="pickWeatherArea">
            <div id="rkMap" ref="riskMapHost" class="rk-map"></div>
            <ObjectRiskMapInfo v-if="objectRiskSelected" :risk="selectedRisk" :marker="objectMarker" :title="riskTitle(selectedRisk)" :color="riskPoint?.color || '#ffb020'"
              :heat="objectHeat" :heat-count="objectHeatPoints.length" :trail="objectTrail" :trail-index="objectTrailIndex" :trail-visible="objectTrailVisible" :playing="objectPlaying" :track-error="objectTrackError"
              @toggle-heat="toggleObjectHeat" @toggle-trail="toggleObjectTrail" @toggle-play="toggleObjectPlayback" @step="stepObjectTrail" />
            <WeatherMapInfo v-if="weatherRing" :fact="riskWeather" :title="weatherTitle" :severity="severityLabel(selectedRisk.severity)"
              :source="selectedRisk.source_name" :color="weatherColor" :visible="weatherVisible" :kind="weatherKind" :simulated="simulatedWeather"
              v-model:boundary-visible="weatherBoundaryVisible" v-model:opened="weatherOpened" @toggle-layer="toggleWeatherLayer" />
          </div>
          <div v-else class="empty rk-map-empty">{{ riskMapNote }}<button v-if="riskWeatherError && selectedRisk" class="btn" type="button" @click="loadRiskDetail(selectedRisk.risk_id)">重试</button></div>
          <div v-if="selectedRisk?.risk_type !== 'WEATHER' && !objectRiskSelected" class="rk-legend" title="圆点表示发现风险时的位置，颜色表示风险等级；青色虚线表示相关航线。没有位置记录的内容不显示。">
            <span style="color:#269bad">青色虚线</span>=相关航线 · 圆点=风险位置
            <span style="color:#ff4d5e">高</span>/<span style="color:#ffb020">中</span>/<span style="color:#3d8bff">低</span>
            <span v-if="riskMapMissingNote" style="color:var(--txt-3)"> · {{ riskMapMissingNote }}</span>
          </div>
          <div v-else-if="riskMapMissingNote" class="rk-weather-note" role="status">{{ riskMapMissingNote }}<button v-if="riskWeatherError" class="btn" type="button" @click="loadRiskDetail(selectedRisk.risk_id)">重试</button></div>
        </UPanel>

        <UPanel title="风险详情与处理" class="workspace-detail" nopad>
          <div class="tabs workspace-detail-tabs"><button class="tab" :class="{ on: riskTab === 'event' }" type="button" @click="switchRiskTab('event')">风险详情</button><button class="tab" :class="{ on: riskTab === 'notice' }" type="button" @click="switchRiskTab('notice')">通知与回执<span v-if="noticesTotal && !noticesLoading" class="tag t-gray">{{ noticesTotal }}</span></button></div>
          <div id="rkDetail" class="rk-detail" :data-risk-id="selectedRisk?.risk_id || null">
            <div v-if="riskDetailLoading" class="empty">正在读取风险详情与核验历史…</div>
            <div v-else-if="riskDetailError" class="warnbox rk-error">{{ riskDetailError }} <button class="btn" type="button" @click="retryRiskDetail">重试</button></div>
            <div v-else-if="!selectedRisk" class="empty">{{ risks.length ? '请选择事件' : '暂无可显示的风险事件' }}</div>
            <template v-else>
              <div class="detail-hero detail-hero-micro"><div class="detail-hero-inner">
                <div class="detail-hero-icon" v-html="riskHeroIcon"></div>
                <div class="detail-hero-copy"><div class="detail-hero-eyebrow">飞行风险</div><div class="detail-hero-title">{{ labelOf(RISK_TYPE_LABEL, selectedRisk.risk_type, '风险类型未提供') }}</div><div v-if="selectedRisk.risk_no" class="detail-hero-id">{{ selectedRisk.risk_no }}</div></div>
                <div class="detail-hero-side"><div class="detail-hero-tags"><span class="tag" :class="severityTag(selectedRisk.severity)">{{ severityLabel(selectedRisk.severity) }}</span><span class="tag" :class="stateTag(selectedRisk.state)">{{ stateLabel(selectedRisk.state) }}</span></div></div>
              </div></div>
              <template v-if="riskTab === 'event'">
              <RiskOpticalPanel v-if="selectedRisk.risk_type !== 'WEATHER'" :key="selectedRisk.risk_id" :risk="selectedRisk" />
              <div class="sect"><h4>事件信息</h4><dl class="kv kv-surface">
                <dt>来源</dt><dd>{{ sourceDescription(selectedRisk.source_name, selectedRisk.source_code, selectedRisk.source_mode) }}</dd>
                <dt>发生时间</dt><dd>{{ formatTime(selectedRisk.occurred_at) }}</dd>
                <dt>接收时间</dt><dd>{{ formatTime(selectedRisk.received_at) }}</dd>
                <dt>所属范围</dt><dd>{{ selectedRisk.owner_org_name || '未知机构' }} / {{ selectedRisk.district_name || '未知区域' }}</dd>
              </dl></div>
              <div class="sect"><h4>风险依据</h4><dl class="kv kv-surface">
                <dt>触发原因</dt><dd>{{ labelOf(REASON_CODE_LABEL, selectedRisk.reason_code, '未提供') }}</dd>
                <dt>依据说明</dt><dd class="rk-wrap">{{ riskReasonText(selectedRisk) }}</dd>
                <template v-if="selectedRisk.risk_type !== 'WEATHER'"><dt>测得高度</dt><dd>{{ altitudeText(selectedRisk) }}<span v-if="selectedRisk.observed_altitude_m == null" class="rk-hint">尚未测得高度，无法判断是否超高</span></dd>
                <dt>高度关系</dt><dd>{{ heightRelationLabel(selectedRisk.height_relation) }}<span v-if="!selectedRisk.height_relation || selectedRisk.height_relation === 'UNKNOWN'" class="rk-hint">缺高度或 AGL/AMSL 换算依据</span></dd></template>
                <dt>关联计划</dt><dd><button v-if="selectedRisk.plan_id && canFilterByPlan" class="btn ghost" type="button" @click="openRelatedPlan">查看关联飞行计划 →</button><span v-else>{{ relatedIdText(selectedRisk.plan_id, 'flight:read') }}</span></dd>
                <dt>航线版本</dt><dd :title="selectedRisk.route_version_id">{{ relatedIdText(selectedRisk.route_version_id, 'route:read') }}</dd>
                <dt v-if="selectedRisk.assessment_id">关联研判</dt><dd v-if="selectedRisk.assessment_id" :title="selectedRisk.assessment_id">已关联研判记录</dd>
                <dt v-if="selectedRisk.target_id">关联目标</dt><dd v-if="selectedRisk.target_id" class="mono" :title="selectedRisk.target_id">{{ selectedRisk.space_fact?.subtype_name || '关联感知目标' }}</dd>
                <dt v-if="selectedRisk.track_id">关联轨迹</dt><dd v-if="selectedRisk.track_id" :title="selectedRisk.track_id">已关联轨迹</dd>
              </dl><div class="rk-note">{{ selectedRisk.risk_type === 'WEATHER' ? '起飞前请核对最新预警和有效时段。' : '位置为发现时快照；违规结论见合法性研判。' }}</div></div>
              <div class="sect"><h4>核验历史 <span class="tag t-gray">{{ riskHistoryTotal }}</span></h4>
                <div v-if="riskHistoryLoading" class="empty">正在读取核验历史…</div>
                <div v-else-if="riskHistoryError" class="warnbox rk-error">{{ riskHistoryError }}</div>
                <div v-else-if="!riskHistory.length" class="empty">尚无已保存的核验记录</div>
                <div v-else class="rk-history">
                  <div v-for="item in riskHistory" :key="item.history_id" class="rk-history-item">
                    <div class="rk-history-head"><span class="tag" :class="item.conclusion === 'EXCLUDED' ? 't-gray' : 't-green'">{{ item.conclusion === 'EXCLUDED' ? '排除' : item.conclusion === 'CONFIRMED' ? '核验通过' : item.conclusion }}</span><span class="mono rk-sub">{{ stateLabel(item.previous_state) }} → {{ stateLabel(item.resulting_state) }}</span></div>
                    <div class="rk-wrap">{{ item.note }}</div>
                    <div class="rk-sub">{{ formatTime(item.created_at) }} · 操作人 {{ item.actor_name || '操作人员' }}</div>
                  </div>
                </div>
                <div v-if="riskHistoryTotal > HISTORY_PAGE_SIZE" class="pager"><UPagination :page="riskHistoryPage" :page-size="HISTORY_PAGE_SIZE" :item-count="riskHistoryTotal" size="small" @update:page="changeRiskHistoryPage" /></div>
              </div>
              </template>
              <section v-else class="sect notice-section">
                <div class="workspace-section-heading"><button class="btn ghost" type="button" :disabled="noticesLoading" @click="loadRiskNotices(activeRiskId)">刷新记录</button></div>
                <div v-if="noticesError" class="warnbox" role="alert">{{ noticesError }}</div>
                <div v-else-if="noticesLoading" class="empty">正在读取通知记录…</div>
                <div v-else-if="!notices.length" class="empty">这条风险尚无通知记录。</div>
                <div v-else class="rk-history">
                  <article v-for="notice in notices" :key="notice.handoff_id" class="rk-history-item">
                    <div class="rk-history-head"><b>通知上级</b><span class="tag" :class="NOTICE_DELIVERY_TAG[notice.delivery_status] || 't-gray'">{{ NOTICE_DELIVERY_LABEL[notice.delivery_status] || '发送状态未知' }}</span></div>
                    <details v-if="notice.recipient_name && notice.recipient_name !== '上级'"><summary>原通知对象记录</summary><p>{{ notice.recipient_name }}</p></details>
                    <p>{{ labelOf(HANDOFF_TYPE_LABEL, notice.handoff_type) }} · {{ formatTime(notice.created_at) }}</p>
                    <p>对方回复：{{ receiptText(notice) }}</p>
                    <p v-if="notice.blocked_reason">未完成原因：{{ NOTICE_BLOCKED_LABEL[notice.blocked_reason] || notice.blocked_reason }}</p>
                    <a class="lnk" :href="`#/punish?handoff=${encodeURIComponent(notice.handoff_id)}`">查看交接详情 →</a>
                  </article>
                </div>
                <p v-if="noticesTotal > notices.length && !noticesLoading" class="workspace-selection-note">共 {{ noticesTotal }} 条通知记录，当前展示最近 {{ notices.length }} 条。</p>
              </section>
              <p v-if="riskTab === 'event' && selectedRisk.state === 'PENDING_VERIFICATION' && canVerifyRisk" class="workspace-action-note">核验通过后可通知上级。</p>
              <p v-if="riskTab === 'event' && selectedRisk.state === 'PENDING_VERIFICATION' && !canVerifyRisk" class="workspace-action-note">{{ verifyBlockReason }}</p>
              <p v-else-if="selectedRisk.state === 'PENDING_NOTIFICATION' && !canNotifyRisk" class="workspace-action-note">{{ notifyBlockReason }}</p>
              <div v-if="(riskTab === 'event' && (canVerifyRisk || selectedRisk.state === 'PENDING_VERIFICATION')) || canNotifyRisk || selectedRisk.state === 'PENDING_NOTIFICATION'" class="detail-actions is-sticky">
                <button v-if="riskTab === 'event' && (selectedRisk.state === 'PENDING_VERIFICATION' || (selectedRisk.state === 'PENDING_NOTIFICATION' && canVerifyRisk))" class="btn" :class="{ pri: selectedRisk.state === 'PENDING_VERIFICATION', ghost: selectedRisk.state === 'PENDING_NOTIFICATION' }" type="button" :disabled="!canVerifyRisk" :title="verifyBlockReason" @click="openRiskVerify">{{ selectedRisk.state === 'PENDING_NOTIFICATION' ? '改判为排除' : '人工核验' }}</button>
                <button v-if="selectedRisk.state === 'PENDING_NOTIFICATION' || canNotifyRisk" class="btn" :class="{ pri: canNotifyRisk }" type="button" :disabled="!canNotifyRisk" :title="notifyBlockReason" @click="openRiskNotify()">通知上级</button>
              </div>
            </template>
          </div>
        </UPanel>
      </div>
    </template>

    <template v-else>
      <UKpis :list="kpiList" />
      <div v-if="error" class="warnbox">{{ error }}</div>
      <div class="row flight-main">
        <UPanel title="飞行计划" class="workspace-list" nopad>
          <div class="toolbar plan-toolbar">
            <div class="toolbar-fields">
              <div class="field"><label>状态</label><UControl v-model="filters.status_code" type="select" :options="statusOptions" :disabled="loading" /></div>
            </div>
          </div>
          <p v-if="!loading && selected && !plans.some(plan => plan.plan_id === selected.plan_id)" class="workspace-selection-note">正在查看关联计划；本页列表未包含该计划。</p>
          <div v-if="loading" class="empty">正在读取飞行计划…</div>
          <div v-else-if="error" class="empty"><button class="btn" type="button" @click="loadPlans(page, S.selectedPlanId)">重新读取计划</button></div>
          <div v-else-if="!plans.length" class="empty">暂无可访问的飞行计划</div>
          <FlightRecordList v-else :items="planRecords" :selected-id="selected?.plan_id || null" label="飞行计划列表" @select="selectPlan" />
          <FlightListPager :page="page" :page-size="size" :total="total" :loading="loading" @update:page="changePage" @update:page-size="changePageSize" />
        </UPanel>

        <UPanel title="计划航线与实际飞行" class="workspace-map" nopad body-style="padding:6px">
            <!-- UPanel 的 sub/extra 使用 v-html；API 航线编号只能经 Vue 文本插值输出。 -->
            <div class="plan-map-frame" :class="{ unavailable: !hasMapContent }">
              <div ref="mapHost" class="route-map"></div>
              <PlanDeviceMarkers :markers="deviceMarkers" :plan-id="selected?.plan_id" />
              <details class="plan-map-legend" aria-label="航迹图例" open>
                <summary class="plan-map-legend-title">图例<span class="legend-collapse">收起</span><span class="legend-expand">展开</span></summary>
                <ul>
                  <li><span class="legend-line within" aria-hidden="true"></span>范围内</li>
                  <li><span class="legend-line outside" aria-hidden="true"></span>偏离计划</li>
                  <li><span class="legend-line unknown" aria-hidden="true"></span>范围未确定</li>
                  <li><span class="legend-line unobserved" aria-hidden="true"></span>计划航线</li>
                </ul>
                <div class="plan-map-legend-note">缺失的轨迹不连线</div>
              </details>
            </div>
            <div v-if="routeGeometryLoading || airspaceLoading" class="empty">正在加载航线和空域边界…</div>
            <div v-else-if="routeGeometryError || airspaceError" class="warnbox">{{ routeGeometryError || airspaceError }}</div>
            <div v-else-if="!hasMapContent" class="empty">航线位置或空域边界无法确认，暂时不能在地图上显示。</div>
            <div v-if="matchedTrackNote" class="map-note">{{ matchedTrackNote }}<span v-if="trajectory?.param_status === 'DEMO'" class="tag t-amber">演示参数</span></div>
          </UPanel>
          <UPanel title="计划详情与风险" class="workspace-detail" nopad>
            <div class="tabs workspace-detail-tabs" role="tablist" aria-label="计划详情内容">
              <button class="tab" :class="{ on: planDetailTab === 'plan' }" role="tab" :aria-selected="planDetailTab === 'plan'" type="button" @click="planDetailTab = 'plan'">计划信息</button>
              <button class="tab" :class="{ on: planDetailTab === 'forecast' }" role="tab" :aria-selected="planDetailTab === 'forecast'" type="button" @click="planDetailTab = 'forecast'">天气预报</button>
            </div>
            <div class="detail-body">
          <div v-if="detailLoading" class="empty">正在读取详情…</div>
          <div v-else-if="detailError" class="warnbox">{{ detailError }} <button v-if="S.selectedPlanId" class="btn" type="button" @click="loadDetail(S.selectedPlanId)">重试</button></div>
          <div v-else-if="!selected" class="empty">请选择计划</div>
          <template v-else>
            <div v-show="planDetailTab === 'plan'">
              <div class="metric-strip is-compact"><div v-for="metric in [['执行状态', labelOf(PLAN_STATUS_LABEL, selected.status_code)], ['计划时长', formatDuration(selected)]]" :key="metric[0]" class="metric-item"><div class="metric-copy"><small>{{ metric[0] }}</small><b>{{ metric[1] }}</b></div></div></div>
            <PlanFilingDetails :plan="selected" :route-version="routeVersion" :route-loading="routeGeometryLoading" :route-error="routeGeometryError" />
            <section v-if="showComparison" class="sect"><h4>计划与实际对照</h4>
              <div v-if="actualsLoading" class="empty">正在读取…</div>
              <div v-else-if="actualsError" class="warnbox">{{ actualsError }}</div>
              <div v-else-if="!sectionReady(actuals?.match)" class="warnbox">{{ matchSectionNote(actuals?.match) }}</div>
              <template v-else>
                <dl class="kv kv-surface" :title="actuals.match.evaluation_id">
                  <dt>计划匹配</dt><dd>{{ hasRouteDeviation(actuals.match) ? '计划偏离' : labelOf(PLAN_ROW_MATCH_LABEL, actuals.match.plan_match_code) }}</dd>
                  <dt>研判时间</dt><dd>{{ formatTime(actuals.match.evaluated_at) }}</dd>
                  <dt>高度关系</dt><dd>{{ planAltitudeText }}</dd>
                  <template v-if="altitudeBandText"><dt>计划高度带</dt><dd>{{ altitudeBandText }}</dd></template>
                  <template v-if="targetAltitudeText"><dt>实际高度</dt><dd>{{ targetAltitudeText }}</dd></template>
                  <template v-if="matchReasonText"><dt>匹配原因</dt><dd>{{ matchReasonText }}</dd></template>
                </dl>
                <div v-if="demoParams"><span class="tag t-amber">参数为演示值，尚未确认</span></div>
              </template>
            </section>
            <PlanVerificationPanel :key="selected.plan_id" :plan="selected" :match="actuals?.match || null" @map-devices="updatePlanDeviceMap" />
            <PlanRiskRecords v-if="showRouteRisks" :records="routeRiskRecords" :loading="routeRisks.loading"
              :error="routeRisks.error" :total="routeRisks.total" :days="ROUTE_RISK_DAYS"
              @select="jumpToRisk" @notify="notifyRouteRisk" @retry="loadRouteRisks(selected)" />
            <!-- 与 legacy 一致的唯一动作：跳到合法性研判页并选中本计划匹配到的目标（决策 15-48）。 -->
            <div v-if="planLegalityReady" class="detail-actions" style="margin-top:12px">
              <button class="btn pri" type="button" style="flex:1;justify-content:center"
                :title="matchedTargetId ? '打开合法性研判页，按本计划筛选并选中匹配到的目标' : '打开合法性研判页，按本计划筛选'" @click="goLegality">合法性判定 →</button>
            </div>
            <div v-else-if="planPending" class="rk-note" style="margin-top:12px">计划还没执行，暂不判断实际飞行是否违规。到了起飞时间仍没找到飞机时，请核实起飞情况。</div>
            </div>
            <PlanWeatherForecast v-if="planDetailTab === 'forecast'" :key="selected.plan_id" :plan-id="selected.plan_id" />
          </template></div>
          </UPanel>
      </div>
    </template>
  </section>
</template>

<style scoped>
.flights-page { min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.flights-page > .tabs { flex: none; }
.flights-page :deep(.kpis) { flex: none; }
.flights-page :deep(.kpi .lb) { font-size: 14px; }
.flights-page :deep(.kpi .vl) { font-size: 31px; }
.flights-page :deep(.kpi .dt) { font-size: 12px; }
.flights-page .detail-hero-title,.flights-page .detail-hero-id { display: block; white-space: normal; overflow: visible; overflow-wrap: anywhere; text-overflow: clip; -webkit-line-clamp: unset; }
.flight-main,.risk-main { display: grid; grid-template-columns: minmax(250px, .95fr) minmax(300px, 1.35fr) minmax(300px, 1.1fr); grid-template-rows: minmax(0, 1fr); margin-top: 12px; flex: 1; min-height: 0; align-items: stretch; gap: 12px; }
.workspace-list { grid-column: 1; grid-row: 1; }
.workspace-map { grid-column: 2; grid-row: 1; }
.workspace-detail { grid-column: 3; grid-row: 1; }
.flight-main > :deep(.panel),.risk-main > :deep(.panel) { min-width: 0; min-height: 0; width: auto; }
.flights-page .workspace-list .toolbar { display: flex; flex-direction: column; align-items: stretch; padding: 10px; gap: 9px; border-bottom: 1px solid var(--line); }
.flights-page .workspace-list .toolbar-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); width: 100%; gap: 8px; }
.flights-page .workspace-list .toolbar .field { display: flex; flex-direction: column; align-items: stretch; width: auto; min-width: 0; max-width: none; gap: 4px; }
.flights-page .workspace-list .toolbar .field :deep(.n-select) { width: 100%; max-width: none; }
.workspace-list .rk-range { grid-column: 1 / -1; }
.workspace-list .toolbar-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.workspace-sort { width: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 5px; color: var(--txt-3); font-size: 11px; }
.workspace-sort .btn { padding: 3px 7px; font-size: 11px; }
.workspace-scope { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 7px; border-radius: 5px; background: color-mix(in srgb, var(--cyan) 10%, transparent); color: var(--cyan); font-size: 11px; }
.workspace-map-context { flex: none; display: grid; gap: 4px; padding: 7px; font-size: 12px; overflow-wrap: anywhere; }
.workspace-map-context span { color: var(--txt-3); font-size: 11px; }
.workspace-detail .metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.workspace-detail .detail-actions { flex-wrap: wrap; }
.workspace-detail .kv { grid-template-columns: minmax(70px, auto) minmax(0, 1fr); }
.workspace-detail .kv dd { min-width: 0; overflow-wrap: anywhere; }
.workspace-detail-tabs { flex: none; padding: 0 10px; }
.workspace-detail-tabs .tab { font-size: 12px; padding: 9px 8px; }
.workspace-detail-tabs .tag { margin-left: 5px; }
.workspace-section-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.workspace-action-note { color: var(--txt-3); font-size: 12px; line-height: 1.6; }
.workspace-selection-note { flex: none; margin: 0; padding: 8px 12px; color: var(--txt-3); font-size: 11px; line-height: 1.6; }
.notice-section .rk-history-item p { margin: 0; color: var(--txt-3); line-height: 1.6; overflow-wrap: anywhere; }
.plan-toolbar { flex: none; }
.flights-page .workspace-list .plan-toolbar { display: grid; grid-template-columns: minmax(0, 1fr); align-items: end; gap: 10px; }
.flights-page .workspace-list .plan-toolbar .toolbar-fields { grid-template-columns: minmax(0, 1fr); }
.plan-toolbar .toolbar-actions .btn { height: 34px; }
.route-geometry { overflow-wrap: anywhere; line-height: 1.7; }
.plan-map-frame { flex: 1; min-height: 0; position: relative; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.plan-map-frame.unavailable { display: none; }
.route-map { width: 100%; height: 100%; }
.plan-map-legend { position: absolute; right: 8px; bottom: 24px; z-index: 5; padding: 5px 8px; max-width: calc(100% - 16px); border: 1px solid rgba(220, 235, 245, .28); border-radius: 7px; background: color-mix(in srgb, var(--surface-1) 94%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); color: #f0f6fb; box-shadow: 0 2px 8px rgba(0, 0, 0, .12); font-size: 11px; line-height: 1.4; }
.plan-map-legend-title { display: flex; align-items: center; gap: 18px; justify-content: space-between; list-style: none; cursor: pointer; font-size: 11px; font-weight: 600; }
.plan-map-legend-title::-webkit-details-marker { display: none; }
.plan-map-legend-title:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.legend-collapse,.legend-expand { font-size: 10px; font-weight: 400; color: #d2e0eb; }
.plan-map-legend[open] .legend-expand,.plan-map-legend:not([open]) .legend-collapse { display: none; }
.plan-map-legend ul { display: grid; grid-template-columns: auto auto; gap: 3px 10px; list-style: none; margin: 5px 0 0; padding: 0; }
.plan-map-legend li { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.legend-line { width: 16px; border-top: 2px solid currentColor; flex: none; }
.legend-line.within { color: #2fd06e; }
.legend-line.outside { color: #ff4d5e; }
.legend-line.unknown { color: #ffb020; }
.legend-line.unobserved { color: #8ca0a8; border-top-style: dashed; }
.plan-map-legend-note { border-top: 1px solid rgba(220, 235, 245, .2); margin-top: 5px; padding-top: 4px; color: #d2e0eb; }
.map-summary,.map-note { flex: none; padding: 3px 4px; font-size: 11px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.pager { flex: none; display:flex; justify-content:flex-end; padding:10px; }
.muted { color: var(--txt-3); font-size: 12px; }
.sect-title { margin-top: 14px; font-weight: 600; }
/* 两个页签共用列表—地图—详情的阅读顺序，地图始终只有一个实例。 */
.rk-map { flex: 1; min-height: 0; }
.rk-map-shell { position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden; }
.rk-weather-note { flex: none; padding: 4px; font-size: 11px; color: var(--txt-3); overflow-wrap: anywhere; }
.rk-map-empty { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 12px; font-size: 12px; }
.rk-legend { flex: none; height: 18px; line-height: 18px; font-size: 10.5px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rk-list { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.risk-toolbar { gap: 7px; padding: 9px !important; }
.risk-kind-tabs { display: flex; width: 100%; gap: 4px; border-bottom: 1px solid var(--line); }
.risk-kind-tabs button { flex: 1; padding: 6px; border: 0; border-bottom: 2px solid transparent; color: var(--txt-3); background: transparent; cursor: pointer; }
.risk-kind-tabs button.on { color: var(--cyan); border-bottom-color: var(--cyan); }
.risk-quick-fields { display: grid; width: 100%; grid-template-columns: minmax(0,1fr) minmax(0,1fr) auto; align-items: end; gap: 6px; }
.risk-quick-fields .field { min-width: 0; display: block; }
.risk-quick-fields .field :deep(.n-select) { width: 100%; min-width: 0; }
.risk-quick-fields label { display: block; font-size: 10px; margin-bottom: 3px; }
.risk-list-tools { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px; }
.risk-list-tools > :deep(.n-select) { width: 150px; }
.risk-export-menu { position: relative; font-size: 11px; color: var(--txt-2); }
.risk-export-menu summary { cursor: pointer; padding: 5px; }
.risk-export-menu button { position: absolute; right: 0; top: 100%; z-index: 10; background: var(--surface-1); white-space: nowrap; }
.risk-filter-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.risk-filter-chips button { color: var(--cyan); background: color-mix(in srgb, var(--cyan) 8%, transparent); border: 1px solid var(--line); border-radius: 4px; padding: 3px 5px; font-size: 10px; cursor: pointer; }
.risk-kind-tabs button:focus-visible,.risk-filter-chips button:focus-visible,.risk-export-menu summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: -2px; }
.risk-toolbar .tabs .tab { padding: 6px 10px; font-size: 13px; }
.rk-error { margin: 8px 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rk-id { display: inline-block; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.rk-sub { font-size: 11px; color: var(--txt-3); white-space: normal; line-height: 1.4; }
.rk-wrap { white-space: normal; line-height: 1.4; overflow-wrap: anywhere; }
.rk-ellipsis { max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.4; }
.rk-detail { flex: 1; overflow: auto; padding: 12px; }
.rk-hint { margin-left: 6px; font-size: 11px; color: var(--txt-3); }
.rk-note { display: block; margin: -6px 0 12px; font-size: 11px; color: var(--txt-3); }
.rk-history { display: grid; gap: 8px; margin-top: 8px; }
.rk-history-item { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.rk-notify-done { display: grid; gap: 12px; }
.rk-notify-done .detail-actions { display: flex; gap: 8px; justify-content: flex-end; }
.rk-history-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
@media (max-width: 1150px) {
  .flights-page { overflow: auto; }
  .flight-main,.risk-main { flex: none; grid-template-columns: minmax(250px, .8fr) minmax(0, 1.2fr); grid-template-rows: 390px minmax(460px, auto); }
  .workspace-list { grid-column: 1; grid-row: 1 / 3; max-height: 950px; }
  .workspace-map { grid-column: 2; grid-row: 1; }
  .workspace-detail { grid-column: 2; grid-row: 2; max-height: 650px; }
}
@media (max-width: 760px) {
  .flight-main,.risk-main { display: flex; flex-direction: column; }
  .workspace-list { height: 500px; flex: none; }
  .workspace-map { height: 400px; flex: none; }
  .workspace-detail { max-height: none; flex: none; }
}
</style>
