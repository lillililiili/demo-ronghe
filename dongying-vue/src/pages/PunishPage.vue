<script>
/* 模块级状态：跨导航保持筛选、分页与选中项（legacy 约定）。 */
const S = {
  page: 1, size: 20, selectedHandoffId: null,
  filters: { delivery_status: '', receipt_status: '', created: null }
};
export default {};
</script>

<script setup>
/* 处置处罚管理：业务交接清单只列无人机事件的处罚交接。
   通知与案件结果读取服务端，页面不再用本地标记代替送达。 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import ModuleStatistics from '@/components/ModuleStatistics.vue';
import { useModuleStatistics } from '@/hooks/useModuleStatistics.js';
import { getHandoffStatistics } from '@/services/handoffApi.js';
import UPagination from '@/components/UPagination.vue';
import UField from '@/components/form/UField.vue';
import UFilterBar from '@/components/form/UFilterBar.vue';
import { UAV_STATE_TEXT as UAV_STATE_LABEL } from '@/ui/uavVerificationModal.js';
import { handoffApi } from '@/services/handoffApi.js';
import AdvisoryRecords from '@/components/disposal/AdvisoryRecords.vue';
import PunishmentOutcome from '@/pages/punish/PunishmentOutcome.vue';
import PunishmentNotification from '@/pages/punish/PunishmentNotification.vue';
import HandoffMaterialFacts from '@/pages/punish/HandoffMaterialFacts.vue';
import { DELIVERY_OPTIONS, RECEIPT_OPTIONS, deliveryView, receiptView, statusQuery } from '@/pages/punish/handoffStatus.js';
import RecipientSnapshotFields from '@/components/notifications/RecipientSnapshotFields.vue';
import { getEvidenceChain } from '@/services/evidenceApi.js';
import {
  ALARM_TYPE_LABEL, CONCLUSION_LABEL as EVENT_CONCLUSION_LABEL,
  DISPOSAL_ACTION_LABEL, HANDOFF_KIND_LABEL, HANDOFF_TYPE_LABEL, SOURCE_MODE_LABEL,
  disposalStatusText, labelOf, readableNo
} from '@/ui/labels.js';
import { chainTypeCards, openEvidenceChainTypeModal } from '@/ui/evidenceChainView.js';
import { pilotLocationText } from '@/services/pilotLocation.js';

usePageChrome('punish');
const root = ref(null);
const authorizationId = new URLSearchParams(location.hash.split('?')[1] || '').get('authorization') || '';

const U = window.UI;

const UAV_KIND = 'UAV_EVENT';
const KIND_LABEL = HANDOFF_KIND_LABEL;
const TYPE_LABEL = HANDOFF_TYPE_LABEL;
const deliveryOptions = [{ label: '全部送达状态', value: '' }, ...DELIVERY_OPTIONS];
const receiptOptions = [{ label: '全部签收状态', value: '' }, ...RECEIPT_OPTIONS];

const forbidden = ref(false);
const filters = reactive(S.filters);
const listLoading = ref(false);
const listError = ref('');
const handoffs = ref([]);
let appliedQuery = { source_kind: UAV_KIND };
const statistics = useModuleStatistics(getHandoffStatistics, [
  { key: 'by_delivery', title: '处罚送达状态分布', type: 'bar', labels: Object.fromEntries(DELIVERY_OPTIONS.map(item => [item.value, item.label])), colors: Object.fromEntries(DELIVERY_OPTIONS.map(item => [item.value, item.color])) },
  { key: 'by_receipt', title: '签收回执占比', type: 'donut', labels: Object.fromEntries(RECEIPT_OPTIONS.map(item => [item.value, item.label])), colors: { NOT_EXPECTED: 'gray', PENDING: 'amber', ACKNOWLEDGED: 'green', TIMEOUT: 'red' } },
  { key: 'by_day', title: '近7日移送趋势', type: 'line', windowed: true, label: code => code.slice(5), note: '按提交时间 · 北京时间' }
]);
const total = ref(0);
const page = ref(S.page);
const size = ref(S.size);
const kpiTotals = ref({});
const kpiFailed = ref({});
const detailLoading = ref(false);
const detailError = ref('');
const selected = ref(null);
const chain = ref(null);
const chainLoading = ref(false);
const chainError = ref('');
const legacyLinkNote = ref('');
let listToken = 0, kpiToken = 0, detailToken = 0, chainToken = 0;

function updateNotificationStatus(data) {
  if (selected.value?.handoff_id !== data.handoff_id) return;
  const changed = selected.value.delivery_status !== data.delivery_status || selected.value.receipt_status !== data.receipt_status;
  const fields = { delivery_status: data.delivery_status, receipt_status: data.receipt_status, latest_delivery: data.latest_delivery, blocked_reason: data.latest_delivery?.blocked_reason || null };
  Object.assign(selected.value, fields);
  const row = handoffs.value.find(item => item.handoff_id === data.handoff_id);
  if (row) Object.assign(row, fields);
  if (changed) { loadKpis(); void statistics.load(appliedQuery); }
}

const kpiList = computed(() => {
  const value = key => (forbidden.value || kpiFailed.value[key] ? '—' : kpiTotals.value[key] == null ? '读取中' : Number(kpiTotals.value[key]).toLocaleString('en-US'));
  const desc = (key, text) => forbidden.value ? '没有查看业务交接的权限' : kpiFailed.value[key] ? '总数读取失败' : text;
  return [
    { label: '交接总数', value: value('all'), color: 'blue', icon: 'gavel', desc: desc('all', '无人机事件处罚交接总数') },
    ...DELIVERY_OPTIONS.map(item => ({ label: item.label, value: value(item.value), color: item.color, icon: item.icon,
      desc: desc(item.value, item.value === 'SUBMITTED' ? '已提交但送达尚未确认，包含处理中和结果未知' : `最近一次投递：${item.label}`) }))
  ];
});

function label(map, value, fallback = '未知') { return value == null || value === '' ? fallback : (map[value] || value); }
function materialAuthorizationMode(row) {
  if (row?.authorization_mode === 'DIRECT') return '免逐次审批';
  if (row?.authorization_mode === 'REVIEW') return '申请审批';
  return '';
}
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
  if (reason.status === 403) return '当前账号没有查看业务交接的权限。';
  if (reason.status === 404) return '交接记录不存在或不在当前权限范围内。';
  if (reason.code === 'NETWORK_ERROR' || reason.code === 'TIMEOUT') return '服务连接超时或不可用，请稍后重试。';
  return reason.message || fallback;
}

function listQuery() {
  const query = { source_kind: UAV_KIND, ...statusQuery(filters.delivery_status, filters.receipt_status) };
  const range = Array.isArray(filters.created) ? filters.created : null;
  if (range && range[0] != null && range[1] != null) {
    if (!(Number(range[0]) < Number(range[1]))) throw new Error('提交时间范围必须满足开始时间早于结束时间。');
    query.created_from = Number(range[0]);
    query.created_to = Number(range[1]);
  }
  return query;
}

async function loadKpis() {
  const token = ++kpiToken;
  const base = { source_kind: UAV_KIND };
  const queries = { all: { ...base }, ...Object.fromEntries(DELIVERY_OPTIONS.map(item => [item.value, { ...base, delivery_status: item.value }])) };
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
  statistics.begin();
  listLoading.value = true;
  listError.value = '';
  try {
    const query = listQuery();
    const data = await handoffApi.listHandoffs({ ...query, page: nextPage, size: size.value });
    if (token !== listToken) return;
    forbidden.value = false;
    handoffs.value = data.items || [];
    total.value = data.total;
    appliedQuery = query;
    void statistics.load(query);
    page.value = data.page;
    S.page = data.page;
    const wanted = requestedId || S.selectedHandoffId;
    const hit = handoffs.value.find(item => item.handoff_id === wanted);
    if (requestedId) loadDetail(requestedId);
    else if (hit) loadDetail(hit.handoff_id);
    else if (handoffs.value.length) loadDetail(handoffs.value[0].handoff_id);
    else { selected.value = null; S.selectedHandoffId = null; }
  } catch (requestError) {
    if (token !== listToken) return;
    forbidden.value = requestError.status === 403;
    listError.value = messageOf(requestError, '读取交接清单失败');
    statistics.fail(requestError);
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
  try {
    const detail = await handoffApi.getHandoff(handoffId);
    if (token !== detailToken) return;
    selected.value = detail;
    loadChain(detail);
  } catch (requestError) {
    if (token !== detailToken) return;
    selected.value = null;
    chain.value = null;
    chainError.value = '';
    detailError.value = messageOf(requestError, '读取交接详情失败');
  } finally {
    if (token === detailToken) detailLoading.value = false;
  }
}

watch(() => [filters.delivery_status, filters.receipt_status], () => applyFilters());
function applyFilters() {
  try { listQuery(); } catch (validation) { listError.value = validation.message; return; }
  S.selectedHandoffId = null;
  loadList(1);
}
function changePage(nextPage) { if (nextPage !== page.value) loadList(nextPage); }
function changePageSize(nextSize) { size.value = nextSize; S.size = nextSize; loadList(1); }
function selectHandoff(handoffId) {
  if (selected.value?.handoff_id === handoffId && !detailError.value) return;
  loadDetail(handoffId);
}
function retryList() { loadKpis(); loadList(page.value); }

/* 实时刷新：移送或处罚变化后静默重读列表与统计；选中记录本身有变化时才重读详情。 */
async function realtimeRefresh() {
  if (listLoading.value || listError.value || !appliedQuery) return;
  const token = ++listToken;
  const before = JSON.stringify(handoffs.value.find(item => item.handoff_id === S.selectedHandoffId) || null);
  void loadKpis();
  try {
    const data = await handoffApi.listHandoffs({ ...appliedQuery, page: page.value, size: size.value });
    if (token !== listToken) return;
    handoffs.value = data.items || [];
    total.value = data.total;
    void statistics.load(appliedQuery);
    const after = JSON.stringify(handoffs.value.find(item => item.handoff_id === S.selectedHandoffId) || null);
    if (S.selectedHandoffId && after !== before && after !== 'null') loadDetail(S.selectedHandoffId);
  } catch { /* 静默刷新失败保留当前列表 */ }
}
useRealtimeRefresh(['punishment', 'evidence'], realtimeRefresh, { minIntervalMs: 2_000 });
function retryDetail() { if (S.selectedHandoffId) loadDetail(S.selectedHandoffId); }

async function loadChain(detail) {
  const token = ++chainToken;
  chain.value = null;
  chainError.value = '';
  if (!detail || detail.source_kind !== UAV_KIND || !detail.source_id) {
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
      ? '当前账号无权查看关联证据，请联系管理员。'
      : (requestError.message || '证据链读取失败');
  } finally {
    if (token === chainToken) chainLoading.value = false;
  }
}

const chainCards = computed(() => chainTypeCards(chain.value));
const chainTotal = computed(() => chainCards.value.reduce((sum, item) => sum + item.count, 0));
const chainBroken = computed(() => chainCards.value.reduce((sum, item) => sum + item.broken, 0));

function hashHandoffId() {
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
    legacyLinkNote.value = '原链接无法定位交接记录，请从下方清单选择。';
  }
  return typeof handoffId === 'string' && handoffId ? handoffId : null;
}

onMounted(() => {
  if (authorizationId) { window.location.replace(`#/alarms?tab=authorizations&authorization=${encodeURIComponent(authorizationId)}`); return; }
  const requested = consumeDeepLink();
  if (requested) { Object.assign(filters, { delivery_status: '', receipt_status: '', created: null }); S.selectedHandoffId = requested; }
  loadKpis();
  loadList(requested ? 1 : page.value, requested);
});
</script>

<template>
  <div class="view" id="view" ref="root">
    <div style="height:100%;min-height:600px;display:flex;flex-direction:column">
      <UKpis :list="kpiList" class-name="pn-kpis" />
      <div id="pnBody" class="pn-body" style="margin-top:12px;flex:1;min-height:0">
        <div v-if="forbidden" class="warnbox pn-forbidden">
          当前账号没有查看业务交接的权限，无法读取交接清单、材料和通知状态。
          <button class="btn" type="button" :disabled="listLoading" @click="retryList">重试</button>
        </div>
        <template v-else>
          <div v-if="legacyLinkNote" class="warnbox pn-note">{{ legacyLinkNote }}</div>
          <div class="row pn-main">
            <UPanel title="业务交接清单" panel-style="flex:6;min-width:0" nopad>
              <div id="pnList" class="pn-list">
                <UFilterBar class="pn-toolbar">
                  <UField id="pn-delivery" v-model="filters.delivery_status" label="送达状态" variant="filter" type="select" :options="deliveryOptions" :disabled="listLoading" />
                  <UField id="pn-receipt" v-model="filters.receipt_status" label="签收回执" variant="filter" type="select" :options="receiptOptions" :disabled="listLoading" />
                  <UField id="pn-created" v-model="filters.created" class="pn-range" label="提交时间" variant="filter" type="datetimerange" clearable :disabled="listLoading" start-placeholder="开始时间" end-placeholder="结束时间" />
                  <template #actions>
                    <button class="btn pri" type="button" :disabled="listLoading" @click="applyFilters">查询</button>
                  </template>
                </UFilterBar>
                <div v-if="listError" class="warnbox pn-error">{{ listError }} <button class="btn" type="button" :disabled="listLoading" @click="retryList">重试</button></div>
                <div v-if="listLoading && !handoffs.length" class="empty">正在读取交接清单</div>
                <div v-else-if="!listError && !handoffs.length" class="empty">暂无符合筛选条件的交接记录</div>
                <div v-else-if="handoffs.length" class="scroll table-scroll table-shell" style="flex:1">
                  <table class="tb">
                    <thead><tr>
                      <th>来源编号</th>
                      <th>来源事项</th>
                      <th>接收方</th>
                      <th>提交时间</th>
                      <th class="pn-status">送达状态</th>
                      <th class="pn-status">签收回执</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="row in handoffs" :key="row.handoff_id" :data-row="row.handoff_id" tabindex="0" :class="{ on: selected?.handoff_id === row.handoff_id || (!selected && S.selectedHandoffId === row.handoff_id) }"
                        @click="selectHandoff(row.handoff_id)" @keydown.enter.prevent="selectHandoff(row.handoff_id)">
                        <td class="num"><span class="mono pn-id" :title="row.handoff_id">{{ readableNo(row.source_no, row.source_id) || '—' }}</span></td>
                        <td><span class="tag t-cyan" :title="row.source_id">{{ label(KIND_LABEL, row.source_kind) }}</span></td>
                        <td><div class="pn-wrap" :title="row.recipient_id">{{ row.recipient_name || '—' }}</div><div class="pn-sub">{{ labelOf(SOURCE_MODE_LABEL, row.source_mode, '') }}</div></td>
                        <td class="num" :title="formatTime(row.created_at)">{{ formatClock(row.created_at) }}</td>
                        <td class="pn-status"><span class="tag" :class="deliveryView(row).tag">{{ deliveryView(row).label }}</span></td>
                        <td class="pn-status"><span class="tag" :class="receiptView(row).tag">{{ receiptView(row).label }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="pager"><UPagination :page="page" :page-size="size" :item-count="total" :prefix="`共 ${total.toLocaleString('en-US')} 条`" @update:page="changePage" @update:page-size="changePageSize" /></div>
              </div>
            </UPanel>

            <UPanel title="交接详情" panel-style="flex:4;min-width:340px" nopad>
              <div id="pnDetail" class="pn-detail">
                <div v-if="detailLoading" class="empty">正在读取交接详情</div>
                <div v-else-if="detailError" class="warnbox pn-error">{{ detailError }} <button class="btn" type="button" @click="retryDetail">重试</button></div>
                <div v-else-if="!selected" class="empty">{{ handoffs.length ? '请选择交接记录' : '暂无可显示的交接记录' }}</div>
                <template v-else>
                  <div class="detail-hero detail-hero-micro"><div class="detail-hero-inner">
                    <div class="detail-hero-icon" v-html="U?.icon ? U.icon('clipboard') : ''"></div>
                    <div class="detail-hero-copy"><div class="detail-hero-eyebrow">业务交接</div><div class="detail-hero-title">{{ label(TYPE_LABEL, selected.handoff_type) }}</div><div class="detail-hero-id mono" :title="selected.handoff_id">{{ readableNo(selected.source_no, selected.source_id) || '来源编号未提供' }}</div></div>
                  </div></div>
                  <div class="sect pn-section pn-section-info"><h4>交接信息</h4><dl class="kv kv-surface">
                    <dt>来源事项</dt><dd :title="selected.source_id"><span class="tag t-cyan">{{ label(KIND_LABEL, selected.source_kind) }}</span></dd>
                    <dt>接收方</dt><dd class="pn-recipient" :title="selected.recipient_id">{{ selected.recipient_name || '未提供' }}</dd>
                    <RecipientSnapshotFields :snapshot="selected.recipient_snapshot" historical />
                    <dt>提交时间</dt><dd>{{ formatTime(selected.created_at) }}</dd>
                    <dt>提交人</dt><dd :title="selected.submitted_by">{{ selected.submitted_by_name || '姓名未记录' }}</dd>
                    <dt>所属范围</dt><dd :title="`${selected.owner_org_id || ''} / ${selected.district_id || ''}`">{{ selected.owner_org_name || '—' }} / {{ selected.district_name || '—' }}</dd>
                  </dl></div>
                  <div class="sect pn-section pn-section-evidence"><h4>当前关联证据
                    <span class="tag t-gray">{{ chainTotal }} 项</span>
                    <span v-if="chainBroken" class="tag t-red">{{ chainBroken }} 份校验异常</span>
                  </h4>
                    <div v-if="chainLoading" class="empty">正在读取证据链</div>
                    <div v-else-if="chainError" class="warnbox pn-error">{{ chainError }} <button class="btn" type="button" @click="loadChain(selected)">重试</button></div>
                    <template v-else-if="chain">
                      <div class="ev-chain-grid">
                        <button v-for="item in chainCards" :key="item.type" type="button" class="ev-chain-card"
                          :class="item.cardClass" :title="item.preview" :aria-label="item.ariaLabel"
                          @click="openEvidenceChainTypeModal({ chain, type: item.type })">
                          <span class="ev-chain-card-head">
                            <span class="ev-chain-card-icon" v-html="U.icon(item.icon)"></span>
                            <b>{{ item.label }}</b>
                            <span class="tag" :class="item.tagClass">{{ item.statusText }}</span>
                          </span>
                          <span class="ev-chain-card-preview">{{ item.preview }}</span>
                        </button>
                      </div>
                    </template>
                  </div>
                  <div class="sect pn-section pn-section-material"><h4>移送材料</h4>
                    <div v-if="!selected.material" class="empty">暂无材料</div>
                    <template v-else>
                      <div v-if="selected.material.event" class="pn-material-summary">
                        <p>{{ labelOf(ALARM_TYPE_LABEL, selected.material.event.alarm_type, '未提供') }} · 移送时{{ labelOf(UAV_STATE_LABEL, selected.material.event.state, '状态未提供') }}</p>
                        <p class="pn-material-meta">发生于 {{ formatTime(selected.material.event.occurred_at) }}</p>
                        <p class="pn-material-meta">遥控器位置：{{ pilotLocationText(selected.material.pilot_location) }}</p>
                        <HandoffMaterialFacts part="summary" :material="selected.material" />
                      </div>
                      <p v-else class="pn-material-meta">无事件材料</p>
                      <p v-if="selected.material.evidence_omitted" class="pn-material-meta">当前无权查看移送时证据</p>
                      <details :key="selected.handoff_id" class="pn-material-details">
                        <summary><span class="pn-material-expand">查看详细材料</span><span class="pn-material-collapse">收起详细材料</span></summary>
                        <div class="pn-material-content">
                      <div v-if="selected.material.verifications?.length" class="pn-sub pn-wrap">
                        <div v-for="(vr, i) in selected.material.verifications" :key="i">
                          核实结论：{{ labelOf(EVENT_CONCLUSION_LABEL, vr.conclusion, vr.conclusion) }}
                        </div>
                      </div>
                      <div v-if="selected.material.advisory_records?.length" class="pn-sub pn-wrap">
                        <h4>移送时的联系与观察记录</h4>
                        <AdvisoryRecords :records="selected.material.advisory_records" />
                      </div>
                      <div v-if="selected.material.disposals?.length" class="pn-sub pn-wrap">
                        <div v-for="d in selected.material.disposals" :key="d.authorization_id">
                          {{ labelOf(DISPOSAL_ACTION_LABEL, d.action_type) }} · {{ disposalStatusText(d) }}
                          <span v-if="materialAuthorizationMode(d)" class="tag t-gray">{{ materialAuthorizationMode(d) }}</span>
                          <p class="pn-material-meta">
                            {{ d.authorization_mode === 'DIRECT' ? '发起人' : '申请人' }}：{{ d.requested_by_name || '未记录' }}
                            <span v-if="d.authorization_mode !== 'DIRECT' && d.approved_by_name"> · 审批人：{{ d.approved_by_name }}</span>
                          </p>
                        </div>
                      </div>
                      <HandoffMaterialFacts :material="selected.material" :evidence-availability="selected.availability?.evidence || ''" />
                        </div>
                      </details>
                    </template>
                  </div>
                  <PunishmentNotification :key="selected.handoff_id" :handoff-id="selected.handoff_id" :recipient-name="selected.recipient_name" @status="updateNotificationStatus" />
                  <PunishmentOutcome class="pn-section pn-section-outcome" :key="selected.handoff_id" :handoff-id="selected.handoff_id" />
                </template>
              </div>
              <div id="pnNotifyDock" class="pn-notify-dock"></div>
            </UPanel>
          </div>
        </template>
      </div>
      <ModuleStatistics :state="statistics.state" @retry="retryList" />
    </div>
  </div>
</template>

<style scoped>
.pn-frozen-link { color: var(--cyan); text-decoration: underline; overflow-wrap: anywhere; }
.pn-frozen-link:hover { color: var(--txt); }
.pn-frozen-link:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.pn-body { display: flex; flex-direction: column; min-height: 0; overflow: auto; }
.pn-forbidden, .pn-note { margin: 0 0 12px; }
/* 清单和详情各自滚动；筛选换行时保留记录区，矮窗口通过 pn-body 查看下方统计。 */
.pn-main { align-items: stretch; gap: var(--gap); min-height: 440px; flex: 1 0 440px; overflow: hidden; }
.pn-main :deep(.panel > .pb) { display: flex; flex-direction: column; overflow: hidden; }
.pn-list { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pn-toolbar { --filter-field-width: 160px; }
.pn-range { --filter-field-width: 380px; }
.pn-status { min-width: 110px; white-space: nowrap; }
.pn-status .tag { white-space: nowrap; height: auto; }
:deep(.pn-kpis) { grid-template-columns: repeat(5, minmax(0, 1fr)); }
:deep(.pn-kpis .lb) { white-space: normal; overflow-wrap: anywhere; }
.pn-error { margin: 8px 10px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tb tr { cursor: pointer; }
.tb tr.on { background: var(--surface-selected); }
.pn-id { display: inline-block; max-width: 160px; white-space: normal; overflow-wrap: anywhere; vertical-align: bottom; }
.pn-sub { font-size: 11px; color: var(--txt-3); white-space: normal; line-height: 1.4; overflow-wrap: anywhere; }
.pn-wrap { white-space: normal; line-height: 1.4; overflow-wrap: anywhere; }
.pager { display: flex; justify-content: flex-end; padding: 10px; }
.pn-notify-dock:empty { display: none; }
.pn-notify-dock:not(:empty) {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 12px 16px;
  background: var(--surface-1);
  border-top: 1px solid var(--line);
}
.pn-notify-dock :deep(.notify-send) {
  flex: none;
  margin-left: auto;
  min-height: 36px;
  max-width: 100%;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  white-space: normal;
  height: auto;
}
.pn-notify-dock :deep(.notify-send:focus-visible) {
  outline: 2px solid var(--cyan);
  outline-offset: 3px;
}
.pn-notify-dock :deep(.notify-block) {
  flex: 1 1 160px;
  min-width: 0;
  margin: 0;
  color: var(--amber);
  font-size: 13px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.pn-detail { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.pn-detail .detail-hero-title, .pn-detail .detail-hero-id { display: block; overflow: visible; white-space: normal; text-overflow: unset; -webkit-line-clamp: unset; overflow-wrap: anywhere; }
/* 按信息用途配色，状态标签仍沿用既有语义色。 */
.pn-detail .detail-hero.detail-hero-micro {
  background: color-mix(in srgb, var(--indigo) 8%, var(--surface-1));
  border-color: color-mix(in srgb, var(--indigo) 32%, var(--line));
  border-left: 3px solid var(--indigo);
}
.pn-detail .detail-hero-icon {
  color: var(--purple);
  background: color-mix(in srgb, var(--purple) 12%, var(--surface-1));
  border-color: color-mix(in srgb, var(--purple) 40%, transparent);
}
.pn-detail .detail-hero-eyebrow { color: var(--purple); }
.pn-detail .detail-hero-id { color: var(--cyan); }
.pn-detail .pn-section-info { --pn-accent: var(--cyan); }
.pn-detail .pn-section-evidence { --pn-accent: var(--purple); }
.pn-detail .pn-section-material { --pn-accent: var(--orange); }
.pn-material-summary p { margin: 0; line-height: 1.6; }
.pn-material-summary { color: var(--txt); font-size: 13px; }
.pn-material-meta { margin: 3px 0 6px; color: var(--txt-2); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.pn-material-details { margin-top: 6px; font-size: 12px; }
.pn-material-details > summary { width: fit-content; padding: 4px 0; color: var(--orange); cursor: pointer; }
.pn-material-details > summary:hover { color: var(--txt); }
.pn-material-details > summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; border-radius: 3px; }
.pn-material-details:not([open]) .pn-material-collapse, .pn-material-details[open] .pn-material-expand { display: none; }
.pn-material-content { display: grid; gap: 10px; padding: 8px 0 0 12px; margin-top: 4px; border-left: 1px solid var(--line); }
.pn-detail :deep(.punishment-notification) { --pn-accent: var(--blue); }
.pn-detail .pn-section-outcome { --pn-accent: var(--indigo); }
.pn-detail :deep(:is(.pn-section, .punishment-notification) h4) { color: color-mix(in srgb, var(--pn-accent) 72%, var(--txt)); }
.pn-detail :deep(:is(.pn-section, .punishment-notification) h4::before) { background: var(--pn-accent); }
.pn-detail :deep(:is(.pn-section, .punishment-notification) .kv-surface) {
  background: color-mix(in srgb, var(--pn-accent) 5%, var(--surface-1));
  border-color: color-mix(in srgb, var(--pn-accent) 24%, var(--line));
}
.pn-detail :deep(:is(.pn-section, .punishment-notification) .kv-surface > dd) { color: var(--txt); }
.pn-detail :deep(:is(.pn-section, .punishment-notification) .kv-surface > dt) { color: var(--txt-2); }
.pn-detail :deep(:is(.pn-section, .punishment-notification) .kv-surface > .pn-recipient) { color: var(--cyan); font-weight: 600; }
</style>
