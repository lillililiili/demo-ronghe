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
   案件管理、罚款/裁量、处罚文书、证据链与定性复核自阶段 14 起接后端案件域（不用 handoff_id 伪装 case_id）；
   反制与干扰授权记录自阶段 13 起接处置授权域。每块仍存在的缺口逐条写在 BLOCK_GAPS 里，不写笼统的“未建设”。
   API 失败只显示失败态，不回退 Mock。 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { usePageChrome } from '@/hooks/usePageChrome.js';
import UKpis from '@/components/UKpis.vue';
import UPanel from '@/components/UPanel.vue';
import UPagination from '@/components/UPagination.vue';
import UControl from '@/components/form/UControl.vue';
import { toast } from '@/ui/nv.js';
import { hasPermission } from '@/services/accessControl.js';
import { UAV_STATE_TEXT as UAV_STATE_LABEL } from '@/ui/uavVerificationModal.js';
import { handoffApi } from '@/services/handoffApi.js';
import { getEvidenceChain, listEvidenceFiles } from '@/services/evidenceApi.js';
import { disposalApi, isDisposalUnavailable } from '@/services/disposalApi.js';
import { fetchDocumentContent, isPunishmentUnavailable, punishmentApi, PUNISHMENT_UNAVAILABLE_TEXT } from '@/services/punishmentApi.js';
import {
  confirmDiscretion, openCaseAssign, openCaseClose, openCaseFile, openCaseReview, openCaseWithdraw,
  openDiscretionDraft, openDocumentRevoke, openLeadAdd, openLeadResolve, yuan
} from '@/ui/punishmentModals.js';
import {
  DISPOSAL_UNAVAILABLE_TEXT, openDisposalApproval, openDisposalExecution, openDisposalManualResult, openDisposalStop
} from '@/ui/disposalAuthModal.js';
import { ALARM_TYPE_LABEL, CASE_EVENT_KIND_LABEL, CASE_STATUS_LABEL, CONCLUSION_LABEL as EVENT_CONCLUSION_LABEL, DELIVERY_STATUS_LABEL, DISCRETION_STATUS_LABEL, DISPOSAL_ACTION_LABEL, DISPOSAL_BLOCK_REASON_LABEL, DISPOSAL_CHANNEL_LABEL, DISPOSAL_EVENT_KIND_LABEL, DISPOSAL_RESULT_LABEL, DOCUMENT_STATUS_LABEL, EVIDENCE_COVERAGE_LABEL, EVIDENCE_KIND_LABEL, EVIDENCE_RECORD_TYPE_LABEL, HANDOFF_BLOCKED_LABEL, HANDOFF_KIND_LABEL, HANDOFF_TYPE_LABEL, LEAD_KIND_LABEL, PENALTY_TYPE_LABEL, REASON_CODE_LABEL, RECEIPT_STATUS_LABEL, REVIEW_CONCLUSION_LABEL, RISK_CONCLUSION_LABEL, RISK_STATE_LABEL, RISK_TYPE_LABEL, SEVERITY_LABEL, SEVERITY_TAG, SOURCE_MODE_LABEL, VIOLATION_CODE_LABEL, disposalStatusText, labelOf, readableNo, verificationOrdinal } from '@/ui/labels.js';
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
const FIXED_SORT_NOTE = '当前按提交时间倒序：created_at DESC, handoff_id DESC';
/* 五块的边界说明：接上案件域之后不再是"整块未建设"，但每块仍有具体的、说得清的缺口，逐条写明白。 */
const BLOCK_GAPS = {
  case: '案件只在本平台内流转：外部处罚系统与文书报送渠道尚未接入',
  penalty: '罚则档位与金额区间是演示值，未经业务方确认',
  doc: '决定书为平台内生成的演示文本，无法律效力，也不提供下载（只能在平台内预览与复制）',
  evidence: '上方为移送时事件上的证据快照；下方为立案后挂到本案的证据文件',
  review: '复核只记录在本平台，未接入上级法制机构的复核流程'
};

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

/* 处罚案件（阶段 14）：按所选交接读案件、事件流、裁量、文书与罚则档位。
   读不到（14.1 未落地时是 404）显示原因；没有案件显示"尚未立案"——两者不互相冒充。 */
const punishment = reactive({
  loading: false, unavailable: false, error: '',
  caseRow: null, events: [], documents: [], rules: [], officers: [],
  caseEvidence: [], caseEvidenceOmitted: false, caseEvidenceError: ''
});

/* 只清与所选交接有关的部分：罚则档位是全局字典，重选交接不必重读。 */
function resetPunishment() {
  Object.assign(punishment, { loading: false, unavailable: false, error: '', caseRow: null, events: [], documents: [],
    caseEvidence: [], caseEvidenceOmitted: false, caseEvidenceError: '' });
}

async function loadPunishment(row) {
  resetPunishment();
  // 罚则档位与所选交接无关，先单独读一次：读不到要能说清是"服务没接入"还是"确实没有档位"，
  // 不能因为所选交接不是处罚移送就显示成"暂无档位"。
  if (!punishment.rules.length) {
    try {
      const rules = await punishmentApi.penaltyRules();
      punishment.rules = Array.isArray(rules) ? rules : (rules?.items || []);
    } catch (error) {
      punishment.unavailable = isPunishmentUnavailable(error);
      punishment.error = punishment.unavailable ? PUNISHMENT_UNAVAILABLE_TEXT : messageOf(error, '读取罚则档位失败');
    }
  }
  if (!row?.handoff_id || row.handoff_type !== 'UAV_PUNISHMENT') return;
  punishment.loading = true;
  try {
    const page = await punishmentApi.listCases({ handoff_id: row.handoff_id, page: 1, size: 1 });
    const brief = (page?.items || [])[0] || null;
    if (brief?.case_id) {
      const [detail, events, documents] = await Promise.all([
        punishmentApi.getCase(brief.case_id),
        punishmentApi.caseEvents(brief.case_id).catch(() => []),
        punishmentApi.listDocuments(brief.case_id).catch(() => [])
      ]);
      punishment.caseRow = detail || brief;
      punishment.events = Array.isArray(events) ? events : (events?.items || []);
      punishment.documents = Array.isArray(documents) ? documents : (documents?.items || []);
      try {
        const files = await listEvidenceFiles({ subject_kind: 'CASE', subject_id: punishment.caseRow.case_id, page: 1, size: 100 });
        punishment.caseEvidence = files?.items || [];
        punishment.caseEvidenceOmitted = false;
        punishment.caseEvidenceError = '';
      } catch (error) {
        if (error.status === 403) {
          punishment.caseEvidence = [];
          punishment.caseEvidenceOmitted = true;
          punishment.caseEvidenceError = '';
        } else {
          punishment.caseEvidence = [];
          punishment.caseEvidenceOmitted = false;
          punishment.caseEvidenceError = messageOf(error, '读取案件证据失败');
        }
      }
    }
  } catch (error) {
    punishment.unavailable = isPunishmentUnavailable(error);
    punishment.error = punishment.unavailable ? PUNISHMENT_UNAVAILABLE_TEXT : messageOf(error, '读取处罚案件失败');
  } finally {
    punishment.loading = false;
  }
}

/* 案件详情给的是 current_discretion（单个对象）与 open_leads（只含未解决的），
   没有 discretions[]/leads[]/reviews[] 这些数组；复核历史只能从事件流里取 REVIEWED 事件。 */
const currentDiscretion = computed(() => punishment.caseRow?.current_discretion || null);
const caseActions = computed(() => punishment.caseRow?.allowed_actions || []);
const leads = computed(() => punishment.caseRow?.open_leads || []);
const reviewEvents = computed(() => punishment.events.filter(ev => ev.event_kind === 'REVIEWED'));
/* 材料快照 v2 的证据段；availability.evidence 决定"为什么看不到"，空数组不等于无权限。 */
const materialEvidence = computed(() => selected.value?.material?.evidence || []);
const evidenceAvailability = computed(() => selected.value?.availability?.evidence || null);
const evidenceNote = computed(() => {
  const state = evidenceAvailability.value;
  if (state === 'FORBIDDEN') return '当前账号无证据查看权限';
  if (state === 'OMITTED_AT_SUBMISSION') return '提交人当时无证据查看权限，材料未含证据清单';
  // 与 material 的同名取值用同一句：同一个原因在同一页上不能有两种说法。
  if (state === 'SOURCE_NOT_VISIBLE') return '源事件已不在当前可见范围，服务端已省略证据清单。';
  // 材料包第 1 版（阶段 5 的风险移送）里没有证据这一段：说"没有关联证据"是替服务端下了它没下的结论。
  const version = Number(selected.value?.material?.schema_version || 0);
  if (version && version < 2) return '这条交接的材料包是第 1 版，当时的材料不含证据清单';
  if (!selected.value?.material) return '这条交接没有材料快照';
  if (!materialEvidence.value.length) return '移送时该事件没有关联证据';
  return '';
});

/* 立案按钮：既要有处罚移送交接，也要有立案权限；两者缺一都禁用并在 title 说明是哪一样缺。 */
/* 前端只看菜单级权限（permission_codes 是 punishment.read/op/auth 这种模块码，没有 punishment:file 这种动作码），
   真正的动作权限由服务端判：够不到就让 403 说话，不在前端预判（14-18）。 */
const canFileCase = computed(() => selected.value?.handoff_type === 'UAV_PUNISHMENT'
  && !punishment.unavailable && hasPermission('punishment.op'));

async function refreshPunishment() {
  const row = selected.value;
  if (row) await loadPunishment(row);
  return punishment.caseRow;
}

/* 决定书正文：平台内预览与复制，不提供下载（浏览器沙箱里下载链接是死的）。 */
const documentPreview = reactive({ open: false, title: '', text: '', error: '' });
async function previewDocument(doc) {
  documentPreview.open = true; documentPreview.title = doc.document_no || ''; documentPreview.text = ''; documentPreview.error = '';
  try {
    documentPreview.text = await fetchDocumentContent(doc.document_id);
  } catch (error) {
    documentPreview.error = messageOf(error, '文书正文读取失败');
  }
}
async function copyDocument() {
  try {
    await navigator.clipboard.writeText(documentPreview.text || '');
    toast('决定书全文已复制', 'ok');
  } catch {
    toast('复制失败，请手动选中全文复制', 'err');
  }
}

async function issueDocument() {
  const c = punishment.caseRow;
  if (!c?.case_id) return;
  try {
    await punishmentApi.issueDocument(c.case_id, { expected_version: Number(c.version) });
    toast('决定书已出具', 'ok');
    await refreshPunishment();
  } catch (error) {
    toast(messageOf(error, '出具决定书失败'), 'err');
  }
}

/* 每行能点哪些动作由服务端逐条返回的 allowed_actions 决定（决策 15-35）：
   它已经把"状态允不允许"和"这个人有没有这项权限"两件事都算进去了，前端再自己判一遍只会与它不一致。
   没有这个字段、或者它是空的，就一个按钮都不画——不画"点了才吃 403"的按钮。
   批准与驳回是同一个弹窗里的两个结论，所以只画一颗"审批"。
   撤回（CANCEL）暂不画：还没有对应的弹窗，画一颗点不动的按钮不如不画。 */
const DISPOSAL_ROW_ACTIONS = [
  { key: 'approve', codes: ['APPROVE', 'REJECT'], label: '审批', open: openDisposalApproval, title: '批准或驳回这条申请；审批人不能是申请人' },
  { key: 'execute', codes: ['EXECUTE'], label: '执行', open: openDisposalExecution, title: '按已批准的处置下发执行指令' },
  { key: 'manual', codes: ['MANUAL_RESULT'], label: '登记执行结果', open: openDisposalManualResult, title: '人工执行的处置在现场完成后登记结果' },
  { key: 'stop', codes: ['STOP'], label: '停止', open: openDisposalStop, title: '立即停止这条处置，并尝试让设备急停' }
];
function disposalRowActions(row) {
  const allowed = Array.isArray(row?.allowed_actions) ? row.allowed_actions : [];
  return DISPOSAL_ROW_ACTIONS.filter(action => action.codes.some(code => allowed.includes(code)));
}
/* 写完之后回读这一行并交回给弹窗：结果未确认时，弹窗要靠这条记录判断服务端到底落库了没有。 */
async function refreshDisposalRow(authorizationId) {
  await loadDisposals(selected.value);
  return disposals.value.find(row => row.authorization_id === authorizationId) || null;
}
function runDisposalAction(action, row) {
  action.open({ authorization: row, refresh: () => refreshDisposalRow(row.authorization_id) });
}

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
  const desc = (key, text) => (kpiFailed.value[key] ? '总数读取失败' : text);
  if (forbidden.value) return [
    { label: '交接总数', value: '—', color: 'blue', icon: 'gavel', desc: '无 handoff:read 权限' },
    { label: '待投递', value: '—', color: 'amber', icon: 'alert', desc: '无 handoff:read 权限' },
    { label: '已送达', value: '—', color: 'green', icon: 'check', desc: '无 handoff:read 权限' }
  ];
  return [
    { label: '交接总数', value: value('all'), color: 'blue', icon: 'gavel', desc: desc('all', '当前权限范围内总数') },
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
/* 服务端 availability.material：FORBIDDEN（缺 risk:read）/ SOURCE_NOT_VISIBLE（源风险不在可见范围）时材料被省略。
   兜底那句要按材料包版本分开说：第 2 版是无人机事件移送，里面本来就没有"风险材料"这一段，
   照搬第 1 版的说法会让人以为数据缺了。 */
const materialUnavailableText = computed(() => {
  const availability = selected.value?.availability?.material;
  const kind = selected.value?.source_kind === 'UAV_EVENT' ? '事件' : '风险';
  if (availability === 'FORBIDDEN') return `当前账号没有查看源${kind}的权限，已省略材料与核实历史。`;
  if (availability === 'SOURCE_NOT_VISIBLE') return `源${kind}已不在当前可见范围，已省略材料与核实历史。`;
  return Number(selected.value?.material?.schema_version || 0) >= 2
    ? '快照中没有事件材料。'
    : '快照中没有风险材料。';
});
const deliveryNote = computed(() => {
  const row = selected.value;
  if (!row) return '';
  if (row.delivery_status === 'PENDING_DELIVERY') return '已提交，尚未发送：材料已入库等待投递，通知渠道未接通。提交成功不等于已通知上级，也不等于处罚办结。';
  if (row.delivery_status === 'DELIVERED') return `接收方已接收交接材料${row.receipt_status === 'ACKNOWLEDGED' ? '并回执' : ''}；送达不等于处罚办结。`;
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
    loadPunishment(detail);             // 处罚案件同理：读失败只影响这五块，不影响交接清单
    deliveries.value = history.items || [];
    deliveriesTotal.value = history.total;
    deliveriesPage.value = history.page;
    loadChain(detail);
  } catch (requestError) {
    if (token !== detailToken) return;
    selected.value = null;
    disposals.value = []; disposalEvents.value = []; disposalError.value = ''; disposalUnavailable.value = false;
    resetPunishment();
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

// 三个下拉一改就查（决策 15-56）；时间范围仍走查询按钮，避免选到一半就发请求。
watch(() => [filters.source_kind, filters.delivery_status, filters.source_mode], () => applyFilters());
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
          当前账号没有查看业务交接的权限（handoff:read）。交接清单、材料与投递状态不可读取；本页不展示任何演示数据。
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
                    <span class="toolbar-note" :title="FIXED_SORT_NOTE">按提交时间倒序</span>
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
                        <td class="num"><span class="mono pn-id" :title="row.handoff_id">{{ readableNo(row.source_no) || '—' }}</span></td>
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
                    <div class="detail-hero-copy"><div class="detail-hero-eyebrow">业务交接</div><div class="detail-hero-title">{{ label(TYPE_LABEL, selected.handoff_type) }}</div><div v-if="readableNo(selected.source_no)" class="detail-hero-id mono" :title="selected.handoff_id">{{ readableNo(selected.source_no) }}</div></div>
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
                    <dt>来源编号</dt><dd class="mono" :title="selected.handoff_id">{{ readableNo(selected.source_no) || '未提供' }}</dd>
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
                          :title="recordHint(row, chain)"
                          :aria-label="'查看证据：' + recordCaption(row)"
                          @click="isFileRecord(row) && openEvidenceFileModal(row.record_id)">
                          <span>{{ recordCaption(row) }}</span>
                          <small>{{ isFileRecord(row) ? '打开文件' : recordHint(row, chain) }}</small>
                        </button>
                      </div>
                      <div v-if="chainRecords.length > 8" class="pn-note-text">另有 {{ chainRecords.length - 8 }} 项，可在「证据管理」查看文件台账。</div>
                      <div v-if="chain.integrity" class="pn-note-text" :title="`${chain.integrity.algorithm} ${chain.integrity.checksum}`">链校验已生成 · {{ chain.integrity.member_count }} 项（悬停查看摘要）</div>
                    </template>
                  </div>
                  <div class="sect"><h4>材料快照 <span v-if="selected.material?.schema_version" class="tag t-gray">第 {{ selected.material.schema_version }} 版</span></h4>
                    <div v-if="!selected.material" class="empty">这条交接没有材料快照。</div>
                    <template v-else>
                      <!-- 材料包第 2 版（无人机事件移送）：事件 / 核实 / 处置授权 / 证据四段。 -->
                      <dl v-if="selected.material.event" class="kv kv-surface">
                        <dt>事件编号</dt><dd class="mono" :title="selected.material.event.event_id">{{ selected.material.event.source_alarm_id || selected.material.event.alarm_id || '未提供' }}</dd>
                        <dt>告警类型</dt><dd>{{ labelOf(ALARM_TYPE_LABEL, selected.material.event.alarm_type, '未提供') }}</dd>
                        <dt>提交时状态</dt><dd>{{ labelOf(UAV_STATE_LABEL, selected.material.event.state, '未提供') }}</dd>
                        <dt>发生时间</dt><dd>{{ formatTime(selected.material.event.occurred_at) }}</dd>
                      </dl>
                      <div v-if="selected.material.verifications?.length" class="pn-sub pn-wrap">
                        <div v-for="(vr, i) in selected.material.verifications" :key="i">
                          第 {{ vr.version }} 次核实 · 结论：{{ labelOf(EVENT_CONCLUSION_LABEL, vr.conclusion, vr.conclusion) }}
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
                      <div v-else-if="!selected.material.event" class="empty">{{ materialUnavailableText }}</div>
                      <template v-if="selected.material.risk">
                      <div class="pn-subhead">关联引用</div>
                      <dl v-if="visibleReferences.length" class="kv kv-surface">
                        <template v-for="reference in visibleReferences" :key="reference.key">
                          <dt>{{ reference.label }}</dt><dd :title="reference.value">已记录关联</dd>
                        </template>
                      </dl>
                      <div v-else class="pn-note-text">当前权限下没有可见的关联引用（不可见的引用已省略）。</div>
                      <div class="pn-subhead">核实历史 <span class="tag t-gray">{{ selected.material.verifications?.length || 0 }}</span></div>
                      <div v-if="!selected.material.verifications?.length" class="pn-note-text">快照中没有核实记录。</div>
                      <div v-else class="pn-history">
                        <div v-for="item in selected.material.verifications" :key="`${item.version}-${item.created_at}`" class="pn-history-item">
                          <div><span class="tag" :class="item.conclusion === 'CONFIRMED' ? 't-green' : 't-gray'">{{ label(CONCLUSION_LABEL, item.conclusion) }}</span> <span class="mono">{{ verificationOrdinal(item.version) }}</span> → {{ label(RISK_STATE_LABEL, item.resulting_state) }}</div>
                          <div class="pn-wrap">{{ item.note || '无说明' }}</div>
                          <div class="pn-sub">{{ formatTime(item.created_at) }} · 操作人 {{ item.actor_name || readableNo(item.actor_id) || '系统' }}</div>
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
                    <div class="pn-note-text">送达与回执来自通知渠道返回的事实；本页没有发送、重试或回执写入口。</div>
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
                  <div v-if="disposalRowActions(row).length" class="pn-disposal-acts">
                    <button v-for="action in disposalRowActions(row)" :key="action.key" class="btn" type="button"
                      :title="action.title" @click="runDisposalAction(action, row)">{{ action.label }}</button>
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

          <UPanel v-if="selected?.handoff_type === 'UAV_PUNISHMENT'" title="处罚案件、文书与证据" sub="按所选处罚交接办理：立案 → 指派 → 裁量 → 复核 → 决定书 → 结案" panel-style="margin-top:12px" nopad>
            <div class="pn-not-built">
              <div class="pn-not-built-item" data-not-built="case">
                <div class="pn-not-built-head"><b>处罚案件管理</b>
                  <span v-if="punishment.caseRow" class="tag">{{ labelOf(CASE_STATUS_LABEL, punishment.caseRow.status) }}</span>
                </div>
                <div v-if="punishment.error" class="pn-sub pn-wrap">{{ punishment.error }}</div>
                <template v-else-if="punishment.caseRow">
                  <div class="pn-sub pn-wrap">
                    <b class="mono" :title="punishment.caseRow.case_id">{{ punishment.caseRow.case_no }}</b>
                    <span v-if="punishment.caseRow.officer_name"> · 承办人：{{ punishment.caseRow.officer_name }}</span>
                    <span v-else> · 尚未指派承办人</span>
                    <span v-if="punishment.caseRow.party_name"> · 当事人：{{ punishment.caseRow.party_name }}</span>
                  </div>
                  <div v-if="leads.length" class="pn-sub pn-wrap">
                    <span v-for="lead in leads" :key="lead.lead_id">
                      待补线索 {{ labelOf(LEAD_KIND_LABEL, lead.kind) }}：{{ lead.description }}
                      <button v-if="!lead.resolved && caseActions.includes('RESOLVE_LEAD')" class="btn" type="button" @click="openLeadResolve({ punishmentCase: punishment.caseRow, lead, refresh: refreshPunishment })">标记已补齐</button>
                    </span>
                  </div>
                  <div v-if="punishment.events.length" class="pn-sub pn-wrap">
                    <div v-for="ev in punishment.events" :key="ev.event_id">
                      {{ formatTime(ev.occurred_at) }} · {{ labelOf(CASE_EVENT_KIND_LABEL, ev.event_kind) }}<span v-if="ev.note"> · {{ ev.note }}</span>
                    </div>
                  </div>
                  <div class="pn-actions">
                    <button v-if="caseActions.includes('ASSIGN')" class="btn" type="button" @click="openCaseAssign({ punishmentCase: punishment.caseRow, officers: punishment.officers, refresh: refreshPunishment })">指派承办人</button>
                    <button v-if="caseActions.includes('ADD_LEAD')" class="btn" type="button" @click="openLeadAdd({ punishmentCase: punishment.caseRow, refresh: refreshPunishment })">新增待补线索</button>
                    <button v-if="caseActions.includes('CLOSE')" class="btn" type="button" @click="openCaseClose({ punishmentCase: punishment.caseRow, refresh: refreshPunishment })">结案</button>
                    <button v-if="caseActions.includes('WITHDRAW')" class="btn" type="button" @click="openCaseWithdraw({ punishmentCase: punishment.caseRow, refresh: refreshPunishment })">撤案</button>
                  </div>
                </template>
                <template v-else>
                  <div class="pn-sub pn-wrap">{{ selected?.handoff_type === 'UAV_PUNISHMENT' ? '该处罚交接尚未立案。' : '所选交接不是处罚移送，无法立案。' }}</div>
                  <button class="btn pri" type="button" :disabled="!canFileCase"
                    :title="canFileCase ? '' : '需要立案权限与一条处罚移送交接'"
                    @click="openCaseFile({ handoff: selected, refresh: refreshPunishment })">立案</button>
                </template>
                <div class="pn-sub pn-wrap">{{ BLOCK_GAPS.case }}</div>
              </div>

              <div class="pn-not-built-item" data-not-built="penalty">
                <div class="pn-not-built-head"><b>罚款与裁量</b><span class="tag t-gray">演示档位</span></div>
                <div v-if="!punishment.rules.length" class="pn-sub pn-wrap">{{ punishment.error || '服务端没有返回任何罚则档位。' }}</div>
                <div v-else class="pn-sub pn-wrap">
                  <div v-for="rule in punishment.rules" :key="rule.rule_code">
                    {{ rule.title || labelOf(VIOLATION_CODE_LABEL, rule.violation_code) }}<!--
                    -->{{ Number(rule.fine_max) > 0 ? `：${yuan(rule.fine_min)}–${yuan(rule.fine_max)} 元` : '：不涉及罚款' }}
                    <span v-if="(rule.penalty_types || []).length"> · 可用处罚：{{ (rule.penalty_types || []).map(t => labelOf(PENALTY_TYPE_LABEL, t)).join(' / ') }}</span>
                    <span v-if="rule.legal_basis"> · 依据：{{ rule.legal_basis }}</span>
                  </div>
                </div>
                <div v-if="currentDiscretion" class="pn-sub pn-wrap">
                  当前裁量（第 {{ currentDiscretion.version_no }} 版）：{{ labelOf(DISCRETION_STATUS_LABEL, currentDiscretion.status) }} ·
                  {{ labelOf(PENALTY_TYPE_LABEL, currentDiscretion.penalty_type) }}
                  <span v-if="currentDiscretion.fine_amount != null"> · {{ yuan(currentDiscretion.fine_amount) }} 元</span>
                  <span v-if="currentDiscretion.basis_text"> · {{ currentDiscretion.basis_text }}</span>
                </div>
                <div class="pn-actions">
                  <button v-if="caseActions.includes('DRAFT_DISCRETION')" class="btn" type="button" @click="openDiscretionDraft({ punishmentCase: punishment.caseRow, rules: punishment.rules, refresh: refreshPunishment })">拟定裁量</button>
                  <button v-if="currentDiscretion?.status === 'DRAFT' && caseActions.includes('CONFIRM_DISCRETION')" class="btn pri" type="button" @click="confirmDiscretion({ punishmentCase: punishment.caseRow, discretion: currentDiscretion, refresh: refreshPunishment })">确认裁量</button>
                </div>
                <div class="pn-sub pn-wrap">{{ BLOCK_GAPS.penalty }}</div>
              </div>

              <div class="pn-not-built-item" data-not-built="doc">
                <div class="pn-not-built-head"><b>《行政处罚决定书》</b><span class="tag t-gray">演示文本</span></div>
                <div v-if="!punishment.documents.length" class="pn-sub pn-wrap">尚未出具决定书。</div>
                <div v-else class="pn-sub pn-wrap">
                  <div v-for="doc in punishment.documents" :key="doc.document_id">
                    <b class="mono" :title="doc.rendered_sha256">{{ doc.document_no }}</b> · {{ labelOf(DOCUMENT_STATUS_LABEL, doc.status) }}
                    <span v-if="doc.issued_by_name"> · 出具人：{{ doc.issued_by_name }}</span>
                    <button class="btn" type="button" @click="previewDocument(doc)">预览全文</button>
                    <button v-if="doc.status === 'ISSUED' && caseActions.includes('REVOKE_DOCUMENT')" class="btn" type="button" @click="openDocumentRevoke({ document: doc, refresh: refreshPunishment })">作废</button>
                  </div>
                </div>
                <div class="pn-actions">
                  <button v-if="caseActions.includes('ISSUE_DOCUMENT')" class="btn pri" type="button" @click="issueDocument">生成决定书</button>
                </div>
                <div class="pn-sub pn-wrap">{{ BLOCK_GAPS.doc }}</div>
              </div>

              <div class="pn-not-built-item" data-not-built="evidence">
                <div class="pn-not-built-head"><b>移送材料中的证据引用</b></div>
                <div v-if="evidenceNote" class="pn-sub pn-wrap">{{ evidenceNote }}</div>
                <div v-else class="pn-sub pn-wrap">
                  <div v-for="item in materialEvidence" :key="item.evidence_id">
                    <span class="mono" :title="item.sha256">{{ item.evidence_no }}</span> · {{ labelOf(EVIDENCE_KIND_LABEL, item.kind_code, item.kind_code) }}<span v-if="item.captured_at"> · {{ formatTime(item.captured_at) }}</span>
                  </div>
                </div>
                <div class="pn-sub pn-wrap">{{ BLOCK_GAPS.evidence }}</div>
                <div class="pn-not-built-head" style="margin-top:8px"><b>本案关联证据</b></div>
                <div v-if="punishment.caseEvidenceOmitted" class="pn-sub pn-wrap">当前账号没有 evidence:read，无法读取案件证据。</div>
                <div v-else-if="punishment.caseEvidenceError" class="pn-sub pn-wrap">{{ punishment.caseEvidenceError }}</div>
                <div v-else-if="!punishment.caseEvidence.length" class="pn-sub pn-wrap">本案尚未关联证据文件。</div>
                <div v-else class="pn-sub pn-wrap">
                  <div v-for="item in punishment.caseEvidence" :key="item.evidence_id">
                    <span class="mono">{{ item.evidence_no }}</span> · {{ labelOf(EVIDENCE_KIND_LABEL, item.kind_code, item.kind_code) }}
                  </div>
                </div>
              </div>

              <div class="pn-not-built-item" data-not-built="review">
                <div class="pn-not-built-head"><b>定性依据复核</b></div>
                <div v-if="reviewEvents.length" class="pn-sub pn-wrap">
                  <div v-for="rv in reviewEvents" :key="rv.event_id">
                    {{ formatTime(rv.occurred_at) }} · {{ labelOf(CASE_EVENT_KIND_LABEL, rv.event_kind) }}<span v-if="rv.note"> · {{ rv.note }}</span>
                  </div>
                </div>
                <div v-else class="pn-sub pn-wrap">尚无复核记录。</div>
                <div class="pn-actions">
                  <button v-if="caseActions.includes('REVIEW')" class="btn" type="button" @click="openCaseReview({ punishmentCase: punishment.caseRow, refresh: refreshPunishment })">提交复核结论</button>
                </div>
                <div class="pn-sub pn-wrap">{{ BLOCK_GAPS.review }}</div>
              </div>
            </div>
          </UPanel>

          <UPanel v-if="documentPreview.open" title="决定书全文" sub="平台内预览与复制，不提供下载" panel-style="margin-top:12px" nopad>
            <div class="pn-doc-preview">
              <div v-if="documentPreview.error" class="pn-sub pn-wrap">{{ documentPreview.error }}</div>
              <pre v-else class="pn-doc-text">{{ documentPreview.text }}</pre>
              <div class="pn-actions">
                <button class="btn" type="button" @click="copyDocument">复制全文</button>
                <button class="btn" type="button" @click="documentPreview.open = false">关闭</button>
              </div>
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
.pn-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 6px; }
.pn-doc-preview { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
/* 决定书正文按同文件 .pn-wrap 的约定折行：pre 默认 white-space: pre，长行会把面板撑到横向溢出。 */
.pn-doc-text { margin: 0; max-height: 320px; overflow: auto; font-size: 12px; line-height: 1.6;
  white-space: pre-wrap; overflow-wrap: anywhere; }
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
.pn-disposal-acts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 2px; }
.pn-disposal-events { display: grid; gap: 4px; margin-top: 4px; }
.pn-chain-cov { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-bottom: 8px; }
.pn-chain-cov-item { display: grid; gap: 4px; padding: 6px; border: 1px solid var(--line); border-radius: 4px; font-size: 11px; }
.pn-chain-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.punish-evidence-card { height: 54px; border: 1px solid var(--line); border-radius: 4px; background: linear-gradient(135deg, rgba(61,139,255,.22), rgba(4,12,32,.9)); color: inherit; font: inherit; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
.punish-evidence-card:disabled { cursor: default; opacity: .85; }
.punish-evidence-card small { font-size: 10px; color: var(--txt-3); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
