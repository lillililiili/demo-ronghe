<script>
/* 模块级页面状态：跨导航保留分页、筛选、选中项与证据页签；业务事实始终重新读取标准 API。 */
const S = {
  st: {
    page: 1, size: 10, legal: 'ILLEGAL', district: '',
    selectedPlanId: null, historyPage: 1, historyPageSize: 10,
    selectedAssessmentId: null, evidenceTab: 'space'
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
import { flightApi, listAllFlightPlans } from '@/services/flightApi.js';
import { legalityApi } from '@/services/legalityApi.js';

usePageChrome('legality');
const UI = window.UI;
const root = ref(null);
const st = reactive(S.st);
const plans = ref([]);
const totalCount = ref(0);
const latestByPlan = ref(new Map());
const summaryFailures = ref(new Map());
const selectedPlan = ref(null);
const historyItems = ref([]);
const historyTotal = ref(0);
const selectedAssessment = ref(null);
const loading = ref(false);
const summaryLoading = ref(false);
const historyLoading = ref(false);
const detailLoading = ref(false);
const planError = ref('');
const summaryError = ref('');
const historyError = ref('');
const detailError = ref('');
const deepLinkNotice = ref('');
let planToken = 0;
let summaryToken = 0;
let historyToken = 0;
let detailToken = 0;

const conclusionMeta = {
  LEGAL: { label: '合法', tone: 'green' },
  ILLEGAL: { label: '非法', tone: 'red' },
  UNDETERMINED: { label: '不可判定', tone: 'amber' },
  NOT_APPLICABLE: { label: '不适用', tone: 'amber' }
};
const resultMeta = {
  PASS: { label: '通过', className: 'is-pass' },
  FAIL: { label: '未通过', className: 'is-fail' },
  UNDETERMINED: { label: '不可判定', className: 'is-warn' },
  NOT_APPLICABLE: { label: '不适用', className: 'is-warn' }
};
const tabs = [
  { value: 'ILLEGAL', label: '系统判定非法' },
  { value: 'UNDETERMINED', label: '系统待确认' },
  { value: 'LEGAL', label: '系统自动通过' }
];
const evidenceTabs = [
  { value: 'space', label: '空间证据' },
  { value: 'plan', label: '计划与身份' },
  { value: 'source', label: '相关资源与来源' }
];
const kpiList = [
  { label: '今日判定目标', value: '—', color: 'blue', icon: 'check', desc: '尚未接入后端聚合口径' },
  { label: '合法', value: '—', color: 'green', icon: 'check', desc: '尚未接入后端聚合口径' },
  { label: '非法', value: '—', color: 'red', icon: 'alert', desc: '尚未接入后端聚合口径' },
  { label: '待确认', value: '—', color: 'amber', icon: 'alert', desc: '尚未接入后端聚合口径' }
];

const districtOptions = computed(() => {
  const values = new Set(plans.value.map(plan => plan.district_id).filter(Boolean));
  if (st.district) values.add(st.district);
  return [{ label: '全部区域', value: '' }, ...[...values].sort().map(value => ({ label: value, value }))];
});
const selectedConclusion = computed(() => conclusionMeta[selectedAssessment.value?.conclusion_code]
  || { label: '尚未选择研判', tone: 'amber' });
const visiblePlans = computed(() => plans.value.filter(plan => matchesTab(plan)));
const selectedQueueIndex = computed(() => visiblePlans.value.findIndex(plan => plan.plan_id === selectedPlan.value?.plan_id));
const primaryReason = computed(() => assessmentReason(selectedAssessment.value));

function matchesTab(plan) {
  if (summaryFailures.value.has(plan.plan_id)) return true;
  const assessment = latestByPlan.value.get(plan.plan_id);
  if (!assessment) return st.legal === 'UNDETERMINED';
  if (st.legal === 'UNDETERMINED') return ['UNDETERMINED', 'NOT_APPLICABLE'].includes(assessment.conclusion_code);
  return assessment.conclusion_code === st.legal;
}

function groupedPlans(code) {
  return plans.value.filter(plan => {
    if (code === 'FAILED') return summaryFailures.value.has(plan.plan_id);
    if (summaryFailures.value.has(plan.plan_id)) return false;
    const assessment = latestByPlan.value.get(plan.plan_id);
    if (code === 'NONE') return !assessment;
    if (code === 'UNDETERMINED') return assessment && ['UNDETERMINED', 'NOT_APPLICABLE'].includes(assessment.conclusion_code);
    return assessment?.conclusion_code === code;
  });
}

function conclusionText(code) {
  return conclusionMeta[code]?.label || code || '尚无已保存研判';
}

function resultText(code) {
  return resultMeta[code]?.label || code || '服务端未提供';
}

function resultClass(code) {
  return resultMeta[code]?.className || 'is-warn';
}

function sourceText(mode) {
  if (mode === 'mock') return '演示规则/模拟来源';
  return mode || '服务端未提供';
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

function assessmentReason(assessment) {
  if (!assessment) return '尚未取得已保存研判详情';
  if (assessment.unknown_reasons?.length) return assessment.unknown_reasons[0];
  const failed = assessment.checks?.find(check => check.result_code === 'FAIL' && check.reason_code);
  if (failed) return failed.reason_code;
  const explained = assessment.checks?.find(check => check.reason_code);
  return explained?.reason_code || '服务端未提供结论摘要';
}

function queueConclusion(plan) {
  return summaryFailures.value.has(plan.plan_id)
    ? '研判读取失败'
    : conclusionText(latestByPlan.value.get(plan.plan_id)?.conclusion_code);
}

function queueReason(plan) {
  return summaryFailures.value.get(plan.plan_id)
    || assessmentReason(latestByPlan.value.get(plan.plan_id));
}

function formatApiError(error, fallback) {
  const statusText = {
    401: '未登录或会话已失效（HTTP 401）',
    403: '无权读取该资源（HTTP 403）',
    404: '资源不存在或不在可见范围内（HTTP 404）',
    500: '后端服务内部错误（HTTP 500）'
  }[error?.status];
  const message = error?.message || fallback;
  return statusText ? `${statusText}：${message}` : message;
}

function invalidateDetailChain() {
  historyToken += 1;
  detailToken += 1;
  selectedPlan.value = null;
  historyItems.value = [];
  historyTotal.value = 0;
  selectedAssessment.value = null;
  historyError.value = '';
  detailError.value = '';
}

async function loadLatestAssessments(rows, ownerToken) {
  const token = ++summaryToken;
  summaryLoading.value = true;
  summaryError.value = '';
  latestByPlan.value = new Map();
  summaryFailures.value = new Map();
  const results = await Promise.all(rows.map(async plan => {
    try {
      const data = await legalityApi.history(plan.plan_id, { page: 1, size: 1 });
      const item = data.items?.[0] || null;
      if (item || Number(data.total || 0) === 0) return { planId: plan.plan_id, item };
      return { planId: plan.plan_id, error: new Error('研判摘要分页响应缺少数据项') };
    } catch (error) {
      return { planId: plan.plan_id, error };
    }
  }));
  if (token !== summaryToken || ownerToken !== planToken) return false;
  const next = new Map();
  const failed = new Map();
  results.forEach(result => { if (result.item) next.set(result.planId, result.item); });
  results.forEach(result => {
    if (result.error) failed.set(result.planId, formatApiError(result.error, '读取研判摘要失败'));
  });
  latestByPlan.value = next;
  summaryFailures.value = failed;
  const failures = results.filter(result => result.error);
  if (failures.length) {
    summaryError.value = `${failures.length} 个计划的研判摘要读取失败；未以旧数据或演示结论补齐。${formatApiError(failures[0].error, '读取研判摘要失败')}`;
  }
  summaryLoading.value = false;
  return true;
}

async function locateTargetInVisiblePlans(targetId, rows, ownerToken) {
  for (const plan of rows) {
    let nextPage = 1;
    let seen = 0;
    do {
      const data = await legalityApi.history(plan.plan_id, { page: nextPage, size: st.historyPageSize });
      if (ownerToken !== planToken) return null;
      const items = data.items || [];
      const hit = items.find(item => item.target_id === targetId);
      if (hit) return { plan, assessment: hit, assessmentId: hit.assessment_id, historyPage: data.page };
      seen += items.length;
      if (!items.length || seen >= (data.total || 0)) break;
      nextPage += 1;
    } while (true);
  }
  return null;
}

async function loadPlans(options = {}) {
  const token = ++planToken;
  summaryToken += 1;
  invalidateDetailChain();
  loading.value = true;
  planError.value = '';
  summaryError.value = '';
  deepLinkNotice.value = '';
  plans.value = [];
  totalCount.value = 0;
  latestByPlan.value = new Map();
  summaryFailures.value = new Map();
  try {
    const data = await flightApi.list({ page: st.page, size: st.size, district_id: st.district });
    if (token !== planToken) return;
    plans.value = data.items || [];
    totalCount.value = data.total || 0;
    st.page = data.page || st.page;
    const summariesReady = await loadLatestAssessments(plans.value, token);
    if (!summariesReady || token !== planToken) return;

    if (options.targetResolved) {
      const hit = options.targetResolved;
      const plan = plans.value.find(item => item.plan_id === hit.plan.plan_id);
      if (!plan) {
        deepLinkNotice.value = `目标 ${hit.assessment.target_id} 已定位到计划，但目标计划页响应中缺少该计划；未自动选择无关计划。`;
        return;
      }
      st.legal = ['UNDETERMINED', 'NOT_APPLICABLE'].includes(hit.assessment.conclusion_code)
        ? 'UNDETERMINED' : hit.assessment.conclusion_code;
      await selectPlan(plan, {
        page: hit.historyPage,
        assessmentId: hit.assessmentId,
        strictAssessment: true
      });
      return;
    }

    if (options.targetId) {
      let hit = null;
      let allPlans = [];
      try {
        // target 深链没有 plan_id，必须逐页扫描全部可见计划；普通队列仍只读取当前服务端分页。
        allPlans = await listAllFlightPlans({ district_id: st.district });
        if (token !== planToken) return;
        hit = await locateTargetInVisiblePlans(options.targetId, allPlans, token);
      } catch (error) {
        if (token === planToken) {
          deepLinkNotice.value = `目标 ${options.targetId} 的研判定位失败：${formatApiError(error, '读取研判历史失败')}`;
        }
        return;
      }
      if (token !== planToken) return;
      if (!hit) {
        deepLinkNotice.value = `目标 ${options.targetId} 无法由全部可见服务端计划映射；未自动选择无关计划。`;
        return;
      }
      const targetIndex = allPlans.findIndex(plan => plan.plan_id === hit.plan.plan_id);
      const targetPage = Math.floor(targetIndex / st.size) + 1;
      if (targetPage !== st.page) {
        st.page = targetPage;
        await loadPlans({ targetResolved: hit });
        return;
      }
      st.legal = ['UNDETERMINED', 'NOT_APPLICABLE'].includes(hit.assessment.conclusion_code)
        ? 'UNDETERMINED' : hit.assessment.conclusion_code;
      await selectPlan(hit.plan, {
        page: hit.historyPage,
        assessmentId: hit.assessmentId,
        strictAssessment: true
      });
      return;
    }

    const retained = visiblePlans.value.find(plan => plan.plan_id === S.st.selectedPlanId);
    const preferred = retained
      || visiblePlans.value.find(plan => !summaryFailures.value.has(plan.plan_id))
      || visiblePlans.value[0];
    if (preferred) {
      await selectPlan(preferred, {
        page: retained ? st.historyPage : 1,
        assessmentId: retained ? st.selectedAssessmentId : null
      });
    }
  } catch (error) {
    if (token !== planToken) return;
    // 计划真源失败时必须清掉计划→历史→详情旧链路；不回退任何 legacy 演示数据。
    invalidateDetailChain();
    plans.value = [];
    totalCount.value = 0;
    latestByPlan.value = new Map();
    summaryFailures.value = new Map();
    planError.value = formatApiError(error, '读取飞行计划失败');
  } finally {
    if (token === planToken) loading.value = false;
  }
}

async function selectPlan(plan, options = {}) {
  const token = ++historyToken;
  detailToken += 1;
  selectedPlan.value = plan;
  S.st.selectedPlanId = plan.plan_id;
  st.historyPage = options.page || 1;
  historyItems.value = [];
  historyTotal.value = 0;
  selectedAssessment.value = null;
  historyError.value = '';
  detailError.value = '';
  historyLoading.value = true;
  try {
    const data = await legalityApi.history(plan.plan_id, { page: st.historyPage, size: st.historyPageSize });
    if (token !== historyToken || selectedPlan.value?.plan_id !== plan.plan_id) return;
    historyItems.value = data.items || [];
    historyTotal.value = data.total || 0;
    st.historyPage = data.page || st.historyPage;
    const exact = historyItems.value.find(item => item.assessment_id === options.assessmentId);
    if (options.strictAssessment && options.assessmentId && !exact) {
      selectedAssessment.value = null;
      S.st.selectedAssessmentId = null;
      detailError.value = `指定研判已不在定位到的历史页中（${options.assessmentId}）；未自动打开其他研判。`;
      return;
    }
    const preferred = exact
      || historyItems.value.find(item => item.assessment_id === S.st.selectedAssessmentId)
      || historyItems.value[0];
    if (preferred) await loadAssessment(preferred);
    else S.st.selectedAssessmentId = null;
  } catch (error) {
    if (token !== historyToken) return;
    detailToken += 1;
    historyItems.value = [];
    historyTotal.value = 0;
    selectedAssessment.value = null;
    S.st.selectedAssessmentId = null;
    historyError.value = formatApiError(error, '读取已保存研判历史失败');
  } finally {
    if (token === historyToken) historyLoading.value = false;
  }
}

async function loadAssessment(summary) {
  const token = ++detailToken;
  selectedAssessment.value = null;
  detailError.value = '';
  detailLoading.value = true;
  try {
    const data = await legalityApi.detail(summary.assessment_id);
    if (token !== detailToken) return;
    selectedAssessment.value = data;
    S.st.selectedAssessmentId = data.assessment_id;
  } catch (error) {
    if (token !== detailToken) return;
    selectedAssessment.value = null;
    S.st.selectedAssessmentId = null;
    detailError.value = formatApiError(error, '读取研判详情失败');
  } finally {
    if (token === detailToken) detailLoading.value = false;
  }
}

function chooseTab(value) {
  st.legal = value;
  const first = visiblePlans.value[0];
  if (!selectedPlan.value || !visiblePlans.value.some(plan => plan.plan_id === selectedPlan.value.plan_id)) {
    if (first) selectPlan(first, { page: 1 });
    else invalidateDetailChain();
  }
}

function onRegionChange() {
  st.page = 1;
  loadPlans();
}

function onPage(next) {
  st.page = next;
  loadPlans();
}

function onPageSize(next) {
  st.size = next;
  st.page = 1;
  loadPlans();
}

function onHistoryPage(next) {
  if (!selectedPlan.value) return;
  st.historyPage = next;
  selectPlan(selectedPlan.value, { page: next });
}

function onHistoryPageSize(next) {
  if (!selectedPlan.value) return;
  st.historyPageSize = next;
  st.historyPage = 1;
  selectPlan(selectedPlan.value, { page: 1 });
}

function moveSelection(offset) {
  const next = visiblePlans.value[selectedQueueIndex.value + offset];
  if (next) selectPlan(next, { page: 1 });
}

watch(() => st.evidenceTab, value => { S.st.evidenceTab = value; });

onMounted(() => {
  const context = UI.consume('legality');
  const targetId = context?.target || null;
  if (targetId) {
    st.district = '';
    st.page = 1;
  }
  loadPlans({ targetId });
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
            <h2>待人工复核 <span id="lgQueueN">{{ visiblePlans.length }}</span></h2>
            <span class="lg-head-spacer"></span>
            <UField class="lg-region-filter" variant="toolbar" label="区域" v-model="st.district" type="select"
              :options="districtOptions" :disabled="loading" @update:model-value="onRegionChange" />
            <button class="lg-icon-btn" id="lgRule" type="button" disabled aria-label="查看判定规则（尚未接入）" title="规则目录尚未接入">规则</button>
            <button class="lg-icon-btn" type="button" :disabled="loading" aria-label="刷新服务端数据"
              title="刷新服务端只读数据" @click="loadPlans()">刷新</button>
            <button class="lg-icon-btn" id="lgRecalc" type="button" disabled aria-label="重新判定（尚未接入）"
              title="重新判定尚未接入">重算</button>
          </header>

          <div class="lg-queue-tabs" role="tablist" aria-label="判定状态筛选">
            <button v-for="tab in tabs" :key="tab.value" type="button" role="tab"
              :aria-selected="st.legal === tab.value" :class="{ 'is-active': st.legal === tab.value }"
              @click="chooseTab(tab.value)">{{ tab.label }}</button>
          </div>

          <div id="lgList" class="lg-list-host">
            <div class="lg-queue-columns" aria-hidden="true">
              <span>计划 / 时间</span><span>系统判定</span><span>风险等级</span><span>区域</span><span>主要原因</span>
            </div>
            <div class="lg-queue-scroll">
              <div v-if="planError" class="empty lg-state-error" role="alert">{{ planError }}</div>
              <div v-else-if="loading" class="empty">正在读取服务端飞行计划…</div>
              <div v-else-if="deepLinkNotice" class="empty lg-state-warn" role="status">{{ deepLinkNotice }}</div>
              <template v-else>
                <div v-if="summaryError" class="lg-inline-error" role="alert">{{ summaryError }}</div>
                <div v-if="summaryLoading" class="empty">正在读取已保存研判摘要…</div>
                <template v-else>
                  <section v-for="group in [
                    { code: 'ILLEGAL', label: '系统判定非法', tone: 'red' },
                    { code: 'UNDETERMINED', label: '系统待确认', tone: 'amber' },
                    { code: 'LEGAL', label: '系统自动通过', tone: 'green' },
                    { code: 'NONE', label: '尚无已保存研判', tone: 'amber' },
                    { code: 'FAILED', label: '研判读取失败', tone: 'red' }
                  ]" v-show="group.code === 'FAILED' ? groupedPlans('FAILED').length : (st.legal === group.code || (st.legal === 'UNDETERMINED' && ['UNDETERMINED', 'NONE'].includes(group.code)))"
                    :key="group.code" class="lg-queue-group" :class="`is-${group.tone}`">
                    <div class="lg-group-head">
                      <span class="lg-group-caret">›</span><b>{{ group.label }}（{{ groupedPlans(group.code).length }}）</b>
                      <span>当前服务端计划页</span>
                    </div>
                    <div class="lg-group-rows">
                      <button v-for="plan in groupedPlans(group.code)" :key="plan.plan_id" type="button"
                        class="lg-queue-row" :class="{ 'is-selected': selectedPlan?.plan_id === plan.plan_id }"
                        :aria-current="selectedPlan?.plan_id === plan.plan_id" @click="selectPlan(plan, { page: 1 })">
                        <span class="lg-row-target"><b class="mono">{{ plan.plan_no || plan.plan_id }}</b><small>{{ shortTime(plan.start_at) }}</small></span>
                        <span class="lg-row-verdict">{{ queueConclusion(plan) }}</span>
                        <span class="lg-row-risk">—</span>
                        <span class="lg-row-region">{{ plan.district_id || '未知' }}</span>
                        <span class="lg-row-reason" :title="queueReason(plan)">{{ queueReason(plan) }}</span>
                      </button>
                    </div>
                  </section>
                  <div v-if="!visiblePlans.length" class="empty">当前计划页在此判定分组下没有已保存研判</div>
                </template>
              </template>
            </div>
          </div>

          <footer class="lg-pager pager">
            <UPagination v-model:page="st.page" v-model:page-size="st.size" :item-count="totalCount"
              :prefix="`服务端计划共 ${totalCount.toLocaleString()} 条`"
              @update:page="onPage" @update:page-size="onPageSize" />
          </footer>
        </section>

        <section class="lg-review-panel" aria-label="合法性研判详情">
          <span id="lgSt" class="lg-hidden-status">{{ selectedConclusion.label }}</span>
          <div id="lgDetail" class="lg-detail-host">
            <header class="lg-review-head">
              <b>{{ selectedPlan?.plan_no || selectedPlan?.plan_id || '未选择计划' }}</b>
              <span>{{ selectedAssessment ? `研判 ${selectedAssessment.assessment_id}` : '已保存研判' }}</span>
              <span class="lg-head-spacer"></span>
              <button class="lg-icon-btn" type="button" :disabled="selectedQueueIndex <= 0"
                aria-label="上一条" @click="moveSelection(-1)">←</button>
              <button class="lg-icon-btn is-next" type="button"
                :disabled="selectedQueueIndex < 0 || selectedQueueIndex >= visiblePlans.length - 1"
                aria-label="下一条" @click="moveSelection(1)">→</button>
            </header>

            <div v-if="historyError" class="empty lg-state-error" role="alert">{{ historyError }}</div>
            <div v-else-if="historyLoading" class="empty">正在读取已保存研判历史…</div>
            <div v-else-if="!selectedPlan" class="empty">请选择计划；若从目标深链进入且无法映射，页面不会默认选择无关计划。</div>
            <div v-else-if="!historyItems.length" class="empty">尚无已保存研判；空结果不代表合法。</div>
            <template v-else>
              <div class="lg-history-strip" aria-label="已保存研判历史">
                <button v-for="item in historyItems" :key="item.assessment_id" type="button"
                  :class="{ 'is-active': selectedAssessment?.assessment_id === item.assessment_id }"
                  @click="loadAssessment(item)">{{ conclusionText(item.conclusion_code) }} · {{ formatTime(item.assessed_at) }}</button>
                <UPagination v-model:page="st.historyPage" v-model:page-size="st.historyPageSize"
                  :item-count="historyTotal" :prefix="`历史共 ${historyTotal.toLocaleString()} 条`"
                  @update:page="onHistoryPage" @update:page-size="onHistoryPageSize" />
              </div>

              <div v-if="detailError" class="empty lg-state-error" role="alert">{{ detailError }}</div>
              <div v-else-if="detailLoading" class="empty">正在读取研判详情…</div>
              <div v-else-if="!selectedAssessment" class="empty">请选择一条已保存研判</div>
              <template v-else>
                <div class="lg-detail-scroll">
                  <section class="lg-verdict-card" :class="`is-${selectedConclusion.tone}`">
                    <div class="lg-verdict-block">
                      <span class="lg-verdict-icon">✓</span>
                      <div><small>已保存结论</small><strong>{{ selectedConclusion.label }}</strong>
                        <span>{{ sourceText(selectedAssessment.source_mode) }}</span></div>
                    </div>
                    <div class="lg-core-reason"><small>核心依据 / 未知原因</small><b>{{ primaryReason }}</b>
                      <span>仅展示服务端保存字段，不在前端生成结论</span></div>
                    <div class="lg-target-facts">
                      <dl>
                        <dt>目标 ID</dt><dd>{{ selectedAssessment.target_id || '服务端未提供' }}</dd>
                        <dt>轨迹 ID</dt><dd>{{ selectedAssessment.track_id || '服务端未提供' }}</dd>
                        <dt>计划 ID</dt><dd>{{ selectedAssessment.plan_id }}</dd>
                        <dt>航线版本</dt><dd>{{ selectedAssessment.route_version_id || '服务端未提供' }}</dd>
                      </dl>
                    </div>
                    <div class="lg-review-state">
                      <span class="tag t-gray">只读结果</span>
                      <dl>
                        <dt>研判时间</dt><dd>{{ formatTime(selectedAssessment.assessed_at) }}</dd>
                        <dt>规则版本</dt><dd>{{ selectedAssessment.rule_version_code || selectedAssessment.rule_version_id || '服务端未提供' }}</dd>
                      </dl>
                    </div>
                  </section>

                  <section class="lg-basis-card">
                    <header>判定依据表 <span>服务端已保存单项检查</span></header>
                    <div class="lg-basis-columns"><span>序号</span><span>规则 / 检查项</span><span>判定结果</span><span>规则版本</span><span>服务端原因码</span></div>
                    <div v-if="!selectedAssessment.checks?.length" class="empty">服务端未提供单项检查</div>
                    <button v-for="(check, index) in selectedAssessment.checks || []"
                      :key="`${check.rule_code}-${index}`" type="button" class="lg-basis-row">
                      <span>{{ index + 1 }}</span>
                      <span><b class="mono">{{ check.rule_code || '未知规则' }}</b><small>已保存检查</small></span>
                      <span :class="resultClass(check.result_code)">{{ resultText(check.result_code) }}</span>
                      <span>{{ selectedAssessment.rule_version_code || '—' }}</span>
                      <span>{{ check.reason_code || '服务端未提供' }}</span>
                    </button>
                  </section>

                  <section class="lg-evidence-card">
                    <header>证据与相关资源 <span>只读取 assessment 字段及其精确输入版本</span></header>
                    <div class="lg-evidence-tabs" role="tablist" aria-label="研判证据">
                      <button v-for="tab in evidenceTabs" :key="tab.value" type="button" class="lg-evidence-tab"
                        :class="{ 'is-active': st.evidenceTab === tab.value }" role="tab"
                        :aria-selected="st.evidenceTab === tab.value" @click="st.evidenceTab = tab.value">{{ tab.label }}</button>
                    </div>
                    <div class="lg-evidence-body">
                      <template v-if="st.evidenceTab === 'space'">
                        <div class="lg-evidence-copy">
                          <h4>空间输入状态 <span>尚未接入</span></h4>
                          <p>当前研判读取接口未提供可信空域边界、计划航线或目标轨迹几何。</p>
                          <p class="lg-evidence-alert">因此地图不可绘制；不会连接旧空域、旧轨迹或推测坐标。</p>
                        </div>
                        <div class="lg-map-wrap" aria-label="空间证据地图不可绘制">
                          <div id="lgMap"><div class="lg-map-empty">可信输入几何尚未接入<br>地图不可绘制</div></div>
                          <div class="lg-map-legend"><span class="is-zone">空域边界</span>
                            <span class="is-plan">计划航线</span><span class="is-track">目标轨迹</span></div>
                        </div>
                      </template>
                      <div v-else-if="st.evidenceTab === 'plan'" class="lg-evidence-wide">
                        <h4>精确输入版本 <span>服务端事实</span></h4>
                        <dl class="lg-resource-grid">
                          <dt>计划 ID</dt><dd>{{ selectedAssessment.plan_id }}</dd>
                          <dt>研判 ID</dt><dd>{{ selectedAssessment.assessment_id }}</dd>
                          <dt>航线版本 ID</dt><dd>{{ selectedAssessment.route_version_id || '服务端未提供' }}</dd>
                          <dt>目标 ID</dt><dd>{{ selectedAssessment.target_id || '服务端未提供' }}</dd>
                          <dt>轨迹 ID</dt><dd>{{ selectedAssessment.track_id || '服务端未提供' }}</dd>
                        </dl>
                      </div>
                      <div v-else class="lg-evidence-wide">
                        <h4>来源、规则版本与引用 <span>服务端保存字段</span></h4>
                        <dl class="lg-resource-grid">
                          <dt>来源模式</dt><dd>{{ sourceText(selectedAssessment.source_mode) }}</dd>
                          <dt>规则版本代码</dt><dd>{{ selectedAssessment.rule_version_code || '服务端未提供' }}</dd>
                          <dt>规则版本 ID</dt><dd>{{ selectedAssessment.rule_version_id || '服务端未提供' }}</dd>
                          <dt>未知原因</dt><dd>{{ selectedAssessment.unknown_reasons?.join('、') || '服务端未提供' }}</dd>
                        </dl>
                        <h4>证据引用</h4>
                        <ul v-if="selectedAssessment.evidence_references?.length" class="lg-reference-list">
                          <li v-for="reference in selectedAssessment.evidence_references" :key="reference">{{ reference }}</li>
                        </ul>
                        <p v-else>服务端未提供证据引用</p>
                      </div>
                    </div>
                  </section>
                </div>

                <footer class="lg-action-dock">
                  <!-- 阶段 3 只有只读 GET；旧复核/重算/流转区块保留视觉位置，但没有服务端写契约时必须禁用。 -->
                  <div class="detail-actions">
                    <button class="btn pri" type="button" disabled title="尚未接入">人工复核（尚未接入）</button>
                    <button class="btn" type="button" disabled title="尚未接入">重新研判（尚未接入）</button>
                    <button class="btn warn" type="button" disabled title="尚未接入">转告警（尚未接入）</button>
                    <button class="btn warn" type="button" disabled title="尚未接入">转入处置（尚未接入）</button>
                  </div>
                </footer>
              </template>
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
</style>
