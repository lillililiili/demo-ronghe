<script>
/* 模块级页面状态：跨导航保留分页、筛选、选中项与证据页签；业务事实始终重新读取标准 API。 */
const S = {
  st: {
    page: 1, size: 10, legal: '', district: '', review: '', plan: '',
    selectedEvaluationId: null, revisionPage: 1, revisionPageSize: 10,
    evidenceTab: 'space'
  }
};
export default {};
</script>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import UKpis from '@/components/UKpis.vue';
import { UField } from '@/components/form/index.js';
import UPagination from '@/components/UPagination.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { legalityReviewFocus } from '@/ui/legalityReviewFocus.js';
import { legalityApi } from '@/services/legalityApi.js';
import { flightApi } from '@/services/flightApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { loadTargetPosition, loadRouteCenterline, loadAirspaceOverlays, installOverlays, overlayPoints } from '@/services/positionMap.js';
import { RULE_SET_LABEL, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
import {
  openLegalityReview, openLegalityRecompute,
  legalStatusText, reviewStateText, planMatchText, ruleReasonText,
  RULE_CODE_TEXT, RULE_RESULT_TEXT, MERGE_KIND_TEXT, CONCLUSION_TEXT, GRADE_TEXT
} from '@/ui/legalityReviewModal.js';

usePageChrome('legality');
const UI = window.UI;
const root = ref(null);
const st = reactive(S.st);
/* 阶段 7：队列读引擎研判（legality-evaluations?latest_only=true&mode=ACTIVE），不再以计划为主键；
   页面只展示服务端字段，不在前端推导结论，接口失败不回退任何演示数据。 */
const items = ref([]);
const totalCount = ref(0);
const selectedEvaluation = ref(null);
const revisions = ref([]);
const revisionsTotal = ref(0);
const loading = ref(false);
const detailLoading = ref(false);
const revisionsLoading = ref(false);
const listError = ref('');
const detailError = ref('');
const revisionsError = ref('');
const deepLinkNotice = ref('');
const selectedHitIndex = ref(-1);
const showAllChecks = ref(false);
const kpiList = ref(kpiPlaceholder('正在读取规则效果汇总…'));
const shadowHint = ref('');
let listToken = 0;
let detailToken = 0;
let revisionsToken = 0;

const conclusionMeta = {
  LEGAL: { label: '合法', tone: 'green' },
  ABNORMAL: { label: '异常', tone: 'amber' },
  ILLEGAL: { label: '非法', tone: 'red' },
  UNDETERMINED: { label: '不可判定', tone: 'amber' },
  NOT_APPLICABLE: { label: '不适用', tone: 'amber' }
};
const resultMeta = {
  PASS: { className: 'is-pass' },
  FAIL: { className: 'is-fail' },
  UNDETERMINED: { className: 'is-warn' },
  NOT_APPLICABLE: { className: 'is-warn' }
};
const tabs = [
  { value: '', label: '全部目标' },
  { value: 'LEGAL', label: '合法' },
  { value: 'ABNORMAL', label: '异常' },
  { value: 'ILLEGAL', label: '非法' },
  { value: 'UNDETERMINED', label: '不可判定' }
];
const evidenceTabs = [
  { value: 'space', label: '空间证据' },
  { value: 'plan', label: '计划与身份' },
  { value: 'review', label: '复核历史与告警' }
];

const reviewOptions = [{ label: '全部', value: '' }, { label: '待人工复核', value: 'PENDING_REVIEW' }, { label: '已确认', value: 'CONFIRMED' }, { label: '已驳回', value: 'REJECTED' }, { label: '已改判', value: 'OVERRIDDEN' }];
const districtOptions = computed(() => {
  const values = new Map();
  items.value.forEach(item => { if (item.district_id) values.set(item.district_id, item.district_name || item.district_id); });
  if (st.district && !values.has(st.district)) values.set(st.district, st.district);
  return [{ label: '全部区域', value: '' }, ...[...values.entries()].sort().map(([value, label]) => ({ label, value }))];
});
/* 按计划筛选（决策 19-1）：下拉取当前可见的计划；没有飞行计划读取权限就整块不显示——
   服务端对无权限的 plan_id 直接拒绝，画一个点了就报错的下拉没有意义。 */
const canReadPlans = computed(() => hasPermission('flights.read'));
const plans = ref([]);
const plansError = ref('');
const planOptions = computed(() => {
  const options = [{ label: '全部计划', value: '' }];
  plans.value.forEach(plan => options.push({ label: plan.plan_no || plan.plan_id, value: plan.plan_id }));
  if (st.plan && !plans.value.some(plan => plan.plan_id === st.plan)) options.push({ label: '当前所选计划', value: st.plan });
  return options;
});
async function loadPlans() {
  if (!canReadPlans.value) { plans.value = []; return; }
  try {
    const page = await flightApi.list({ page: 1, size: 100 });
    plans.value = page.items || [];
    plansError.value = '';
  } catch (error) {
    plans.value = [];
    plansError.value = formatApiError(error, '读取飞行计划失败');
  }
}
/* 研判详情里的"所属飞行计划"：编号与归属单位取研判自带的字段，序列号再读一次计划详情。
   服务端没有飞手字段，这一项不编。 */
const planDetail = ref(null);
async function loadPlanDetail(evaluation) {
  planDetail.value = null;
  const planId = evaluation?.plan_id;
  if (!planId || !canReadPlans.value) return;
  try {
    const detail = await flightApi.detail(planId);
    if (selectedEvaluation.value?.plan_id === planId) planDetail.value = detail;
  } catch { planDetail.value = null; }
}
function openPlan(planId) {
  if (!planId) return;
  if (UI?.goto) UI.goto('flights', { plan: planId });
  else location.hash = `#/flights?plan=${encodeURIComponent(planId)}`;
}

const selectedConclusion = computed(() => conclusionMeta[selectedEvaluation.value?.legal_status]
  || { label: '尚未选择研判', tone: 'amber' });
const selectedQueueIndex = computed(() => items.value.findIndex(item => item.evaluation_id === selectedEvaluation.value?.evaluation_id));
const primaryReason = computed(() => evaluationReason(selectedEvaluation.value));
const allowed = computed(() => selectedEvaluation.value?.allowed_actions || []);
const reviewFocus = computed(() => legalityReviewFocus(selectedEvaluation.value));
const checkRows = computed(() => (selectedEvaluation.value?.hit_details || []).map((hit, index) => ({ hit, index }))
  .filter(({ hit }) => showAllChecks.value || ['FAIL', 'UNDETERMINED'].includes(hit.result_code)));
const secondaryCheckCount = computed(() => (selectedEvaluation.value?.hit_details || []).filter(hit => !['FAIL', 'UNDETERMINED'].includes(hit.result_code)).length);
const unlistedUnknowns = computed(() => reviewFocus.value.unknownReasons.filter(code => !(selectedEvaluation.value?.hit_details || []).some(hit => hit.reason_code === code)));
function chooseReviewQueue() {
  const active = st.review === 'PENDING_REVIEW' && st.legal === 'UNDETERMINED';
  st.review = active ? '' : 'PENDING_REVIEW';
  st.legal = active ? '' : 'UNDETERMINED';
  onRegionChange();
}
const c01Facts = computed(() => selectedEvaluation.value?.hit_details?.find(hit => hit.rule_code === 'C01')?.facts || null);
const demoParams = computed(() => selectedEvaluation.value?.param_status === 'DEMO');

function kpiPlaceholder(desc) {
  return [
    { label: '研判总数', value: '—', color: 'blue', icon: 'database', desc },
    { label: '合法', value: '—', color: 'green', icon: 'shield', desc },
    { label: '异常', value: '—', color: 'amber', icon: 'warning', desc },
    { label: '非法', value: '—', color: 'red', icon: 'ban', desc },
    { label: '不可判定', value: '—', color: 'gray', icon: 'clock', desc }
  ];
}
function tabCount(index) { return kpiList.value[index]?.value ?? '—'; }
function evidenceIcon(kind) {
  return { target: 'radar', track: 'location', flight_plan: 'clipboard', route_version: 'plane', airspace_version: 'zone', rule_set_version: 'shield', rule_version: 'shield', alarm: 'bell', risk: 'warning' }[kind] || 'file';
}

function resultText(code) { return RULE_RESULT_TEXT[code] || code || '未提供'; }
function resultClass(code) { return resultMeta[code]?.className || 'is-warn'; }
function ruleName(code) { return RULE_CODE_TEXT[code] || '规则'; }
function gradeText(item) {
  if (!item?.grade) return '—';
  const score = item.score != null ? ` ${Number(item.score).toFixed(0)}分` : '';
  return `${GRADE_TEXT[item.grade] || item.grade}${score}`;
}
function sourceText(mode) { return labelOf(SOURCE_MODE_LABEL, mode, '未提供'); }
/* 证据引用只给种类与内部 id；屏幕上显示中文种类和可读编号，id 放 title。 */
const REFERENCE_KIND_TEXT = { target: '感知目标', track: '目标轨迹', flight_plan: '飞行计划', route_version: '航线版本', airspace_version: '空域版本', rule_set_version: '规则集版本', rule_version: '规则版本', alarm: '告警', risk: '风险事件' };
function referenceKindText(kind) { return REFERENCE_KIND_TEXT[kind] || '引用'; }
function referenceText(reference) {
  const current = selectedEvaluation.value || {};
  if (reference.kind === 'target' && current.target_id === reference.id && current.target_no) return current.target_no;
  if (reference.kind === 'flight_plan' && current.plan_id === reference.id && current.plan_no) return current.plan_no;
  return `已引用${referenceKindText(reference.kind)}`;
}
function ruleVersionText(item) {
  if (!item?.rule_set_code) return '未提供';
  const name = labelOf(RULE_SET_LABEL, item.rule_set_code);
  return item.rule_set_version_no == null ? name : `${name} 第${item.rule_set_version_no}版`;
}
function formatTime(value) {
  if (value === null || value === undefined) return '未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString('zh-CN', { hour12: false });
}
function shortTime(value) {
  if (value === null || value === undefined) return '时间未知';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleTimeString('zh-CN', { hour12: false });
}
function evaluationReason(item) {
  if (!item) return '尚未取得研判详情';
  if (item.legal_status === 'LEGAL') return item.unknown_reasons?.length ? `系统判定合法，另有 ${item.unknown_reasons.length} 项未知信息` : '全部检查通过';
  if (item.violation_reasons?.length) return ruleReasonText(item.violation_reasons[0]);
  if (item.unknown_reasons?.length) return ruleReasonText(item.unknown_reasons[0]);
  if (item.legal_status === 'LEGAL') return '全部检查通过';
  return '未提供结论摘要';
}
function reasonList(codes) {
  return (codes || []).map(code => ruleReasonText(code)).join('、');
}
function subjectLabel(item) {
  if (!item) return '未选择研判';
  if (item.target_no || item.target_id) return item.target_no || '目标（未提供编号）';
  if (item.plan_no || item.plan_id) return item.plan_no || '计划（未提供编号）';
  return '没有可查看的目标或计划';
}
/* 命中事实与参数的键都是引擎内部名；上屏用中文，数值取一位小数，内部 id 不上屏。 */
const FACT_KEY_TEXT = {
  plan_id: '计划', route_version_id: '航线版本', target_id: '目标', track_id: '轨迹', airspace_version_id: '空域版本',
  distance_m: '距中心线（米）', deviation_m: '偏离量（米）', half_width_m: '走廊半宽（米）', tolerance_m: '容差（米）', corridor_tolerance_m: '走廊容差（米）',
  altitude_m: '高度（米）', max_altitude_m: '最大高度（米）', min_altitude_m: '最小高度（米）', limit_m: '限高（米）', margin_m: '余量（米）',
  time_window: '时间窗', corridor: '走廊', identity: '身份', confidence: '置信度', candidate_count: '候选计划数', match_reason: '匹配原因',
  start_at: '开始', end_at: '结束', observed_at: '监测时间', night_from: '夜航起', night_to: '夜航止', kinds: '空域类型'
};
const DIM_TEXT = { MATCH: '匹配', MISMATCH: '不匹配', UNDETERMINED: '不可判定', PASS: '通过', FAIL: '不通过', UNKNOWN: '未知' };
function factKeyText(key) { return FACT_KEY_TEXT[key] || key.replace(/_/g, ' '); }
function factValueText(key, value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (typeof value === 'string') {
    if (/_id$/.test(key) || /^seed-/.test(value)) return '已关联';
    if (DIM_TEXT[value]) return DIM_TEXT[value];
    return ruleReasonText(value) === value ? value : ruleReasonText(value);
  }
  return factText(value);
}
function factText(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${factKeyText(k)} ${factValueText(k, v)}`).join('；');
  return String(value);
}
function dimText(value) { return value ? (DIM_TEXT[value] || value) : '未评估'; }
/* 合法结论且从未复核过，不是"待人工复核"，而是"无需复核"（原版口径）。 */
function reviewText(item) {
  if (item?.legal_status === 'LEGAL' && !(Number(item?.review?.version) > 0)) return '无需复核';
  return reviewStateText(item?.review?.state);
}
function planMatchDetail(item) {
  const base = planMatchText(item?.plan_match_code);
  if (!item?.plan_no) return base;
  if (item.plan_match_code === 'NONE') return `${base}（候选 ${item.plan_no} 不匹配）`;
  return `${base} · ${item.plan_no}`;
}
function outcomeText(item) {
  const kind = item?.alarm_outcome_kind;
  if (!kind) return item?.mode === 'SHADOW' ? MERGE_KIND_TEXT.SUPPRESSED_SHADOW : '未生成告警';
  return MERGE_KIND_TEXT[kind] || kind;
}
function formatApiError(error, fallback) {
  const statusText = {
    401: '未登录或会话已失效（HTTP 401）',
    403: '无权读取该资源（HTTP 403）',
    404: '资源不存在或不在可见范围内（HTTP 404）',
    408: '请求超时（HTTP 408）',
    500: '后端服务内部错误（HTTP 500）'
  }[error?.status];
  const message = error?.message || fallback;
  return statusText ? `${statusText}：${message}` : message;
}

function invalidateDetail() {
  detailToken += 1;
  revisionsToken += 1;
  selectedEvaluation.value = null;
  revisions.value = [];
  revisionsTotal.value = 0;
  selectedHitIndex.value = -1;
  showAllChecks.value = false;
  detailError.value = '';
  revisionsError.value = '';
}

function queryParams() {
  return {
    mode: 'ACTIVE', latest_only: true, legal_status: st.legal, district_id: st.district,
    review_state: st.review || undefined,
    // 按计划筛选（决策 19-1）：服务端 legality-evaluations 支持 plan_id，需要飞行计划读取权限。
    plan_id: st.plan || undefined,
    page: st.page, size: st.size
  };
}

async function loadQueue(options = {}) {
  const token = ++listToken;
  loading.value = true;
  listError.value = '';
  deepLinkNotice.value = '';
  if (!options.keepSelection) invalidateDetail();
  try {
    let deepLink = null;
    if (options.targetId) {
      // target 深链：先按目标定位最新研判，再把队列切到它所属的判定分组；定位失败不自动选择无关研判。
      try {
        const located = await legalityApi.listEvaluations({ mode: 'ACTIVE', latest_only: true, target_id: options.targetId, page: 1, size: 1 });
        if (token !== listToken) return;
        deepLink = located.items?.[0] || null;
        if (!deepLink) deepLinkNotice.value = `目标 ${options.targetNo || options.targetId} 没有可见的研判记录。`;
        else st.legal = conclusionMeta[deepLink.legal_status] && deepLink.legal_status !== 'NOT_APPLICABLE' ? deepLink.legal_status : 'UNDETERMINED';
      } catch (error) {
        if (token !== listToken) return;
        deepLinkNotice.value = `目标 ${options.targetId} 的研判定位失败：${formatApiError(error, '读取研判失败')}`;
      }
    }
    const data = await legalityApi.listEvaluations(queryParams());
    if (token !== listToken) return;
    items.value = data.items || [];
    totalCount.value = data.total || 0;
    st.page = data.page || st.page;
    if (deepLink) { await selectEvaluation(deepLink); return; }
    if (deepLinkNotice.value) return;
    const retainedId = options.selectId || S.st.selectedEvaluationId;
    const retained = items.value.find(item => item.evaluation_id === retainedId);
    if (retained) await selectEvaluation(retained);
    else if (options.selectId) await selectEvaluationById(options.selectId);
    else if (items.value[0]) await selectEvaluation(items.value[0]);
    else invalidateDetail();
  } catch (error) {
    if (token !== listToken) return;
    invalidateDetail();
    items.value = [];
    totalCount.value = 0;
    listError.value = formatApiError(error, '读取研判失败');
  } finally {
    if (token === listToken) loading.value = false;
  }
}

async function selectEvaluation(summary) {
  await selectEvaluationById(summary.evaluation_id);
}

async function selectEvaluationById(evaluationId) {
  const token = ++detailToken;
  S.st.selectedEvaluationId = evaluationId;
  selectedHitIndex.value = -1;
  showAllChecks.value = false;
  detailError.value = '';
  detailLoading.value = true;
  try {
    const data = await legalityApi.getEvaluation(evaluationId);
    if (token !== detailToken) return;
    selectedEvaluation.value = data;
    st.revisionPage = 1;
    loadPlanDetail(data);
    await loadRevisions();
  } catch (error) {
    if (token !== detailToken) return;
    selectedEvaluation.value = null;
    revisions.value = [];
    revisionsTotal.value = 0;
    detailError.value = formatApiError(error, '读取研判详情失败');
  } finally {
    if (token === detailToken) detailLoading.value = false;
  }
}

async function loadRevisions() {
  const evaluation = selectedEvaluation.value;
  if (!evaluation) return;
  const token = ++revisionsToken;
  revisionsLoading.value = true;
  revisionsError.value = '';
  try {
    const data = await legalityApi.listRevisions(evaluation.evaluation_id, { page: st.revisionPage, size: st.revisionPageSize });
    if (token !== revisionsToken) return;
    revisions.value = data.items || [];
    revisionsTotal.value = data.total || 0;
    st.revisionPage = data.page || st.revisionPage;
  } catch (error) {
    if (token !== revisionsToken) return;
    revisions.value = [];
    revisionsTotal.value = 0;
    revisionsError.value = formatApiError(error, '读取复核历史失败');
  } finally {
    if (token === revisionsToken) revisionsLoading.value = false;
  }
}

/* 写动作完成或结果未知后的回读：详情 + 队列 + KPI 都以服务端为准；返回最新详情供弹窗核对版本。 */
async function refreshAfterAction(result) {
  const id = result?.evaluation_id || selectedEvaluation.value?.evaluation_id;
  await loadQueue({ keepSelection: true, selectId: id });
  loadKpi();
  return selectedEvaluation.value;
}

function onReview() {
  openLegalityReview({ evaluation: selectedEvaluation.value, refresh: refreshAfterAction });
}
function onRecompute() {
  openLegalityRecompute({ evaluation: selectedEvaluation.value, refresh: refreshAfterAction });
}

async function loadKpi() {
  /* 各状态统计沿用队列的区域 / 复核 / 计划条件；异常单独读取服务端总数，不由其余状态相减推算。 */
  const scope = {
    mode: 'ACTIVE', latest_only: true,
    district_id: st.district || undefined,
    review_state: st.review || undefined,
    plan_id: st.plan || undefined,
    page: 1, size: 1
  };
  const filterNote = [
    st.district ? `区域：${districtOptions.value.find(option => option.value === st.district)?.label || st.district}` : '',
    st.review ? `复核：${reviewOptions.find(option => option.value === st.review)?.label || st.review}` : '',
    st.plan ? `计划：${planOptions.value.find(option => option.value === st.plan)?.label || st.plan}` : ''
  ].filter(Boolean).join(' · ');
  const scopeText = filterNote ? `当前筛选：${filterNote}` : '当前筛选：全部';
  try {
    const [all, legal, abnormal, illegal, undetermined] = await Promise.all([
      legalityApi.listEvaluations(scope),
      legalityApi.listEvaluations({ ...scope, legal_status: 'LEGAL' }),
      legalityApi.listEvaluations({ ...scope, legal_status: 'ABNORMAL' }),
      legalityApi.listEvaluations({ ...scope, legal_status: 'ILLEGAL' }),
      legalityApi.listEvaluations({ ...scope, legal_status: 'UNDETERMINED' })
    ]);
    kpiList.value = [
      { label: '研判总数', value: String(all.total ?? '—'), color: 'blue', icon: 'database', desc: `正式模式，每个目标只取最新一次；${scopeText}` },
      { label: '合法', value: String(legal.total ?? '—'), color: 'green', icon: 'shield', desc: '计划、时间、空域、航线都对得上' },
      { label: '异常', value: String(abnormal.total ?? '—'), color: 'amber', icon: 'warning', desc: '系统判定存在偏差的最新研判' },
      { label: '非法', value: String(illegal.total ?? '—'), color: 'red', icon: 'ban', desc: '没有有效计划，或进入了任何计划都不能批准的空域、时段' },
      { label: '不可判定', value: String(undetermined.total ?? '—'), color: 'gray', icon: 'clock', desc: '关键数据缺失或有偏差，要人工核实后才能定性' }
    ];
  } catch (error) {
    if (error?.status === 403) kpiList.value = kpiPlaceholder('无权限').map(card => ({ ...card, value: '无权限' }));
    else kpiList.value = kpiPlaceholder(formatApiError(error, '读取研判统计失败')).map(card => ({ ...card, value: '读取失败' }));
  }
}

async function loadShadowHint() {
  // 阴影运行提示只在具备 rule:read 时展示；无权限或读取失败时不提示，也不猜测。
  try {
    const data = await legalityApi.listRuleSets();
    const sets = Array.isArray(data) ? data : (data?.items || []);
    const shadow = sets.filter(set => set.shadow_version_id);
    shadowHint.value = shadow.length
      ? `试运行中：${shadow.map(set => labelOf(RULE_SET_LABEL, set.rule_set_code, set.rule_set_code)).join('、')} 正在用试运行版本并行研判，试运行结论不进入本队列、不产生告警。`
      : '';
  } catch {
    shadowHint.value = '';
  }
}

function chooseTab(value) {
  st.legal = value;
  st.page = 1;
  loadQueue();
}
function onRegionChange() {
  st.page = 1;
  loadQueue();
  loadKpi();   // 四格跟随筛选（决策 19-2）：条件一变就重算，否则上面的数与下面的列表对不上
}
function onPage(next) {
  st.page = next;
  loadQueue();
}
function onPageSize(next) {
  st.size = next;
  st.page = 1;
  loadQueue();
}
function onRevisionPage(next) {
  st.revisionPage = next;
  loadRevisions();
}
function onRevisionPageSize(next) {
  st.revisionPageSize = next;
  st.revisionPage = 1;
  loadRevisions();
}
function moveSelection(offset) {
  const next = items.value[selectedQueueIndex.value + offset];
  if (next) selectEvaluation(next);
}
function toggleHit(index) {
  selectedHitIndex.value = selectedHitIndex.value === index ? -1 : index;
}

watch(() => st.evidenceTab, value => { S.st.evidenceTab = value; if (value === 'space') void renderEvidenceMap(selectedEvaluation.value); else destroyEvidenceMap(); });
watch(selectedEvaluation, value => { if (st.evidenceTab === 'space') void renderEvidenceMap(value); });
onBeforeUnmount(destroyEvidenceMap);

/* ---------- 空间证据地图：画研判引用的目标轨迹、计划航线中心线与涉及的空域边界 ----------
   只画可信 WGS-84 几何；读不到的项在说明里写明，不以 (0,0) 补位、不推断合法性。 */
const evidenceMapHost = ref(null);
const evidenceMapNote = ref('');
let evidenceMap = null;
let evidenceMapSeq = 0;
function destroyEvidenceMap() {
  if (evidenceMap) { try { evidenceMap.destroy(); } catch { /* 已卸载 */ } }
  evidenceMap = null;
}
async function renderEvidenceMap(evaluation) {
  const my = ++evidenceMapSeq;
  destroyEvidenceMap();
  if (!evaluation) { evidenceMapNote.value = ''; return; }
  evidenceMapNote.value = '正在读取位置…';
  let centerline = null, airspaces = [], loaded = null;
  const missing = [];
  if (evaluation.route_version_id) { try { centerline = await loadRouteCenterline(evaluation.route_version_id); } catch { centerline = null; } }
  if (!centerline) missing.push(evaluation.plan_id ? '航线位置无法确认' : '无匹配计划，无航线');
  if (evaluation.plan_id) { try { airspaces = await loadAirspaceOverlays(evaluation.plan_id); } catch { airspaces = []; } }
  if (evaluation.target_id) {
    try { loaded = await loadTargetPosition(evaluation.target_id, { legal: legalStatusText(evaluation.legal_status) }); } catch { loaded = null; }
    if (!loaded?.mapTarget) missing.push('目标坐标未知');
  } else missing.push('没有可查看的目标记录');
  if (my !== evidenceMapSeq) return;
  const targets = loaded?.mapTarget ? [loaded.mapTarget] : [];
  const points = overlayPoints({ centerline, airspaces, points: loaded?.points || [], anchor: loaded?.anchor || null });
  if (!points.length) { evidenceMapNote.value = `暂时无法在地图上显示：${missing.join('；')}`; return; }
  const drawn = [];
  if (targets.length) drawn.push(loaded.points.length > 1 ? `目标轨迹 ${loaded.points.length} 点` : '目标最新位置');
  if (centerline) drawn.push('计划航线');
  if (airspaces.length) drawn.push(`空域 ${airspaces.length} 块`);
  evidenceMapNote.value = `已绘制：${drawn.join('、')}${missing.length ? `；未绘制：${missing.join('、')}` : ''}`;
  await nextTick();
  if (my !== evidenceMapSeq || !evidenceMapHost.value) return;
  evidenceMap = new window.MapView(evidenceMapHost.value, { zoom: 3, maxDev: 0, legend: false, layers: { device: false, track: targets.length > 0, alarm: false } });
  installOverlays(evidenceMap, { centerline, airspaces });
  evidenceMap.setData({ airspaces: [], devices: [], targets, alarms: [] });
  if (targets.length) evidenceMap.sel = targets[0].id;
  evidenceMap.fitTo(points);
}

onMounted(() => {
  const context = UI.consume('legality');
  const targetId = context?.target || null;
  /* 从飞行计划页过来时带着计划（决策 19-1）：预置"计划"筛选，其余筛选放开，
     否则一进来就被默认的"系统判定非法"挡住，看着像这条计划没有研判。 */
  const planId = context?.plan || new URLSearchParams((location.hash.split('?')[1] || '')).get('plan') || '';
  if (planId) {
    st.plan = planId;
    st.legal = '';
    st.district = '';
    st.review = '';
    st.page = 1;
  }
  if (targetId) {
    st.district = '';
    st.page = 1;
  }
  loadPlans();
  loadQueue({ targetId });
  loadKpi();
  loadShadowHint();
});
</script>

<template>
  <div class="view legality-workbench" id="view" ref="root">
    <div class="lg-shell">
      <div class="lg-workspace">
        <div class="lg-main-column">
          <div id="lgKpi" class="lg-kpi-host" aria-label="合法性研判统计（跟随当前筛选）">
            <UKpis :list="kpiList" />
          </div>
        <section class="lg-queue-panel" aria-label="合法性判定目标列表">
          <div class="lg-queue-tabs" role="tablist" aria-label="判定状态筛选">
            <button v-for="(tab, index) in tabs" :key="tab.value" type="button" role="tab"
              :aria-selected="st.legal === tab.value" :class="{ 'is-active': st.legal === tab.value }"
              @click="chooseTab(tab.value)">{{ tab.label }} <span>({{ tabCount(index) }})</span></button>
          </div>
          <div class="lg-queue-filters" role="group" aria-label="队列筛选">
            <button class="btn sm lg-review-filter" type="button" :class="{ pri: st.review === 'PENDING_REVIEW' && st.legal === 'UNDETERMINED' }" :aria-pressed="st.review === 'PENDING_REVIEW' && st.legal === 'UNDETERMINED'" :disabled="loading" title="查看不可判定且待人工复核的目标" @click="chooseReviewQueue">信息待核对</button>
            <UField class="lg-region-filter" variant="filter" label="区域" v-model="st.district" type="select" size="small"
              :options="districtOptions" :disabled="loading" @update:model-value="onRegionChange" />
            <UField class="lg-region-filter" variant="filter" label="复核" v-model="st.review" type="select" size="small"
              :options="reviewOptions" :disabled="loading" @update:model-value="onRegionChange" />
            <UField v-if="canReadPlans" class="lg-region-filter" variant="filter" label="计划" v-model="st.plan" type="select" size="small"
              :options="planOptions" :disabled="loading" :title="plansError || '只看某一条飞行计划的研判'" @update:model-value="onRegionChange" />
          </div>

          <div id="lgList" class="lg-list-host">
            <div v-if="shadowHint" class="lg-inline-error lg-shadow-hint" role="status">{{ shadowHint }}</div>
            <div v-if="listError" class="empty lg-state-error" role="alert">{{ listError }}</div>
            <div v-else-if="loading" class="empty">正在读取研判…</div>
            <div v-else-if="deepLinkNotice" class="empty lg-state-warn" role="status">{{ deepLinkNotice }}</div>
            <div v-else class="lg-table-scroll">
              <table class="lg-target-table" aria-label="目标判定结果">
                <thead><tr><th>目标编号</th><th>匹配计划</th><th>所在区域</th><th>判定结果</th><th>违规 / 未知原因</th><th>研判时间</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="item in items" :key="item.evaluation_id"
                    :class="{ 'is-selected': selectedEvaluation?.evaluation_id === item.evaluation_id }" @click="selectEvaluation(item)">
                    <td><button class="lg-target-link" type="button" @click.stop="selectEvaluation(item)">
                      <span class="lg-target-icon" v-html="UI.icon(item.target_id ? 'radar' : 'clipboard')"></span>
                      <span class="lg-row-target"><b class="mono" :title="item.evaluation_id">{{ subjectLabel(item) }}</b><small>{{ reviewText(item) }}</small></span>
                    </button></td>
                    <td><span class="lg-plan-cell" :class="item.plan_match_code === 'FULL' ? 'is-pass' : item.plan_match_code === 'NONE' ? 'is-fail' : 'is-warn'" :title="planMatchDetail(item)">
                      <span v-html="UI.icon(item.plan_match_code === 'FULL' ? 'check' : item.plan_match_code === 'NONE' ? 'cross' : 'clock')"></span>
                      <span class="lg-plan-number">{{ item.plan_no || (item.plan_id ? '已关联计划' : '无匹配计划') }}</span>
                    </span></td>
                    <td :title="item.district_name || item.district_id">{{ item.district_name || item.district_id || '未知' }}</td>
                    <td class="lg-verdict-cell"><span class="lg-status-tag" :class="`is-${conclusionMeta[item.legal_status]?.tone || 'amber'}`">{{ legalStatusText(item.legal_status) }}</span><small class="lg-row-risk" :title="`风险等级：${gradeText(item)}`">{{ gradeText(item) }}</small></td>
                    <td><span class="lg-reason-cell" :title="evaluationReason(item)">{{ evaluationReason(item) }}</span></td>
                    <td class="lg-time-cell" :title="formatTime(item.evaluated_at)">{{ formatTime(item.evaluated_at) }}</td>
                    <td><button class="lg-icon-btn" type="button" :aria-label="`查看 ${subjectLabel(item)} 的判定依据`" title="查看判定依据" @click.stop="selectEvaluation(item)" v-html="UI.icon('list')"></button></td>
                  </tr>
                </tbody>
              </table>
              <div v-if="!items.length" class="empty">当前筛选下没有研判记录。没有记录不代表合法，也可能是还没有生效的规则集。</div>
            </div>
          </div>

          <footer class="lg-pager pager">
            <UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount"
              :prefix="`研判共 ${totalCount.toLocaleString()} 条`"
              @update:page="onPage" @update:page-size="onPageSize" />
          </footer>
        </section>

        </div>

        <section class="lg-review-panel" aria-label="合法性研判详情">
          <span id="lgSt" class="lg-hidden-status">{{ selectedConclusion.label }}</span>
          <div id="lgDetail" class="lg-detail-host">
            <div v-if="detailError" class="empty lg-state-error" role="alert">{{ detailError }}</div>
            <div v-else-if="detailLoading" class="empty">正在读取研判详情…</div>
            <div v-else-if="!selectedEvaluation" class="empty">请选择一条研判</div>
            <template v-else>
              <div class="lg-detail-scroll">
                <section class="lg-focus-card" aria-label="系统结论与人工核对重点">
                  <div class="lg-focus-verdict"><span>系统结论</span><strong class="lg-status-tag" :class="`is-${selectedConclusion.tone}`">{{ selectedConclusion.label }}</strong><span>{{ reviewText(selectedEvaluation) }}</span></div>
                  <p class="lg-focus-basis">{{ primaryReason }}</p>
                  <p class="lg-muted">{{ formatTime(selectedEvaluation.evaluated_at) }} · {{ sourceText(selectedEvaluation.source_mode) }}{{ demoParams ? ' · 演示参数' : '' }}</p>
                  <p v-if="selectedEvaluation.review?.manual_status" class="lg-focus-manual">人工结论：<b>{{ legalStatusText(selectedEvaluation.review.manual_status) }}</b>（原始系统结论保留）</p>
                  <div class="lg-focus-task" :class="{ 'needs-review': reviewFocus.needsReview }">
                    <b>{{ reviewFocus.title }}</b><p>{{ reviewFocus.note }}</p>
                    <ul v-if="unlistedUnknowns.length"><li v-for="code in unlistedUnknowns" :key="code">{{ ruleReasonText(code) }}</li></ul>
                    <p v-if="reviewFocus.needsReview && !allowed.includes('REVIEW')" class="lg-state-warn">当前账号或记录状态不允许复核，可查看依据与历史。</p>
                  </div>
                  <p class="lg-focus-outcome">告警结果：{{ outcomeText(selectedEvaluation) }}</p>
                </section>
                <section class="lg-basis-card">
                  <header>判定依据与差异 <span :title="ruleVersionText(selectedEvaluation)">{{ ruleVersionText(selectedEvaluation) }}</span></header>
                  <div class="lg-selected-subject"><b :title="subjectLabel(selectedEvaluation)">{{ subjectLabel(selectedEvaluation) }}</b><span>{{ demoParams ? '演示参数' : '已确认参数' }}</span>
                    <button class="lg-icon-btn lg-previous" type="button" :disabled="selectedQueueIndex <= 0" aria-label="上一条" @click="moveSelection(-1)" v-html="UI.icon('arrowRight')"></button>
                    <button class="lg-icon-btn" type="button" :disabled="selectedQueueIndex < 0 || selectedQueueIndex >= items.length - 1" aria-label="下一条" @click="moveSelection(1)" v-html="UI.icon('arrowRight')"></button>
                  </div>
                  <div class="lg-check-list">
                    <div v-if="!selectedEvaluation.hit_details?.length" class="empty">未提供单项检查</div>
                    <p v-if="selectedEvaluation.hit_details?.length && !checkRows.length" class="lg-check-empty">没有不通过或不可判定的单项检查，可展开查看完整依据。</p>
                    <button v-for="{ hit, index } in checkRows"
                      :key="`${hit.rule_code}-${index}`" type="button" class="lg-check-item"
                      :class="[resultClass(hit.result_code), { 'is-selected': selectedHitIndex === index }]"
                      :aria-expanded="selectedHitIndex === index" :title="hit.message || ''" @click="toggleHit(index)">
                      <span class="lg-check-icon" v-html="UI.icon(hit.result_code === 'PASS' ? 'check' : hit.result_code === 'FAIL' ? 'cross' : 'clock')"></span>
                      <span class="lg-check-copy"><b>{{ ruleName(hit.rule_code) }}<em>{{ resultText(hit.result_code) }}</em></b>
                        <small class="lg-check-description">{{ hit.message || (hit.reason_code ? ruleReasonText(hit.reason_code) : '未提供说明') }}</small>
                        <small v-if="selectedHitIndex === index && hit.facts && Object.keys(hit.facts).length">判定时事实：{{ factText(hit.facts) }}</small>
                        <small v-if="selectedHitIndex === index">{{ hit.rule_code }} · {{ hit.params?.some(p => p.status === 'DEMO') ? '演示参数' : (hit.params?.length ? '已确认参数' : '未提供参数') }}</small>
                      </span>
                    </button>
                  </div>
                  <footer v-if="secondaryCheckCount" class="lg-result-summary"><button type="button" class="lg-link-btn" :aria-expanded="showAllChecks" @click="showAllChecks = !showAllChecks">{{ showAllChecks ? '收起通过及不适用项' : `查看通过及不适用项（${secondaryCheckCount}）` }}</button></footer>
                </section>

                <section class="lg-evidence-card">
                  <header>证据链 <span :title="subjectLabel(selectedEvaluation)">{{ subjectLabel(selectedEvaluation) }}</span></header>
                  <div class="lg-evidence-tabs" role="tablist" aria-label="研判证据">
                    <button v-for="tab in evidenceTabs" :key="tab.value" type="button" class="lg-evidence-tab"
                      :class="{ 'is-active': st.evidenceTab === tab.value }" role="tab"
                      :aria-selected="st.evidenceTab === tab.value" @click="st.evidenceTab = tab.value">{{ tab.label }}</button>
                  </div>
                  <div class="lg-evidence-body">
                    <template v-if="st.evidenceTab === 'space'">
                      <div class="lg-evidence-copy">
                        <ol v-if="selectedEvaluation.evidence_references?.length" class="lg-evidence-timeline">
                          <li v-for="(reference, index) in selectedEvaluation.evidence_references" :key="`${reference.kind}-${reference.id}-${index}`">
                            <span class="lg-evidence-icon" v-html="UI.icon(evidenceIcon(reference.kind))"></span>
                            <div><b>{{ referenceKindText(reference.kind) }}</b><p :title="reference.id">{{ referenceText(reference) }}</p></div>
                          </li>
                        </ol>
                        <p v-else>未提供证据引用</p>
                        <p class="lg-muted">{{ evidenceMapNote }}</p>
                      </div>
                      <div class="lg-map-wrap" aria-label="空间证据地图">
                        <div ref="evidenceMapHost" class="lg-map-host"></div>
                        <div class="lg-map-legend"><span class="is-zone">空域边界</span><span class="is-plan">计划航线</span><span class="is-track">目标轨迹</span></div>
                      </div>
                    </template>
                    <div v-else-if="st.evidenceTab === 'plan'" class="lg-evidence-wide">
                      <h4>计划匹配与身份 <span>判定时记录的情况</span></h4>
                      <dl class="lg-resource-grid">
                        <dt>匹配等级</dt><dd>{{ planMatchText(selectedEvaluation.plan_match_code) }}{{ c01Facts?.match_reason ? `（${ruleReasonText(c01Facts.match_reason)}）` : '' }}</dd>
                        <dt>计划编号</dt><dd class="mono" :title="selectedEvaluation.plan_id">{{ selectedEvaluation.plan_no || (selectedEvaluation.plan_id ? '已关联计划' : '没有可查看的对应计划') }}</dd>
                        <dt>关联目标</dt><dd class="mono" :title="selectedEvaluation.target_id">{{ selectedEvaluation.target_no || (selectedEvaluation.target_id ? '已关联' : '不可见') }}</dd>
                        <dt>时间窗</dt><dd>{{ dimText(c01Facts?.dimensions?.time_window) }}</dd>
                        <dt>走廊</dt><dd>{{ dimText(c01Facts?.dimensions?.corridor) }}</dd>
                        <dt>身份</dt><dd>{{ c01Facts?.dimensions?.identity === 'UNDETERMINED' ? '身份线索缺失（无测向或基站数据）' : dimText(c01Facts?.dimensions?.identity) }}</dd>
                        <dt>候选计划数</dt><dd>{{ c01Facts?.candidate_count ?? '未知' }}</dd>
                      </dl>
                    </div>
                    <div v-else class="lg-evidence-wide">
                      <h4>复核历史 <span>按时间追加</span></h4>
                      <p v-if="revisionsError" class="lg-evidence-alert">{{ revisionsError }}</p>
                      <p v-else-if="revisionsLoading">正在读取复核历史…</p>
                      <ul v-else-if="revisions.length" class="lg-reference-list lg-revision-list">
                        <li v-for="item in revisions" :key="item.history_id">
                          第 {{ item.version }} 次 · {{ CONCLUSION_TEXT[item.conclusion] || item.conclusion }} · {{ reviewStateText(item.previous_state) }} → {{ reviewStateText(item.resulting_state) }}
                          {{ item.status_after && item.status_after !== item.status_before ? `（${legalStatusText(item.status_before)} → ${legalStatusText(item.status_after)}）` : '' }}
                          · {{ item.actor_name || item.actor_id }} · {{ formatTime(item.created_at) }}
                          <br><span class="lg-muted">{{ item.note }}</span>
                          <span v-if="item.related_evaluation_id" class="lg-muted"> · 新研判 <button type="button" class="lg-link-btn" @click="selectEvaluationById(item.related_evaluation_id)">查看</button></span>
                        </li>
                      </ul>
                      <p v-else>尚无复核历史</p>
                <UPagination v-if="revisionsTotal > 0" v-model:page="st.revisionPage" v-model:page-size="st.revisionPageSize"
                  :item-count="revisionsTotal" :prefix="`复核历史共 ${revisionsTotal.toLocaleString()} 条`"
                  @update:page="onRevisionPage" @update:page-size="onRevisionPageSize" />
                    </div>
                  </div>
                </section>
                <details class="lg-more-details">
                  <summary>目标详情与复核记录</summary>
              <div class="lg-history-strip" aria-label="研判链与复核历史">
                <button v-if="selectedEvaluation.supersedes_evaluation_id" type="button"
                  :title="selectedEvaluation.supersedes_evaluation_id" @click="selectEvaluationById(selectedEvaluation.supersedes_evaluation_id)">← 被取代的旧研判</button>
                <button type="button" class="is-active" :title="selectedEvaluation.evaluation_id">{{ legalStatusText(selectedEvaluation.legal_status) }} · {{ formatTime(selectedEvaluation.evaluated_at) }}</button>
                <button v-if="selectedEvaluation.superseded_by_evaluation_id" type="button"
                  :title="selectedEvaluation.superseded_by_evaluation_id" @click="selectEvaluationById(selectedEvaluation.superseded_by_evaluation_id)">查看重新判定的结果 →</button>

              </div>

                <section class="lg-verdict-card" :class="`is-${selectedConclusion.tone}`">
                  <div class="lg-verdict-block">
                    <span class="lg-verdict-icon" v-html="UI.icon(selectedConclusion.tone === 'green' ? 'shield' : 'warning')"></span>
                    <div><small>系统结论</small><strong>{{ selectedConclusion.label }}</strong>
                      <span>{{ sourceText(selectedEvaluation.source_mode) }} · 等级 {{ gradeText(selectedEvaluation) }}</span></div>
                  </div>
                  <div class="lg-core-reason"><small>核心依据 / 未知原因</small><b>{{ primaryReason }}</b>
                    <span>{{ selectedEvaluation.violation_reasons?.length ? `违规：${reasonList(selectedEvaluation.violation_reasons)}` : '' }}{{ selectedEvaluation.unknown_reasons?.length ? `　未知：${reasonList(selectedEvaluation.unknown_reasons)}` : '' }}{{ !selectedEvaluation.violation_reasons?.length && !selectedEvaluation.unknown_reasons?.length ? '这里显示本次保存的判定结果' : '' }}</span></div>
                  <div class="lg-target-facts">
                    <dl>
                      <dt>关联目标</dt><dd :title="selectedEvaluation.target_id">{{ selectedEvaluation.target_no || (selectedEvaluation.target_id ? '已关联目标' : '没有可查看的相关记录') }}</dd>
                      <dt>关联轨迹</dt><dd :title="selectedEvaluation.track_id">{{ selectedEvaluation.track_id ? '已关联轨迹' : '没有可查看的相关记录' }}</dd>
                      <dt>计划匹配</dt><dd :title="selectedEvaluation.plan_id">{{ planMatchDetail(selectedEvaluation) }}</dd>
                      <!-- 决策 19-1：研判的主视角是计划。有计划就把编号做成入口，能直接过去看计划本身。
                           匹配等级为"无匹配"时它只是**候选**计划，标题要说清楚，不能写成"所属"。 -->
                      <dt>{{ selectedEvaluation.plan_match_code === 'NONE' ? '候选计划' : '所属计划' }}</dt><dd :title="selectedEvaluation.plan_id">
                        <template v-if="selectedEvaluation.plan_no && selectedEvaluation.plan_id">
                          <button type="button" class="lg-link-btn" title="打开飞行计划页并选中这条计划"
                            @click="openPlan(selectedEvaluation.plan_id)">{{ selectedEvaluation.plan_no }}</button>
                          <span v-if="selectedEvaluation.plan_match_code === 'NONE'" class="lg-muted">（未匹配上这条计划）</span>
                        </template>
                        <template v-else-if="selectedEvaluation.plan_id">已关联计划（未提供编号）</template>
                        <template v-else>无匹配计划</template>
                      </dd>
                      <dt v-if="selectedEvaluation.owner_org_name">归属单位</dt>
                      <dd v-if="selectedEvaluation.owner_org_name" :title="selectedEvaluation.owner_org_id">{{ selectedEvaluation.owner_org_name }}</dd>
                      <dt v-if="planDetail?.uav_sn">无人机序列号</dt>
                      <dd v-if="planDetail?.uav_sn" class="mono">{{ planDetail.uav_sn }}</dd>
                      <dt>航线版本</dt><dd :title="selectedEvaluation.route_version_id">{{ selectedEvaluation.route_version_id ? '已关联航线版本' : '没有可查看的相关记录' }}</dd>
                    </dl>
                  </div>
                  <div class="lg-review-state">
                    <span class="tag" :class="selectedEvaluation.review?.state === 'PENDING_REVIEW' ? 't-amber' : 't-gray'">{{ reviewText(selectedEvaluation) }}{{ selectedEvaluation.review?.version > 0 ? ` · 第${selectedEvaluation.review.version}次复核` : '' }}</span>
                    <dl>
                      <dt>研判时间</dt><dd>{{ formatTime(selectedEvaluation.evaluated_at) }}</dd>
                      <dt>规则版本</dt><dd :title="selectedEvaluation.rule_set_code">{{ ruleVersionText(selectedEvaluation) }}{{ demoParams ? '（演示参数）' : '' }}</dd>
                      <dt>人工结论</dt><dd>{{ selectedEvaluation.review?.manual_status ? legalStatusText(selectedEvaluation.review.manual_status) : '—' }}</dd>
                      <dt>告警结果</dt><dd>{{ outcomeText(selectedEvaluation) }}</dd>
                    </dl>
                  </div>
                </section>

                </details>
              </div>

              <footer class="lg-action-dock">
                <div class="detail-actions">
                  <button v-if="reviewFocus.superseded && selectedEvaluation.superseded_by_evaluation_id" class="btn pri" type="button" @click="selectEvaluationById(selectedEvaluation.superseded_by_evaluation_id)">查看最新研判</button>
                  <button v-else-if="reviewFocus.needsReview" class="btn pri" type="button" :disabled="!allowed.includes('REVIEW')" @click="onReview">{{ reviewFocus.unresolved ? '核对信息缺口' : '核对判定依据' }}</button>
                  <details v-if="allowed.includes('RECOMPUTE') || (allowed.includes('REVIEW') && !reviewFocus.needsReview && !reviewFocus.superseded)" :key="selectedEvaluation.evaluation_id" class="lg-secondary-actions">
                    <summary>更多操作</summary>
                    <div>
                      <button v-if="allowed.includes('REVIEW') && !reviewFocus.needsReview && !reviewFocus.superseded" class="btn" type="button" @click="onReview">补充人工纠正</button>
                      <button v-if="allowed.includes('RECOMPUTE')" class="btn" type="button" @click="onRecompute">重新研判</button>
                    </div>
                  </details>
                </div>
              </footer>
            </template>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.legality-workbench{--lg-blue:var(--blue);--lg-red:var(--red);--lg-green:var(--green);--lg-amber:var(--amber);--lg-line:rgba(39,112,185,.28);--lg-surface:#04172e;overflow:hidden!important;padding:16px!important;background:#020e20}
.legality-workbench *{box-sizing:border-box}
.legality-workbench button{font:inherit;cursor:pointer}
.legality-workbench button:focus-visible,.legality-workbench summary:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}
.lg-shell,.lg-workspace{height:100%;min-height:0}
.lg-workspace{display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr);gap:16px}
.lg-main-column{min-width:0;min-height:0;display:flex;flex-direction:column;gap:16px}
.lg-kpi-host{flex:none}
.legality-workbench .lg-kpi-host :deep(.kpis){display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}
.legality-workbench .lg-kpi-host :deep(.kpi){position:relative;min-width:0;min-height:108px;padding:17px 18px;border:1px solid color-mix(in srgb,var(--kpi-c) 32%,transparent);border-radius:6px;background:linear-gradient(125deg,color-mix(in srgb,var(--kpi-c) 9%,#031429),#031429);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--kpi-c) 10%,transparent);display:block}
.legality-workbench .lg-kpi-host :deep(.kpi:before),.legality-workbench .lg-kpi-host :deep(.kpi:after){display:none}
.legality-workbench .lg-kpi-host :deep(.kpi-gray){--kpi-c:#99b2d2}
.legality-workbench .lg-kpi-host :deep(.ic){position:absolute;left:17px;top:17px;width:20px;height:20px;padding:0;border:0;background:none;color:var(--kpi-c)}
.legality-workbench .lg-kpi-host :deep(.ic .svg-icon){width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:1.8}
.legality-workbench .lg-kpi-host :deep(.tx){display:block;min-width:0}
.legality-workbench .lg-kpi-host :deep(.lb){margin:0 0 10px;padding-left:28px;color:var(--kpi-c);font-size:15px;font-weight:600;line-height:22px}
.legality-workbench .lg-kpi-host :deep(.vl){color:var(--kpi-c);font-size:36px;font-weight:600;line-height:1.2;font-variant-numeric:tabular-nums}
.lg-queue-panel{flex:1;min-height:0;display:flex;flex-direction:column;border:1px solid var(--lg-line);border-radius:6px;background:var(--lg-surface);overflow:hidden}
.lg-queue-tabs{display:flex;align-items:stretch;min-height:50px;border-bottom:1px solid var(--lg-line);background:linear-gradient(90deg,#062449,#04172e)}
.lg-queue-tabs button{position:relative;padding:0 18px;border:0;border-right:1px solid rgba(39,112,185,.08);background:transparent;color:#91aac9;font-size:14px;white-space:nowrap}
.lg-queue-tabs button:hover{color:#d5eeff;background:rgba(0,159,255,.06)}
.lg-queue-tabs button.is-active{color:var(--cyan);background:rgba(0,159,255,.1)}
.lg-queue-tabs button.is-active:after{content:"";position:absolute;bottom:0;left:14px;right:14px;height:2px;background:var(--cyan);box-shadow:0 0 8px rgba(0,172,255,.45)}
.lg-queue-tabs button span{font-size:12px}
.lg-queue-filters{display:flex;align-items:center;gap:14px;min-height:54px;padding:8px 14px;border-bottom:1px solid var(--lg-line)}
.lg-region-filter{min-width:0;flex:1;margin:0}
.lg-region-filter :deep(.u-field-label){font-size:12px;white-space:nowrap}
.lg-list-host{min-height:0;flex:1;display:flex;flex-direction:column}
.lg-table-scroll{flex:1;min-height:0;overflow:auto;scrollbar-width:thin}
.lg-target-table{border-collapse:separate;border-spacing:0;width:100%;min-width:720px;table-layout:fixed;font-size:13px;color:#b9cce4}
.lg-target-table th{white-space:nowrap;position:sticky;top:0;z-index:1;height:46px;padding:10px;background:#0a284b;color:#bdd1ee;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--lg-line)}
.lg-target-table td{height:62px;padding:9px;border-bottom:1px solid var(--lg-line);border-right:1px solid rgba(39,112,185,.13);overflow:hidden;text-overflow:ellipsis}
.lg-target-table th:nth-child(1){width:20%}.lg-target-table th:nth-child(2){width:19%}.lg-target-table th:nth-child(3){width:13%}.lg-target-table th:nth-child(4){width:12%}.lg-target-table th:nth-child(5){width:17%}.lg-target-table th:nth-child(6){width:14%}.lg-target-table th:nth-child(7){width:5%;text-align:center}
.lg-target-table tbody tr{cursor:pointer}.lg-target-table tbody tr:hover{background:#072344}.lg-target-table tbody tr.is-selected{background:#092b4d;box-shadow:inset 3px 0 var(--cyan)}
.lg-target-link{display:flex;align-items:center;gap:8px;width:100%;padding:0;border:0;background:none;text-align:left;color:inherit}
.lg-target-icon{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:4px;background:#0d2a4e;color:#86cfff}
.lg-row-target{display:flex;flex-direction:column;min-width:0;gap:5px}.lg-row-target b{overflow-wrap:anywhere;white-space:normal;color:#c6e0f7;font-size:12px;font-weight:500}.lg-row-target small{font-size:11px;color:#738fac}
.lg-plan-cell{display:flex;align-items:center;gap:6px;font-size:12px;overflow-wrap:anywhere}.lg-plan-cell>span:first-child{display:flex;flex:none}.lg-plan-number{min-width:0;word-break:break-all;overflow-wrap:anywhere;white-space:normal;line-height:1.5}
.lg-status-tag{display:inline-flex;justify-content:center;align-items:center;min-width:58px;padding:4px 8px;border:1px solid currentColor;border-radius:4px;font-size:13px;white-space:nowrap;line-height:1.4}
.lg-status-tag.is-green{color:var(--green);background:rgba(23,181,140,.12);border-color:rgba(23,181,140,.28)}.lg-status-tag.is-red{color:var(--red);background:rgba(244,70,88,.12);border-color:rgba(244,70,88,.28)}.lg-status-tag.is-amber{color:var(--amber);background:rgba(230,162,58,.12);border-color:rgba(230,162,58,.28)}
.lg-verdict-cell .lg-row-risk{display:block;margin-top:5px;color:#819bb7;font-size:11px;white-space:nowrap}.lg-reason-cell{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px;line-height:1.6}.lg-time-cell{font-size:12px;line-height:1.6;font-variant-numeric:tabular-nums}
.lg-icon-btn{display:inline-flex;justify-content:center;align-items:center;width:28px;height:28px;border:0;border-radius:3px;background:transparent;color:#65b6f8}.lg-icon-btn:hover{background:rgba(0,162,255,.12)}
.legality-workbench :deep(.svg-icon){width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7}
.lg-pager{min-height:52px;padding:8px 12px;margin:0;border-top:1px solid var(--lg-line);background:#04172e;overflow:auto}
.lg-review-panel{min-width:0;min-height:0}.lg-hidden-status{display:none}.lg-detail-host{height:100%;min-height:0;display:flex;flex-direction:column}.lg-detail-scroll{min-height:0;flex:1;overflow:auto;scrollbar-width:thin;display:flex;flex-direction:column;gap:12px}
.lg-basis-card,.lg-evidence-card,.lg-more-details{flex:none;min-width:0;border:1px solid var(--lg-line);border-radius:5px;background:var(--lg-surface);overflow:hidden}
.lg-basis-card>header,.lg-evidence-card>header{display:flex;align-items:center;gap:10px;min-height:42px;padding:10px 16px;border-bottom:1px solid var(--lg-line);background:linear-gradient(100deg,#0a2e58,#051a35);font-size:15px;font-weight:600;color:#d1e7ff}
.lg-basis-card>header span,.lg-evidence-card>header span{flex:1;min-width:0;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;font-weight:400;color:#7798be}
.lg-basis-card{display:flex;flex-direction:column;max-height:none;min-height:0}.lg-check-list{padding:5px 12px;overflow:auto;max-height:320px;min-height:0;scrollbar-width:thin}.lg-selected-subject{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--lg-line);font-size:11px;color:#7f9ec2}.lg-selected-subject b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#afcce8;font-weight:500}.lg-selected-subject>span{flex:none;color:var(--amber)}.lg-check-item{display:flex;align-items:flex-start;gap:12px;width:100%;padding:8px 6px;border:0;border-radius:3px;background:transparent;text-align:left}.lg-check-item:hover,.lg-check-item.is-selected{background:rgba(25,104,187,.14)}
.lg-check-icon{display:flex;align-items:center;justify-content:center;flex:none;width:21px;height:21px;margin-top:1px;border-radius:5px;color:#dbf7ff;background:var(--green)}
.lg-check-item.is-fail .lg-check-icon{background:var(--red)}.lg-check-item.is-warn .lg-check-icon{background:var(--amber);color:#152137}
.lg-check-copy{min-width:0;flex:1}.lg-check-copy b{display:flex;gap:8px;justify-content:space-between;color:#c5d9ee;font-size:13px;font-weight:600;line-height:1.6}.lg-check-copy em{font-size:11px;font-style:normal;font-weight:400;color:var(--green)}.lg-check-item.is-fail em{color:var(--red)}.lg-check-item.is-warn em{color:var(--amber)}
.lg-check-description{display:-webkit-box!important;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}.lg-check-item.is-selected .lg-check-description{-webkit-line-clamp:unset}.lg-check-copy small{display:block;margin-top:3px;color:#7f9ec2;font-size:12px;line-height:1.65;overflow-wrap:anywhere}
.lg-rule-focus{margin:0 16px 12px;padding:10px;border:1px solid var(--lg-line);border-radius:4px;font-size:12px;line-height:1.7}.lg-rule-focus b,.lg-rule-focus>span{display:block}
.lg-result-summary{flex:none;display:flex;align-items:center;gap:12px;min-height:51px;padding:9px 16px;border-top:1px solid var(--lg-line);color:#c1d3eb;font-size:14px}
.lg-evidence-card{display:flex;flex-direction:column;min-height:300px;flex:none}.lg-evidence-card>header,.lg-evidence-tabs{flex:none}.lg-evidence-body{min-height:0;overflow:auto;scrollbar-width:thin}.lg-evidence-tabs{display:flex;border-bottom:1px solid var(--lg-line)}.lg-evidence-tab{flex:1;padding:11px 4px;border:0;border-bottom:2px solid transparent;background:transparent;color:#7895b7;font-size:11px!important;white-space:nowrap}.lg-evidence-tab.is-active{color:var(--cyan);border-bottom-color:var(--cyan);background:rgba(0,162,255,.05)}
.lg-evidence-body{padding:12px 16px;font-size:12px;line-height:1.6;color:#9bb4d0}.lg-evidence-body h4{margin:0 0 10px;color:#c7deee;font-size:13px}.lg-evidence-body h4 span{display:block;color:#728fae;font-size:11px;font-weight:400}.lg-evidence-body p{margin:4px 0}
.lg-evidence-timeline{list-style:none;margin:0 0 12px;padding:0}.lg-evidence-timeline li{position:relative;display:flex;gap:12px;min-height:70px;padding:10px 0}.lg-evidence-timeline li:not(:last-child):before{content:"";position:absolute;left:11px;top:35px;bottom:-8px;width:1px;background:rgba(0,163,248,.4)}.lg-evidence-timeline li+li{border-top:1px solid rgba(39,112,185,.17)}.lg-evidence-icon{display:flex;justify-content:center;align-items:center;width:24px;height:24px;flex:none;border-radius:50%;background:#073c67;color:var(--cyan)}.lg-evidence-timeline b{color:#54c7fa;font-size:13px}.lg-evidence-timeline p{overflow-wrap:anywhere;color:#8caaca;font-size:12px}
.lg-map-wrap{position:relative;min-height:185px;margin-top:10px;overflow:hidden;border:1px solid var(--lg-line);border-radius:4px;background:#09213a}.lg-map-host{position:absolute;inset:0}.lg-map-legend{position:absolute;left:5px;right:5px;bottom:5px;display:flex;justify-content:center;gap:10px;padding:3px;background:rgba(3,17,34,.88);font-size:9px}.lg-map-legend .is-zone{color:var(--red)}.lg-map-legend .is-plan{color:var(--blue)}.lg-map-legend .is-track{color:var(--amber)}
.lg-resource-grid,.lg-target-facts dl,.lg-review-state dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:7px;margin:8px 0;font-size:12px}.lg-resource-grid dt,.lg-target-facts dt,.lg-review-state dt{color:#7793b0}.lg-resource-grid dd,.lg-target-facts dd,.lg-review-state dd{margin:0;overflow-wrap:anywhere;color:#bad0e5}
.lg-more-details{max-height:none;overflow:auto;scrollbar-width:thin}.lg-selected-subject .lg-icon-btn{flex:none;width:22px;height:22px}.lg-previous :deep(svg){transform:rotate(180deg)}.lg-icon-btn:disabled{opacity:.35;cursor:not-allowed}.lg-evidence-wide :deep(.pager){overflow:auto;max-width:100%}.lg-more-details summary{padding:12px 16px;color:#9dbbdb;font-size:12px;cursor:pointer}.lg-history-strip{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px;border-top:1px solid var(--lg-line)}.lg-history-strip button{padding:6px;border:1px solid var(--lg-line);border-radius:4px;background:#082445;color:#a3c5e5;font-size:11px}.lg-history-strip :deep(.pager){max-width:100%;overflow:auto}
.lg-verdict-card{padding:12px 16px}.lg-verdict-block{display:flex;align-items:center;gap:10px}.lg-verdict-icon{display:flex;color:var(--amber)}.lg-verdict-block>div{display:flex;flex-direction:column;gap:4px}.lg-verdict-block strong{font-size:22px;color:var(--red)}.lg-verdict-card.is-green strong{color:var(--green)}.lg-verdict-card.is-amber strong{color:var(--amber)}.lg-verdict-block small,.lg-verdict-block span,.lg-core-reason{font-size:12px;color:#93aecc}.lg-core-reason{display:flex;flex-direction:column;gap:5px;margin:14px 0}.lg-core-reason b{color:#c8ddef}.lg-target-facts,.lg-review-state{border-top:1px solid var(--lg-line);padding-top:10px;margin-top:10px}.lg-review-state>.tag{font-size:11px}
.lg-action-dock{flex:none;padding:12px 0 0}.detail-actions{display:flex;gap:8px;margin:0}.lg-action-dock .btn{flex:1;min-width:0;height:40px!important;border-radius:4px;font-size:13px;background:#052246;border-color:#1264ad;color:#55c4ff}.lg-action-dock .btn.pri{background:linear-gradient(100deg,#075fa2,#08366a);color:#b8ecff}.detail-actions .btn:disabled{cursor:not-allowed;opacity:.45}
.lg-link-btn{border:0;padding:0;background:transparent;color:var(--cyan);font-size:12px}.lg-reference-list{padding-left:16px;font-size:12px;line-height:1.8}.lg-muted{color:#7691b0!important}.is-pass{color:var(--green)}.is-fail,.lg-state-error,.lg-evidence-alert{color:var(--red)}.is-warn,.lg-state-warn{color:var(--amber)}.lg-inline-error{padding:10px 14px;border-bottom:1px solid var(--lg-line);font-size:12px;line-height:1.6;color:var(--amber)}.empty{padding:28px 16px;font-size:13px;line-height:1.8}
.lg-focus-card{flex:none;border:1px solid var(--lg-line);border-radius:5px;padding:14px 16px;background:var(--lg-surface);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.lg-focus-verdict{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--muted)}.lg-focus-verdict>span:first-child{color:var(--text);font-size:14px}.lg-focus-card p{margin:7px 0}.lg-focus-basis{color:var(--text)}.lg-focus-task{border-top:1px solid var(--lg-line);padding-top:10px;margin-top:10px;color:var(--muted)}.lg-focus-task>b{color:var(--text)}.lg-focus-task.needs-review>b{color:var(--amber)}.lg-focus-task ul{padding-left:18px;margin:6px 0}.lg-focus-outcome{color:var(--muted)}.lg-focus-manual{color:var(--cyan)}.lg-check-empty{font-size:12px;line-height:1.6;color:var(--muted);padding:0 4px}.lg-secondary-actions{position:relative;flex:none}.lg-secondary-actions>summary{padding:10px 14px;border:1px solid var(--lg-line);border-radius:4px;color:var(--cyan);cursor:pointer;list-style:none;font-size:13px}.lg-secondary-actions>div{position:absolute;bottom:calc(100% + 8px);right:0;z-index:5;min-width:180px;padding:8px;background:var(--lg-surface);border:1px solid var(--lg-line);border-radius:4px;box-shadow:0 4px 20px #0006;display:flex;flex-direction:column;gap:6px}.lg-review-filter{white-space:nowrap}
@media(min-width:1800px){.lg-queue-panel{display:grid;grid-template-columns:minmax(0,1fr) 490px;grid-template-rows:54px minmax(0,1fr) auto}.lg-queue-tabs{min-height:54px}.lg-queue-filters{gap:10px;padding:8px 10px}.lg-list-host,.lg-pager{grid-column:1/-1}.lg-queue-tabs button{padding:0 15px}.lg-target-table{font-size:14px}.lg-target-table td{height:76px}.lg-target-table th{height:48px}.lg-main-column{gap:18px}.legality-workbench .lg-kpi-host :deep(.kpi){min-height:120px}.legality-workbench .lg-kpi-host :deep(.vl){font-size:40px}}
@media(max-width:1399px){.legality-workbench{padding:12px!important}.lg-workspace{gap:12px;grid-template-columns:minmax(0,3fr) minmax(0,2fr)}.lg-main-column{gap:12px}.legality-workbench .lg-kpi-host :deep(.kpis){gap:8px}.legality-workbench .lg-kpi-host :deep(.kpi){padding:14px 10px;min-height:100px}.legality-workbench .lg-kpi-host :deep(.ic){left:10px;top:14px;width:17px}.legality-workbench .lg-kpi-host :deep(.lb){padding-left:23px;font-size:12px}.legality-workbench .lg-kpi-host :deep(.vl){font-size:30px}.lg-queue-tabs button{flex:1;padding:0 7px;font-size:12px}.lg-queue-tabs button span{font-size:11px}.lg-queue-filters{gap:8px;padding:7px 10px}}
@media(max-width:1040px){.legality-workbench{overflow:auto!important}.lg-shell,.lg-workspace{height:auto;min-height:100%}.lg-workspace{grid-template-columns:minmax(0,1fr)}.lg-queue-panel{height:560px;flex:auto}.lg-detail-scroll{overflow:visible}.lg-basis-card{max-height:none}.lg-evidence-card{min-height:300px}.lg-more-details{max-height:none}.lg-review-panel{min-height:0}.lg-map-wrap{min-height:250px}}
@media(prefers-reduced-motion:reduce){.legality-workbench *{transition:none!important;scroll-behavior:auto!important}}
</style>
