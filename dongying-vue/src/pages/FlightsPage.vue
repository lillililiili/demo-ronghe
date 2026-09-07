<script>
/* 跨导航只保留筛选、分页与选中 ID；业务事实仍每次从只读 API 重取，不能缓存成 Mock 副本。 */
const S = { filters: { status_code: '', keyword: '', owner_org_id: '', district_id: '' }, page: 1, size: 20, selectedPlanId: null, tab: 'route', tabHash: '',
  /* 风险页签：筛选只收契约允许的字段；目标类型筛选与任意排序契约不支持，只保留禁用控件。 */
  riskFilters: { severity: '', state: '', plan_id: '', owner_org_id: '', district_id: '', source_mode: '', occurred: null },
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
  ALTITUDE_DATUM_LABEL, ALTITUDE_RELATION_LABEL, AUTHORIZATION_SOURCE_LABEL,
  HANDOFF_TYPE_LABEL, LEGALITY_LABEL, PLAN_MATCH_LABEL, PLAN_STATUS_LABEL, REASON_CODE_LABEL, RISK_TYPE_LABEL,
  SECTION_AVAILABILITY_LABEL, SOURCE_MODE_LABEL, labelOf
} from '@/ui/labels.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
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
const activeTab = ref('route');
const mapHost = ref(null);
const routeLoaded = ref(false);
/* 全页只允许一个活动 MapView：航线页签与风险页签共用同一变量，切换前先 destroyRouteMap()。 */
let routeMap = null;

/* ---------- 风险页签状态（数据只来自 riskApi，不读 window.MOCK / RISK_IMPL） ---------- */
const riskFilters = reactive(S.riskFilters);
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
const riskMapLoading = ref(false);
const riskMapError = ref('');
const riskMapHost = ref(null);
const riskKpiTotals = ref({});
const riskKpiFailed = ref({});
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
const FIXED_SORT_NOTE = '服务端固定排序：received_at DESC, risk_id DESC；阶段 4 未提供按该列排序';
const NO_TYPE_FILTER_NOTE = '阶段 4 未提供目标类型筛选（契约仅支持状态、等级、计划、发生时间、组织、区域、来源模式）';
const HISTORY_PAGE_SIZE = 10;

const riskSeverityOptions = [{ label: '全部', value: '' }, ...Object.keys(RISK_SEVERITY_LABEL).map(value => ({ label: RISK_SEVERITY_LABEL[value], value }))];
const riskStateOptions = [{ label: '全部', value: '' }, ...Object.keys(RISK_STATE_LABEL).map(value => ({ label: RISK_STATE_LABEL[value], value }))];
/* 原页面的目标类型下拉保留原选项，但契约无此筛选，控件禁用且不参与请求。 */
const riskTypeOptions = ['全部', '鸟', '未知', '识别中', '船', '车'].map(label => ({ label, value: label === '全部' ? '' : label }));
const riskTypeFilterDisabled = ref('');
/* /auth/me 的 permission_codes 目前只含模块级 `<module>.read/op/auth`，不含阶段动作码（flight:read 等）。
   只有会话真的暴露了冒号动作码才在前端预判；否则返回 null，交给服务端裁决（关联 ID 是否返回即服务端的权限声明）。 */
const knowsActionCodes = computed(() => (authUser.value?.permission_codes || []).some(code => /^[a-z_]+:[a-z_]+$/.test(code)));
function actionAllowed(code) { return knowsActionCodes.value ? hasPermission(code) : null; }
const canFilterByPlan = computed(() => actionAllowed('flight:read') !== false);
const canReadRoute = computed(() => actionAllowed('route:read') !== false);

const pageCount = computed(() => Math.max(1, Math.ceil(total.value / size.value)));
const statusOptions = [{ label: '全部状态', value: '' }, ...['PENDING', 'APPROVED', 'EXECUTING', 'COMPLETED', 'CANCELLED'].map(value => ({ label: value, value }))];
const kpiList = ['今日报备计划', '执行中', '待执行', '已完成', '计划未匹配到目标', '偏离报备计划'].map((label, index) => ({ label, value: '—', color: ['blue', 'cyan', 'purple', 'green', 'amber', 'red'][index], icon: ['plan', 'radar', 'check', 'check', 'alert', 'alert'][index], desc: '尚未接入后端聚合口径' }));
const trustedCenterline = computed(() => trustedCoordinates(routeVersion.value));
const trustedAirspaces = computed(() => trustedAirspaceOverlays());
const hasMapContent = computed(() => Boolean(trustedCenterline.value?.length || trustedAirspaces.value.length));

/* 6 个 KPI 与原页面同位同色；数值只取服务端 size=1 的 total，后端无法得出的指标显示“尚未接入”。 */
const RISK_KPI_QUERIES = { all: {}, high: { severity: 'HIGH' }, medium: { severity: 'MEDIUM' }, pending: { state: 'PENDING_VERIFICATION' } };
const riskKpis = computed(() => {
  const value = key => (riskKpiFailed.value[key] ? '—' : riskKpiTotals.value[key] == null ? '…' : Number(riskKpiTotals.value[key]).toLocaleString('en-US'));
  const desc = (key, text) => (riskKpiFailed.value[key] ? '服务端总数读取失败' : text);
  return [
    { label: '风险事件', value: value('all'), color: 'blue', icon: 'bird', desc: desc('all', '当前权限范围内服务端总数') },
    { label: '高风险事件', value: value('high'), color: 'red', icon: 'alert', desc: desc('high', 'severity=HIGH 的服务端总数') },
    { label: '中风险事件', value: value('medium'), color: 'amber', icon: 'alert', desc: desc('medium', 'severity=MEDIUM 的服务端总数') },
    { label: '鸟类事件', value: '尚未接入', color: 'green', icon: 'bird', desc: '阶段 4 风险无目标类型口径' },
    { label: '待核验', value: value('pending'), color: 'orange', icon: 'check', desc: desc('pending', 'state=PENDING_VERIFICATION 的服务端总数') },
    { label: '涉及航线', value: '尚未接入', color: 'purple', icon: 'zone', desc: '阶段 4 未提供航线维度聚合' }
  ];
});

const riskMapCoords = computed(() => trustedCoordinates(riskRouteVersion.value));
const riskMapNote = computed(() => {
  if (riskMapLoading.value) return '正在读取关联航线版本几何…';
  if (riskMapError.value) return riskMapError.value;
  if (!selectedRisk.value) return '未选择风险事件；风险本身无坐标字段，只按关联航线版本绘制依据。';
  if (!selectedRisk.value.route_version_id) return canReadRoute.value ? '服务端未返回航线版本关联（需 route:read 且对象可见），无可信坐标，不绘制。' : '无 route:read 权限，服务端未返回航线版本，不绘制。';
  if (!canReadRoute.value) return '无 route:read 权限，不读取航线几何。';
  return '不可绘制：航线版本未取得可信 WGS-84 中心线。';
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
const canNotifyRisk = computed(() => {
  const risk = selectedRisk.value;
  if (!risk) return false;
  return (risk.allowed_actions || []).includes('NOTIFY') || risk.state === 'PENDING_NOTIFICATION';
});
const notifyBlockReason = computed(() => {
  if (!selectedRisk.value) return '';
  if (canNotifyRisk.value) return '向接收方提交风险通知交接（材料入库，不等于已发送；权限由服务端裁决）';
  return `当前状态「${stateLabel(selectedRisk.value.state)}」不允许通知`;
});
const verifyBlockReason = computed(() => {
  if (!selectedRisk.value) return '';
  if (canVerifyRisk.value) return '提交核验通过或排除结论';
  if (selectedRisk.value.state !== 'PENDING_VERIFICATION') return `当前状态「${stateLabel(selectedRisk.value.state)}」不允许核验`;
  return '服务端未授予 VERIFY：缺少 risk:verify 权限或对象不在当前范围';
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
  return `服务端未返回（需 ${permissionCode} 且对象在可见范围）`;
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
    const data = await flightApi.list({ page: nextPage, size: size.value, ...filters });
    page.value = data.page;
    total.value = data.total;
    plans.value = data.items;
    routeLoaded.value = true;
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
    await Promise.all([loadRouteGeometry(plan), loadAirspaceContext(plan), loadActuals(plan)]);
  }
}

/* ---------- 计划与实际对照（阶段 9）----------
   五段各自带 availability：无权限的段只说"无权限查看"，不显示任何数量；
   有权限但没有数据是空列表或"尚无引擎研判"，两者含义不同，页面不能混为一谈。
   匹配、高度关系、合法性都来自同一次已保存的研判，页面不自行计算几何或换算高度基准。 */
const actuals = ref(null);
const actualsLoading = ref(false);
const actualsError = ref('');
const authorizationBusy = ref(false);
/* 服务端要的是动作码 flight:authorize，不是菜单模块 flights 的级别码：
   ROLE-JUDGE 有 flights OP 却没这个动作（按钮可点、提交 403），只授动作码的角色又会被误禁用。
   沿用本页既有的三态写法：动作码清单未知时不预先禁用，交给服务端裁决。 */
const canAuthorize = computed(() => actionAllowed('flight:authorize') !== false);
const authorizeBlockedNote = '需要外部授权登记权限';

async function loadActuals(plan) {
  actualsLoading.value = true;
  actualsError.value = '';
  try {
    const data = await flightApi.actuals(plan.plan_id);
    if (selected.value?.plan_id !== plan.plan_id) return;
    actuals.value = data;
  } catch (requestError) {
    if (selected.value?.plan_id !== plan.plan_id) return;
    actualsError.value = requestError.message || '读取计划与实际对照失败';
  } finally {
    if (selected.value?.plan_id === plan.plan_id) actualsLoading.value = false;
  }
}

function sectionReady(section) { return section?.availability === 'AVAILABLE'; }
function sectionNote(section) { return labelOf(SECTION_AVAILABILITY_LABEL, section?.availability, '暂不可用'); }

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
const demoLegalityParams = computed(() => actuals.value?.legality?.param_status === 'DEMO');

/* 指标条与下方"计划与实际对照"读同一条研判，避免同屏出现两个说法。 */
const matchMetricText = computed(() => {
  const section = actuals.value?.match;
  if (!section) return actualsLoading.value ? '读取中' : '—';
  return sectionReady(section) ? labelOf(PLAN_MATCH_LABEL, section.plan_match_code) : sectionNote(section);
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

function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* 登记外部授权：记录别处已经批下来的文号，只增一条记录，不改变本平台的计划状态。 */
function openAuthorization() {
  if (!canAuthorize.value || !selected.value) return;
  const plan = selected.value;
  const key = newIdempotencyKey();
  openFormModal({
    title: `登记外部授权 · ${plan.plan_no}`,
    notice: '登记的是别处已经批下来的授权文号，只作记录，不会改变这条计划的执行状态。同一计划的同一文号只能登记一次。',
    fields: [
      { key: 'document_no', label: '授权文号', required: true, placeholder: '例如 SW-2026-001' },
      { key: 'issuer', label: '签发单位', required: true },
      { key: 'granted_from', label: '授权开始时间', type: 'datetime', required: true },
      { key: 'granted_to', label: '授权结束时间', type: 'datetime', required: true },
      { key: 'scope_note', label: '授权说明', type: 'textarea', placeholder: '例如：限于报备航线走廊内' }
    ],
    confirmText: '登记',
    validate: values => (new Date(values.granted_from).getTime() < new Date(values.granted_to).getTime()
      ? '' : '结束时间必须晚于开始时间'),
    onSubmit: async values => {
      if (authorizationBusy.value) return;
      authorizationBusy.value = true;
      try {
        const body = {
          document_no: values.document_no.trim(),
          issuer: values.issuer.trim(),
          granted_from: new Date(values.granted_from).getTime(),
          granted_to: new Date(values.granted_to).getTime()
        };
        if (values.scope_note) body.scope_note = values.scope_note.trim();
        await flightApi.recordAuthorization(plan.plan_id, body, key);
        closeModal();
        toast('外部授权已登记。', 'ok');
        if (selected.value?.plan_id === plan.plan_id) await loadActuals(plan);
      } catch (reason) {
        toast(authorizationMessage(reason), 'err');
        // 结果未知时不重试同一个键，改为回读服务已经记下的内容。
        if (isUncertainOutcome?.(reason) && selected.value?.plan_id === plan.plan_id) await loadActuals(plan);
      } finally { authorizationBusy.value = false; }
    }
  });
}

function authorizationMessage(reason) {
  const code = reason?.code;
  if (code === 'AUTHORIZATION_EXISTS') return '这条计划已经登记过同一个文号了。';
  if (code === 'INVALID_VALIDITY') return '结束时间必须晚于开始时间。';
  if (code === 'IDEMPOTENCY_REPLAY') return '该登记已提交过，已为你刷新最新结果。';
  if (reason?.status === 403) return authorizeBlockedNote;
  return reason?.message || '登记失败，请稍后重试。';
}

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
  if (activeTab.value !== 'route' || !mapHost.value || (!coordinates && !airspaces.length)) return;
  routeMap = new window.MapView(mapHost.value, {
    zoom: 3.2, maxDev: 0, legend: false, layers: { device: false, track: false, alarm: false }
  });
  routeMap.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
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
  const [longitude, latitude] = coordinates?.[Math.floor(coordinates.length / 2)] || airspaces[0].polygons[0][0][0];
  routeMap.centerAt(longitude, latitude);
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
function changePage(nextPage) { if (nextPage !== page.value) loadPlans(nextPage); }
function changePageSize(nextSize) { size.value = nextSize; routeLoaded.value = false; loadPlans(1); }

/* ---------- 风险页签：列表 / KPI ---------- */
function riskQuery() {
  const text = value => String(value ?? '').trim();
  const query = { severity: riskFilters.severity || '', state: riskFilters.state || '', owner_org_id: text(riskFilters.owner_org_id),
    district_id: text(riskFilters.district_id), source_mode: text(riskFilters.source_mode) };
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
  if (detail && token === riskDetailToken) await loadRiskRouteGeometry(detail, token);
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
    await nextTick();
    renderRiskMap();
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
  const coordinates = riskMapCoords.value;
  if (activeTab.value !== 'events' || !riskMapHost.value || !coordinates) return;
  const version = riskRouteVersion.value;
  const label = `${version?.route_id || '航线'} v${version?.version_no ?? '—'}`;
  routeMap = new window.MapView(riskMapHost.value, {
    zoom: 3.2, maxDev: 0, legend: false, layers: { device: false, track: false, alarm: false }
  });
  routeMap.setData({ airspaces: [], devices: [], targets: [], alarms: [] });
  const drawBase = routeMap.draw.bind(routeMap);
  routeMap.draw = function drawRiskRouteCenterline() {
    drawBase();
    const context = this.ctx;
    if (!context || !this.w) return;
    // 只画已保存航线版本的 WGS-84 中心线；风险无坐标时不画标记，也不以 (0,0) 补位。
    context.save();
    context.beginPath();
    coordinates.forEach(([longitude, latitude], index) => {
      const point = this.px(longitude, latitude);
      if (index) context.lineTo(point[0], point[1]);
      else context.moveTo(point[0], point[1]);
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
    context.restore();
  };
  const [longitude, latitude] = coordinates[Math.floor(coordinates.length / 2)];
  routeMap.centerAt(longitude, latitude);
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
  if (error.status === 403) return '服务端拒绝：当前账号没有提交或查看交接的权限（handoff:create / handoff:read）。';
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
}

/* 成功提示只用 Vue 节点渲染服务端 ID，不走 innerHTML；链接指向处罚页的交接详情。 */
function showHandoffSubmitted(created) {
  const link = `#/punish?handoff=${encodeURIComponent(created.handoff_id)}`;
  openModal({
    title: '已提交，尚未发送', width: '520px', footer: false,
    render: () => h('div', { class: 'rk-notify-done' }, [
      h('div', { class: 'warnbox' }, '材料已入库等待投递（PENDING_DELIVERY），通知渠道未接通：不表示已发送、已送达或处罚办结；源风险保持“待通知”。'),
      h('dl', { class: 'kv kv-surface' }, [
        h('dt', '交接编号'), h('dd', { class: 'mono' }, created.handoff_id),
        h('dt', '接收方'), h('dd', { class: 'mono' }, created.recipient_id),
        h('dt', '投递状态'), h('dd', `${NOTICE_DELIVERY_LABEL[created.delivery_status] || created.delivery_status || '未知'} · ${NOTICE_BLOCKED_LABEL[created.blocked_reason] || created.blocked_reason || '无阻断'}`)
      ]),
      h('div', { class: 'detail-actions' }, [
        h('button', { class: 'btn', type: 'button', onClick: () => closeModal() }, '关闭'),
        h('a', { class: 'btn pri', href: link, onClick: () => closeModal() }, '查看交接')
      ])
    ])
  });
}

async function openRiskNotify() {
  const risk = selectedRisk.value;
  if (!risk || !canNotifyRisk.value) return;
  const riskId = risk.risk_id;
  const expectedVersion = Number(risk.version);
  let recipients = [];
  try { recipients = (await handoffApi.listHandoffRecipients('RISK_NOTICE')).items || []; }
  catch (requestError) { toast(handoffMessageOf(requestError, '读取交接接收方失败'), 'err'); return; }
  if (selectedRisk.value?.risk_id !== riskId) return;
  const empty = !recipients.length;
  if (!pendingHandoffKeys.has(riskId)) pendingHandoffKeys.set(riskId, newHandoffIdempotencyKey());
  openFormModal({
    title: '通知上级 · 风险通知交接',
    width: '560px',
    warning: empty
      ? '接收方未配置：服务端交接接收方目录为空，不能提交；本页不以默认部门补值。'
      : '提交只表示材料入库（待投递），通知渠道未接通，不表示已发送、已送达或处罚办结；源风险保持“待通知”。',
    notice: `风险 ${riskId} · 当前版本 v${expectedVersion}`,
    fields: [{ key: 'recipient_id', label: '接收方', type: 'select', required: true,
      options: recipients.map(item => ({ label: item.display_name, value: item.recipient_id })), placeholder: empty ? '接收方未配置' : '请选择接收方' }],
    initial: { recipient_id: recipients.length === 1 ? recipients[0].recipient_id : null },
    confirmText: empty ? '接收方未配置' : '提交交接',
    submitEnabled: values => !empty && !!values.recipient_id,
    onSubmit: async values => {
      const key = pendingHandoffKeys.get(riskId);
      const body = { source_kind: 'RISK', source_id: riskId, handoff_type: 'RISK_NOTICE', recipient_id: values.recipient_id, expected_version: expectedVersion };
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
          toast(code === 'HANDOFF_ALREADY_EXISTS' ? '该风险已向此接收方提交过交接，已切换到通报记录。' : '该请求此前已提交，请在通报记录核对。', 'err');
          return;
        }
        if (code === 'VERSION_CONFLICT' || code === 'INVALID_TRANSITION' || code === 'RECIPIENT_NOT_CONFIGURED' || code === 'RECIPIENT_NOT_FOUND') {
          // 明确失败：服务端未落库，换新键并回读风险，避免旧版本再次提交。
          pendingHandoffKeys.set(riskId, newHandoffIdempotencyKey());
          await refreshAfterNotify(riskId);
          throw new Error(`提交被拒绝，已刷新服务端状态：${handoffMessageOf(requestError, '请核对后重试')}`);
        }
        if (isUncertainOutcome(requestError)) {
          // 超时 / 断网 / 其他 409：服务端可能已落库。保留原键，先回读风险与交接记录，不自动换键重试、不提示成功。
          await refreshAfterNotify(riskId);
          throw new Error(`提交结果未确认，请刷新核对：${handoffMessageOf(requestError, '服务端未返回明确结果')}`);
        }
        pendingHandoffKeys.set(riskId, newHandoffIdempotencyKey());
        throw new Error(handoffMessageOf(requestError, '提交交接失败'));
      }
    }
  });
}

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
  if (selectedRisk.value?.risk_id === riskId && !riskDetailError.value) return;
  loadRiskDetail(riskId);
}
function retryRiskDetail() { if (S.selectedRiskId) loadRiskDetail(S.selectedRiskId); }
function retryRiskList() { loadRiskKpis(); loadRisks(riskPage.value); }

function enterRiskTab(requestedId = null) {
  destroyRouteMap();
  if (requestedId) {
    // 深链只清筛选与页码，避免选中的那条被当前筛选挡在列表外；详情仍按精确 ID 读取。
    Object.assign(riskFilters, { severity: '', state: '', plan_id: '', owner_org_id: '', district_id: '', source_mode: '', occurred: null });
    riskTab.value = 'event';
    S.selectedRiskId = requestedId;
  }
  loadRiskKpis();
  loadRisks(requestedId ? 1 : riskPage.value, requestedId);
}

/* 阶段 9 曾把 #/risk 拆成独立页面，2026-09-07 按用户裁定撤回：这两个模块原型里没有，
   risk / airspace 恢复为本页的别名。深链键 'risk'（工作台、处罚页、态势页的"转风险"）
   重新由本页消费，否则那三个生产者写入的一次性键将无人接收。 */
function consumeRiskDeepLink() {
  const context = window.UI?.consume?.('risk');
  const requested = context?.eventId || context?.riskId || context?.risk_id || context?.risk || null;
  return typeof requested === 'string' && requested ? requested : null;
}

function syncTabByRoute() {
  const hash = (location.hash || '').split('?')[0];
  if (hash === S.tabHash) return;
  S.tabHash = hash;
  // risk 是唯一能预置事件页签的别名；离开它再进入 flights 必须回到航线页，不能复用旧页签状态。
  const nextTab = hash.startsWith('#/risk') ? 'events' : 'route';
  if (nextTab === 'events') {
    activeTab.value = nextTab;
    enterRiskTab(consumeRiskDeepLink());
    return;
  }
  activeTab.value = nextTab;
  destroyRouteMap();
  if (!routeLoaded.value && !loading.value) loadPlans();
  else nextTick(renderRouteMap);
}

function activateTab(tab) {
  if (tab === 'events') {
    activeTab.value = 'events';
    // 先记下目标 hash，再改地址：随后的 hashchange 不会再触发一次重复加载。
    if (!location.hash.startsWith('#/risk')) { S.tabHash = '#/risk'; location.hash = '#/risk'; }
    enterRiskTab(consumeRiskDeepLink());
    return;
  }
  activeTab.value = 'route';
  destroyRouteMap();
  if (location.hash.startsWith('#/risk')) { S.tabHash = '#/flights'; location.hash = '#/flights'; }
  if (!routeLoaded.value && !loading.value) loadPlans();
  else nextTick(renderRouteMap);
}

onMounted(() => {
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
          <div v-if="riskMapCoords" id="rkMap" ref="riskMapHost" class="rk-map"></div>
          <div v-else class="empty rk-map-empty">{{ riskMapNote }}</div>
          <div class="rk-legend" title="蓝虚线为所选风险关联的已保存航线版本中心线；风险等级不表示合法性，风险本身未返回坐标时不绘制标记">
            <span style="color:#8fbaff">蓝虚线</span>=所选风险关联的航线版本中心线 · 风险坐标未返回，不绘制
            <span style="color:#ff4d5e">高</span>/<span style="color:#ffb020">中</span>/<span style="color:#3d8bff">低</span> 标记
          </div>
        </UPanel>

        <UPanel title="风险事件与通报" panel-style="flex:1.7" nopad>
          <div id="rkList" class="rk-list">
            <div class="toolbar risk-toolbar">
              <div class="tabs" style="border-bottom:none;gap:0">
                <button class="tab" :class="{ on: riskTab === 'event' }" type="button" @click="switchRiskTab('event')">风险事件</button>
                <button class="tab" :class="{ on: riskTab === 'notice' }" type="button" title="按选中风险读取服务端交接记录" @click="switchRiskTab('notice')">通报记录
                  <span class="tag t-gray" style="margin-left:4px">{{ riskTab === 'notice' ? noticesTotal : '交接' }}</span></button>
              </div>
              <template v-if="riskTab === 'event'">
                <div class="field"><label>风险等级</label><UControl v-model="riskFilters.severity" type="select" :options="riskSeverityOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                <div class="field" :title="NO_TYPE_FILTER_NOTE"><label>目标类型</label><UControl v-model="riskTypeFilterDisabled" type="select" :options="riskTypeOptions" disabled size="small" /></div>
                <div class="field"><label>状态</label><UControl v-model="riskFilters.state" type="select" :options="riskStateOptions" :disabled="riskLoading" size="small" @update:model-value="applyRiskFilters" /></div>
                <div class="field rk-range"><label>发生时间</label><UControl v-model="riskFilters.occurred" type="datetimerange" clearable :disabled="riskLoading" size="small" start-placeholder="开始" end-placeholder="结束" /></div>
                <div class="field" :title="canFilterByPlan ? '按已保存计划 ID 筛选（服务端要求 flight:read）' : '无 flight:read 权限，阶段 4 契约不允许以计划 ID 筛选'"><label>计划标识</label><UControl v-model="riskFilters.plan_id" placeholder="内部计划标识" :disabled="riskLoading || !canFilterByPlan" size="small" @keyup.enter="applyRiskFilters" /></div>
                <div class="field"><label>组织</label><UControl v-model="riskFilters.owner_org_id" placeholder="机构标识" :disabled="riskLoading" size="small" @keyup.enter="applyRiskFilters" /></div>
                <div class="field"><label>区域</label><UControl v-model="riskFilters.district_id" placeholder="区域标识" :disabled="riskLoading" size="small" @keyup.enter="applyRiskFilters" /></div>
                <div class="field"><label>来源模式</label><UControl v-model="riskFilters.source_mode" placeholder="source_mode" :disabled="riskLoading" size="small" @keyup.enter="applyRiskFilters" /></div>
                <button class="btn" type="button" :disabled="riskLoading" @click="applyRiskFilters">查询</button>
                <span style="flex:1"></span>
                <span class="rk-sort-note" :title="FIXED_SORT_NOTE">服务端固定按接收时间倒序</span>
              </template>
              <template v-else>
                <span style="flex:1"></span>
                <span class="rk-sort-note">交接记录来自服务端；提交成功只表示材料入库，不表示已发送</span>
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
                    <th><span class="rk-sort" aria-disabled="true" :title="FIXED_SORT_NOTE">类型</span></th>
                    <th>依据</th>
                    <th>来源</th>
                    <th><span class="rk-sort" aria-disabled="true" :title="FIXED_SORT_NOTE">区域 / 高度</span></th>
                    <th><span class="rk-sort" aria-disabled="true" :title="FIXED_SORT_NOTE">关联计划 / 航线</span></th>
                    <th style="text-align:center"><span class="rk-sort" aria-disabled="true" :title="FIXED_SORT_NOTE">风险</span></th>
                    <th><span class="rk-sort" aria-disabled="true" :title="FIXED_SORT_NOTE">时间</span></th>
                    <th><span class="rk-sort" aria-disabled="true" :title="FIXED_SORT_NOTE">状态</span></th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="risk in risks" :key="risk.risk_id" :data-row="risk.risk_id" tabindex="0" :class="{ on: activeRiskId === risk.risk_id }"
                      @click="selectRisk(risk.risk_id)" @keydown.enter.prevent="selectRisk(risk.risk_id)">
                      <td class="num"><span class="mono rk-id" :title="risk.risk_id">{{ risk.source_risk_id || risk.risk_id }}</span></td>
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
              <div v-else-if="!notices.length" class="empty">该风险尚无交接记录；核验通过后可在详情栏点击“通知上级”提交。</div>
              <div v-else class="scroll table-scroll table-shell" style="flex:1">
                <table class="tb">
                  <thead><tr><th>交接类型</th><th>接收方</th><th>提交时间</th><th>投递状态</th><th>回执</th><th>阻断原因</th><th></th></tr></thead>
                  <tbody>
                    <tr v-for="notice in notices" :key="notice.handoff_id" :data-row="notice.handoff_id">
                      <td><span :title="notice.handoff_id">{{ labelOf(HANDOFF_TYPE_LABEL, notice.handoff_type) }}</span></td>
                      <td><div class="rk-wrap">{{ notice.recipient_name || notice.recipient_id }}</div></td>
                      <td class="num" :title="formatTime(notice.created_at)">{{ formatClock(notice.created_at) }}</td>
                      <td><span class="tag" :class="NOTICE_DELIVERY_TAG[notice.delivery_status] || 't-gray'">{{ NOTICE_DELIVERY_LABEL[notice.delivery_status] || notice.delivery_status || '未知' }}</span></td>
                      <td>{{ NOTICE_RECEIPT_LABEL[notice.receipt_status] || notice.receipt_status || '未知' }}</td>
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
                <div class="detail-hero-copy"><div class="detail-hero-eyebrow">飞行风险</div><div class="detail-hero-title">{{ labelOf(RISK_TYPE_LABEL, selectedRisk.risk_type, '风险事件') }}</div><div class="detail-hero-id mono" :title="selectedRisk.risk_id">{{ selectedRisk.source_risk_id || selectedRisk.risk_id }}</div></div>
                <div class="detail-hero-side"><div class="detail-hero-tags"><span class="tag" :class="severityTag(selectedRisk.severity)">{{ severityLabel(selectedRisk.severity) }}</span><span class="tag" :class="stateTag(selectedRisk.state)">{{ stateLabel(selectedRisk.state) }}</span></div></div>
              </div></div>
              <div class="metric-strip is-compact">
                <div class="metric-item" :class="RISK_SEVERITY_TONE[selectedRisk.severity] ? 'is-' + RISK_SEVERITY_TONE[selectedRisk.severity] : ''"><span class="metric-copy"><small>风险等级</small><b>{{ severityLabel(selectedRisk.severity) }}</b></span></div>
                <div class="metric-item"><span class="metric-copy"><small>当前状态</small><b>{{ stateLabel(selectedRisk.state) }}</b></span></div>
                <div class="metric-item"><span class="metric-copy"><small>观测高度</small><b>{{ altitudeText(selectedRisk) }}</b></span></div>
                <div class="metric-item"><span class="metric-copy"><small>高度关系</small><b>{{ heightRelationLabel(selectedRisk.height_relation) }}</b></span></div>
              </div>
              <div class="sect"><h4>事件信息</h4><dl class="kv kv-surface">
                <dt>风险编号</dt><dd class="mono" :title="selectedRisk.risk_id">{{ selectedRisk.source_risk_id || '未提供' }}</dd>
                <dt>风险类型</dt><dd>{{ labelOf(RISK_TYPE_LABEL, selectedRisk.risk_type, '未提供') }}</dd>
                <dt>来源</dt><dd>{{ selectedRisk.source_name || selectedRisk.source_code || '未提供' }}（{{ labelOf(SOURCE_MODE_LABEL, selectedRisk.source_mode, '未提供') }}）</dd>
                <dt>发生时间</dt><dd>{{ formatTime(selectedRisk.occurred_at) }}</dd>
                <dt>接收时间</dt><dd>{{ formatTime(selectedRisk.received_at) }}</dd>
                <dt>所属范围</dt><dd>{{ selectedRisk.owner_org_name || selectedRisk.owner_org_id }} / {{ selectedRisk.district_name || selectedRisk.district_id }}</dd>
                <dt>版本</dt><dd class="mono">v{{ selectedRisk.version }}</dd>
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
              </dl><div class="rk-note">依据来自服务端已保存的风险事实与固定航线版本；前端不按最新规则重算，也不推断合法性。</div></div>
              <div class="sect"><h4>核验历史 <span class="tag t-gray">{{ riskHistoryTotal }}</span></h4>
                <div v-if="riskHistoryLoading" class="empty">正在读取核验历史…</div>
                <div v-else-if="riskHistoryError" class="warnbox rk-error">{{ riskHistoryError }}</div>
                <div v-else-if="!riskHistory.length" class="empty">尚无已保存的核验记录</div>
                <div v-else class="rk-history">
                  <div v-for="item in riskHistory" :key="item.history_id" class="rk-history-item">
                    <div class="rk-history-head"><span class="tag" :class="item.conclusion === 'EXCLUDED' ? 't-gray' : 't-green'">{{ item.conclusion === 'EXCLUDED' ? '排除' : item.conclusion === 'CONFIRMED' ? '核验通过' : item.conclusion }}</span><span class="mono rk-sub">{{ stateLabel(item.previous_state) }} → {{ stateLabel(item.resulting_state) }} · v{{ item.version }}</span></div>
                    <div class="rk-wrap">{{ item.note }}</div>
                    <div class="rk-sub">{{ formatTime(item.created_at) }} · 操作人 {{ item.actor_name || item.actor_id }}</div>
                  </div>
                </div>
                <div v-if="riskHistoryTotal > HISTORY_PAGE_SIZE" class="pager"><UPagination :page="riskHistoryPage" :page-size="HISTORY_PAGE_SIZE" :item-count="riskHistoryTotal" size="small" @update:page="changeRiskHistoryPage" /></div>
              </div>
              <div class="detail-actions is-sticky">
                <button class="btn" type="button" :disabled="!canNotifyRisk" :title="notifyBlockReason" @click="openRiskNotify">通知上级</button>
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
        <UPanel title="飞行计划与活动" :panel-style="'flex:1.1;min-width:0'" nopad>
          <div class="toolbar plan-toolbar">
            <div class="field"><label>状态</label><UControl v-model="filters.status_code" type="select" :options="statusOptions" :disabled="loading" /></div>
            <div class="field plan-keyword"><label>关键字</label><UControl v-model="filters.keyword" placeholder="计划编号 / 无人机序列号" :disabled="loading" @keyup.enter="applyFilters" /></div>
            <div class="field"><label>组织</label><UControl v-model="filters.owner_org_id" placeholder="机构标识" :disabled="loading" @keyup.enter="applyFilters" /></div>
            <div class="field"><label>区域</label><UControl v-model="filters.district_id" placeholder="区域标识" :disabled="loading" @keyup.enter="applyFilters" /></div>
            <button class="btn" type="button" :disabled="loading" @click="applyFilters">查询</button>
            <span class="spacer"></span><button class="btn" type="button" disabled title="尚未接入">导出（尚未接入）</button>
          </div>
          <div v-if="loading" class="empty">正在读取飞行计划…</div>
          <div v-else-if="!plans.length" class="empty">暂无可访问的飞行计划</div>
          <div v-else class="tb-wrap">
            <table class="tb">
              <thead><tr><th>计划编号</th><th>计划时段</th><th>状态</th><th>航线版本</th></tr></thead>
              <tbody>
                <tr v-for="plan in plans" :key="plan.plan_id" :class="{ on: selected?.plan_id === plan.plan_id }"
                  tabindex="0" @click="loadDetail(plan.plan_id)" @keydown.enter="loadDetail(plan.plan_id)">
                  <td class="mono">{{ plan.plan_no }}</td>
                  <td>{{ formatTime(plan.start_at) }}<br><small>{{ formatDuration(plan) }}</small></td>
                  <td>{{ labelOf(PLAN_STATUS_LABEL, plan.status_code) }}</td>
                  <td>{{ plan.route?.route_no || '未知航线' }} / v{{ plan.route?.version_no ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="pager"><UPagination :page="page" :page-size="size" :item-count="total" @update:page="changePage" @update:page-size="changePageSize" /></div>
        </UPanel>

        <div class="col flight-right">
          <UPanel title="航线周边态势" nopad body-style="padding:6px">
            <!-- UPanel 的 sub/extra 使用 v-html；API 航线编号只能经 Vue 文本插值输出。 -->
            <div class="map-summary">{{ selected?.route ? `${selected.route.route_no} / v${selected.route.version_no} · ` : '' }}{{ conflicts.length ? `服务端返回 ${conflicts.length} 条空域时空关系事实` : '未接入风险/异物推导；仅展示已取得的航线与空域版本几何。' }}</div>
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
            <section class="sect"><h4>审批信息</h4><div class="empty">尚未接入审批事实读取。</div></section>
            <section class="sect"><h4>外部授权登记</h4>
              <div class="row" style="gap:8px;align-items:center;margin-bottom:8px">
                <button class="btn" type="button" :disabled="!canAuthorize || authorizationBusy"
                  :title="canAuthorize ? '' : authorizeBlockedNote" @click="openAuthorization">登记外部授权</button>
                <span v-if="!canAuthorize" class="muted">{{ authorizeBlockedNote }}</span>
              </div>
              <div v-if="actualsLoading" class="empty">正在读取…</div>
              <div v-else-if="actualsError" class="warnbox">{{ actualsError }}</div>
              <div v-else-if="!sectionReady(actuals?.authorizations)" class="empty">{{ sectionNote(actuals?.authorizations) }}</div>
              <div v-else-if="!actuals.authorizations.items.length" class="empty">还没有登记过外部授权。</div>
              <div v-else class="conflict-list">
                <div v-for="item in actuals.authorizations.items" :key="item.authorization_id" class="conflict-item" :title="item.authorization_id">
                  <b>{{ item.document_no }}</b>
                  <span>{{ item.issuer }}</span>
                  <span>{{ formatTime(item.granted_from) }} ～ {{ formatTime(item.granted_to) }}</span>
                  <span v-if="item.scope_note">说明：{{ item.scope_note }}</span>
                  <span class="muted">{{ labelOf(AUTHORIZATION_SOURCE_LABEL, item.source_kind) }} · 登记人 {{ item.recorded_by_name || '未知' }} · {{ formatTime(item.recorded_at) }}</span>
                </div>
              </div>
            </section>
            <section class="sect"><h4>计划与实际对照</h4>
              <div v-if="actualsLoading" class="empty">正在读取…</div>
              <div v-else-if="actualsError" class="warnbox">{{ actualsError }}</div>
              <div v-else-if="!sectionReady(actuals?.match)" class="empty">{{ sectionNote(actuals?.match) }}</div>
              <template v-else>
                <dl class="kv kv-surface" :title="actuals.match.evaluation_id">
                  <dt>计划匹配</dt><dd>{{ labelOf(PLAN_MATCH_LABEL, actuals.match.plan_match_code) }}</dd>
                  <dt>研判时间</dt><dd>{{ formatTime(actuals.match.evaluated_at) }}</dd>
                  <dt>高度关系</dt><dd>{{ planAltitudeText }}</dd>
                  <template v-if="altitudeBandText"><dt>计划高度带</dt><dd>{{ altitudeBandText }}</dd></template>
                  <template v-if="targetAltitudeText"><dt>实际高度</dt><dd>{{ targetAltitudeText }}</dd></template>
                  <template v-if="matchReasonText"><dt>匹配原因</dt><dd>{{ matchReasonText }}</dd></template>
                </dl>
                <div v-if="demoParams"><span class="tag t-amber">参数为演示值，尚未确认</span></div>
              </template>
            </section>
            <section class="sect"><h4>本航线风险</h4>
              <div v-if="actualsLoading" class="empty">正在读取…</div>
              <div v-else-if="actualsError" class="warnbox">{{ actualsError }}</div>
              <div v-else-if="!sectionReady(actuals?.latest_risks)" class="empty">{{ sectionNote(actuals?.latest_risks) }}</div>
              <div v-else-if="!actuals.latest_risks.items.length" class="empty">最近没有与这条计划关联的风险。</div>
              <div v-else class="conflict-list">
                <div v-for="item in actuals.latest_risks.items" :key="item.risk_id" class="conflict-item" :title="item.risk_id">
                  <b>{{ labelOf(RISK_TYPE_LABEL, item.risk_type) }} · {{ severityLabel(item.severity) }}</b>
                  <span>{{ item.reason_text }}</span>
                  <span class="muted">{{ stateLabel(item.state_code) }} · 接收 {{ formatTime(item.received_at) }}</span>
                </div>
              </div>
            </section>
            <section class="sect"><h4>合法性</h4>
              <div v-if="actualsLoading" class="empty">正在读取…</div>
              <div v-else-if="actualsError" class="warnbox">{{ actualsError }}</div>
              <div v-else-if="!sectionReady(actuals?.legality)" class="empty">{{ sectionNote(actuals?.legality) }}</div>
              <template v-else>
                <dl class="kv kv-surface" :title="actuals.legality.evaluation_id">
                  <dt>研判结论</dt><dd>{{ labelOf(LEGALITY_LABEL, actuals.legality.legal_status) }}</dd>
                  <dt>研判时间</dt><dd>{{ formatTime(actuals.legality.evaluated_at) }}</dd>
                </dl>
                <div v-if="demoLegalityParams"><span class="tag t-amber">参数为演示值，尚未确认</span></div>
                <div class="muted">这里显示的是引擎已保存的研判结论；下方的空域冲突事实只是它的输入之一。</div>
              </template>
            </section>
            <section class="sect"><h4>空域冲突事实</h4><div v-if="!conflicts.length" class="empty">服务端未返回空域冲突事实。</div><div v-else class="conflict-list"><div v-for="fact in conflicts" :key="`${fact.airspace_version_id}-${fact.conflict_code}`" class="conflict-item">{{ fact.airspace_id }} / {{ fact.airspace_version_id }}：水平 {{ fact.horizontal_relation }}；高度 {{ fact.height_relation }}；时间 {{ fact.time_relation }}；{{ fact.conflict_code || '未提供' }}</div></div></section>
            <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
              <button class="btn" type="button" disabled title="尚未接入">导出（尚未接入）</button>
              <button class="btn" type="button" disabled title="尚未接入">风险通知（尚未接入）</button>
              <button class="btn" type="button" disabled title="尚未接入">写入操作（尚未接入）</button>
            </div>
          </template></div>
          </UPanel>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.flights-page { min-width: 0; }
.flight-main { margin-top: 12px; align-items: stretch; gap: var(--gap); height: max(812px, calc(100vh - 332px)); }
.flight-right { flex: 1; min-width: 560px; display: grid; grid-template-rows: 320px minmax(460px, 1fr); gap: var(--gap); }
.toolbar { display: flex; gap: 8px; padding: 10px; flex-wrap: wrap; align-items: center; }
/* UControl 根节点是 naive 的 .n-select/.n-input（默认 width:100%），必须用 :deep 定宽，否则每个控件独占一行。 */
.plan-toolbar .field :deep(.n-select), .plan-toolbar .field :deep(.n-input) { width: 158px; }
.plan-toolbar .plan-keyword :deep(.n-input) { width: 190px; }
.toolbar .spacer { flex: 1; }
.tb-wrap { overflow: auto; }
.tb tr { cursor: pointer; }
.tb tr.on { background: rgba(34, 211, 238, .12); }
.route-geometry { overflow-wrap: anywhere; line-height: 1.7; }
.route-map { height: 245px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.route-map.unavailable { display: none; }
.map-summary,.map-note { padding: 3px 4px; font-size: 11px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.detail-body { height: 100%; overflow: auto; padding: 12px; }
.pager { display:flex; justify-content:flex-end; padding:10px; }
.conflict-list { display: grid; gap: 8px; margin-top: 8px; }
.conflict-item { display: grid; gap: 3px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.muted { color: var(--txt-3); font-size: 12px; }
.sect-title { margin-top: 14px; font-weight: 600; }
/* 风险页签：沿用原 RISK_IMPL 的三栏高度与面板比例（地图 0.82 / 列表 1.7 / 详情 30%）。 */
.risk-main { margin-top: 12px; height: calc(100vh - 314px); min-height: 578px; }
.rk-map { flex: 1; min-height: 0; }
.rk-map-empty { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; text-align: center; padding: 12px; font-size: 12px; }
.rk-legend { flex: none; height: 18px; line-height: 18px; font-size: 10.5px; color: var(--txt-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rk-list { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.risk-toolbar { gap: 6px 10px; }
.risk-toolbar .tabs .tab { padding: 6px 10px; font-size: 13px; }
.risk-toolbar .field :deep(.n-select), .risk-toolbar .field :deep(.n-input) { width: 108px; }
.risk-toolbar .rk-range :deep(.n-date-picker) { width: 300px; }
.rk-sort-note { font-size: 11px; color: var(--txt-3); white-space: nowrap; }
.rk-sort { color: inherit; cursor: not-allowed; text-decoration: underline dotted; text-underline-offset: 3px; text-decoration-color: rgba(156, 198, 255, .3); opacity: .75; }
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
@media (max-width: 1100px) { .flight-main { height:auto; flex-direction:column; }.flight-right { min-width:0; grid-template-rows:320px minmax(460px,auto); } }
@media (max-width: 1180px) { .risk-main { height: auto; flex-direction: column; }.risk-main :deep(.panel) { width: auto !important; min-height: 360px; } }
</style>
