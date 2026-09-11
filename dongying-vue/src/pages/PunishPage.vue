<script>
/* 模块级状态：跨导航保持筛选、分页与选中项（legacy 约定）。 */
const S = {
  page: 1, size: 20, selectedHandoffId: null,
  filters: { notify_status: '', created: null }
};
export default {};
</script>

<script setup>
/* 处置处罚管理：业务交接清单只列无人机事件的处罚交接。
   通知状态是页面口径：已通知 / 未通知。未通知时可点「通知处罚部门」，先走统一确认弹窗，确认后本期只记录已提交、不调接口。 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import AuthorizationQueue from '@/pages/punish/AuthorizationQueue.vue';
import UPagination from '@/components/UPagination.vue';
import UControl from '@/components/form/UControl.vue';
import { toast } from '@/ui/nv.js';
import { openConfirm } from '@/ui/confirm.js';
import { UAV_STATE_TEXT as UAV_STATE_LABEL } from '@/ui/uavVerificationModal.js';
import { handoffApi } from '@/services/handoffApi.js';
import { getEvidenceChain } from '@/services/evidenceApi.js';
import {
  ALARM_TYPE_LABEL, CONCLUSION_LABEL as EVENT_CONCLUSION_LABEL,
  DISPOSAL_ACTION_LABEL, HANDOFF_KIND_LABEL, HANDOFF_TYPE_LABEL, SOURCE_MODE_LABEL,
  disposalStatusText, labelOf, readableNo
} from '@/ui/labels.js';
import { chainTypeCards, openEvidenceChainTypeModal } from '@/ui/evidenceChainView.js';

usePageChrome('punish');
const root = ref(null);
const activeTab = ref('handoffs');
const U = window.UI;

const UAV_KIND = 'UAV_EVENT';
const KIND_LABEL = HANDOFF_KIND_LABEL;
const TYPE_LABEL = HANDOFF_TYPE_LABEL;
const notifyOptions = [
  { label: '全部通知状态', value: '' },
  { label: '未通知', value: 'UNNOTIFIED' },
  { label: '已通知', value: 'NOTIFIED' }
];

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
const chain = ref(null);
const chainLoading = ref(false);
const chainError = ref('');
const legacyLinkNote = ref('');
const notifiedIds = ref(new Set());
let listToken = 0, kpiToken = 0, detailToken = 0, chainToken = 0;

function isNotified(row) {
  if (!row) return false;
  if (notifiedIds.value.has(row.handoff_id)) return true;
  return row.delivery_status === 'DELIVERED' || row.receipt_status === 'ACKNOWLEDGED';
}
function notifyLabel(row) { return isNotified(row) ? '已通知' : '未通知'; }
function notifyTag(row) { return isNotified(row) ? 't-green' : 't-amber'; }
function notifyTone(row) { return isNotified(row) ? 'good' : 'warn'; }

async function notifyDepartment() {
  const row = selected.value;
  if (!row || isNotified(row)) return;
  const sourceNo = readableNo(row.source_no, row.source_id) || '该交接';
  const recipient = row.recipient_name || '处罚接收方';
  const ok = await new Promise(resolve => openConfirm({
    title: '通知处罚部门',
    message: `将把 ${sourceNo} 的处罚交接通知「${recipient}」。确认后只记录已提交通知，不表示处罚已立案或办结。是否继续？`,
    confirmText: '确认通知',
    onConfirm: () => { resolve(true); return true; },
    onCancel: () => resolve(false)
  }));
  if (!ok) return;
  const next = new Set(notifiedIds.value);
  next.add(row.handoff_id);
  notifiedIds.value = next;
  toast('已提交', 'ok');
}

const kpiList = computed(() => {
  const value = key => (kpiFailed.value[key] ? '—' : kpiTotals.value[key] == null ? '…' : Number(kpiTotals.value[key]).toLocaleString('en-US'));
  const desc = (key, text) => (kpiFailed.value[key] ? '总数读取失败' : text);
  if (forbidden.value) return [
    { label: '交接总数', value: '—', color: 'blue', icon: 'gavel', desc: '无 handoff:read 权限' },
    { label: '未通知', value: '—', color: 'amber', icon: 'alert', desc: '无 handoff:read 权限' },
    { label: '已通知', value: '—', color: 'green', icon: 'check', desc: '无 handoff:read 权限' }
  ];
  return [
    { label: '交接总数', value: value('all'), color: 'blue', icon: 'gavel', desc: desc('all', '无人机事件处罚交接') },
    { label: '未通知', value: value('pending'), color: 'amber', icon: 'alert', desc: desc('pending', '尚未通知处罚部门') },
    { label: '已通知', value: value('delivered'), color: 'green', icon: 'check', desc: desc('delivered', '已通知处罚部门') }
  ];
});

const detailExtra = computed(() => {
  const row = selected.value;
  if (!row) return '';
  return `<span class="tag ${notifyTag(row)}">${notifyLabel(row)}</span>`;
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
  const query = { source_kind: UAV_KIND };
  if (filters.notify_status === 'NOTIFIED') query.delivery_status = 'DELIVERED';
  if (filters.notify_status === 'UNNOTIFIED') query.delivery_status = 'PENDING_DELIVERY';
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
  const queries = { all: { ...base }, pending: { ...base, delivery_status: 'PENDING_DELIVERY' }, delivered: { ...base, delivery_status: 'DELIVERED' } };
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
    else { selected.value = null; S.selectedHandoffId = null; }
  } catch (requestError) {
    if (token !== listToken) return;
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

watch(() => filters.notify_status, () => applyFilters());
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
      ? '当前账号没有 evidence:read，无法读取证据链。'
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
    legacyLinkNote.value = `本期未建设处罚案件对象：旧案件深链 ${String(context.caseId)} 无对应记录，下方为真实交接清单。`;
  }
  return typeof handoffId === 'string' && handoffId ? handoffId : null;
}

onMounted(() => {
  const requested = consumeDeepLink();
  if (requested) { Object.assign(filters, { notify_status: '', created: null }); S.selectedHandoffId = requested; }
  loadKpis();
  loadList(requested ? 1 : page.value, requested);
});
</script>

<template>
  <div class="view" id="view" ref="root" style="overflow:hidden">
    <div style="height:100%;display:flex;flex-direction:column;min-height:0">
      <UKpis :list="kpiList" />
      <div class="toolbar" style="display:flex;gap:8px;margin-top:12px">
        <button class="btn" :class="{ pri: activeTab === 'authorizations' }" @click="activeTab = 'authorizations'">反制授权</button>
        <button class="btn" :class="{ pri: activeTab === 'handoffs' }" @click="activeTab = 'handoffs'">交接与处罚</button>
      </div>
      <AuthorizationQueue v-if="activeTab === 'authorizations'" />
      <div v-show="activeTab === 'handoffs'" id="pnBody" class="pn-body" style="margin-top:12px;flex:1;min-height:0">
        <div v-if="forbidden" class="warnbox pn-forbidden">
          当前账号没有查看业务交接的权限（handoff:read）。交接清单、材料与通知状态不可读取；本页不展示任何演示数据。
          <button class="btn" type="button" :disabled="listLoading" @click="retryList">重试</button>
        </div>
        <template v-else>
          <div v-if="legacyLinkNote" class="warnbox pn-note">{{ legacyLinkNote }}</div>
          <div class="row pn-main">
            <UPanel title="业务交接清单" panel-style="flex:6;min-width:0" nopad>
              <div id="pnList" class="pn-list">
                <div class="toolbar pn-toolbar">
                  <div class="toolbar-fields">
                    <div class="field"><label>通知状态</label><UControl v-model="filters.notify_status" type="select" :options="notifyOptions" :disabled="listLoading" size="small" /></div>
                    <div class="field pn-range"><label>提交时间</label><UControl v-model="filters.created" type="datetimerange" clearable :disabled="listLoading" size="small" start-placeholder="开始" end-placeholder="结束" /></div>
                  </div>
                  <div class="toolbar-actions">
                    <button class="btn" type="button" :disabled="listLoading" @click="applyFilters">查询</button>
                  </div>
                </div>
                <div v-if="listError" class="warnbox pn-error">{{ listError }} <button class="btn" type="button" :disabled="listLoading" @click="retryList">重试</button></div>
                <div v-if="listLoading && !handoffs.length" class="empty">正在读取交接清单…</div>
                <div v-else-if="!listError && !handoffs.length" class="empty">当前筛选与权限范围内暂无无人机事件处罚交接。</div>
                <div v-else-if="handoffs.length" class="scroll table-scroll table-shell" style="flex:1">
                  <table class="tb">
                    <thead><tr>
                      <th>来源编号</th>
                      <th>来源事项</th>
                      <th>接收方</th>
                      <th>提交时间</th>
                      <th>通知状态</th>
                    </tr></thead>
                    <tbody>
                      <tr v-for="row in handoffs" :key="row.handoff_id" :data-row="row.handoff_id" tabindex="0" :class="{ on: selected?.handoff_id === row.handoff_id || (!selected && S.selectedHandoffId === row.handoff_id) }"
                        @click="selectHandoff(row.handoff_id)" @keydown.enter.prevent="selectHandoff(row.handoff_id)">
                        <td class="num"><span class="mono pn-id" :title="row.handoff_id">{{ readableNo(row.source_no, row.source_id) || '—' }}</span></td>
                        <td><span class="tag t-cyan" :title="row.source_id">{{ label(KIND_LABEL, row.source_kind) }}</span></td>
                        <td><div class="pn-wrap" :title="row.recipient_id">{{ row.recipient_name || '—' }}</div><div class="pn-sub">{{ labelOf(SOURCE_MODE_LABEL, row.source_mode, '') }}</div></td>
                        <td class="num" :title="formatTime(row.created_at)">{{ formatClock(row.created_at) }}</td>
                        <td><span class="tag" :class="notifyTag(row)">{{ notifyLabel(row) }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="pager"><UPagination :page="page" :page-size="size" :item-count="total" :prefix="`共 ${total.toLocaleString('en-US')} 条`" @update:page="changePage" @update:page-size="changePageSize" /></div>
              </div>
            </UPanel>

            <UPanel title="交接详情" panel-style="flex:4;min-width:340px" nopad :extra="detailExtra">
              <div id="pnDetail" class="pn-detail">
                <div v-if="detailLoading" class="empty">正在读取交接详情…</div>
                <div v-else-if="detailError" class="warnbox pn-error">{{ detailError }} <button class="btn" type="button" @click="retryDetail">重试</button></div>
                <div v-else-if="!selected" class="empty">{{ handoffs.length ? '请选择交接记录' : '暂无可显示的交接记录' }}</div>
                <template v-else>
                  <div class="detail-hero detail-hero-micro"><div class="detail-hero-inner">
                    <div class="detail-hero-icon" v-html="U?.icon ? U.icon('clipboard') : ''"></div>
                    <div class="detail-hero-copy"><div class="detail-hero-eyebrow">业务交接</div><div class="detail-hero-title">{{ label(TYPE_LABEL, selected.handoff_type) }}</div><div v-if="readableNo(selected.source_no, selected.source_id)" class="detail-hero-id mono" :title="selected.handoff_id">{{ readableNo(selected.source_no, selected.source_id) }}</div></div>
                    <div class="detail-hero-side"><div class="detail-hero-tags"><span class="tag" :class="notifyTag(selected)">{{ notifyLabel(selected) }}</span></div></div>
                  </div></div>
                  <div class="metric-strip is-compact">
                    <div class="metric-item" :class="'is-' + notifyTone(selected)"><span class="metric-copy"><small>通知状态</small><b>{{ notifyLabel(selected) }}</b></span></div>
                    <div class="metric-item"><span class="metric-copy"><small>接收方</small><b>{{ selected.recipient_name || '—' }}</b></span></div>
                    <div class="metric-item"><span class="metric-copy"><small>提交时间</small><b>{{ formatClock(selected.created_at) }}</b></span></div>
                  </div>
                  <div class="sect"><h4>交接信息</h4><dl class="kv kv-surface">
                    <dt>来源编号</dt><dd class="mono" :title="selected.handoff_id">{{ readableNo(selected.source_no, selected.source_id) || '未提供' }}</dd>
                    <dt>来源事项</dt><dd :title="selected.source_id">{{ label(KIND_LABEL, selected.source_kind) }}</dd>
                    <dt>接收方</dt><dd :title="selected.recipient_id">{{ selected.recipient_name || '未提供' }}</dd>
                    <dt>提交时间</dt><dd>{{ formatTime(selected.created_at) }}</dd>
                    <dt>提交人</dt><dd :title="selected.submitted_by">{{ selected.submitted_by_name || selected.submitted_by || '未提供' }}</dd>
                    <dt>所属范围</dt><dd :title="`${selected.owner_org_id || ''} / ${selected.district_id || ''}`">{{ selected.owner_org_name || '—' }} / {{ selected.district_name || '—' }}</dd>
                  </dl></div>
                  <div class="sect"><h4>证据链
                    <span class="tag t-gray">{{ chainTotal }} 项</span>
                    <span v-if="chainBroken" class="tag t-red">{{ chainBroken }} 份校验异常</span>
                  </h4>
                    <div v-if="chainLoading" class="empty">正在读取证据链…</div>
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
                      <div v-if="chain.integrity" class="ev-chain-integrity" :title="chain.integrity.checksum">
                        链校验 {{ chain.integrity.algorithm }}
                      </div>
                    </template>
                  </div>
                  <div class="sect"><h4>材料快照 <span v-if="selected.material?.schema_version" class="tag t-gray">第 {{ selected.material.schema_version }} 版</span></h4>
                    <div v-if="!selected.material" class="empty">这条交接没有材料快照。</div>
                    <template v-else>
                      <dl v-if="selected.material.event" class="kv kv-surface">
                        <dt>事件编号</dt><dd class="mono" :title="selected.material.event.event_id">{{ readableNo(selected.material.event.source_alarm_id) || '未提供' }}</dd>
                        <dt>告警类型</dt><dd>{{ labelOf(ALARM_TYPE_LABEL, selected.material.event.alarm_type, '未提供') }}</dd>
                        <dt>提交时状态</dt><dd>{{ labelOf(UAV_STATE_LABEL, selected.material.event.state, '未提供') }}</dd>
                        <dt>发生时间</dt><dd>{{ formatTime(selected.material.event.occurred_at) }}</dd>
                      </dl>
                      <div v-if="selected.material.verifications?.length" class="pn-sub pn-wrap">
                        <div v-for="(vr, i) in selected.material.verifications" :key="i">
                          核实结论：{{ labelOf(EVENT_CONCLUSION_LABEL, vr.conclusion, vr.conclusion) }}
                          <span v-if="vr.actor_name"> · {{ vr.actor_name }}</span><span v-if="vr.note"> · {{ vr.note }}</span>
                        </div>
                      </div>
                      <div v-if="selected.material.disposals?.length" class="pn-sub pn-wrap">
                        <div v-for="d in selected.material.disposals" :key="d.authorization_id">
                          <span class="mono" :title="d.authorization_id">{{ d.authorization_no }}</span>
                          · {{ labelOf(DISPOSAL_ACTION_LABEL, d.action_type) }} · {{ disposalStatusText(d) }}
                          <span v-if="d.approved_by_name"> · 审批人：{{ d.approved_by_name }}</span>
                        </div>
                      </div>
                      <div v-if="!selected.material.event" class="empty">快照中没有事件材料。</div>
                      <div class="pn-note-text">交接材料只含结构化字段；没有文件、哈希或下载链接，也不生成证据台账。</div>
                    </template>
                  </div>
                  <div v-if="!isNotified(selected)" class="detail-actions is-sticky">
                    <button class="btn pri" type="button" title="先确认再记录已通知；不表示处罚已立案或办结" @click="notifyDepartment">通知处罚部门</button>
                  </div>
                </template>
              </div>
            </UPanel>
          </div>
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
.pn-wrap { white-space: normal; line-height: 1.4; overflow-wrap: anywhere; }
.pager { display: flex; justify-content: flex-end; padding: 10px; }
.pn-detail { flex: 1; overflow: auto; padding: 12px; }
.pn-note-text { margin: 6px 0 4px; font-size: 11px; color: var(--txt-3); line-height: 1.6; }
</style>
