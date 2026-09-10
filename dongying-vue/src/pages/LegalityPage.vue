<script>
/* 模块级页面状态：跨导航保留分页、筛选、选中项与证据页签；业务事实始终重新读取标准 API。 */
const S = {
  st: {
    page: 1, size: 10, legal: 'ILLEGAL', district: '',
    selectedEvaluationId: null, revisionPage: 1, revisionPageSize: 10,
    evidenceTab: 'space'
  }
};
export default {};
</script>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import UKpis from '@/components/UKpis.vue';
import { UField } from '@/components/form/index.js';
import UPagination from '@/components/UPagination.vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { legalityApi } from '@/services/legalityApi.js';
import { RULE_SET_LABEL, SOURCE_MODE_LABEL, labelOf } from '@/ui/labels.js';
import {
  openLegalityReview, openLegalityRecompute, openLegalityEscalation, openLegalityManualEvaluate, openRuleVersionView,
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
  { value: 'ILLEGAL', label: '系统判定非法' },
  { value: 'ABNORMAL', label: '系统判定异常' },
  { value: 'UNDETERMINED', label: '系统待确认' },
  { value: 'LEGAL', label: '系统自动通过' }
];
const groups = [
  { code: 'ILLEGAL', label: '系统判定非法', tone: 'red' },
  { code: 'ABNORMAL', label: '系统判定异常', tone: 'amber' },
  { code: 'UNDETERMINED', label: '系统待确认', tone: 'amber' },
  { code: 'LEGAL', label: '系统自动通过', tone: 'green' }
];
const evidenceTabs = [
  { value: 'space', label: '空间证据' },
  { value: 'plan', label: '计划与身份' },
  { value: 'review', label: '复核历史与告警' }
];

const districtOptions = computed(() => {
  const values = new Map();
  items.value.forEach(item => { if (item.district_id) values.set(item.district_id, item.district_name || item.district_id); });
  if (st.district && !values.has(st.district)) values.set(st.district, st.district);
  return [{ label: '全部区域', value: '' }, ...[...values.entries()].sort().map(([value, label]) => ({ label, value }))];
});
const selectedConclusion = computed(() => conclusionMeta[selectedEvaluation.value?.legal_status]
  || { label: '尚未选择研判', tone: 'amber' });
const selectedQueueIndex = computed(() => items.value.findIndex(item => item.evaluation_id === selectedEvaluation.value?.evaluation_id));
const primaryReason = computed(() => evaluationReason(selectedEvaluation.value));
const allowed = computed(() => selectedEvaluation.value?.allowed_actions || []);
const selectedHit = computed(() => selectedEvaluation.value?.hit_details?.[selectedHitIndex.value] || null);
const c01Facts = computed(() => selectedEvaluation.value?.hit_details?.find(hit => hit.rule_code === 'C01')?.facts || null);
const demoParams = computed(() => selectedEvaluation.value?.param_status === 'DEMO');
const alarmHref = computed(() => selectedEvaluation.value?.alarm_id ? '#/alarms' : '');

function kpiPlaceholder(desc) {
  return [
    { label: '今日研判', value: '—', color: 'blue', icon: 'check', desc },
    { label: '可告警研判', value: '—', color: 'red', icon: 'alert', desc },
    { label: '已人工复核', value: '—', color: 'green', icon: 'check', desc },
    { label: '误报率', value: '—', color: 'amber', icon: 'alert', desc }
  ];
}

function groupedItems(code) {
  return items.value.filter(item => (item.legal_status === code) || (code === 'UNDETERMINED' && item.legal_status === 'NOT_APPLICABLE'));
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
function percent(ratio) {
  if (!ratio || ratio.value === null || ratio.value === undefined) return '无分母';
  return `${(Number(ratio.value) * 100).toFixed(1)}%`;
}
function evaluationReason(item) {
  if (!item) return '尚未取得研判详情';
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
  if (item.target_no || item.target_id) return item.target_no || '目标（编号不可见）';
  if (item.plan_no || item.plan_id) return item.plan_no || '计划（编号不可见）';
  return '主体不可见';
}
function factText(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}=${factText(v)}`).join('；');
  return String(value);
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
  detailError.value = '';
  revisionsError.value = '';
}

function queryParams() {
  return { mode: 'ACTIVE', latest_only: true, legal_status: st.legal, district_id: st.district, page: st.page, size: st.size };
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
        if (!deepLink) deepLinkNotice.value = `目标 ${options.targetId} 没有可见的引擎研判；未自动选择无关研判。`;
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
    listError.value = formatApiError(error, '读取引擎研判失败');
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
  detailError.value = '';
  detailLoading.value = true;
  try {
    const data = await legalityApi.getEvaluation(evaluationId);
    if (token !== detailToken) return;
    selectedEvaluation.value = data;
    st.revisionPage = 1;
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
function onEscalate() {
  openLegalityEscalation({ evaluation: selectedEvaluation.value, refresh: refreshAfterAction });
}
function onManualEvaluate() {
  const current = selectedEvaluation.value;
  openLegalityManualEvaluate({ targetId: current?.target_id, targetNo: current?.target_no, refresh: refreshAfterAction });
}
function onRuleView() {
  const current = selectedEvaluation.value;
  openRuleVersionView({ ruleSetVersionId: current?.rule_set_version_id, ruleSetCode: current?.rule_set_code, versionNo: current?.rule_set_version_no });
}
function openAlarm() {
  const alarmId = selectedEvaluation.value?.alarm_id;
  if (!alarmId) return;
  UI.goto('alarms', { alarm: alarmId });
}

async function loadKpi() {
  // 当日窗口按北京时间取 [今日 00:00, 明日 00:00)，不随浏览器所在时区漂移；北京无夏令时，固定 UTC+8。无权限显示“无权限”而不是 0。
  const timezone = 'Asia/Shanghai';
  // 非展示用：把当下折算成北京时区的年月日，用来拼查询窗口，不上屏。
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const pick = type => Number(parts.find(part => part.type === type)?.value);
  const from = new Date(Date.UTC(pick('year'), pick('month') - 1, pick('day')) - 8 * 60 * 60 * 1000);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  try {
    const summary = await legalityApi.ruleEffectsSummary({ from: from.getTime(), to: to.getTime(), timezone });
    kpiList.value = [
      { label: '今日研判', value: String(summary.evaluations ?? '—'), color: 'blue', icon: 'check', desc: '正式模式 · 北京时间当日（影子运行不计）' },
      { label: '可告警研判', value: String(summary.alarm_worthy ?? '—'), color: 'red', icon: 'alert', desc: `生成 ${summary.alarms_created ?? '—'} · 合并 ${summary.alarms_merged ?? '—'}` },
      { label: '已人工复核', value: String(summary.reviewed ?? '—'), color: 'green', icon: 'check', desc: `人工干预率 ${percent(summary.manual_override_rate)}` },
      { label: '误报率', value: percent(summary.false_positive_rate), color: 'amber', icon: 'alert', desc: `漏判率 ${percent(summary.miss_rate)}` }
    ];
  } catch (error) {
    if (error?.status === 403) kpiList.value = kpiPlaceholder('无权限').map(card => ({ ...card, value: '无权限' }));
    else kpiList.value = kpiPlaceholder(formatApiError(error, '读取规则效果汇总失败')).map(card => ({ ...card, value: '读取失败' }));
  }
}

async function loadShadowHint() {
  // 阴影运行提示只在具备 rule:read 时展示；无权限或读取失败时不提示，也不猜测。
  try {
    const data = await legalityApi.listRuleSets();
    const sets = Array.isArray(data) ? data : (data?.items || []);
    const shadow = sets.filter(set => set.shadow_version_id);
    shadowHint.value = shadow.length
      ? `阴影运行中：${shadow.map(set => set.rule_set_code).join('、')} 正在用影子版本并行研判，影子结论不进入本队列、不投影、不告警。`
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

watch(() => st.evidenceTab, value => { S.st.evidenceTab = value; });

onMounted(() => {
  const context = UI.consume('legality');
  const targetId = context?.target || null;
  if (targetId) {
    st.district = '';
    st.page = 1;
  }
  loadQueue({ targetId });
  loadKpi();
  loadShadowHint();
});
</script>

<template>
  <div class="view legality-workbench" id="view" ref="root">
    <div class="lg-shell">
      <div id="lgKpi" class="lg-kpi-host" aria-label="今日合法性判定统计">
        <UKpis :list="kpiList" />
      </div>

      <div class="lg-workspace">
        <section class="lg-queue-panel" aria-label="待人工复核目标队列">
          <header class="lg-panel-head">
            <h2>待人工复核 <span id="lgQueueN">{{ totalCount }}</span></h2>
            <span class="lg-head-spacer"></span>
            <UField class="lg-region-filter" variant="toolbar" label="区域" v-model="st.district" type="select"
              :options="districtOptions" :disabled="loading" @update:model-value="onRegionChange" />
            <button class="lg-icon-btn" id="lgRule" type="button" :disabled="!selectedEvaluation" aria-label="查看判定规则与参数（只读）"
              :title="selectedEvaluation ? `查看 ${ruleVersionText(selectedEvaluation)} 的规则与参数（需要规则读取权限）` : '请先选择研判'" @click="onRuleView">规则</button>
            <button class="lg-icon-btn" type="button" :disabled="loading" aria-label="刷新数据"
              title="刷新研判队列与统计" @click="loadQueue({ keepSelection: true }); loadKpi(); loadShadowHint()">刷新</button>
            <button class="lg-icon-btn" id="lgRecalc" type="button" :disabled="!selectedEvaluation?.target_id || !allowed.includes('RECOMPUTE')"
              aria-label="对当前目标手动评估" :title="selectedEvaluation?.target_id ? '按当前生效规则集对该目标立即评估一次（需要评估与目标读取权限）' : '当前研判没有可见目标，无法手动评估'"
              @click="onManualEvaluate">重算</button>
          </header>

          <div class="lg-queue-tabs" role="tablist" aria-label="判定状态筛选">
            <button v-for="tab in tabs" :key="tab.value" type="button" role="tab"
              :aria-selected="st.legal === tab.value" :class="{ 'is-active': st.legal === tab.value }"
              @click="chooseTab(tab.value)">{{ tab.label }}</button>
          </div>

          <div id="lgList" class="lg-list-host">
            <div class="lg-queue-columns" aria-hidden="true">
              <span>目标 / 时间</span><span>系统判定</span><span>风险等级</span><span>区域</span><span>主要原因</span>
            </div>
            <div class="lg-queue-scroll">
              <div v-if="shadowHint" class="lg-inline-error lg-shadow-hint" role="status">{{ shadowHint }}</div>
              <div v-if="listError" class="empty lg-state-error" role="alert">{{ listError }}</div>
              <div v-else-if="loading" class="empty">正在读取引擎研判…</div>
              <div v-else-if="deepLinkNotice" class="empty lg-state-warn" role="status">{{ deepLinkNotice }}</div>
              <template v-else>
                <section v-for="group in groups" v-show="st.legal === group.code"
                  :key="group.code" class="lg-queue-group" :class="`is-${group.tone}`">
                  <div class="lg-group-head">
                    <span class="lg-group-caret">›</span><b>{{ group.label }}（{{ groupedItems(group.code).length }}）</b>
                    <span>每目标最新一条</span>
                  </div>
                  <div class="lg-group-rows">
                    <button v-for="item in groupedItems(group.code)" :key="item.evaluation_id" type="button"
                      class="lg-queue-row" :class="{ 'is-selected': selectedEvaluation?.evaluation_id === item.evaluation_id }"
                      :aria-current="selectedEvaluation?.evaluation_id === item.evaluation_id" @click="selectEvaluation(item)">
                      <span class="lg-row-target"><b class="mono" :title="item.evaluation_id">{{ subjectLabel(item) }}</b><small>{{ shortTime(item.evaluated_at) }} · {{ reviewStateText(item.review?.state) }}</small></span>
                      <span class="lg-row-verdict">{{ legalStatusText(item.legal_status) }}</span>
                      <span class="lg-row-risk">{{ gradeText(item) }}</span>
                      <span class="lg-row-region">{{ item.district_name || item.district_id || '未知' }}</span>
                      <span class="lg-row-reason" :title="evaluationReason(item)">{{ evaluationReason(item) }}</span>
                    </button>
                  </div>
                </section>
                <div v-if="!items.length" class="empty">当前判定分组下没有引擎研判；空结果不代表合法，也可能是尚无生效规则集。</div>
              </template>
            </div>
          </div>

          <footer class="lg-pager pager">
            <UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount"
              :prefix="`研判共 ${totalCount.toLocaleString()} 条`"
              @update:page="onPage" @update:page-size="onPageSize" />
          </footer>
        </section>

        <section class="lg-review-panel" aria-label="合法性研判详情">
          <span id="lgSt" class="lg-hidden-status">{{ selectedConclusion.label }}</span>
          <div id="lgDetail" class="lg-detail-host">
            <header class="lg-review-head">
              <b>{{ subjectLabel(selectedEvaluation) }}</b>
              <span :title="selectedEvaluation?.evaluation_id">{{ selectedEvaluation ? `研判时间 ${formatTime(selectedEvaluation.evaluated_at)}` : '引擎研判' }}</span>
              <span v-if="selectedEvaluation" class="tag" :class="demoParams ? 't-amber' : 't-green'">{{ demoParams ? 'DEMO 参数' : '已确认参数' }}</span>
              <span class="lg-head-spacer"></span>
              <button class="lg-icon-btn" type="button" :disabled="selectedQueueIndex <= 0"
                aria-label="上一条" @click="moveSelection(-1)">←</button>
              <button class="lg-icon-btn is-next" type="button"
                :disabled="selectedQueueIndex < 0 || selectedQueueIndex >= items.length - 1"
                aria-label="下一条" @click="moveSelection(1)">→</button>
            </header>

            <div v-if="detailError" class="empty lg-state-error" role="alert">{{ detailError }}</div>
            <div v-else-if="detailLoading" class="empty">正在读取研判详情…</div>
            <div v-else-if="!selectedEvaluation" class="empty">请选择研判；若从目标深链进入且无法映射，页面不会默认选择无关研判。</div>
            <template v-else>
              <div class="lg-history-strip" aria-label="研判链与复核历史">
                <button v-if="selectedEvaluation.supersedes_evaluation_id" type="button"
                  :title="selectedEvaluation.supersedes_evaluation_id" @click="selectEvaluationById(selectedEvaluation.supersedes_evaluation_id)">← 被取代的旧研判</button>
                <button type="button" class="is-active" :title="selectedEvaluation.evaluation_id">{{ legalStatusText(selectedEvaluation.legal_status) }} · {{ formatTime(selectedEvaluation.evaluated_at) }}</button>
                <button v-if="selectedEvaluation.superseded_by_evaluation_id" type="button"
                  :title="selectedEvaluation.superseded_by_evaluation_id" @click="selectEvaluationById(selectedEvaluation.superseded_by_evaluation_id)">重算后的新研判 →</button>
                <UPagination v-model:page="st.revisionPage" v-model:page-size="st.revisionPageSize"
                  :item-count="revisionsTotal" :prefix="`复核历史共 ${revisionsTotal.toLocaleString()} 条`"
                  @update:page="onRevisionPage" @update:page-size="onRevisionPageSize" />
              </div>

              <div class="lg-detail-scroll">
                <section class="lg-verdict-card" :class="`is-${selectedConclusion.tone}`">
                  <div class="lg-verdict-block">
                    <span class="lg-verdict-icon">✓</span>
                    <div><small>系统结论</small><strong>{{ selectedConclusion.label }}</strong>
                      <span>{{ sourceText(selectedEvaluation.source_mode) }} · 等级 {{ gradeText(selectedEvaluation) }}</span></div>
                  </div>
                  <div class="lg-core-reason"><small>核心依据 / 未知原因</small><b>{{ primaryReason }}</b>
                    <span>{{ selectedEvaluation.violation_reasons?.length ? `违规：${reasonList(selectedEvaluation.violation_reasons)}` : '' }}{{ selectedEvaluation.unknown_reasons?.length ? `　未知：${reasonList(selectedEvaluation.unknown_reasons)}` : '' }}{{ !selectedEvaluation.violation_reasons?.length && !selectedEvaluation.unknown_reasons?.length ? '仅展示已保存字段，不在前端生成结论' : '' }}</span></div>
                  <div class="lg-target-facts">
                    <dl>
                      <dt>关联目标</dt><dd :title="selectedEvaluation.target_id">{{ selectedEvaluation.target_no || (selectedEvaluation.target_id ? '已关联目标' : '不可见或无关联') }}</dd>
                      <dt>关联轨迹</dt><dd :title="selectedEvaluation.track_id">{{ selectedEvaluation.track_id ? '已关联轨迹' : '不可见或无关联' }}</dd>
                      <dt>计划匹配</dt><dd :title="selectedEvaluation.plan_id">{{ planMatchText(selectedEvaluation.plan_match_code) }}{{ selectedEvaluation.plan_no ? ` · ${selectedEvaluation.plan_no}` : '' }}</dd>
                      <dt>航线版本</dt><dd :title="selectedEvaluation.route_version_id">{{ selectedEvaluation.route_version_id ? '已关联航线版本' : '不可见或无关联' }}</dd>
                    </dl>
                  </div>
                  <div class="lg-review-state">
                    <span class="tag" :class="selectedEvaluation.review?.state === 'PENDING_REVIEW' ? 't-amber' : 't-gray'">{{ reviewStateText(selectedEvaluation.review?.state) }}{{ selectedEvaluation.review?.version > 0 ? ` · 第${selectedEvaluation.review.version}次复核` : '' }}</span>
                    <dl>
                      <dt>研判时间</dt><dd>{{ formatTime(selectedEvaluation.evaluated_at) }}</dd>
                      <dt>规则版本</dt><dd :title="selectedEvaluation.rule_set_code">{{ ruleVersionText(selectedEvaluation) }}{{ demoParams ? '（演示参数）' : '' }}</dd>
                      <dt>人工结论</dt><dd>{{ selectedEvaluation.review?.manual_status ? legalStatusText(selectedEvaluation.review.manual_status) : '—' }}</dd>
                      <dt>告警结果</dt><dd>{{ outcomeText(selectedEvaluation) }}</dd>
                    </dl>
                  </div>
                </section>

                <section class="lg-basis-card">
                  <header>判定依据表 <span>点击行查看命中事实与参数</span></header>
                  <div class="lg-basis-columns"><span>序号</span><span>规则 / 检查项</span><span>判定结果</span><span>参数状态</span><span>原因码</span></div>
                  <div v-if="!selectedEvaluation.hit_details?.length" class="empty">未提供单项检查</div>
                  <button v-for="(hit, index) in selectedEvaluation.hit_details || []"
                    :key="`${hit.rule_code}-${index}`" type="button" class="lg-basis-row" :class="{ 'is-selected': selectedHitIndex === index }"
                    :title="hit.message || ''" @click="toggleHit(index)">
                    <span>{{ index + 1 }}</span>
                    <span><b class="mono">{{ hit.rule_code || '未知规则' }}</b><small>{{ ruleName(hit.rule_code) }}</small></span>
                    <span :class="resultClass(hit.result_code)">{{ resultText(hit.result_code) }}</span>
                    <span>{{ hit.params?.some(p => p.status === 'DEMO') ? 'DEMO 演示值' : (hit.params?.length ? '已确认' : '—') }}</span>
                    <span>{{ hit.reason_code ? ruleReasonText(hit.reason_code) : (hit.facts?.match_reason ? ruleReasonText(hit.facts.match_reason) : '—') }}</span>
                  </button>
                  <div v-if="selectedHit" class="lg-rule-focus" :class="resultClass(selectedHit.result_code)">
                    <b>{{ selectedHit.rule_code }} {{ ruleName(selectedHit.rule_code) }}</b>
                    <span>{{ selectedHit.message || '未提供解释' }}</span>
                    <span v-if="selectedHit.params?.length" class="lg-muted">参数：{{ selectedHit.params.map(p => `${p.key}=${p.value}${p.status === 'DEMO' ? '(DEMO)' : ''}`).join('，') }}</span>
                    <span v-if="selectedHit.facts && Object.keys(selectedHit.facts).length" class="lg-muted">事实：{{ factText(selectedHit.facts) }}</span>
                  </div>
                </section>

                <section class="lg-evidence-card">
                  <header>证据与相关资源 <span>只读取研判字段及其精确输入版本</span></header>
                  <div class="lg-evidence-tabs" role="tablist" aria-label="研判证据">
                    <button v-for="tab in evidenceTabs" :key="tab.value" type="button" class="lg-evidence-tab"
                      :class="{ 'is-active': st.evidenceTab === tab.value }" role="tab"
                      :aria-selected="st.evidenceTab === tab.value" @click="st.evidenceTab = tab.value">{{ tab.label }}</button>
                  </div>
                  <div class="lg-evidence-body">
                    <template v-if="st.evidenceTab === 'space'">
                      <div class="lg-evidence-copy">
                        <h4>证据引用 <span>研判时读取的精确输入</span></h4>
                        <dl v-if="selectedEvaluation.evidence_references?.length">
                          <template v-for="(reference, index) in selectedEvaluation.evidence_references" :key="`${reference.kind}-${reference.id}-${index}`">
                            <dt>{{ referenceKindText(reference.kind) }}</dt><dd :title="reference.id">{{ referenceText(reference) }}</dd>
                          </template>
                        </dl>
                        <p v-else>未提供证据引用</p>
                        <p class="lg-evidence-alert">研判读取接口不提供空域边界、航线或轨迹几何，地图不可绘制；不会连接旧空域、旧轨迹或推测坐标。</p>
                      </div>
                      <div class="lg-map-wrap" aria-label="空间证据地图不可绘制">
                        <div id="lgMap"><div class="lg-map-empty">可信输入几何尚未接入<br>地图不可绘制</div></div>
                        <div class="lg-map-legend"><span class="is-zone">空域边界</span>
                          <span class="is-plan">计划航线</span><span class="is-track">目标轨迹</span></div>
                      </div>
                    </template>
                    <div v-else-if="st.evidenceTab === 'plan'" class="lg-evidence-wide">
                      <h4>计划匹配（C01）与身份 <span>已保存事实</span></h4>
                      <dl class="lg-resource-grid">
                        <dt>匹配等级</dt><dd>{{ planMatchText(selectedEvaluation.plan_match_code) }}{{ c01Facts?.match_reason ? `（${ruleReasonText(c01Facts.match_reason)}）` : '' }}</dd>
                        <dt>计划编号</dt><dd class="mono" :title="selectedEvaluation.plan_id">{{ selectedEvaluation.plan_no || (selectedEvaluation.plan_id ? '已关联计划' : '无匹配计划或不可见') }}</dd>
                        <dt>关联目标</dt><dd class="mono" :title="selectedEvaluation.target_id">{{ selectedEvaluation.target_no || (selectedEvaluation.target_id ? '已关联' : '不可见') }}</dd>
                        <dt>时间窗</dt><dd>{{ c01Facts?.dimensions?.time_window || '未评估' }}</dd>
                        <dt>走廊</dt><dd>{{ c01Facts?.dimensions?.corridor || '未评估' }}</dd>
                        <dt>身份</dt><dd>{{ c01Facts?.dimensions?.identity === 'UNDETERMINED' ? '线索缺失（TDOA/5G-A 未接入）' : (c01Facts?.dimensions?.identity || '未评估') }}</dd>
                        <dt>起降点</dt><dd>尚未接入</dd>
                        <dt>飞手 / 单位</dt><dd>尚未接入</dd>
                        <dt>候选计划数</dt><dd>{{ c01Facts?.candidate_count ?? '未知' }}</dd>
                      </dl>
                    </div>
                    <div v-else class="lg-evidence-wide">
                      <h4>复核历史 <span>只增记录</span></h4>
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
                      <h4>告警与规则版本</h4>
                      <dl class="lg-resource-grid">
                        <dt>告警结果</dt><dd>{{ outcomeText(selectedEvaluation) }}</dd>
                        <dt>关联告警</dt><dd>
                          <template v-if="selectedEvaluation.alarm_id"><a class="lg-link-btn" :href="alarmHref" :title="selectedEvaluation.alarm_id" @click.prevent="openAlarm">打开告警页核实</a>{{ selectedEvaluation.event_id ? '（已建待核实事件）' : '' }}</template>
                        <template v-else>无告警关联或无告警读取权限</template></dd>
                        <dt>来源模式</dt><dd>{{ sourceText(selectedEvaluation.source_mode) }}</dd>
                        <dt>规则集版本</dt><dd>{{ ruleVersionText(selectedEvaluation) }} · 参数 {{ demoParams ? 'DEMO 演示值，尚未业务确认' : '已确认' }}</dd>
                        <dt>运行触发</dt><dd>{{ selectedEvaluation.trigger_kind || '—' }} · {{ selectedEvaluation.mode || '—' }}</dd>
                        <dt>计划投影</dt><dd :title="selectedEvaluation.assessment_id">{{ selectedEvaluation.assessment_id ? '已投影到计划研判' : '未投影（无匹配计划或影子运行）' }}</dd>
                      </dl>
                    </div>
                  </div>
                </section>
              </div>

              <footer class="lg-action-dock">
                <!-- 动作以服务端 allowed_actions 为准：权限、状态、告警关联任一不满足即禁用；转入处置尚未接入。 -->
                <div class="detail-actions">
                  <button class="btn pri" type="button" :disabled="!allowed.includes('REVIEW')"
                    :title="allowed.includes('REVIEW') ? '记录人工复核结论' : '当前不可复核：已复核、已被取代或缺少复核权限'" @click="onReview">人工复核</button>
                  <button class="btn" type="button" :disabled="!allowed.includes('RECOMPUTE')"
                    :title="allowed.includes('RECOMPUTE') ? '按当前生效规则集重新研判' : '当前不可重算：已被取代或缺少评估权限'" @click="onRecompute">重新研判</button>
                  <button class="btn warn" type="button" :disabled="!allowed.includes('ESCALATE')"
                    :title="allowed.includes('ESCALATE') ? '人工生成来源告警与待核实事件' : '当前不可转告警：结论为合法、已关联告警或缺少权限'" @click="onEscalate">转告警</button>
                  <button class="btn warn" type="button" disabled title="尚未接入">转入处置（尚未接入）</button>
                </div>
              </footer>
            </template>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style>
.legality-workbench{--lg-blue:#4b9cff;--lg-red:#ff5b61;--lg-green:#41d49a;--lg-amber:#f1a43a;overflow:hidden!important;padding:10px 12px 12px!important}
.legality-workbench *{box-sizing:border-box}
.legality-workbench button{font:inherit}
.legality-workbench button:focus-visible,.legality-workbench select:focus-visible{outline:2px solid var(--lg-blue);outline-offset:2px}
.legality-workbench .lg-shell{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px}
.legality-workbench .lg-kpi-host{flex:none}.legality-workbench .lg-kpi-host>.kpis{grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.legality-workbench .lg-kpi-host .kpi{min-width:0}
.legality-workbench .lg-workspace{min-height:0;flex:1;display:grid;grid-template-columns:minmax(430px,32%) minmax(0,1fr);gap:10px}
.legality-workbench .lg-queue-panel,.legality-workbench .lg-review-panel{min-width:0;min-height:0;display:flex;flex-direction:column;border:1px solid rgba(130,174,218,.17);border-radius:8px;background:#091827;overflow:hidden;box-shadow:0 10px 24px rgba(0,0,0,.14)}
.legality-workbench .lg-panel-head,.legality-workbench .lg-review-head{height:46px;min-height:46px;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid rgba(130,174,218,.12);background:#0b1b2d}
.legality-workbench .lg-panel-head h2{margin:0;color:#dfe9f5;font-size:14px;font-weight:650}.legality-workbench .lg-panel-head h2 span{color:var(--lg-amber)}
.legality-workbench .lg-head-spacer{flex:1}
.legality-workbench .lg-region-filter{display:flex;align-items:center;gap:6px;color:#7f93aa;font-size:11px}.legality-workbench .lg-region-filter .n-select{width:112px}
.legality-workbench .lg-icon-btn{width:32px;height:30px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(130,174,218,.16);border-radius:5px;background:#0b1b2d;color:#91a6bd;cursor:pointer}.legality-workbench .lg-icon-btn:hover{color:#dce9f8;border-color:rgba(75,156,255,.5)}
.legality-workbench .lg-icon-btn .svg-icon{width:15px;height:15px;fill:none;stroke:currentColor}.legality-workbench .lg-review-head .lg-icon-btn .svg-icon{transform:rotate(180deg)}.legality-workbench .lg-review-head .lg-icon-btn.is-next .svg-icon{transform:none}
.legality-workbench .lg-queue-tabs{height:42px;min-height:42px;display:flex;align-items:center;gap:7px;padding:6px 10px;border-bottom:1px solid rgba(130,174,218,.09)}
.legality-workbench .lg-queue-tabs button{height:28px;padding:0 12px;border:1px solid transparent;border-radius:5px;background:transparent;color:#8498af;font-size:11.5px;cursor:pointer}.legality-workbench .lg-queue-tabs button:hover{color:#dfeaf7}.legality-workbench .lg-queue-tabs button.is-active{border-color:rgba(255,91,97,.25);background:rgba(255,91,97,.1);color:#ff7a80}
.legality-workbench .lg-list-host{min-height:0;flex:1;display:flex;flex-direction:column}
.legality-workbench .lg-queue-columns,.legality-workbench .lg-queue-row{display:grid;grid-template-columns:minmax(112px,1.3fr) minmax(72px,.75fr) minmax(70px,.72fr) minmax(58px,.62fr) minmax(100px,1.1fr);align-items:center;column-gap:7px}
.legality-workbench .lg-queue-columns{height:34px;min-height:34px;padding:0 12px;color:#8195ad;font-size:11px;border-bottom:1px solid rgba(130,174,218,.1);background:#0a1a2c}
.legality-workbench .lg-queue-scroll{min-height:0;flex:1;overflow:auto;scrollbar-width:thin}
.legality-workbench .lg-queue-group{border-bottom:1px solid rgba(130,174,218,.09)}
.legality-workbench .lg-group-head{width:100%;height:32px;padding:0 11px;display:flex;align-items:center;gap:7px;border:0;border-bottom:1px solid rgba(130,174,218,.07);background:#0b1d30;color:#93a7bd;text-align:left;cursor:pointer}.legality-workbench .lg-group-head b{font-size:11.5px}.legality-workbench .lg-group-head>span:last-child{margin-left:auto;color:#61758d;font-size:10px}
.legality-workbench .lg-group-caret{width:13px;height:13px;display:flex;align-items:center;justify-content:center}.legality-workbench .lg-group-caret .svg-icon{width:10px;height:10px;fill:none;stroke:currentColor;transform:rotate(90deg)}
.legality-workbench .lg-queue-group.is-red .lg-group-head b{color:#ff686f}.legality-workbench .lg-queue-group.is-amber .lg-group-head b{color:#e6a130}.legality-workbench .lg-queue-group.is-green .lg-group-head b{color:#37c488}
.legality-workbench .lg-queue-row{width:100%;min-height:49px;padding:5px 12px;border:0;border-bottom:1px solid rgba(130,174,218,.065);background:#091827;color:#b7c5d5;text-align:left;cursor:pointer}.legality-workbench .lg-queue-row:hover{background:#0d2238}.legality-workbench .lg-queue-row.is-selected{background:#0f2b4c;box-shadow:inset 2px 0 var(--lg-blue),inset 0 0 0 1px rgba(75,156,255,.5)}
.legality-workbench .lg-queue-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.legality-workbench .lg-row-target{display:flex;flex-direction:column}.legality-workbench .lg-row-target b{color:#d8e5f3;font-size:11px}.legality-workbench .lg-row-target small{color:#70859d;font-size:10px}.legality-workbench .lg-row-note{display:block;margin-top:2px;color:#c5a7ff;font-size:9px}.legality-workbench .lg-row-note.is-amber{color:#e7ad55}.legality-workbench .lg-row-region,.legality-workbench .lg-row-reason{font-size:10.5px}
.legality-workbench .lg-pager{min-height:50px;padding:5px 8px;border-top:1px solid rgba(130,174,218,.1);background:#091725}
.legality-workbench .lg-hidden-status{display:none}.legality-workbench .lg-detail-host{height:100%;min-height:0;display:flex;flex-direction:column}.legality-workbench .lg-review-head{color:#879bb2;font-size:12px}.legality-workbench .lg-review-head b{color:#c8d7e8}.legality-workbench .lg-review-head>.tag{margin-left:4px}
.legality-workbench .lg-detail-scroll{min-height:0;flex:1;overflow:auto;padding:9px;scrollbar-width:thin}
.legality-workbench .lg-verdict-card{min-height:116px;display:grid;grid-template-columns:1.05fr 1.55fr 1.05fr .92fr;border:1px solid rgba(130,174,218,.13);border-radius:7px;background:#0b1b2d;overflow:hidden}.legality-workbench .lg-verdict-card>div{min-width:0;padding:12px;border-right:1px solid rgba(130,174,218,.1)}.legality-workbench .lg-verdict-card>div:last-child{border-right:0}
.legality-workbench .lg-verdict-block{display:flex;align-items:center;gap:10px}.legality-workbench .lg-verdict-icon{width:38px;height:38px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(255,91,97,.11);color:var(--lg-red)}.legality-workbench .lg-verdict-icon .svg-icon{width:20px;height:20px;fill:none;stroke:currentColor}.legality-workbench .lg-verdict-block>div{min-width:0;display:flex;flex-direction:column}.legality-workbench .lg-verdict-card small{color:#7f92a8;font-size:10px}.legality-workbench .lg-verdict-block strong{margin:2px 0;color:var(--lg-red);font-size:24px;font-weight:600}.legality-workbench .lg-verdict-card.is-green .lg-verdict-block strong,.legality-workbench .lg-verdict-card.is-green .lg-verdict-icon{color:var(--lg-green)}.legality-workbench .lg-verdict-card.is-amber .lg-verdict-block strong,.legality-workbench .lg-verdict-card.is-amber .lg-verdict-icon{color:var(--lg-amber)}.legality-workbench .lg-verdict-block span,.legality-workbench .lg-core-reason span{color:#788ca3;font-size:10px}
.legality-workbench .lg-core-reason{display:flex;flex-direction:column;justify-content:center}.legality-workbench .lg-core-reason b{margin:7px 0;color:#e3edf8;font-size:14px;white-space:normal}.legality-workbench .lg-target-facts dl,.legality-workbench .lg-review-state dl{margin:0;display:grid;grid-template-columns:64px minmax(0,1fr);gap:5px 7px;font-size:10px}.legality-workbench .lg-target-facts dt,.legality-workbench .lg-review-state dt{color:#6f839b}.legality-workbench .lg-target-facts dd,.legality-workbench .lg-review-state dd{margin:0;color:#b9c7d6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.legality-workbench .lg-review-state{display:flex;flex-direction:column;gap:7px}.legality-workbench .lg-review-state>.tag{align-self:flex-start}
.legality-workbench .lg-basis-card,.legality-workbench .lg-evidence-card{margin-top:9px;border:1px solid rgba(130,174,218,.12);border-radius:7px;background:#091827;overflow:hidden}.legality-workbench .lg-basis-card>header,.legality-workbench .lg-evidence-card>header{height:34px;display:flex;align-items:center;gap:5px;padding:0 11px;color:#d5e1ee;font-size:12px;border-bottom:1px solid rgba(130,174,218,.09)}.legality-workbench .lg-basis-card>header span,.legality-workbench .lg-evidence-card>header span{color:#667b93;font-size:10px}
.legality-workbench .lg-basis-columns,.legality-workbench .lg-basis-row{display:grid;grid-template-columns:45px minmax(140px,1fr) minmax(102px,.72fr) minmax(92px,.66fr) minmax(220px,2.35fr);align-items:center;column-gap:8px}.legality-workbench .lg-basis-columns{height:28px;padding:0 10px;background:#0b1c2f;color:#6f849b;font-size:10px}.legality-workbench .lg-basis-row{width:100%;height:26px;min-height:26px;padding:2px 10px;border:0;border-top:1px solid rgba(130,174,218,.055);background:transparent;color:#aebdcd;text-align:left;font-size:10.5px;cursor:pointer}.legality-workbench .lg-basis-row:hover{background:#0d2238}.legality-workbench .lg-basis-row.is-selected{background:#10305a;box-shadow:inset 0 0 0 1px #2f82ef}.legality-workbench .lg-basis-row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.legality-workbench .lg-basis-row>span:nth-child(2){display:flex;align-items:baseline;gap:6px}.legality-workbench .lg-basis-row small{color:#61768e}.legality-workbench .lg-basis-row .is-pass{color:#38c98a}.legality-workbench .lg-basis-row .is-warn{color:#e4a22e}.legality-workbench .lg-basis-row .is-fail{color:#ff656c}.legality-workbench .lg-basis-row .svg-icon{width:12px;height:12px;vertical-align:-2px}
.legality-workbench .lg-evidence-tabs{height:36px;display:flex;align-items:end;gap:3px;padding:4px 8px 0;border-bottom:1px solid rgba(130,174,218,.09);background:#0a1a2c}.legality-workbench .lg-evidence-tab{height:31px;padding:0 12px;display:flex;align-items:center;gap:5px;border:1px solid rgba(130,174,218,.08);border-bottom:0;border-radius:5px 5px 0 0;background:#0b1b2d;color:#7c91a9;font-size:10.5px;cursor:pointer}.legality-workbench .lg-evidence-tab.is-active{background:#103666;color:#dbeaff;border-color:rgba(75,156,255,.35)}.legality-workbench .lg-evidence-tab .svg-icon{width:12px;height:12px;fill:none;stroke:currentColor}
.legality-workbench .lg-evidence-body{height:175px;min-height:175px;display:grid;grid-template-columns:minmax(260px,35%) minmax(0,1fr);gap:9px;padding:8px}.legality-workbench .lg-evidence-copy,.legality-workbench .lg-evidence-wide{min-width:0;overflow:auto;padding:7px 10px;border:1px solid rgba(130,174,218,.08);border-radius:6px;background:#0a1a2b}.legality-workbench .lg-evidence-wide{grid-column:1/-1}.legality-workbench .lg-evidence-copy h4,.legality-workbench .lg-evidence-wide h4{margin:0 0 5px;color:#cbd9e7;font-size:11.5px}.legality-workbench .lg-evidence-copy h4 span,.legality-workbench .lg-evidence-wide h4 span{color:#657a92;font-size:10px}.legality-workbench .lg-evidence-copy p,.legality-workbench .lg-evidence-wide p{margin:4px 0;color:#8fa1b5;font-size:10px;line-height:1.45}.legality-workbench .lg-evidence-copy dl{margin:5px 0;display:grid;grid-template-columns:67px 1fr;gap:3px;font-size:9.5px}.legality-workbench .lg-evidence-copy dt{color:#657b93}.legality-workbench .lg-evidence-copy dd{margin:0;color:#b5c4d4}.legality-workbench .lg-evidence-alert{padding-left:7px;border-left:2px solid var(--lg-red);color:#d59b9f!important}.legality-workbench .lg-link-btn{padding:0;border:0;background:transparent;color:var(--lg-blue);font-size:10px;cursor:pointer}.legality-workbench .lg-rule-focus{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:4px;background:#0d2238}.legality-workbench .lg-rule-focus.is-pass{color:var(--lg-green)}.legality-workbench .lg-rule-focus.is-warn{color:var(--lg-amber)}.legality-workbench .lg-rule-focus.is-fail{color:var(--lg-red)}.legality-workbench .lg-muted{color:#6e839a!important}
.legality-workbench .lg-map-wrap{position:relative;min-width:0;min-height:159px;border:1px solid rgba(130,174,218,.12);border-radius:6px;overflow:hidden;background:#dbe7ef}.legality-workbench #lgMap{position:absolute;inset:0}.legality-workbench .lg-map-legend{position:absolute;left:50%;bottom:5px;transform:translateX(-50%);display:flex;gap:13px;padding:3px 9px;border-radius:4px;background:rgba(5,15,27,.88);color:#c4d2e0;font-size:9px;white-space:nowrap}.legality-workbench .lg-map-legend span:before{content:"";display:inline-block;width:14px;height:3px;margin-right:4px;vertical-align:2px;background:currentColor}.legality-workbench .lg-map-legend .is-zone{color:#d84d52}.legality-workbench .lg-map-legend .is-plan{color:#4b9cff}.legality-workbench .lg-map-legend .is-track{color:#ff5b61}
.legality-workbench .lg-action-dock{min-height:52px;padding:6px 9px;border-top:1px solid rgba(130,174,218,.12);background:#081522}.legality-workbench .lg-action-dock .detail-actions{margin:0;padding:0;background:transparent;border:0}.legality-workbench .lg-action-dock .btn{height:38px!important;font-size:14px}.legality-workbench .detail-sect{margin-inline:0}
.legality-workbench .lg-icon-btn{width:auto;min-width:32px;padding:0 7px;font-size:10px}.legality-workbench .lg-icon-btn:disabled{cursor:not-allowed;opacity:.45}
.legality-workbench .lg-group-head{cursor:default}.legality-workbench .lg-inline-error{padding:8px 11px;border-bottom:1px solid rgba(255,91,97,.2);background:rgba(255,91,97,.08);color:#ff9da2;font-size:10.5px;line-height:1.5}
.legality-workbench .lg-state-error{color:#ff9da2}.legality-workbench .lg-state-warn{color:#e6b867}
.legality-workbench .lg-history-strip{flex:none;display:flex;align-items:center;gap:6px;min-height:48px;padding:5px 8px;border-bottom:1px solid rgba(130,174,218,.1);overflow-x:auto;background:#091725}
.legality-workbench .lg-history-strip>button{flex:none;max-width:220px;height:30px;padding:0 9px;border:1px solid rgba(130,174,218,.15);border-radius:5px;background:#0b1b2d;color:#8498af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;cursor:pointer}.legality-workbench .lg-history-strip>button.is-active{border-color:rgba(75,156,255,.55);background:#10305a;color:#dceaff}
.legality-workbench .lg-history-strip>.pager{margin-left:auto;flex:none;min-height:34px;padding:0;background:transparent;border:0}
.legality-workbench .lg-map-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#53677c;background:linear-gradient(135deg,#dbe7ef,#cbdbe6);font-size:12px;line-height:1.7}
.legality-workbench .lg-resource-grid{margin:6px 0 10px;display:grid;grid-template-columns:110px minmax(0,1fr);gap:6px 10px;font-size:10.5px}.legality-workbench .lg-resource-grid dt{color:#657b93}.legality-workbench .lg-resource-grid dd{margin:0;color:#b5c4d4;overflow-wrap:anywhere}
.legality-workbench .lg-reference-list{margin:5px 0;padding-left:18px;color:#b5c4d4;font-size:10.5px}.legality-workbench .lg-reference-list li{margin:3px 0;overflow-wrap:anywhere}
.legality-workbench .detail-actions{display:flex;gap:8px}.legality-workbench .detail-actions .btn:disabled{cursor:not-allowed;opacity:.48}
@media (max-width:1320px){.legality-workbench .lg-workspace{grid-template-columns:minmax(410px,38%) minmax(0,1fr)}.legality-workbench .lg-verdict-card{grid-template-columns:1fr 1.4fr 1fr}.legality-workbench .lg-review-state{grid-column:1/-1;border-top:1px solid rgba(130,174,218,.1)!important}.legality-workbench .lg-verdict-card{min-height:154px}.legality-workbench .lg-review-state{flex-direction:row;align-items:center}.legality-workbench .lg-review-state dl{flex:1;grid-template-columns:60px 1fr 60px 1fr}}
@media (max-width:1040px){.legality-workbench{overflow:auto!important}.legality-workbench .lg-shell{height:auto;min-height:100%}.legality-workbench .lg-kpi-host>.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.legality-workbench .lg-workspace{grid-template-columns:1fr}.legality-workbench .lg-queue-panel{min-height:620px}.legality-workbench .lg-review-panel{min-height:720px}.legality-workbench .lg-evidence-body{grid-template-columns:1fr}.legality-workbench .lg-map-wrap{min-height:260px}}
@media (prefers-reduced-motion:reduce){.legality-workbench *{scroll-behavior:auto!important;transition:none!important}}
.legality-workbench .lg-shadow-hint{border-bottom-color:rgba(241,164,58,.25);background:rgba(241,164,58,.08);color:#e7b86a}
.legality-workbench .lg-basis-card .lg-rule-focus{display:flex;flex-direction:column;gap:3px;margin:6px 10px;padding:6px 9px;font-size:10.5px;line-height:1.45}.legality-workbench .lg-basis-card .lg-rule-focus b{color:#dbe7f5}.legality-workbench .lg-basis-card .lg-rule-focus>span{color:#aebdcd;white-space:normal}
.legality-workbench .lg-review-head .tag{margin-left:4px;font-size:10px;line-height:1.5}.legality-workbench .lg-revision-list li{line-height:1.5}
</style>
