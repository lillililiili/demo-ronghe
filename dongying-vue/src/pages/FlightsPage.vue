<script>
/* 跨导航只保留筛选、分页与选中 ID；业务事实仍每次从只读 API 重取，不能缓存成 Mock 副本。 */
const S = { filters: { status_code: '', keyword: '' }, page: 1, size: 20, selectedPlanId: null, tab: 'route', tabHash: '',
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
  SECTION_AVAILABILITY_LABEL, SOURCE_MODE_LABEL, labelOf, OBJECT_TYPE_LABEL, readableNo } from '@/ui/labels.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import { loadTargetPosition } from '@/services/positionMap.js';
import { hasPermission } from '@/services/accessControl.js';
import { authUser } from '@/services/auth.js';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import UPagination from '@/components/UPagination.vue';
import UControl from '@/components/form/UControl.vue';

usePageChrome('flights');

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
const mapHost = ref(null);
const routeLoaded = ref(false);
/* 全页只允许一个活动 MapView：航线页签与风险页签共用同一变量，切换前先 destroyRouteMap()。 */
let routeMap = null;

/* ---------- 风险页签状态（数据只来自 riskApi，不读 window.MOCK / RISK_IMPL） ---------- */
const riskFilters = reactive(S.riskFilters);
if (riskFilters.target_type === undefined) riskFilters.target_type = '';
/* 列表排序走服务端（契约支持这四个键）；表格里其余列不可排，说明写在 title 上。 */
const RISK_SORT_KEYS = { occurred: 'occurred_at', received: 'received_at', severity: 'severity', state: 'state' };
const RISK_SORT_UNSUPPORTED = '服务端不支持按该列排序；在前端对当前一页重排会给出与全局顺序不符的名次';
const riskSort = reactive({ field: 'received_at', order: 'desc' });
function toggleRiskSort(key) {
  const field = RISK_SORT_KEYS[key];
  if (!field) return;
  if (riskSort.field === field) riskSort.order = riskSort.order === 'asc' ? 'desc' : 'asc';
  else { riskSort.field = field; riskSort.order = 'desc'; }
  applyRiskFilters();
}
const riskSortMark = key => (riskSort.field === RISK_SORT_KEYS[key] ? (riskSort.order === 'asc' ? ' ▲' : ' ▼') : '');
/* 工具栏说明随当前排序变化（排序由服务端执行，页面只转述）。 */
const RISK_SORT_FIELD_LABEL = { received_at: '接收时间', occurred_at: '发生时间', severity: '风险等级', state: '状态' };
const riskSortNote = computed(() => `按${RISK_SORT_FIELD_LABEL[riskSort.field] || riskSort.field}${riskSort.order === 'asc' ? '升序' : '倒序'}`);
const riskSortNoteTitle = computed(() => `整份列表按${RISK_SORT_FIELD_LABEL[riskSort.field] || riskSort.field}${riskSort.order === 'asc' ? '升序' : '倒序'}排列（不只是当前这一页）；同一时间的记录按编号排出固定次序。点列头可切换升序 / 倒序`);
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
const NOTICE_DELIVERY_LABEL = { PENDING_DELIVERY: '待投递', SUBMITTED: '已发送', DELIVERED: '已送达', FAILED: '发送失败' };
const NOTICE_DELIVERY_TAG = { PENDING_DELIVERY: 't-amber', SUBMITTED: 't-blue', DELIVERED: 't-green', FAILED: 't-red' };
const NOTICE_RECEIPT_LABEL = { NOT_EXPECTED: '不需回执', PENDING: '等待回执', ACKNOWLEDGED: '已回执', TIMEOUT: '回执超时' };
/* 回执状态 + 回执结果连起来读："已回执 · 已驱离"。服务端没给结果就只显示状态，不补空位（决策 18-14）。 */
function receiptText(notice) {
  const status = NOTICE_RECEIPT_LABEL[notice.receipt_status] || notice.receipt_status || '未知';
  const result = labelOf(RECEIPT_RESULT_LABEL, notice.receipt_result, '');
  return result ? `${status} · ${result}` : status;
}
const NOTICE_BLOCKED_LABEL = { CHANNEL_NOT_CONNECTED: '通知渠道未接通' };
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
const riskMapLoading = ref(false);
const riskMapError = ref('');
const riskMapHost = ref(null);
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

const RISK_STATE_LABEL = { PENDING_VERIFICATION: '待核验', PENDING_NOTIFICATION: '待通知', NOTIFIED: '已通知', EXCLUDED: '已排除' };
const RISK_STATE_TAG = { PENDING_VERIFICATION: 't-amber', PENDING_NOTIFICATION: 't-blue', NOTIFIED: 't-green', EXCLUDED: 't-gray' };
const RISK_SEVERITY_LABEL = { CRITICAL: '紧急', HIGH: '高', MEDIUM: '中', LOW: '低' };
const RISK_SEVERITY_TAG = { CRITICAL: 't-red', HIGH: 't-red', MEDIUM: 't-amber', LOW: 't-blue' };
const RISK_SEVERITY_TONE = { CRITICAL: 'bad', HIGH: 'bad', MEDIUM: 'warn', LOW: 'info' };
/* 与迁移 022 的 CHECK 枚举一致：UNKNOWN / WITHIN / OUTSIDE；未知不判断安全。 */
const HEIGHT_RELATION_LABEL = { UNKNOWN: '高度关系未知', WITHIN: '在航线高度范围内', OUTSIDE: '超出航线高度范围' };
const HISTORY_PAGE_SIZE = 10;

const riskSeverityOptions = [{ label: '全部', value: '' }, ...Object.keys(RISK_SEVERITY_LABEL).map(value => ({ label: RISK_SEVERITY_LABEL[value], value }))];
const riskStateOptions = [{ label: '全部', value: '' }, ...Object.keys(RISK_STATE_LABEL).map(value => ({ label: RISK_STATE_LABEL[value], value }))];
const riskKindOptions = [{ label: '全部', value: '' }, ...['FLIGHT_OPERATION', 'AIRSPACE', 'SPACE_OBJECT'].map(value => ({ label: RISK_TYPE_LABEL[value], value }))];
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
    if (section.availability === 'AVAILABLE' && section.plan_match_code === 'PARTIAL') deviated += 1;
  });
  return { unmatched, deviated };
});
const kpiList = computed(() => {
  const n = value => (value == null ? (planKpis.value.failed ? '—' : '…') : Number(value).toLocaleString('en-US'));
  const k = planKpis.value, m = pageMatchCounts.value;
  return [
    { label: '今日报备计划', value: n(k.today), color: 'blue', icon: 'plan', desc: '计划时段与今天相交的计划数' },
    { label: '执行中', value: n(k.executing), color: 'cyan', icon: 'radar', desc: '状态为执行中' },
    { label: '待执行', value: n(k.pending), color: 'purple', icon: 'check', desc: '未到计划时段' },
    { label: '已完成', value: n(k.completed), color: 'green', icon: 'check', desc: '状态为已完成' },
    { label: '计划未匹配到目标', value: String(m.unmatched), color: 'amber', icon: 'alert', desc: '本页：执行中或已完成，但未匹配到感知目标' },
    { label: '偏离报备计划', value: String(m.deviated), color: 'red', icon: 'alert', desc: '本页：计划匹配为部分匹配' }
  ];
});
const trustedCenterline = computed(() => trustedCoordinates(routeVersion.value));
const trustedAirspaces = computed(() => trustedAirspaceOverlays());
const hasMapContent = computed(() => Boolean(trustedCenterline.value?.length || trustedAirspaces.value.length));

/* 6 个 KPI 与原页面同位同色；数值只取服务端 size=1 的 total，后端无法得出的指标显示“尚未接入”。 */
const RISK_KPI_QUERIES = {
  all: {}, high: { severity: 'HIGH' }, medium: { severity: 'MEDIUM' }, pending: { state: 'PENDING_VERIFICATION' },
  /* 阶段 15：鸟类事件按空中异物风险的细类过滤取总数（阶段 9 起 risks 支持 risk_type/object_subtype）。 */
  bird: { risk_type: 'SPACE_OBJECT', object_subtype: 'BIRD_FLOCK' }
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
    { label: '风险事件', value: value('all'), color: 'blue', icon: 'bird', desc: desc('all', '当前权限范围内总数') },
    { label: '高风险事件', value: value('high'), color: 'red', icon: 'alert', desc: desc('high', 'severity=HIGH 的总数') },
    { label: '中风险事件', value: value('medium'), color: 'amber', icon: 'alert', desc: desc('medium', 'severity=MEDIUM 的总数') },
    { label: '鸟类事件', value: value('bird'), color: 'green', icon: 'bird', desc: desc('bird', '空中异物风险中细类为鸟群的总数') },
    { label: '待核验', value: value('pending'), color: 'orange', icon: 'check', desc: desc('pending', 'state=PENDING_VERIFICATION 的总数') },
    { label: '涉及航线', value: routesInvolved.value.text, color: 'purple', icon: 'zone', desc: routesInvolved.value.desc }
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
const riskMapDrawable = computed(() => Boolean(riskMapCoords.value || riskPoint.value || riskTarget.value));
const riskMapNote = computed(() => {
  if (riskMapLoading.value) return '正在读取关联航线版本几何…';
  if (riskMapError.value) return riskMapError.value;
  if (!selectedRisk.value) return '选择左侧风险事件后，按它的位置与关联航线绘制。';
  const hasRoute = Boolean(selectedRisk.value.route_version_id);
  if (hasRoute && !canReadRoute.value) return '本条风险没有位置坐标，关联航线又无读取权限，不绘制。';
  if (hasRoute) return '本条风险没有位置坐标，关联航线版本也未取得可信 WGS-84 中心线，不绘制。';
  return '本条风险没有位置坐标，也没有关联航线版本，不绘制。';
});
/* 图上少画了什么要说清楚，不能让人以为"图空=没事"。 */
const riskMapMissingNote = computed(() => {
  if (!selectedRisk.value || !riskMapDrawable.value) return '';
  const missing = [];
  if (!riskPoint.value) missing.push('本条风险未返回位置坐标');
  if (selectedRisk.value.target_id && !riskTarget.value) missing.push(riskTargetNote.value || '关联目标位置未取得');
  if (selectedRisk.value.route_version_id && !riskMapCoords.value) missing.push('关联航线中心线不可信');
  return missing.join('；');
});
/* UPanel 的 extra 走 v-html：只输出本页常量映射出的标签，服务端字符串一律不进 v-html。 */
const riskDetailExtra = computed(() => {
  const severity = selectedRisk.value?.severity;
  if (!RISK_SEVERITY_LABEL[severity]) return '<span id="rkSt"></span>';
  return `<span id="rkSt"><span class="tag ${RISK_SEVERITY_TAG[severity]}">${RISK_SEVERITY_LABEL[severity]}</span></span>`;
});
const riskHeroIcon = computed(() => (window.UI?.icon ? window.UI.icon('bird') : ''));
/* 详情卡网格第一列固定留给图标；没有图标元素时文字会落进 40px 列，所以计划卡也必须输出图标。 */
const planHeroIcon = computed(() => (window.UI?.icon ? window.UI.icon('plan') : ''));
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
    // 回执带回了处理结果就一并说出来："已回执 · 已驱离"才是闭环，只有投递状态说明不了这件事办没办（决策 18-14）。
    const result = labelOf(RECEIPT_RESULT_LABEL, submittedNotice.value.receipt_result, '');
    const delivery = NOTICE_DELIVERY_LABEL[submittedNotice.value.delivery_status] || submittedNotice.value.delivery_status;
    return `已提交通知（${delivery}${result ? ` · 回执${result}` : ''}），不能重复提交`;
  }
  if (noticesLoading.value) return '正在读取交接记录';
  if (canNotifyRisk.value) return '提交通知：由通知渠道投递并回执，回执“已驱离”即闭环';
  return `当前状态「${stateLabel(selectedRisk.value.state)}」不允许通知`;
});
const verifyBlockReason = computed(() => {
  if (!selectedRisk.value) return '';
  if (canVerifyRisk.value) return '提交核验通过或排除结论';
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
  if (actionAllowed(permissionCode) === false) return `无 ${permissionCode} 权限，字段未返回`;
  return `未返回该关联（需 ${permissionCode} 且对象在可见范围）`;
}

function riskMessageOf(reason, fallback) {
  if (!reason) return fallback;
  if (reason.status === 401) return '登录已失效，请重新登录。';
  if (reason.status === 403) return '当前账号没有查看飞行风险的权限（risk:read）。';
  if (reason.code === 'TIMEOUT' || reason.code === 'NETWORK_ERROR') return '服务连接超时或不可用，请稍后重试。';
  return reason.message || fallback;
}

async function loadPlans(nextPage = page.value) {
  loading.value = true;
  error.value = '';
  try {
    const data = await flightApi.list({
      page: nextPage,
      size: size.value,
      status_code: filters.status_code,
      keyword: filters.keyword
    });
    page.value = data.page;
    total.value = data.total;
    plans.value = data.items;
    routeLoaded.value = true;
    loadRowActuals(plans.value);
    loadPlanKpis();
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
    loading.value = false;
  }
}

async function loadDetail(planId) {
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
    selected.value = plan;
    S.selectedPlanId = plan.plan_id;
  } catch (requestError) {
    detailError.value = requestError.message || '读取计划详情失败';
  } finally {
    detailLoading.value = false;
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
    try { section = (await flightApi.actuals(plan.plan_id))?.match || null; } catch { section = null; }
    if (seq === rowActualsSeq) rowActuals[plan.plan_id] = section;
  }));
}
function rowMatch(plan) {
  const section = rowActuals[plan.plan_id];
  if (section && sectionReady(section)) return { text: labelOf(PLAN_ROW_MATCH_LABEL, section.plan_match_code), tag: PLAN_MATCH_TAG[section.plan_match_code] || 't-gray', title: '' };
  if (['PENDING', 'APPROVED'].includes(plan.status_code)) return { text: '—', tag: '', title: '计划尚未开始执行' };
  if (plan.status_code === 'CANCELLED') return { text: '—', tag: '', title: '计划已取消' };
  if (section === undefined) return { text: '…', tag: 't-gray', title: '正在读取对照结论' };
  if (!section) return { text: '—', tag: '', title: '对照结论读取失败或无权限' };
  if (!sectionReady(section)) return { text: section.availability === 'NO_EVALUATION' ? '未匹配' : '—', tag: section.availability === 'NO_EVALUATION' ? 't-amber' : '', title: matchMetricNote(section) };
  return { text: labelOf(PLAN_ROW_MATCH_LABEL, section.plan_match_code), tag: PLAN_MATCH_TAG[section.plan_match_code] || 't-gray', title: '' };
}
const DEVIATION_NOTE = '目前只有计划匹配结论，没有横向偏航与时差数值';

/* 合法性判定：与 legacy 同一个跳转——有研判就带目标过去选中，没有就只跳页并说明。 */
/* 与原版同一条规则：「合法性判定 →」只在待执行时出现——判定是起飞前的事，执行中、已完成、已取消都不显示。
   引擎若已把计划匹配到目标就带目标过去选中，否则只打开研判页。 */
const matchedTargetId = computed(() => actuals.value?.match?.target_id || null);
function goLegality() {
  const targetId = matchedTargetId.value;
  if (window.UI?.goto) window.UI.goto('legality', targetId ? { target: targetId } : null);
  else location.hash = '#/legality';
}
function rowSource(plan) {
  return plan.source?.source_name || plan.source?.source_code || labelOf(SOURCE_MODE_LABEL, plan.source_mode, '—');
}

/* 轨迹来源（决策 15-55）：计划本身没有轨迹，画的是"对照聚合"里引擎匹配到的感知目标（match.target_id）的最新实测轨迹；
   没有研判或未匹配到目标就不画，不拿别的目标凑。 */
const matchedTarget = ref(null);
const matchedTrackNote = ref('');
async function loadMatchedTarget(plan, data) {
  matchedTarget.value = null;
  matchedTrackNote.value = '';
  const targetId = data?.match?.target_id;
  if (!targetId) {
    if (['PENDING', 'APPROVED', 'CANCELLED'].includes(plan?.status_code)) return;
    matchedTrackNote.value = data?.match?.availability === 'AVAILABLE' ? '研判未关联感知目标' : '尚无研判，无轨迹可画';
    return;
  }
  try {
    const legal = labelOf(LEGALITY_LABEL, data?.legality?.legal_status, '—');
    const loaded = await loadTargetPosition(targetId, { legal });
    if (selected.value?.plan_id !== plan.plan_id) return;
    if (!loaded.mapTarget) { matchedTrackNote.value = `匹配目标 ${loaded.target?.target_no || targetId} 坐标未知或不可信`; return; }
    matchedTarget.value = loaded.mapTarget;
    matchedTrackNote.value = loaded.points.length > 1 ? `匹配目标 ${loaded.mapTarget.id} 实测轨迹 ${loaded.points.length} 点` : `匹配目标 ${loaded.mapTarget.id} 仅最新位置，无可信轨迹点`;
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
    matchedTrackNote.value = `匹配目标轨迹读取失败：${requestError?.message || '无目标读取权限'}`;
  }
}

/* ---------- 本航线风险（按 legacy「按航线看」区块）：沿线风险直接给「通知上级」入口，状态机与写入口仍是风险页签那一套 ---------- */
const ROUTE_RISK_DAYS = 7; // 与 legacy 一致的演示缺省值，业务方未确认
const routeRisks = reactive({ loading: false, error: '', items: [], loaded: false });
async function loadRouteRisks(plan) {
  routeRisks.items = []; routeRisks.error = ''; routeRisks.loaded = false;
  if (!plan?.route?.route_version_id || ['COMPLETED', 'CANCELLED'].includes(plan.status_code)) return;
  routeRisks.loading = true;
  try {
    const now = Date.now();
    const data = await riskApi.listRisks({ plan_id: plan.plan_id, risk_type: 'SPACE_OBJECT', occurred_from: now - ROUTE_RISK_DAYS * 86400000, occurred_to: now + 86400000, page: 1, size: 50 });
    if (selected.value?.plan_id !== plan.plan_id) return;
    routeRisks.items = data.items || [];
    routeRisks.loaded = true;
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
    routeRisks.error = requestError.message || '读取本航线风险失败';
  } finally {
    if (selected.value?.plan_id === plan.plan_id) routeRisks.loading = false;
  }
}
const routeRiskHeader = computed(() => {
  if (planEnded.value || !selected.value?.route?.route_version_id || !routeRisks.loaded) return '';
  const inside = routeRisks.items.filter(item => item.space_fact?.corridor_relation === 'INSIDE').length;
  const near = routeRisks.items.filter(item => item.space_fact?.corridor_relation === 'NEAR').length;
  return routeRisks.items.length ? `（近 ${ROUTE_RISK_DAYS} 天 · 走廊内 ${inside} / 邻近 ${near}）` : `（近 ${ROUTE_RISK_DAYS} 天）`;
});
function corridorText(item) {
  const relation = item.space_fact?.corridor_relation;
  if (relation === 'INSIDE') return '走廊内';
  if (relation === 'NEAR') return '邻近';
  if (relation === 'OUTSIDE') return '走廊外';
  return severityLabel(item.severity);
}
function corridorTag(item) {
  const relation = item.space_fact?.corridor_relation;
  if (relation === 'INSIDE') return 't-red';
  if (relation === 'NEAR') return 't-amber';
  return 't-gray';
}
function riskTitle(item) {
  const fact = item.space_fact;
  if (fact?.subtype_name) return fact.object_count ? `${fact.subtype_name} ×${fact.object_count}` : fact.subtype_name;
  return labelOf(RISK_TYPE_LABEL, item.risk_type);
}
/* 行内只放「通知上级」：以服务端 allowed_actions 为准，旧记录不带 NOTIFY 时按「待通知」放开；重复提交由服务端 409 裁决。 */
function canNotifyItem(item) { return (item.allowed_actions || []).includes('NOTIFY') || item.state === 'PENDING_NOTIFICATION'; }
function jumpToRisk(riskId) { activateTab('events'); enterRiskTab(riskId); }

async function loadActuals(plan) {
  actualsLoading.value = true;
  actualsError.value = '';
  try {
    const data = await flightApi.actuals(plan.plan_id);
    if (selected.value?.plan_id !== plan.plan_id) return;
    actuals.value = data;
    loadMatchedTarget(plan, data);
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
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
const showComparison = computed(() => sectionReady(actuals.value?.match) || (!planPending.value && selected.value?.status_code !== 'CANCELLED'));
const showRouteRisks = computed(() => !planEnded.value && !!selected.value?.route?.route_version_id);
function sectionReady(section) { return section?.availability === 'AVAILABLE'; }
function sectionNote(section) { return labelOf(SECTION_AVAILABILITY_LABEL, section?.availability, '暂不可用'); }
/* 计划时段内没有任何感知目标被引擎匹配到这条计划：对监管者来说是"没飞或没测到"，不是引擎的事，措辞与原版一致。 */
const NO_MATCH_NOTE = '该计划时段内未匹配到感知目标，可能为：未按计划起飞、目标在探测盲区、或设备异常。建议人工核实。';
function matchSectionNote(section) { return section?.availability === 'NO_EVALUATION' ? NO_MATCH_NOTE : sectionNote(section); }
function matchMetricNote(section) { return section?.availability === 'NO_EVALUATION' ? '未匹配感知目标' : sectionNote(section); }

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

/* 指标条与下方"计划与实际对照"读同一条研判，避免同屏出现两个说法。 */
const matchMetricText = computed(() => {
  const section = actuals.value?.match;
  if (!showComparison.value) return '—';
  if (!section) return actualsLoading.value ? '读取中' : '—';
  return sectionReady(section) ? labelOf(PLAN_ROW_MATCH_LABEL, section.plan_match_code) : matchMetricNote(section);
});

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
    if (selected.value?.plan_id !== plan.plan_id) return;
    routeVersion.value = version;
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
    routeGeometryError.value = requestError.message || '无航线读取权限或航线几何读取失败';
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
  if (routeMap) routeMap.destroy();
  routeMap = null;
}

function renderRouteMap() {
  destroyRouteMap();
  const coordinates = trustedCenterline.value;
  const airspaces = trustedAirspaces.value;
  const target = matchedTarget.value;
  if (activeTab.value !== 'route' || !mapHost.value || (!coordinates && !airspaces.length && !target)) return;
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
    if (coordinates) {
      // corridor_width_m 是走廊全宽；未做投影缓冲时不能把全宽误当半径，因此地图只画中心线。
      context.beginPath();
      coordinates.forEach(([longitude, latitude], index) => {
        const point = this.px(longitude, latitude);
        if (index) context.lineTo(point[0], point[1]);
        else context.moveTo(point[0], point[1]);
      });
      context.strokeStyle = '#22d3ee';
      context.lineWidth = 2.4;
      context.lineJoin = 'round';
      context.stroke();
    }
    context.restore();
  };
  if (coordinates) routeMap.fitTo(coordinates);
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
    if (selected.value?.plan_id !== plan.plan_id) return;
    const versionIds = [...new Set(facts.map(fact => fact.airspace_version_id).filter(Boolean))];
    const versions = await Promise.all(versionIds.map(id => airspaceApi.version(id)));
    if (selected.value?.plan_id !== plan.plan_id) return;
    conflicts.value = facts;
    airspaceVersions.value = versions;
    await nextTick();
    renderRouteMap();
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
    // 冲突读取需要 airspace:read；无此权限只隐藏空域事实，不能覆盖已有 flight:read 计划详情。
    airspaceError.value = requestError.message || '空域冲突事实读取失败';
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
  const query = { severity: riskFilters.severity || '', state: riskFilters.state || '', owner_org_id: text(riskFilters.owner_org_id),
    district_id: text(riskFilters.district_id), source_mode: text(riskFilters.source_mode),
    target_type: riskFilters.target_type || '', risk_type: riskFilters.risk_type || '', sort: riskSort.field, order: riskSort.order };
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
  try {
    query = riskQuery();
    const data = await riskApi.listRisks({ ...query, page: nextPage, size: riskSize.value });
    if (token !== riskListToken) return;
    risks.value = data.items || [];
    riskPage.value = data.page;
    riskTotal.value = data.total;
    if (requestedId) {
      // 深链 ID 不在当前分页时仍按精确 ID 读详情；失败必须显式报错，不能默认打开无关风险。
      await loadRiskDetail(requestedId);
      return;
    }
    const wanted = S.selectedRiskId;
    // safe-default: 普通列表进入时首行会高亮，用户可见且可立即改选；深链路径已在上方严格处理。
    const next = risks.value.find(item => item.risk_id === wanted) || risks.value[0] || null;
    if (next) await loadRiskDetail(next.risk_id);
    else clearRiskDetail();
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
}

async function loadRiskKpis() {
  const token = ++riskKpiToken;
  const keys = Object.keys(RISK_KPI_QUERIES);
  const results = await Promise.allSettled(keys.map(key => riskApi.listRisks({ ...RISK_KPI_QUERIES[key], page: 1, size: 1 })));
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
    const summary = await riskApi.spaceRiskSummary({});
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
  riskDetailToken += 1;
  riskHistoryToken += 1;
  selectedRisk.value = null;
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
  const token = ++riskDetailToken;
  riskHistoryToken += 1;
  activeRiskId.value = riskId;
  riskDetailLoading.value = true;
  riskDetailError.value = '';
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
  // 三样几何各读各的，谁失败都不挡另外两样；全部到齐后只建一次图，避免先到的被后到的重建掉视野。
  await Promise.all([loadRiskTargetPosition(detail, token), loadRiskRouteGeometry(detail, token)]);
  if (token !== riskDetailToken) return;
  await nextTick();
  renderRiskMap();
}

/** 风险关联的感知目标：风险行里带 target_id，位置要再读一次目标详情才有。 */
async function loadRiskTargetPosition(risk, token) {
  if (!risk.target_id) return;
  try {
    const loaded = await loadTargetPosition(risk.target_id, { risk: severityLabel(risk.severity) });
    if (token !== riskDetailToken) return;
    if (!loaded.mapTarget) { riskTargetNote.value = `关联目标 ${loaded.target?.target_no || risk.target_id} 坐标未知或不可信`; return; }
    riskTarget.value = loaded.mapTarget;
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
    riskMapError.value = `航线版本几何读取失败：${riskMessageOf(requestError, '无 route:read 权限或航线版本不可见')}`;
    destroyRouteMap();
  } finally {
    if (token === riskDetailToken) riskMapLoading.value = false;
  }
}

function renderRiskMap() {
  destroyRouteMap();
  if (activeTab.value !== 'events' || !riskMapHost.value) return;
  const coordinates = riskMapCoords.value;
  const point = riskPoint.value;
  const target = riskTarget.value;
  /* 视野按"这条风险相关的全部几何"收：风险点、关联目标、航线中心线三样有几样算几样。
     只 centerAt 或只按中心线收，都会把另外两样推到视野外，看上去还是一张空图。 */
  const focus = coordinates ? coordinates.slice() : [];
  if (point) focus.push([point.longitude, point.latitude]);
  if (target && Number.isFinite(target.lon) && Number.isFinite(target.lat)) focus.push([target.lon, target.lat]);
  routeMap = new window.MapView(riskMapHost.value, {
    zoom: focus.length ? 3.2 : 1, maxDev: 0, legend: false,
    layers: { device: false, track: !!target, alarm: false }
  });
  routeMap.setData({ airspaces: [], devices: [], targets: target ? [target] : [], alarms: [] });
  if (target) routeMap.sel = target.id;
  if (!coordinates && !point) { if (focus.length) routeMap.fitTo(focus); return; }
  const version = riskRouteVersion.value;
  const label = `${version?.route_id || '航线'} v${version?.version_no ?? '—'}`;
  const drawBase = routeMap.draw.bind(routeMap);
  routeMap.draw = function drawRiskRouteCenterline() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    // 只画已保存航线版本的 WGS-84 中心线与风险自身的位置快照；缺哪样就不画哪样，不以 (0,0) 补位。
    context.save();
    if (coordinates) {
      context.beginPath();
      coordinates.forEach(([longitude, latitude], index) => {
        const at = this.px(longitude, latitude);
        if (index) context.lineTo(at[0], at[1]);
        else context.moveTo(at[0], at[1]);
      });
      context.setLineDash([6, 4]);
      context.strokeStyle = 'rgba(61,139,255,.75)';
      context.lineWidth = 1.6;
      context.lineJoin = 'round';
      context.stroke();
      context.setLineDash([]);
      const mid = this.px(...coordinates[coordinates.length >> 1]);
      context.font = '10.5px "PingFang SC"';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      const width = context.measureText(label).width + 8;
      context.fillStyle = 'rgba(4,10,26,.75)';
      context.fillRect(mid[0] - width / 2, mid[1] - 8, width, 15);
      context.fillStyle = '#8fbaff';
      context.fillText(label, mid[0], mid[1]);
    }
    if (point) {
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
  if (error.status === 403) return '当前账号没有提交或查看交接的权限（handoff:create / handoff:read）。';
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return '服务连接超时或不可用，请稍后重试。';
  return error.message || fallback;
}

async function loadRiskNotices(riskId) {
  if (!riskId) { notices.value = []; noticesTotal.value = 0; noticesError.value = ''; return; }
  const token = ++noticesToken;
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
        ? `接收方已接收通知${created.receipt_status === 'ACKNOWLEDGED' ? '并回执' : ''}；回执“已驱离”才算闭环，在此之前源风险保持“待通知”。`
        : '材料已入库等待投递，通知渠道未接通：不表示已发送、已送达；源风险保持“待通知”。'),
      h('dl', { class: 'kv kv-surface' }, [
        h('dt', '通知编号'), h('dd', { class: 'mono' }, created.handoff_id),
        /* 只有拿到接收方名称才显示这一行：创建应答目前只回内部标识，把它摆上屏等于给人看一串没用的编码
           （名称在通知记录里读得到）。 */
        ...(created.recipient_name
          ? [h('dt', '接收方'), h('dd', { title: created.recipient_id || '' }, created.recipient_name)]
          : []),
        h('dt', '投递状态'), h('dd', `${NOTICE_DELIVERY_LABEL[created.delivery_status] || created.delivery_status || '未知'} · ${NOTICE_BLOCKED_LABEL[created.blocked_reason] || created.blocked_reason || '无阻断'}`)
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
    warning: '提交后由通知渠道投递并回执；回执“已驱离”即闭环，风险不进入处置。',
    notice: [risk.risk_no || readableNo(risk.source_risk_id) ? `风险 ${risk.risk_no || readableNo(risk.source_risk_id)}` : '风险事件', labelOf(RISK_TYPE_LABEL, risk.risk_type, ''), Number(expectedVersion) > 0 ? `已第${Number(expectedVersion)}次核验` : '尚未核验'].filter(Boolean).join(' · '),
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
/* 进页签时列表会自动选中第一条，那只是为了让右侧详情不空着，不代表用户在看这条风险的位置。
   所以地图先停在全市视角，只有用户自己点了某条风险才放大过去（阶段 18 对照原版）。 */
const riskUserPicked = ref(false);
const riskMoreActiveCount = computed(() => {
  const values = [riskFilters.risk_type, riskFilters.source_mode, riskFilters.occurred];
  return values.filter(value => (Array.isArray(value) ? value.length > 0 : !!value)).length;
});
const riskMoreTitle = computed(() => (riskMoreActiveCount.value
  ? `另有 ${riskMoreActiveCount.value} 个筛选正在生效：风险类型 / 发生时间 / 来源模式`
  : '展开风险类型、发生时间、来源模式'));

/* ---------- 风险页签：交互 ---------- */
function applyRiskFilters() {
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
  riskUserPicked.value = true;
  if (selectedRisk.value?.risk_id === riskId && !riskDetailError.value) return;
  loadRiskDetail(riskId);
}
function retryRiskDetail() { if (S.selectedRiskId) loadRiskDetail(S.selectedRiskId); }
function retryRiskList() { loadRiskKpis(); loadRisks(riskPage.value); }

function enterRiskTab(requestedId = null) {
  destroyRouteMap();
  riskUserPicked.value = !!requestedId;   // 深链带着风险编号进来，等同于用户点了这一条
  // 进页签就先摆出全局底图，不等选中风险（选中后 loadRiskRouteGeometry 会再画一次）。
  nextTick(() => renderRiskMap());
  if (requestedId) {
    // 深链只清筛选与页码，避免选中的那条被当前筛选挡在列表外；详情仍按精确 ID 读取。
    Object.assign(riskFilters, { severity: '', state: '', risk_type: '', plan_id: '', owner_org_id: '', district_id: '', source_mode: '', occurred: null });
    riskTab.value = 'event';
    S.selectedRiskId = requestedId;
  }
  loadRiskKpis();
  loadRisks(requestedId ? 1 : riskPage.value, requestedId);
}

/* 阶段 9 曾把 #/risk 拆成独立「空间安全风险」页，已撤回。工作台 / 处罚 / 态势仍可能
   写入深链键 'risk' 或打开 #/risk；本页消费这些上下文，并只在飞行计划里切「全部风险事件」。 */
function consumeRiskDeepLink() {
  const context = window.UI?.consume?.('risk');
  const requested = context?.eventId || context?.riskId || context?.risk_id || context?.risk || null;
  return typeof requested === 'string' && requested ? requested : null;
}

function flightsTabHash(tab) {
  return tab === 'events' ? '#/flights?tab=events' : '#/flights';
}

function showEventsTab(requestedId = null) {
  activeTab.value = 'events';
  enterRiskTab(requestedId);
}

function showRouteTab() {
  activeTab.value = 'route';
  destroyRouteMap();
  if (!routeLoaded.value && !loading.value) loadPlans();
  else nextTick(renderRouteMap);
}

function syncTabByRoute() {
  const raw = location.hash || '';
  if (raw === S.tabHash) return;
  if (hashPath(raw).startsWith('#/risk')) {
    S.tabHash = flightsTabHash('events');
    if (raw !== S.tabHash) location.hash = S.tabHash;
    showEventsTab(consumeRiskDeepLink());
    return;
  }
  S.tabHash = raw;
  if (hashWantsEventsTab(raw)) showEventsTab(consumeRiskDeepLink());
  else showRouteTab();
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
  if (activeTab.value !== 'events') {
    const context = window.UI?.consume?.('flights');
    loadPlans().then(() => {
      const planId = context?.plan || S.selectedPlanId;
      if (planId) loadDetail(planId);
    });
  }
});

watch(page, value => { S.page = value; });
watch(size, value => { S.size = value; });
watch(activeTab, value => { S.tab = value; });
watch(riskPage, value => { S.riskPage = value; });
watch(riskSize, value => { S.riskSize = value; });
watch(riskTab, value => { S.riskTab = value; });
watch(() => [riskTab.value, activeRiskId.value], ([tab, id]) => { if (tab === 'notice') loadRiskNotices(id); }, { immediate: true });

onUnmounted(() => {
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
      <button class="tab" :class="{ on: activeTab === 'route' }" type="button" @click="activateTab('route')">按航线看</button>
      <button class="tab" :class="{ on: activeTab === 'events' }" type="button" @click="activateTab('events')">全部风险事件</button>
    </div>

    <template v-if="activeTab === 'events'">
      <UKpis :list="riskKpis" />
      <div class="row risk-main">
        <UPanel title="风险事件与航线分布" panel-style="flex:0.82" nopad body-style="padding:6px">
          <div v-if="riskMapDrawable" id="rkMap" ref="riskMapHost" class="rk-map"></div>
          <div v-else class="empty rk-map-empty">{{ riskMapNote }}</div>
          <div class="rk-legend" title="圆点是这条风险的位置快照，颜色只表示等级，不表示合法性；蓝虚线是它关联的已保存航线版本中心线；哪一样没有就不画哪一样">
            <span style="color:#8fbaff">蓝虚线</span>=关联航线中心线 · 圆点=风险位置
            <span style="color:#ff4d5e">高</span>/<span style="color:#ffb020">中</span>/<span style="color:#3d8bff">低</span>
            <span v-if="riskMapMissingNote" style="color:var(--txt-3)"> · {{ riskMapMissingNote }}</span>
          </div>
        </UPanel>

        <UPanel title="风险事件与通报" panel-style="flex:1.7" nopad>
          <div id="rkList" class="rk-list">
            <div class="toolbar risk-toolbar">
              <div class="tabs" style="border-bottom:none;gap:0">
                <button class="tab" :class="{ on: riskTab === 'event' }" type="button" @click="switchRiskTab('event')">风险事件</button>
                <button class="tab" :class="{ on: riskTab === 'notice' }" type="button" title="按选中风险读取交接记录" @click="switchRiskTab('notice')">通报记录
                  <span class="tag t-gray" style="margin-left:4px">{{ riskTab === 'notice' ? noticesTotal : '交接' }}</span></button>
              </div>
              <template v-if="riskTab === 'event'">
                <div class="toolbar-fields">
                  <div class="field"><label>风险等级</label><UControl v-model="riskFilters.severity" type="select" :options="riskSeverityOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div class="field"><label>目标类型</label><UControl v-model="riskFilters.target_type" type="select" :options="riskTypeOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div class="field"><label>状态</label><UControl v-model="riskFilters.state" type="select" :options="riskStateOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div class="field" :title="riskDistrictTitle"><label>区域</label><UControl v-model="riskFilters.district_id" type="select" :options="riskDistrictOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                </div>
                <div class="toolbar-actions">
                  <button class="btn" :class="{ on: riskMoreOpen }" type="button" :title="riskMoreTitle" @click="riskMoreOpen = !riskMoreOpen">更多筛选<span
                    v-if="riskMoreActiveCount" class="tag t-blue" style="margin-left:4px">{{ riskMoreActiveCount }}</span></button>
                  <button class="btn" type="button" :disabled="riskLoading" @click="applyRiskFilters">查询</button>
                  <button class="btn" type="button" :disabled="riskLoading" title="按当前筛选与排序导出风险列表 CSV（上限 5000 行）"
                    @click="exportRiskCsv">导出 CSV</button>
                  <span class="toolbar-note" :title="riskSortNoteTitle">{{ riskSortNote }}</span>
                </div>
                <div v-if="riskMoreOpen" class="toolbar-fields rk-more">
                  <div class="field"><label>风险类型</label><UControl v-model="riskFilters.risk_type" type="select" :options="riskKindOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                  <div class="field rk-range"><label>发生时间</label><UControl v-model="riskFilters.occurred" type="datetimerange" clearable :disabled="riskLoading" size="small" start-placeholder="开始" end-placeholder="结束" /></div>
                  <div class="field"><label>来源模式</label><UControl v-model="riskFilters.source_mode" type="select" :options="sourceModeOptions" :disabled="riskLoading" size="small" /></div>
                </div>
              </template>
              <template v-else>
                <div class="toolbar-actions">
                  <span class="toolbar-note">提交成功只表示材料入库，不表示已发送</span>
                </div>
              </template>
            </div>

            <template v-if="riskTab === 'event'">
              <div v-if="riskError" class="warnbox rk-error">{{ riskError }} <button class="btn" type="button" :disabled="riskLoading" @click="retryRiskList">重试</button></div>
              <div v-if="riskLoading" class="empty">正在读取飞行风险…</div>
              <div v-else-if="!riskError && !risks.length" class="empty">当前筛选与权限范围内暂无飞行风险</div>
              <div v-else-if="risks.length" class="scroll table-scroll table-shell" style="flex:1">
                <table class="tb">
                  <thead><tr>
                    <th>编号</th>
                    <th><span class="rk-sort" aria-disabled="true" :title="RISK_SORT_UNSUPPORTED">类型</span></th>
                    <th>依据</th>
                    <th>来源</th>
                    <th><span class="rk-sort" aria-disabled="true" :title="RISK_SORT_UNSUPPORTED">区域 / 高度</span></th>
                    <th><span class="rk-sort" aria-disabled="true" :title="RISK_SORT_UNSUPPORTED">关联计划 / 航线</span></th>
                    <th style="text-align:center"><span class="rk-sort" role="button" tabindex="0" title="按风险等级排序"
                      @click="toggleRiskSort('severity')" @keydown.enter="toggleRiskSort('severity')">风险{{ riskSortMark('severity') }}</span></th>
                    <th><span class="rk-sort" role="button" tabindex="0" title="按接收时间排序（该列显示的是接收时间；发生时间见单元格提示）"
                      @click="toggleRiskSort('received')" @keydown.enter="toggleRiskSort('received')">时间{{ riskSortMark('received') }}</span></th>
                    <th><span class="rk-sort" role="button" tabindex="0" title="按状态排序"
                      @click="toggleRiskSort('state')" @keydown.enter="toggleRiskSort('state')">状态{{ riskSortMark('state') }}</span></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="risk in risks" :key="risk.risk_id" :data-row="risk.risk_id" tabindex="0" :class="{ on: activeRiskId === risk.risk_id }"
                      @click="selectRisk(risk.risk_id)" @keydown.enter.prevent="selectRisk(risk.risk_id)">
                      <td class="num"><span class="mono rk-id" :title="`${risk.source_risk_id || ''} / ${risk.risk_id}`">{{ risk.risk_no || readableNo(risk.source_risk_id) || '—' }}</span></td>
                      <td><span class="tag t-cyan">{{ labelOf(RISK_TYPE_LABEL, risk.risk_type, '未知') }}</span><div v-if="risk.target_id" class="mono rk-sub" :title="risk.target_id">{{ risk.target_no || risk.target_id }}</div></td>
                      <td><div class="rk-wrap">{{ labelOf(REASON_CODE_LABEL, risk.reason_code, '未提供') }}</div></td>
                      <td><div class="rk-sub">{{ risk.source_name || risk.source_code || '未提供' }}</div><div class="rk-sub">{{ labelOf(SOURCE_MODE_LABEL, risk.source_mode, '') }}</div></td>
                      <td><div class="rk-wrap">{{ risk.district_name || risk.district_id || '未知' }}</div><div class="mono rk-sub">{{ altitudeText(risk) }} · {{ heightRelationLabel(risk.height_relation) }}</div></td>
                      <td><div class="rk-ellipsis mono" :title="risk.plan_id || '未返回计划'">{{ risk.plan_no || (risk.plan_id ? '已关联计划' : '—') }}</div><div class="rk-ellipsis rk-sub" :title="risk.route_version_id || '未返回航线版本'">{{ risk.route_version_id ? '已关联航线版本' : '—' }}</div></td>
                      <td style="text-align:center"><span class="tag" :class="severityTag(risk.severity)">{{ severityLabel(risk.severity) }}</span></td>
                      <td class="num" :title="`接收 ${formatTime(risk.received_at)}；发生 ${formatTime(risk.occurred_at)}`">{{ formatClock(risk.received_at) }}</td>
                      <td><span class="tag" :class="stateTag(risk.state)">{{ stateLabel(risk.state) }}</span></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="pager"><UPagination :page="riskPage" :page-size="riskSize" :item-count="riskTotal" :prefix="`共 ${riskTotal.toLocaleString('en-US')} 条`" @update:page="changeRiskPage" @update:page-size="changeRiskPageSize" /></div>
            </template>
            <template v-else>
              <div v-if="!activeRiskId" class="empty">请先在“风险事件”页签选择一条风险。</div>
              <div v-else-if="noticesError" class="warnbox rk-error">{{ noticesError }} <button class="btn" type="button" :disabled="noticesLoading" @click="loadRiskNotices(activeRiskId)">重试</button></div>
              <div v-else-if="noticesLoading" class="empty">正在读取交接记录…</div>
              <div v-else-if="!notices.length" class="empty">该风险尚无通知记录；核验通过后可在详情栏点击“通知上级”提交。</div>
              <div v-else class="scroll table-scroll table-shell" style="flex:1">
                <table class="tb">
                  <thead><tr><th>交接类型</th><th>接收方</th><th>提交时间</th><th>投递状态</th><th>回执</th><th>阻断原因</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="notice in notices" :key="notice.handoff_id" :data-row="notice.handoff_id">
                      <td><span :title="notice.handoff_id">{{ labelOf(HANDOFF_TYPE_LABEL, notice.handoff_type) }}</span></td>
                      <td><div class="rk-wrap">{{ notice.recipient_name || notice.recipient_id }}</div></td>
                      <td class="num" :title="formatTime(notice.created_at)">{{ formatClock(notice.created_at) }}</td>
                      <td><span class="tag" :class="NOTICE_DELIVERY_TAG[notice.delivery_status] || 't-gray'">{{ NOTICE_DELIVERY_LABEL[notice.delivery_status] || notice.delivery_status || '未知' }}</span></td>
                      <td>{{ receiptText(notice) }}</td>
                      <td><div class="rk-wrap">{{ notice.blocked_reason ? (NOTICE_BLOCKED_LABEL[notice.blocked_reason] || notice.blocked_reason) : '—' }}</div></td>
                      <td><a class="lnk" :href="`#/punish?handoff=${encodeURIComponent(notice.handoff_id)}`">查看交接</a></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>
        </UPanel>

        <UPanel title="风险详情" panel-style="width:30%;min-width:340px;flex:none" nopad :extra="riskDetailExtra">
          <div id="rkDetail" class="rk-detail">
            <div v-if="riskDetailLoading" class="empty">正在读取风险详情与核验历史…</div>
            <div v-else-if="riskDetailError" class="warnbox rk-error">{{ riskDetailError }} <button class="btn" type="button" @click="retryRiskDetail">重试</button></div>
            <div v-else-if="!selectedRisk" class="empty">{{ risks.length ? '请选择事件' : '暂无可显示的风险事件' }}</div>
            <template v-else>
              <div class="detail-hero detail-hero-micro"><div class="detail-hero-inner">
                <div class="detail-hero-icon" v-html="riskHeroIcon"></div>
                <div class="detail-hero-copy"><div class="detail-hero-eyebrow">飞行风险</div><div class="detail-hero-title">{{ labelOf(RISK_TYPE_LABEL, selectedRisk.risk_type, '风险事件') }}</div><div v-if="readableNo(selectedRisk.source_risk_id)" class="detail-hero-id mono" :title="selectedRisk.risk_id">{{ readableNo(selectedRisk.source_risk_id) }}</div></div>
                <div class="detail-hero-side"><div class="detail-hero-tags"><span class="tag" :class="severityTag(selectedRisk.severity)">{{ severityLabel(selectedRisk.severity) }}</span><span class="tag" :class="stateTag(selectedRisk.state)">{{ stateLabel(selectedRisk.state) }}</span></div></div>
              </div></div>
              <div class="metric-strip is-compact">
                <div class="metric-item" :class="RISK_SEVERITY_TONE[selectedRisk.severity] ? 'is-' + RISK_SEVERITY_TONE[selectedRisk.severity] : ''"><span class="metric-copy"><small>风险等级</small><b>{{ severityLabel(selectedRisk.severity) }}</b></span></div>
                <div class="metric-item"><span class="metric-copy"><small>当前状态</small><b>{{ stateLabel(selectedRisk.state) }}</b></span></div>
                <div class="metric-item"><span class="metric-copy"><small>观测高度</small><b>{{ altitudeText(selectedRisk) }}</b></span></div>
                <div class="metric-item"><span class="metric-copy"><small>高度关系</small><b>{{ heightRelationLabel(selectedRisk.height_relation) }}</b></span></div>
              </div>
              <div class="sect"><h4>事件信息</h4><dl class="kv kv-surface">
                <dt>风险编号</dt><dd class="mono" :title="`${selectedRisk.source_risk_id || ''} / ${selectedRisk.risk_id}`">{{ selectedRisk.risk_no || readableNo(selectedRisk.source_risk_id) || '未提供' }}</dd>
                <dt>风险类型</dt><dd>{{ labelOf(RISK_TYPE_LABEL, selectedRisk.risk_type, '未提供') }}</dd>
                <dt>来源</dt><dd>{{ selectedRisk.source_name || selectedRisk.source_code || '未提供' }}（{{ labelOf(SOURCE_MODE_LABEL, selectedRisk.source_mode, '未提供') }}）</dd>
                <dt>发生时间</dt><dd>{{ formatTime(selectedRisk.occurred_at) }}</dd>
                <dt>接收时间</dt><dd>{{ formatTime(selectedRisk.received_at) }}</dd>
                <dt>所属范围</dt><dd>{{ selectedRisk.owner_org_name || selectedRisk.owner_org_id }} / {{ selectedRisk.district_name || selectedRisk.district_id }}</dd>
              </dl></div>
              <div class="sect"><h4>风险依据</h4><dl class="kv kv-surface">
                <dt>风险依据</dt><dd>{{ labelOf(REASON_CODE_LABEL, selectedRisk.reason_code, '未提供') }}</dd>
                <dt>依据说明</dt><dd class="rk-wrap">{{ selectedRisk.reason_text || '未提供' }}</dd>
                <dt>观测高度</dt><dd>{{ altitudeText(selectedRisk) }}<span v-if="selectedRisk.observed_altitude_m == null" class="rk-hint">未知高度不判断安全，不以 0 补值</span></dd>
                <dt>高度关系</dt><dd>{{ heightRelationLabel(selectedRisk.height_relation) }}<span v-if="!selectedRisk.height_relation || selectedRisk.height_relation === 'UNKNOWN'" class="rk-hint">缺高度或 AGL/AMSL 换算依据</span></dd>
                <dt>关联计划</dt><dd class="mono" :title="selectedRisk.plan_id">{{ selectedRisk.plan_no || relatedIdText(selectedRisk.plan_id, 'flight:read') }}</dd>
                <dt>航线版本</dt><dd :title="selectedRisk.route_version_id">{{ relatedIdText(selectedRisk.route_version_id, 'route:read') }}</dd>
                <dt v-if="selectedRisk.assessment_id">关联研判</dt><dd v-if="selectedRisk.assessment_id" :title="selectedRisk.assessment_id">已关联研判记录</dd>
                <dt v-if="selectedRisk.target_id">关联目标</dt><dd v-if="selectedRisk.target_id" class="mono" :title="selectedRisk.target_id">{{ selectedRisk.target_no || selectedRisk.target_id }}</dd>
                <dt v-if="selectedRisk.track_id">关联轨迹</dt><dd v-if="selectedRisk.track_id" :title="selectedRisk.track_id">已关联轨迹</dd>
              </dl><div class="rk-note">依据来自已保存的风险事实与固定航线版本；前端不按最新规则重算，也不推断合法性。</div></div>
              <div class="sect"><h4>核验历史 <span class="tag t-gray">{{ riskHistoryTotal }}</span></h4>
                <div v-if="riskHistoryLoading" class="empty">正在读取核验历史…</div>
                <div v-else-if="riskHistoryError" class="warnbox rk-error">{{ riskHistoryError }}</div>
                <div v-else-if="!riskHistory.length" class="empty">尚无已保存的核验记录</div>
                <div v-else class="rk-history">
                  <div v-for="item in riskHistory" :key="item.history_id" class="rk-history-item">
                    <div class="rk-history-head"><span class="tag" :class="item.conclusion === 'EXCLUDED' ? 't-gray' : 't-green'">{{ item.conclusion === 'EXCLUDED' ? '排除' : item.conclusion === 'CONFIRMED' ? '核验通过' : item.conclusion }}</span><span class="mono rk-sub">{{ stateLabel(item.previous_state) }} → {{ stateLabel(item.resulting_state) }} · 第 {{ item.version }} 次核验</span></div>
                    <div class="rk-wrap">{{ item.note }}</div>
                    <div class="rk-sub">{{ formatTime(item.created_at) }} · 操作人 {{ item.actor_name || item.actor_id }}</div>
                  </div>
                </div>
                <div v-if="riskHistoryTotal > HISTORY_PAGE_SIZE" class="pager"><UPagination :page="riskHistoryPage" :page-size="HISTORY_PAGE_SIZE" :item-count="riskHistoryTotal" size="small" @update:page="changeRiskHistoryPage" /></div>
              </div>
              <div class="detail-actions is-sticky">
                <button class="btn" type="button" :disabled="!canNotifyRisk" :title="notifyBlockReason" @click="openRiskNotify()">通知上级</button>
                <button class="btn pri" type="button" :disabled="!canVerifyRisk" :title="verifyBlockReason" @click="openRiskVerify">人工核验</button>
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
        <UPanel title="飞行计划与活动" :panel-style="'flex:1.1;min-width:0;min-height:0'" nopad>
          <div class="toolbar plan-toolbar">
            <div class="toolbar-fields">
              <div class="field"><label>状态</label><UControl v-model="filters.status_code" type="select" :options="statusOptions" :disabled="loading" /></div>
              <div class="field plan-keyword"><label>计划编号</label><UControl v-model="filters.keyword" placeholder="计划编号" :disabled="loading" @keyup.enter="applyFilters" /></div>
            </div>
            <div class="toolbar-actions">
              <button class="btn" type="button" :disabled="loading" @click="applyFilters">查询</button>
            </div>
          </div>
          <div v-if="loading" class="empty">正在读取飞行计划…</div>
          <div v-else-if="!plans.length" class="empty">暂无可访问的飞行计划</div>
          <div v-else class="tb-wrap">
            <table class="tb">
              <!-- 列集与 legacy flights.js 一致：编号 / 时段 / 最大高度 / 状态 / 匹配 / 偏航时差 / 来源；航线版本进编号行的小字。 -->
              <thead><tr><th>计划编号</th><th>计划时段</th><th class="num">最大高度</th><th>状态</th><th>匹配</th><th class="num" style="text-align:right">偏航/时差</th><th>来源</th></tr></thead>
              <tbody>
                <tr v-for="plan in plans" :key="plan.plan_id" :class="{ on: selected?.plan_id === plan.plan_id }"
                  tabindex="0" @click="loadDetail(plan.plan_id)" @keydown.enter="loadDetail(plan.plan_id)">
                  <td class="mono">{{ plan.plan_no }}<br><small :title="plan.route?.route_version_id">{{ plan.route?.route_no || '未知航线' }} / v{{ plan.route?.version_no ?? '—' }}</small></td>
                  <td>{{ formatTime(plan.start_at) }}<br><small>{{ formatDuration(plan) }}</small></td>
                  <td class="num">{{ plan.route?.max_altitude_m == null ? '—' : `${plan.route.max_altitude_m} m` }}</td>
                  <td><span class="tag" :class="PLAN_STATUS_TAG[plan.status_code] || 't-gray'">{{ labelOf(PLAN_STATUS_LABEL, plan.status_code) }}</span></td>
                  <td><span v-if="rowMatch(plan).tag" class="tag" :class="rowMatch(plan).tag" :title="rowMatch(plan).title">{{ rowMatch(plan).text }}</span><span v-else style="color:var(--txt-3)" :title="rowMatch(plan).title">{{ rowMatch(plan).text }}</span></td>
                  <td class="num" style="text-align:right;color:var(--txt-3)" :title="DEVIATION_NOTE">—</td>
                  <td><div :title="rowSource(plan)" style="white-space:normal;line-height:1.4;font-size:11.5px">{{ rowSource(plan) }}</div></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pager"><UPagination :page="page" :page-size="size" :item-count="total" @update:page="changePage" @update:page-size="changePageSize" /></div>
        </UPanel>

        <div class="col flight-right">
          <UPanel title="航线周边态势" nopad body-style="padding:6px">
            <!-- UPanel 的 sub/extra 使用 v-html；API 航线编号只能经 Vue 文本插值输出。 -->
            <div class="map-summary">{{ selected?.route ? `${selected.route.route_no} / v${selected.route.version_no} · ` : '' }}{{ conflicts.length ? `共 ${conflicts.length} 条空域时空关系事实` : '仅展示已取得的航线与空域版本几何' }}{{ matchedTrackNote ? ` · ${matchedTrackNote}` : '' }}</div>
            <div ref="mapHost" class="route-map" :class="{ unavailable: !hasMapContent }"></div>
            <div v-if="routeGeometryLoading || airspaceLoading" class="empty">正在读取航线或空域事实…</div>
            <div v-else-if="routeGeometryError || airspaceError" class="warnbox">{{ routeGeometryError || airspaceError }}</div>
            <div v-else-if="!hasMapContent" class="empty">不可绘制：未取得可信 WGS-84 航线或空域边界。</div>
            <div class="map-note">未知几何不绘制；走廊宽度、风险与合法性均不在前端推断。</div>
          </UPanel>
          <UPanel title="计划详情" :panel-style="'flex:3;min-height:0'" nopad>
            <div class="detail-body">
          <div v-if="detailLoading" class="empty">正在读取详情…</div>
          <div v-else-if="detailError" class="warnbox">{{ detailError }}</div>
          <div v-else-if="!selected" class="empty">请选择计划</div>
          <template v-else>
            <div class="detail-hero detail-hero-compact"><div class="detail-hero-inner"><div class="detail-hero-icon" v-html="planHeroIcon"></div><div class="detail-hero-copy"><div class="detail-hero-eyebrow">飞行计划</div><div class="detail-hero-title">{{ selected.plan_no }}</div><div class="detail-hero-id mono">{{ selected.route?.route_no || '未关联航线' }} / v{{ selected.route?.version_no ?? '—' }}</div></div></div></div>
            <div class="metric-strip is-compact"><div v-for="metric in [['执行状态', labelOf(PLAN_STATUS_LABEL, selected.status_code)], ['计划时长', formatDuration(selected)], ['航线版本', `v${selected.route?.version_no ?? '—'}`], ['目标匹配', matchMetricText]]" :key="metric[0]" class="metric-item"><div class="metric-copy"><small>{{ metric[0] }}</small><b>{{ metric[1] }}</b></div></div></div>
            <section class="sect"><h4>计划信息</h4><dl class="kv kv-surface"><dt>无人机序列号</dt><dd>{{ selected.uav_sn || '未提供' }}</dd><dt>所属范围</dt><dd>{{ selected.owner_org_name || selected.owner_org_id }} / {{ selected.district_name || selected.district_id }}</dd><dt>计划时段</dt><dd>{{ formatTime(selected.start_at) }} ～ {{ formatTime(selected.end_at) }}</dd><dt>计划来源</dt><dd>{{ selected.source?.source_name || selected.source?.source_code || labelOf(SOURCE_MODE_LABEL, selected.source_mode, '未提供') }}</dd></dl></section>
            <section v-if="showComparison" class="sect"><h4>计划与实际对照</h4>
              <div v-if="actualsLoading" class="empty">正在读取…</div>
              <div v-else-if="actualsError" class="warnbox">{{ actualsError }}</div>
              <div v-else-if="!sectionReady(actuals?.match)" class="warnbox">{{ matchSectionNote(actuals?.match) }}</div>
              <template v-else>
                <dl class="kv kv-surface" :title="actuals.match.evaluation_id">
                  <dt>计划匹配</dt><dd>{{ labelOf(PLAN_ROW_MATCH_LABEL, actuals.match.plan_match_code) }}</dd>
                  <dt>研判时间</dt><dd>{{ formatTime(actuals.match.evaluated_at) }}</dd>
                  <dt>高度关系</dt><dd>{{ planAltitudeText }}</dd>
                  <template v-if="altitudeBandText"><dt>计划高度带</dt><dd>{{ altitudeBandText }}</dd></template>
                  <template v-if="targetAltitudeText"><dt>实际高度</dt><dd>{{ targetAltitudeText }}</dd></template>
                  <template v-if="matchReasonText"><dt>匹配原因</dt><dd>{{ matchReasonText }}</dd></template>
                </dl>
                <div v-if="demoParams"><span class="tag t-amber">参数为演示值，尚未确认</span></div>
              </template>
            </section>
            <section v-if="showRouteRisks" class="sect"><h4>本航线风险<span v-if="routeRiskHeader" class="muted route-risk-head">{{ routeRiskHeader }}</span></h4>
              <div v-if="routeRisks.loading" class="empty">正在读取…</div>
              <div v-else-if="routeRisks.error" class="warnbox">{{ routeRisks.error }}</div>
              <div v-else-if="!routeRisks.items.length" class="route-risk-ok">走廊内与邻近范围内无风险事件</div>
              <div v-else class="conflict-list">
                <div v-for="item in routeRisks.items" :key="item.risk_id" class="conflict-item" :title="item.risk_id">
                  <div class="route-risk-line">
                    <span><span class="tag" :class="corridorTag(item)">{{ corridorText(item) }}</span> {{ riskTitle(item) }} <a class="lnk mono" href="#/flights?tab=events" @click.prevent="jumpToRisk(item.risk_id)">{{ item.risk_no || readableNo(item.source_risk_id) || '风险事件' }}</a></span>
                    <span v-if="item.space_fact?.distance_to_route_m != null" class="muted mono">距中心线 {{ (item.space_fact.distance_to_route_m / 1000).toFixed(2) }} km<template v-if="item.space_fact?.target_altitude_raw != null"> · {{ item.space_fact.target_altitude_raw }}m</template></span>
                  </div>
                  <div class="route-risk-line">
                    <span class="tag t-gray">{{ stateLabel(item.state) }}</span>
                    <button v-if="canNotifyItem(item)" class="btn" type="button" title="提交通知：由通知渠道投递并回执，回执“已驱离”即闭环" @click="openRiskNotify(item)">通知上级</button>
                  </div>
                </div>
              </div>
            </section>
            <!-- 与 legacy 一致的唯一动作：跳到合法性研判页并选中本计划匹配到的目标（决策 15-48）。 -->
            <div v-if="planPending" class="detail-actions" style="margin-top:12px">
              <button class="btn pri" type="button" style="flex:1;justify-content:center" :title="matchedTargetId ? '打开合法性研判页并选中本计划匹配到的目标' : '打开合法性研判页'" @click="goLegality">合法性判定 →</button>
            </div>
          </template></div>
          </UPanel>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.flights-page { min-width: 0; min-height: 0; height: 100%; display: flex; flex-direction: column; overflow: hidden; }
.flights-page > .tabs { flex: none; }
.flights-page :deep(.kpis) { flex: none; }
.flight-main { margin-top: 12px; flex: 1; min-height: 0; align-items: stretch; gap: var(--gap); }
.flight-main > :deep(.panel) { min-height: 0; }
.flight-right { flex: 1; min-width: 560px; min-height: 0; display: grid; grid-template-rows: minmax(180px, 28vh) minmax(0, 1fr); gap: var(--gap); }
/* 控件定宽已统一到 controls.css 的 .toolbar .field（决策 12-15）：各页各定一个宽度正是换行位置对不齐的根因。 */
.plan-toolbar { flex: none; padding-bottom: 16px; }
.plan-toolbar + .empty,
.plan-toolbar + .tb-wrap { flex: 1; min-height: 0; margin-top: 8px; }
.tb-wrap { overflow: auto; }
.tb tr { cursor: pointer; }
.tb tr.on { background: rgba(34, 211, 238, .12); }
.route-geometry { overflow-wrap: anywhere; line-height: 1.7; }
.route-map { flex: 1; min-height: 0; height: auto; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.route-map.unavailable { display: none; }
.map-summary,.map-note { flex: none; padding: 3px 4px; font-size: 11px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.pager { flex: none; display:flex; justify-content:flex-end; padding:10px; }
.conflict-list { display: grid; gap: 8px; margin-top: 8px; }
.route-risk-head { font-weight: normal; font-size: 12px; margin-left: 4px; }
.route-risk-ok { color: #79e5a5; font-size: 12.5px; padding: 6px 0; }
.route-risk-line { display: flex; justify-content: space-between; gap: 8px; align-items: center; flex-wrap: wrap; }
.conflict-item { display: grid; gap: 3px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.muted { color: var(--txt-3); font-size: 12px; }
.sect-title { margin-top: 14px; font-weight: 600; }
/* 风险页签：沿用原 RISK_IMPL 的三栏高度与面板比例（地图 0.82 / 列表 1.7 / 详情 30%）。 */
.risk-main { margin-top: 12px; flex: 1; min-height: 0; }
.rk-map { flex: 1; min-height: 0; }
.rk-map-empty { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 12px; font-size: 12px; }
.rk-legend { flex: none; height: 18px; line-height: 18px; font-size: 10.5px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rk-list { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.risk-toolbar .tabs .tab { padding: 6px 10px; font-size: 13px; }
.rk-sort { color: inherit; cursor: not-allowed; text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-color: rgba(156, 198, 255, .3); opacity: .75; }
.rk-sort[role="button"] { cursor: pointer; opacity: 1; text-decoration-color: rgba(156, 198, 255, .6); }
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
@media (max-width: 1100px) { .flights-page { overflow: auto; }.flight-main { flex: none; height: auto; flex-direction: column; }.flight-right { min-width: 0; grid-template-rows: 320px minmax(460px, auto); } }
@media (max-width: 1180px) { .flights-page { overflow: auto; }.risk-main { flex: none; height: auto; flex-direction: column; }.risk-main :deep(.panel) { width: auto !important; min-height: 360px; } }
</style>
