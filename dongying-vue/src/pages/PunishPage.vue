<script>
/* 模块级状态：跨导航保持筛选、分页与选中项（legacy 约定）。 */
const S = {
  page: 1, size: 20, selectedHandoffId: null,
  filters: { source_kind: '', delivery_status: '', source_mode: '', created: null }
};
export default {};
</script>

<script setup>
/* 处置处罚管理 —— 阶段 5 交接查询页。
   页面只读取后端 /handoffs 与 /handoff-recipients 事实：交接清单、材料快照、提交时间、投递状态与阻断原因。
   原 Mock 案件管理、罚款/裁量、处罚文书、证据下载、反制授权记录与定性复核已停止执行：本期没有真实案件源，
   对应区域禁用并说明“本期未建设”，不用 handoff_id 伪装 case_id。API 失败只显示失败态，不回退 Mock。 */
import { computed, onMounted, reactive, ref } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import UPagination from '@/components/UPagination.vue';
import UControl from '@/components/form/UControl.vue';
import { handoffApi } from '@/services/handoffApi.js';
import { getEvidenceChain } from '@/services/evidenceApi.js';
import { disposalApi, isDisposalUnavailable } from '@/services/disposalApi.js';
import { DISPOSAL_UNAVAILABLE_TEXT } from '@/ui/disposalAuthModal.js';
import {
  DELIVERY_STATUS_LABEL, DISPOSAL_ACTION_LABEL, DISPOSAL_BLOCK_REASON_LABEL, DISPOSAL_CHANNEL_LABEL,
  DISPOSAL_EVENT_KIND_LABEL, DISPOSAL_RESULT_LABEL, disposalStatusText, EVIDENCE_COVERAGE_LABEL,
  EVIDENCE_RECORD_TYPE_LABEL, HANDOFF_BLOCKED_LABEL, HANDOFF_KIND_LABEL, HANDOFF_TYPE_LABEL,
  REASON_CODE_LABEL, RECEIPT_STATUS_LABEL, RISK_CONCLUSION_LABEL, RISK_STATE_LABEL, RISK_TYPE_LABEL,
  SEVERITY_LABEL, SEVERITY_TAG, SOURCE_MODE_LABEL, labelOf, verificationOrdinal
} from '@/ui/labels.js';
import { openEvidenceFileModal } from '@/ui/evidenceFileDetail.js';
import {
  EVIDENCE_CHAIN_TYPES, coverageTagClass, isFileRecord, recordCaption, recordHint
} from '@/ui/evidenceChainView.js';

usePageChrome('punish');
const root = ref(null);
const U = window.UI;

/* 文案全部来自共享字典（src/ui/labels.js、services/workbenchEvents.js）；服务端字符串只经 Vue 文本插值输出，不进 v-html。 */
const KIND_LABEL = { RISK: HANDOFF_KIND_LABEL.RISK, UAV_EVENT: HANDOFF_KIND_LABEL.UAV_EVENT };
const TYPE_LABEL = HANDOFF_TYPE_LABEL;
const DELIVERY_LABEL = DELIVERY_STATUS_LABEL;
const DELIVERY_TAG = { PENDING_DELIVERY: 't-amber', SUBMITTED: 't-blue', DELIVERED: 't-green', FAILED: 't-red' };
const DELIVERY_TONE = { PENDING_DELIVERY: 'warn', SUBMITTED: 'info', DELIVERED: 'good', FAILED: 'bad' };
const RECEIPT_LABEL = RECEIPT_STATUS_LABEL;
const BLOCKED_LABEL = HANDOFF_BLOCKED_LABEL;
const CONCLUSION_LABEL = RISK_CONCLUSION_LABEL;
const REFERENCE_LABEL = { plan_id: '关联计划', route_version_id: '航线版本', assessment_id: '关联研判', target_id: '关联目标', track_id: '关联轨迹' };
const DELIVERY_PAGE_SIZE = 10;
const FIXED_SORT_NOTE = '服务端固定排序：created_at DESC, handoff_id DESC';

const kindOptions = [{ label: '全部来源', value: '' }, ...Object.keys(KIND_LABEL).map(value => ({ label: KIND_LABEL[value], value }))];
const deliveryOptions = [{ label: '全部投递状态', value: '' }, ...Object.keys(DELIVERY_LABEL).map(value => ({ label: DELIVERY_LABEL[value], value }))];
const sourceModeOptions = [{ label: '全部来源模式', value: '' }, ...['mock', 'replay', 'live'].map(value => ({ label: labelOf(SOURCE_MODE_LABEL, value), value }))];

/* /auth/me 的 permission_codes 只有 `<模块>.read/.op/.auth`，不含 `handoff:read` 动作码；
   无权限态不在前端预判，直接请求并以服务端 403 为准。 */
const forbidden = ref(false);
const filters = reactive(S.filters);
const listLoading = ref(false);
const listError = ref('');
const handoffs = ref([]);
const total = ref(0);
const page = ref(S.page);
const size = ref(S.size);
const kpiTotals = ref({ all: null, pending: null, delivered: null });
const kpiFailed = ref({ all: false, pending: false, delivered: false });
const detailLoading = ref(false);
const detailError = ref('');
const selected = ref(null);
/* 阶段 13：所选交接对应主体的处置授权记录。读不到（13.1 未落地时是 404）就显示原因，绝不显示空列表冒充“没有授权”。 */
const disposals = ref([]);
const disposalError = ref('');
const disposalUnavailable = ref(false);
const disposalEvents = ref([]);

async function loadDisposals(row) {
  disposals.value = []; disposalEvents.value = []; disposalError.value = ''; disposalUnavailable.value = false;
  if (!row?.source_id || !row?.source_kind) return;
  try {
    const page = await disposalApi.list({ subject_kind: row.source_kind, subject_id: row.source_id, page: 1, size: 50 });
    disposals.value = page?.items || [];
    // 只取最新一条授权的事件流：处置经过要能追溯到人和时刻，多条时由授权详情页展开。
    const latest = disposals.value[0];
    if (latest?.authorization_id) {
      const events = await disposalApi.events(latest.authorization_id, { page: 1, size: 50 });
      // 事件流接口返回的是裸数组（不是分页对象）：两种形状都接住，免得接口小改动就把经过悄悄变空。
      disposalEvents.value = Array.isArray(events) ? events : (events?.items || []);
    }
  } catch (error) {
    disposalUnavailable.value = isDisposalUnavailable(error);
    disposalError.value = disposalUnavailable.value ? DISPOSAL_UNAVAILABLE_TEXT : messageOf(error);
  }
}
const deliveries = ref([]);
const deliveriesTotal = ref(0);
const deliveriesPage = ref(1);
const deliveriesLoading = ref(false);
const deliveriesError = ref('');
const chain = ref(null);
const chainLoading = ref(false);
const chainError = ref('');
const legacyLinkNote = ref('');
let listToken = 0, kpiToken = 0, detailToken = 0, deliveriesToken = 0, chainToken = 0;

/* 3 张 KPI 与原页面同位同色；数值只取服务端 size=1 的 total，不在前端自算。 */
const kpiList = computed(() => {
  const value = key => (kpiFailed.value[key] ? '—' : kpiTotals.value[key] == null ? '…' : Number(kpiTotals.value[key]).toLocaleString('en-US'));
  const desc = (key, text) => (kpiFailed.value[key] ? '服务端总数读取失败' : text);
  if (forbidden.value) return [
    { label: '交接总数', value: '—', color: 'blue', icon: 'gavel', desc: '服务端拒绝：无 handoff:read 权限' },
    { label: '待投递', value: '—', color: 'amber', icon: 'alert', desc: '服务端拒绝：无 handoff:read 权限' },
    { label: '已送达', value: '—', color: 'green', icon: 'check', desc: '服务端拒绝：无 handoff:read 权限' }
  ];
  return [
    { label: '交接总数', value: value('all'), color: 'blue', icon: 'gavel', desc: desc('all', '当前权限范围内服务端总数') },
    { label: '待投递', value: value('pending'), color: 'amber', icon: 'alert', desc: desc('pending', '已提交、尚未发送（通知渠道未接通）') },
    { label: '已送达', value: value('delivered'), color: 'green', icon: 'check', desc: desc('delivered', '仅 local/test 的 mock 历史样例可能出现') }
  ];
});

/* UPanel 的 extra 走 v-html：只输出本页常量映射出的标签，服务端字符串一律不进 v-html。 */
const detailExtra = computed(() => {
  const status = selected.value?.delivery_status;
  if (!status) return '';
  return `<span class="tag ${DELIVERY_TAG[status] || 't-gray'}">${DELIVERY_LABEL[status] || '未知状态'}</span>`;
});
const visibleReferences = computed(() => {
  const references = selected.value?.material?.references || {};
  return Object.keys(REFERENCE_LABEL).filter(key => references[key]).map(key => ({ key, label: REFERENCE_LABEL[key], value: references[key] }));
});
/* 服务端 availability.material：FORBIDDEN（缺 risk:read）/ SOURCE_NOT_VISIBLE（源风险不在可见范围）时风险材料与核实历史被省略。 */
const materialUnavailableText = computed(() => {
  const availability = selected.value?.availability?.material;
  if (availability === 'FORBIDDEN') return '当前账号没有查看源风险的权限（risk:read），服务端已省略风险材料与核实历史。';
  if (availability === 'SOURCE_NOT_VISIBLE') return '源风险已不在当前可见范围，服务端已省略风险材料与核实历史。';
  return '快照中没有风险材料。';
});
const deliveryNote = computed(() => {
  const row = selected.value;
  if (!row) return '';
  if (row.delivery_status === 'PENDING_DELIVERY') return '已提交，尚未发送：材料已入库等待投递，通知渠道未接通。提交成功不等于已通知上级，也不等于处罚办结。';
  if (row.delivery_status === 'DELIVERED') return row.source_mode === 'mock' ? '这是 local/test 的只读 mock 历史样例；本期生产写入只会产生“待投递”。' : '外部系统已送达；送达不等于处罚办结。';
  if (row.delivery_status === 'FAILED') return '最近一次投递失败；本期未建设发送重试。';
  return '';
});

function label(map, value, fallback = '未知') { return value == null || value === '' ? fallback : (map[value] || value); }
function formatTime(value) {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}
function formatClock(value) {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function messageOf(reason, fallback) {
  if (!reason) return fallback;
  if (reason.status === 401) return '登录已失效，请重新登录。';
  if (reason.status === 403) return '当前账号没有查看业务交接的权限（handoff:read）。';
  if (reason.status === 404) return '交接记录不存在或不在当前权限范围内。';
  if (reason.code === 'NETWORK_ERROR' || reason.code === 'TIMEOUT') return '服务连接超时或不可用，请稍后重试。';
  return reason.message || fallback;
}

function listQuery() {
  const query = { source_kind: filters.source_kind, delivery_status: filters.delivery_status, source_mode: filters.source_mode };
  const range = Array.isArray(filters.created) ? filters.created : null;
  if (range && range[0] != null && range[1] != null) {
    // 契约要求 [from,to) 且 from < to；不满足时直接报错，不偷偷丢弃筛选。
    if (!(Number(range[0]) < Number(range[1]))) throw new Error('提交时间范围必须满足开始时间早于结束时间。');
    query.created_from = Number(range[0]);
    query.created_to = Number(range[1]);
  }
  return query;
}

async function loadKpis() {
  const token = ++kpiToken;
  const queries = { all: {}, pending: { delivery_status: 'PENDING_DELIVERY' }, delivered: { delivery_status: 'DELIVERED' } };
  await Promise.all(Object.keys(queries).map(async key => {
    try {
      const data = await handoffApi.listHandoffs({ ...queries[key], page: 1, size: 1 });
      if (token !== kpiToken) return;
      kpiTotals.value = { ...kpiTotals.value, [key]: data.total };
      kpiFailed.value = { ...kpiFailed.value, [key]: false };
    } catch {
      if (token !== kpiToken) return;
      kpiFailed.value = { ...kpiFailed.value, [key]: true };
    }
  }));
}

async function loadList(nextPage = page.value, requestedId = null) {
  const token = ++listToken;
  listLoading.value = true;
  listError.value = '';
  try {
    const data = await handoffApi.listHandoffs({ ...listQuery(), page: nextPage, size: size.value });
    if (token !== listToken) return;
    forbidden.value = false;
    handoffs.value = data.items || [];
    total.value = data.total;
    page.value = data.page;
    S.page = data.page;
    const wanted = requestedId || S.selectedHandoffId;
    const hit = handoffs.value.find(item => item.handoff_id === wanted);
    if (requestedId) loadDetail(requestedId);
    else if (hit) loadDetail(hit.handoff_id);
    else if (handoffs.value.length) loadDetail(handoffs.value[0].handoff_id);
    else { selected.value = null; S.selectedHandoffId = null; deliveries.value = []; deliveriesTotal.value = 0; }
  } catch (requestError) {
    if (token !== listToken) return;
    // 403 以服务端为准进入无权限态；其他错误保留失败态与重试。
    forbidden.value = requestError.status === 403;
    listError.value = messageOf(requestError, '读取交接清单失败');
    handoffs.value = [];
    total.value = 0;
  } finally {
    if (token === listToken) listLoading.value = false;
  }
}

async function loadDetail(handoffId) {
  const token = ++detailToken;
  S.selectedHandoffId = handoffId;
  detailLoading.value = true;
  detailError.value = '';
  deliveriesError.value = '';
  try {
    const [detail, history] = await Promise.all([
      handoffApi.getHandoff(handoffId),
      handoffApi.listHandoffDeliveries(handoffId, { page: 1, size: DELIVERY_PAGE_SIZE })
    ]);
    if (token !== detailToken) return;
    selected.value = detail;
    loadDisposals(detail);              // 授权记录与交接详情并行呈现：读失败不影响交接本身
    deliveries.value = history.items || [];
    deliveriesTotal.value = history.total;
    deliveriesPage.value = history.page;
    loadChain(detail);
  } catch (requestError) {
    if (token !== detailToken) return;
    selected.value = null;
    disposals.value = []; disposalEvents.value = []; disposalError.value = ''; disposalUnavailable.value = false;
    deliveries.value = [];
    deliveriesTotal.value = 0;
    chain.value = null;
    chainError.value = '';
    detailError.value = messageOf(requestError, '读取交接详情或投递记录失败');
  } finally {
    if (token === detailToken) detailLoading.value = false;
  }
}

async function changeDeliveriesPage(nextPage) {
  const row = selected.value;
  if (!row || nextPage === deliveriesPage.value) return;
  const token = ++deliveriesToken;
  deliveriesLoading.value = true;
  deliveriesError.value = '';
  try {
    const history = await handoffApi.listHandoffDeliveries(row.handoff_id, { page: nextPage, size: DELIVERY_PAGE_SIZE });
    if (token !== deliveriesToken || selected.value?.handoff_id !== row.handoff_id) return;
    deliveries.value = history.items || [];
    deliveriesTotal.value = history.total;
    deliveriesPage.value = history.page;
  } catch (requestError) {
    if (token !== deliveriesToken || selected.value?.handoff_id !== row.handoff_id) return;
    deliveriesError.value = messageOf(requestError, '读取投递记录失败');
  } finally {
    if (token === deliveriesToken) deliveriesLoading.value = false;
  }
}

function applyFilters() {
  try { listQuery(); } catch (validation) { listError.value = validation.message; return; }
  S.selectedHandoffId = null;
  loadList(1);
}
function resetFilters() {
  Object.assign(filters, { source_kind: '', delivery_status: '', source_mode: '', created: null });
  applyFilters();
}
function changePage(nextPage) { if (nextPage !== page.value) loadList(nextPage); }
function changePageSize(nextSize) { size.value = nextSize; S.size = nextSize; loadList(1); }
function selectHandoff(handoffId) {
  if (selected.value?.handoff_id === handoffId && !detailError.value) return;
  loadDetail(handoffId);
}
function retryList() { loadKpis(); loadList(page.value); }
function retryDetail() { if (S.selectedHandoffId) loadDetail(S.selectedHandoffId); }

async function loadChain(detail) {
  const token = ++chainToken;
  chain.value = null;
  chainError.value = '';
  if (!detail || detail.source_kind !== 'UAV_EVENT' || !detail.source_id) {
    chainLoading.value = false;
    return;
  }
  chainLoading.value = true;
  try {
    const data = await getEvidenceChain('EVENT', detail.source_id);
    if (token !== chainToken) return;
    chain.value = data;
  } catch (requestError) {
    if (token !== chainToken) return;
    chainError.value = requestError.status === 403
      ? '当前账号没有 evidence:read，无法读取证据链。'
      : (requestError.message || '证据链读取失败');
  } finally {
    if (token === chainToken) chainLoading.value = false;
  }
}

const chainCoverage = computed(() => EVIDENCE_CHAIN_TYPES.map(type => {
  const item = chain.value?.coverage?.[type] || {};
  return { type, label: labelOf(EVIDENCE_RECORD_TYPE_LABEL, type, type), status: item.status || 'ABSENT', count: item.count || 0 };
}));
const chainRecords = computed(() => chain.value?.records || []);
const chainBroken = computed(() => chainRecords.value.filter(row => row.availability === 'UNAVAILABLE').length);
function gotoSource(row) {
  if (!row || row.source_kind !== 'RISK') return;
  U.goto('risk', { riskId: row.source_id });
}

function hashHandoffId() {
  // 飞行风险页提交成功后以 #/punish?handoff=<id> 深链进入；只取该参数，不解释其他 query。
  const query = (location.hash || '').split('?')[1] || '';
  const value = new URLSearchParams(query).get('handoff');
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function consumeDeepLink() {
  const fromHash = hashHandoffId();
  const context = U?.consume?.('punish');
  if (!context) return fromHash;
  const handoffId = context.handoffId || context.handoff_id || fromHash || null;
  if (!handoffId && context.caseId) {
    // 旧页面仍可能以 caseId 深链进入；本期没有案件对象，也不能把案件编号映射成交接编号。
    legacyLinkNote.value = `本期未建设处罚案件对象：旧案件深链 ${String(context.caseId)} 无对应记录，下方为真实交接清单。`;
  }
  return typeof handoffId === 'string' && handoffId ? handoffId : null;
}

onMounted(() => {
  const requested = consumeDeepLink();
  if (requested) { Object.assign(filters, { source_kind: '', delivery_status: '', source_mode: '', created: null }); S.selectedHandoffId = requested; }
  loadKpis();
  loadList(requested ? 1 : page.value, requested);
});
</script>

<template>
  <div class="view" id="view" ref="root" style="overflow:hidden">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <UKpis :list="kpiList" />
      <div id="pnBody" class="pn-body" style="margin-top:12px;flex:1;min-height:0">
        <div v-if="forbidden" class="warnbox pn-forbidden">
          服务端拒绝读取：当前账号没有查看业务交接的权限（handoff:read）。交接清单、材料与投递状态不可读取；本页不展示任何演示数据。
          <button class="btn" type="button" :disabled="listLoading" @click="retryList">重试</button>
        </div>
        <template v-else>
          <div v-if="legacyLinkNote" class="warnbox pn-note">{{ legacyLinkNote }}</div>
          <div class="row pn-main">
            <UPanel title="业务交接清单" sub="提交成功只表示材料入库，不表示已发送、已送达或处罚办结" panel-style="flex:6;min-width:0" nopad>
              <div id="pnList" class="pn-list">
                <div class="toolbar pn-toolbar">
                  <div class="toolbar-fields">
                    <div class="field"><label>来源类型</label><UControl v-model="filters.source_kind" type="select" :options="kindOptions" :disabled="listLoading" size="small" @update:model-value="applyFilters" /></div>
                    <div class="field"><label>投递状态</label><UControl v-model="filters.delivery_status" type="select" :options="deliveryOptions" :disabled="listLoading" size="small" @update:model-value="applyFilters" /></div>
                    <div class="field"><label>来源模式</label><UControl v-model="filters.source_mode" type="select" :options="sourceModeOptions" :disabled="listLoading" size="small" @update:model-value="applyFilters" /></div>
                    <div class="field pn-range"><label>提交时间</label><UControl v-model="filters.created" type="datetimerange" clearable :disabled="listLoading" size="small" start-placeholder="开始" end-placeholder="结束" /></div>
                  </div>
                  <div class="toolbar-actions">
                    <button class="btn" type="button" :disabled="listLoading" @click="applyFilters">查询</button>
                    <button class="btn" type="button" id="pnR" :disabled="listLoading" @click="resetFilters">重置筛选</button>
                    <span class="toolbar-note" :title="FIXED_SORT_NOTE">服务端固定按提交时间倒序</span>
                  </div>
                </div>
                <div v-if="listError" class="warnbox pn-error">{{ listError }} <button class="btn" type="button" :disabled="listLoading" @click="retryList">重试</button></div>
                <div v-if="listLoading" class="empty">正在读取交接清单…</div>
                <div v-else-if="!listError && !handoffs.length" class="empty">当前筛选与权限范围内暂无交接记录；风险核验通过后可在飞行风险页提交通知交接。</div>
                <div v-else-if="handoffs.length" class="scroll table-scroll table-shell" style="flex:1">
                  <table class="tb">
                    <thead><tr>
                      <th>来源编号</th>
                      <th>来源事项</th>
                      <th>交接类型</th>
                      <th>接收方</th>
                      <th>提交时间</th>
                      <th>投递状态</th>
                      <th>回执</th>
                      <th>阻断原因</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="row in handoffs" :key="row.handoff_id" :data-row="row.handoff_id" tabindex="0" :class="{ on: selected?.handoff_id === row.handoff_id || (!selected && S.selectedHandoffId === row.handoff_id) }"
                        @click="selectHandoff(row.handoff_id)" @keydown.enter.prevent="selectHandoff(row.handoff_id)">
                        <td class="num"><span class="mono pn-id" :title="row.handoff_id">{{ row.source_no || row.handoff_id }}</span></td>
                        <td><span class="tag t-cyan" :title="row.source_id">{{ label(KIND_LABEL, row.source_kind) }}</span></td>
                        <td>{{ label(TYPE_LABEL, row.handoff_type) }}</td>
                        <td><div class="pn-wrap" :title="row.recipient_id">{{ row.recipient_name || '—' }}</div><div class="pn-sub">{{ labelOf(SOURCE_MODE_LABEL, row.source_mode, '') }}</div></td>
                        <td class="num" :title="formatTime(row.created_at)">{{ formatClock(row.created_at) }}</td>
                        <td><span class="tag" :class="DELIVERY_TAG[row.delivery_status] || 't-gray'">{{ label(DELIVERY_LABEL, row.delivery_status) }}</span></td>
                        <td>{{ label(RECEIPT_LABEL, row.receipt_status) }}</td>
                        <td><div class="pn-wrap">{{ row.blocked_reason ? label(BLOCKED_LABEL, row.blocked_reason) : '—' }}</div></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="pager"><UPagination :page="page" :page-size="size" :item-count="total" :prefix="`共 ${total.toLocaleString('en-US')} 条`" @update:page="changePage" @update:page-size="changePageSize" /></div>
              </div>
            </UPanel>

            <UPanel title="交接详情" panel-style="flex:4;min-width:340px" nopad :extra="detailExtra">
              <div id="pnDetail" class="pn-detail">
                <div v-if="detailLoading" class="empty">正在读取交接详情与投递记录…</div>
                <div v-else-if="detailError" class="warnbox pn-error">{{ detailError }} <button class="btn" type="button" @click="retryDetail">重试</button></div>
                <div v-else-if="!selected" class="empty">{{ handoffs.length ? '请选择交接记录' : '暂无可显示的交接记录' }}</div>
                <template v-else>
                  <div class="detail-hero detail-hero-micro"><div class="detail-hero-inner">
                    <div class="detail-hero-icon" v-html="U?.icon ? U.icon('clipboard') : ''"></div>
                    <div class="detail-hero-copy"><div class="detail-hero-eyebrow">业务交接</div><div class="detail-hero-title">{{ label(TYPE_LABEL, selected.handoff_type) }}</div><div class="detail-hero-id mono" :title="selected.handoff_id">{{ selected.source_no || selected.handoff_id }}</div></div>
                    <div class="detail-hero-side"><div class="detail-hero-tags"><span class="tag" :class="DELIVERY_TAG[selected.delivery_status] || 't-gray'">{{ label(DELIVERY_LABEL, selected.delivery_status) }}</span><span class="tag t-gray">{{ label(RECEIPT_LABEL, selected.receipt_status) }}</span></div></div>
                  </div></div>
                  <div class="metric-strip is-compact">
                    <div class="metric-item" :class="DELIVERY_TONE[selected.delivery_status] ? 'is-' + DELIVERY_TONE[selected.delivery_status] : ''"><span class="metric-copy"><small>投递状态</small><b>{{ label(DELIVERY_LABEL, selected.delivery_status) }}</b></span></div>
                    <div class="metric-item"><span class="metric-copy"><small>回执状态</small><b>{{ label(RECEIPT_LABEL, selected.receipt_status) }}</b></span></div>
                    <div class="metric-item" :class="selected.blocked_reason ? 'is-warn' : ''"><span class="metric-copy"><small>阻断原因</small><b>{{ selected.blocked_reason ? label(BLOCKED_LABEL, selected.blocked_reason) : '无' }}</b></span></div>
                    <div class="metric-item"><span class="metric-copy"><small>提交时间</small><b>{{ formatClock(selected.created_at) }}</b></span></div>
                  </div>
                  <div v-if="deliveryNote" class="warnbox pn-delivery-note">{{ deliveryNote }}</div>
                  <div class="sect"><h4>交接信息</h4><dl class="kv kv-surface">
                    <dt>来源编号</dt><dd class="mono" :title="selected.handoff_id">{{ selected.source_no || '未提供' }}</dd>
                    <dt>来源事项</dt><dd :title="selected.source_id">{{ label(KIND_LABEL, selected.source_kind) }}
                      <button v-if="selected.source_kind === 'RISK'" class="lnk pn-lnk" type="button" @click="gotoSource(selected)">查看风险</button></dd>
                    <dt>交接类型</dt><dd>{{ label(TYPE_LABEL, selected.handoff_type) }}</dd>
                    <dt>接收方</dt><dd :title="selected.recipient_id">{{ selected.recipient_name || '未提供' }}</dd>
                    <dt>源版本</dt><dd>{{ verificationOrdinal(selected.source_version) || '尚未核验' }}</dd>
                    <dt>提交时间</dt><dd>{{ formatTime(selected.created_at) }}</dd>
                    <dt>提交人</dt><dd :title="selected.submitted_by">{{ selected.submitted_by_name || selected.submitted_by || '未提供' }}</dd>
                    <dt>所属范围</dt><dd :title="`${selected.owner_org_id || ''} / ${selected.district_id || ''}`">{{ selected.owner_org_name || '—' }} / {{ selected.district_name || '—' }}</dd>
                    <dt>来源模式</dt><dd>{{ labelOf(SOURCE_MODE_LABEL, selected.source_mode, '未提供') }}</dd>
                  </dl></div>
                  <div class="sect"><h4>证据链
                    <span v-if="selected.source_kind === 'UAV_EVENT'" class="tag t-gray">{{ chainRecords.length }} 项</span>
                    <span v-if="chainBroken" class="tag t-red">{{ chainBroken }} 份校验异常</span>
                  </h4>
                    <div v-if="selected.source_kind !== 'UAV_EVENT'" class="pn-note-text">风险交接不是无人机八类证据链的根对象；请在告警详情按事件或目标查看。</div>
                    <div v-else-if="chainLoading" class="empty">正在读取证据链…</div>
                    <div v-else-if="chainError" class="warnbox pn-error">{{ chainError }} <button class="btn" type="button" @click="loadChain(selected)">重试</button></div>
                    <template v-else-if="chain">
                      <div class="pn-chain-cov">
                        <div v-for="item in chainCoverage" :key="item.type" class="pn-chain-cov-item">
                          <span>{{ item.label }}</span>
                          <span class="tag" :class="coverageTagClass(item.status)">{{ labelOf(EVIDENCE_COVERAGE_LABEL, item.status, item.status) }}<template v-if="item.count"> {{ item.count }}</template></span>
                        </div>
                      </div>
                      <div v-if="!chainRecords.length" class="pn-note-text">当前事件没有已关联的八类记录。缺项已标为缺失，不编造材料。</div>
                      <div v-else class="pn-chain-cards">
                        <button v-for="row in chainRecords.slice(0, 8)" :key="row.record_id" type="button" class="punish-evidence-card"
                          :disabled="!isFileRecord(row)"
                          :title="recordHint(row)"
                          :aria-label="'查看证据：' + recordCaption(row)"
                          @click="isFileRecord(row) && openEvidenceFileModal(row.record_id)">
                          <span>{{ recordCaption(row) }}</span>
                          <small>{{ isFileRecord(row) ? '打开文件' : recordHint(row) }}</small>
                        </button>
                      </div>
                      <div v-if="chainRecords.length > 8" class="pn-note-text">另有 {{ chainRecords.length - 8 }} 项，可在「证据管理」查看文件台账。</div>
                      <div v-if="chain.integrity" class="pn-note-text">链校验 {{ chain.integrity.algorithm }} · {{ chain.integrity.member_count }} 项 · {{ chain.integrity.checksum }}</div>
                    </template>
                  </div>
                  <div class="sect"><h4>材料快照 <span class="tag t-gray">schema v{{ selected.material?.schema_version ?? '—' }}</span></h4>
                    <div v-if="!selected.material" class="empty">服务端未返回材料快照。</div>
                    <template v-else>
                      <dl v-if="selected.material.risk" class="kv kv-surface">
                        <dt>风险编号</dt><dd class="mono" :title="selected.material.risk.risk_id">{{ selected.material.risk.source_risk_id || '未提供' }}</dd>
                        <dt>风险类型</dt><dd>{{ labelOf(RISK_TYPE_LABEL, selected.material.risk.risk_type, '未提供') }}</dd>
                        <dt>风险等级</dt><dd><span class="tag" :class="SEVERITY_TAG[selected.material.risk.severity] || 't-gray'">{{ label(SEVERITY_LABEL, selected.material.risk.severity) }}</span></dd>
                        <dt>提交时状态</dt><dd>{{ label(RISK_STATE_LABEL, selected.material.risk.state) }}</dd>
                        <dt>风险依据</dt><dd>{{ labelOf(REASON_CODE_LABEL, selected.material.risk.reason_code, '未提供') }}</dd>
                        <dt>依据说明</dt><dd class="pn-wrap">{{ selected.material.risk.reason_text || '未提供' }}</dd>
                        <dt>发生时间</dt><dd>{{ formatTime(selected.material.risk.occurred_at) }}</dd>
                        <dt>接收时间</dt><dd>{{ formatTime(selected.material.risk.received_at) }}</dd>
                        <dt>快照版本</dt><dd>{{ verificationOrdinal(selected.material.risk.version) || '尚未核验' }}</dd>
                      </dl>
                      <div v-else class="empty">{{ materialUnavailableText }}</div>
                      <template v-if="selected.material.risk">
                      <div class="pn-subhead">关联引用</div>
                      <dl v-if="visibleReferences.length" class="kv kv-surface">
                        <template v-for="reference in visibleReferences" :key="reference.key">
                          <dt>{{ reference.label }}</dt><dd :title="reference.value">已记录关联</dd>
                        </template>
                      </dl>
                      <div v-else class="pn-note-text">当前权限下没有可见的关联引用（不可见的引用已由服务端省略）。</div>
                      <div class="pn-subhead">核实历史 <span class="tag t-gray">{{ selected.material.verifications?.length || 0 }}</span></div>
                      <div v-if="!selected.material.verifications?.length" class="pn-note-text">快照中没有核实记录。</div>
                      <div v-else class="pn-history">
                        <div v-for="item in selected.material.verifications" :key="`${item.version}-${item.created_at}`" class="pn-history-item">
                          <div><span class="tag" :class="item.conclusion === 'CONFIRMED' ? 't-green' : 't-gray'">{{ label(CONCLUSION_LABEL, item.conclusion) }}</span> <span class="mono">{{ verificationOrdinal(item.version) }}</span> → {{ label(RISK_STATE_LABEL, item.resulting_state) }}</div>
                          <div class="pn-wrap">{{ item.note || '无说明' }}</div>
                          <div class="pn-sub">{{ formatTime(item.created_at) }} · 操作人 {{ item.actor_name || item.actor_id || '未提供' }}</div>
                        </div>
                      </div>
                      </template>
                      <div class="pn-note-text">交接材料只含结构化字段；没有文件、哈希或下载链接，也不生成证据台账。</div>
                    </template>
                  </div>
                  <div class="sect"><h4>投递记录 <span class="tag t-gray">{{ deliveriesTotal }}</span></h4>
                    <div v-if="deliveriesLoading" class="empty">正在读取投递记录…</div>
                    <div v-else-if="deliveriesError" class="warnbox pn-error">{{ deliveriesError }}</div>
                    <div v-else-if="!deliveries.length" class="empty">尚无投递记录</div>
                    <div v-else class="scroll table-scroll table-shell pn-deliveries">
                      <table class="tb">
                        <thead><tr><th>次序</th><th>投递状态</th><th>回执</th><th>阻断原因</th><th>创建</th><th>发送</th><th>送达</th><th>回执时间</th></tr></thead>
                        <tbody>
                          <tr v-for="item in deliveries" :key="item.delivery_id">
                            <td class="num">{{ item.attempt_no }}</td>
                            <td><span class="tag" :class="DELIVERY_TAG[item.delivery_status] || 't-gray'">{{ label(DELIVERY_LABEL, item.delivery_status) }}</span></td>
                            <td>{{ label(RECEIPT_LABEL, item.receipt_status) }}</td>
                            <td>{{ item.blocked_reason ? label(BLOCKED_LABEL, item.blocked_reason) : '—' }}</td>
                            <td class="num" :title="formatTime(item.created_at)">{{ formatClock(item.created_at) }}</td>
                            <td class="num" :title="formatTime(item.submitted_at)">{{ formatClock(item.submitted_at) }}</td>
                            <td class="num" :title="formatTime(item.delivered_at)">{{ formatClock(item.delivered_at) }}</td>
                            <td class="num" :title="formatTime(item.acknowledged_at)">{{ formatClock(item.acknowledged_at) }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <div v-if="deliveriesTotal > DELIVERY_PAGE_SIZE" class="pager"><UPagination :page="deliveriesPage" :page-size="DELIVERY_PAGE_SIZE" :item-count="deliveriesTotal" size="small" @update:page="changeDeliveriesPage" /></div>
                    <div class="pn-note-text">送达与回执只能来自外部系统事实；本页没有发送、重试或回执写入口。</div>
                  </div>
                </template>
              </div>
            </UPanel>
          </div>

          <UPanel title="反制与公安信号干扰授权记录" sub="按所选交接的处置对象列出授权与经过；执行结果以设备回执为准" panel-style="flex:none">
            <div class="pn-disposal">
              <div v-if="disposalError" class="pn-sub pn-wrap">{{ disposalError }}</div>
              <div v-else-if="!disposals.length" class="pn-sub pn-wrap">该处置对象尚无授权记录。</div>
              <template v-else>
                <div v-for="row in disposals" :key="row.authorization_id" class="pn-disposal-row">
                  <div class="pn-disposal-head">
                    <b class="mono" :title="row.authorization_id">{{ row.authorization_no }}</b>
                    <span class="tag t-gray">{{ labelOf(DISPOSAL_ACTION_LABEL, row.action_type) }}</span>
                    <span class="tag">状态：{{ disposalStatusText(row) }}</span>
                  </div>
                  <div class="pn-sub pn-wrap">
                    <span v-if="row.approved_by_name || row.approved_by" :title="row.approved_by || ''">审批人：{{ row.approved_by_name || '—' }}</span>
                    <span v-if="row.requested_by_name || row.requested_by" :title="row.requested_by || ''"> · 申请人：{{ row.requested_by_name || '—' }}</span>
                    <span v-if="row.valid_until"> · 有效至 {{ formatTime(row.valid_until) }}</span>
                    <span v-if="row.channel"> · {{ labelOf(DISPOSAL_CHANNEL_LABEL, row.channel) }}</span>
                  </div>
                  <div v-if="row.execution_block_reason" class="pn-sub pn-wrap">
                    执行受阻：{{ labelOf(DISPOSAL_BLOCK_REASON_LABEL, row.execution_block_reason) }}
                  </div>
                  <div v-if="row.result_code" class="pn-sub pn-wrap">
                    结果：{{ labelOf(DISPOSAL_RESULT_LABEL, row.result_code) }}<span v-if="row.result_detail"> · {{ row.result_detail }}</span>
                  </div>
                </div>
                <div v-if="disposalEvents.length" class="pn-disposal-events">
                  <div class="pn-sub">最新一条授权的经过</div>
                  <div v-for="ev in disposalEvents" :key="ev.event_id" class="pn-sub pn-wrap">
                    {{ formatTime(ev.occurred_at) }} · {{ labelOf(DISPOSAL_EVENT_KIND_LABEL, ev.event_kind) }}<span v-if="ev.note"> · {{ ev.note }}</span>
                  </div>
                </div>
              </template>
            </div>
          </UPanel>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pn-body { display: flex; flex-direction: column; min-height: 0; overflow: auto; }
.pn-forbidden, .pn-note { margin: 0 0 12px; }
.pn-main { align-items: stretch; gap: var(--gap); height: calc(100vh - 314px); min-height: 560px; flex: none; }
.pn-list { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pn-toolbar { padding: 10px; }
.pn-error { margin: 8px 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tb tr { cursor: pointer; }
.tb tr.on { background: rgba(34, 211, 238, .12); }
.pn-id { display: inline-block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.pn-sub { font-size: 11px; color: var(--txt-3); white-space: normal; line-height: 1.4; overflow-wrap: anywhere; }
.pn-sub-inline { font-size: 11px; color: var(--txt-3); margin-left: 4px; }
.pn-wrap { white-space: normal; line-height: 1.4; overflow-wrap: anywhere; }
.pager { display: flex; justify-content: flex-end; padding: 10px; }
.pn-detail { flex: 1; overflow: auto; padding: 12px; }
.pn-delivery-note { margin: 8px 0 12px; }
.pn-lnk { background: none; border: 0; padding: 0 0 0 6px; font: inherit; cursor: pointer; }
.pn-subhead { margin: 12px 0 6px; font-size: 12px; font-weight: 600; color: var(--txt-2); }
.pn-note-text { margin: 6px 0 4px; font-size: 11px; color: var(--txt-3); line-height: 1.6; }
.pn-history { display: grid; gap: 8px; }
.pn-history-item { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; font-size: 12px; }
.pn-deliveries { max-height: 240px; }
.pn-deliveries .tb tr { cursor: default; }
.pn-disposal { display: grid; gap: 10px; }
.pn-disposal-row { display: grid; gap: 4px; padding: 8px; border: 1px solid var(--line); border-radius: 6px; }
.pn-disposal-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pn-disposal-events { display: grid; gap: 4px; margin-top: 4px; }
.pn-chain-cov { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
.pn-chain-cov-item { display: grid; gap: 4px; padding: 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 11px; }
.pn-chain-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.punish-evidence-card { height: 54px; border: 1px solid var(--line); border-radius: 4px; background: linear-gradient(135deg, rgba(61,139,255,.22), rgba(4,12,32,.9)); color: inherit; font: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
.punish-evidence-card:disabled { cursor: default; opacity: .85; }
.punish-evidence-card small { font-size: 10px; color: var(--txt-3); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
