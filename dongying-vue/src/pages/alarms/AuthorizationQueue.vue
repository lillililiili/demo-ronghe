<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import UPanel from '@/components/UPanel.vue';
import UControl from '@/components/form/UControl.vue';
import UPagination from '@/components/UPagination.vue';
import { disposalApi } from '@/services/disposalApi.js';
import { authUser } from '@/services/auth.js';
import { getAlarm, getUavEvent } from '@/services/alarmApi.js';
import { targetApi } from '@/services/targetApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { DISPOSAL_ACTION_LABEL, DISPOSAL_BLOCK_REASON_LABEL, DISPOSAL_CHANNEL_LABEL, SOURCE_MODE_LABEL, disposalStatusText, labelOf } from '@/ui/labels.js';
import { openDisposalApproval, openDisposalExecution, openDisposalStop } from '@/ui/disposalAuthModal.js';
import EmergencyStopPanel from '@/components/disposal/EmergencyStopPanel.vue';
import TargetLiveVideo from '@/components/video/TargetLiveVideo.vue';
import AuthorizationTargetMap from './AuthorizationTargetMap.vue';
import { canStop, cardStopLabel, nextStep, primaryCode, readPending, resultText, usesEmergency } from './authorizationQueueView.js';

const props = defineProps({ initialAuthorizationId: { type: String, default: '' }, eventId: { type: String, default: '' }, initialStatus: { type: String, default: '' } });
const emit = defineEmits(['event']);
const rows = ref([]), selected = ref(null), page = ref(1), total = ref(0), status = ref(props.initialStatus);
const view = ref(props.initialAuthorizationId || props.initialStatus || props.eventId ? 'all' : 'pending');
const loading = ref(false), error = ref(''), detailError = ref(''), detailLoading = ref(false), loadedAt = ref('');
const pageSize = ref(20), detailHost = ref(null), emergencyInfo = ref(null);
const options = [{ label: '全部状态', value: '' }, ...['REQUESTED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED', 'EXPIRED', 'STOPPED', 'CANCELLED'].map(value => ({ value, label: disposalStatusText({ status: value }) }))];
const selectedSubject = computed(() => selected.value ? subjects.value[subjectKey(selected.value)] : null);
const actions = { APPROVE: openDisposalApproval, EXECUTE: openDisposalExecution };
const userId = computed(() => authUser.value?.user_id);
const visibleRows = computed(() => view.value === 'pending' ? rows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) : rows.value);
const mainCode = row => primaryCode(row, userId.value);
const mainLabel = row => row.execution_block_reason ? '查看原因' : ({ APPROVE: '审批', EXECUTE: '执行' }[mainCode(row)] || (row.status === 'FAILED' ? '查看原因' : row.status === 'EXECUTING' && row.channel !== 'MANUAL' ? '查看执行情况' : '查看详情'));
const modeText = row => row?.authorization_mode === 'DIRECT' ? '免逐次审批' : row?.authorization_mode === 'REVIEW' ? '申请审批' : '方式未知';
const approverText = row => row?.authorization_mode === 'DIRECT' ? '不适用（免逐次审批）' : (row?.approved_by_name || (row.status === 'REQUESTED' ? '待审批' : '未提供'));
const statusText = row => row?.status === 'STOPPED' && emergencyInfo.value?.latest_stop && row.subject_id === emergencyInfo.value.event_id
  ? '反制已中止' : disposalStatusText(row);
const blockReasonText = row => row?.execution_block_reason ? labelOf(DISPOSAL_BLOCK_REASON_LABEL, row.execution_block_reason) : '';
const subjects = ref({});
const subjectKey = row => `${row.subject_kind}:${row.subject_id}`;
const subjectText = row => subjects.value[subjectKey(row)]?.text || `${({ UAV_EVENT: '告警事件', TARGET: '目标', RISK: '风险事件' }[row.subject_kind] || '关联对象')}编号读取中`;
const subjectExtra = row => subjects.value[subjectKey(row)]?.fallback ? `记录 ${row.authorization_no || row.authorization_id}` : subjects.value[subjectKey(row)]?.extra || '';
let request = 0, detailRequest = 0, active = true;
watch(visibleRows, items => { for (const row of items) void readSubject(row); });
watch(selected, row => { if (row) void readSubject(row); });
async function readSubject(row) {
  const key = subjectKey(row);
  if (subjects.value[key]) return;
  subjects.value[key] = { text: '', extra: '' };
  try {
    let text, extra = '', targetId = '';
    if (row.subject_kind === 'UAV_EVENT' && hasPermission('alarm:read')) {
      const event = await getUavEvent(row.subject_id);
      if (!active) return;
      if (!event?.alarm_id) throw new Error('未提供关联告警');
      const alarm = await getAlarm(event.alarm_id);
      text = alarm.alarm_no || '告警编号未提供';
      extra = alarm.target_no ? `目标 ${alarm.target_no}` : '';
      targetId = alarm.target_id || '';
    } else if (row.subject_kind === 'TARGET' && hasPermission('target:read')) {
      const target = await targetApi.detail(row.subject_id);
      text = target.target_no || '目标编号未提供';
      targetId = target.target_id || '';
    } else { text = '关联对象信息不可用'; }
    if (active) subjects.value[key] = { text, extra, targetId, fallback: !targetId };
  } catch {
    if (active) subjects.value[key] = { text: '关联对象读取失败', fallback: true };
  }
}
function formatTime(value) {
  if (value == null || value === '') return '未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false });
}
async function load(next = page.value) {
  const seq = ++request, mode = view.value, filter = status.value;
  loading.value = true; error.value = ''; loadedAt.value = ''; rows.value = []; total.value = 0;
  const current = () => active && seq === request;
  const scope = props.eventId ? { subject_kind: 'UAV_EVENT', subject_id: props.eventId } : {};
  try {
    if (mode === 'pending') {
      const items = await readPending(disposalApi.list, scope, userId.value, current);
      if (!current()) return;
      rows.value = items; total.value = items.length;
      page.value = Math.max(1, Math.min(next, Math.ceil(items.length / pageSize.value)));
    } else {
      const result = await disposalApi.list({ ...scope, page: next, size: pageSize.value, ...(filter ? { status: filter } : {}) });
      if (!current()) return;
      if (!Array.isArray(result?.items) || !Number.isSafeInteger(result.total)) throw new Error('授权列表数据不完整，请刷新重试');
      rows.value = result.items; total.value = result.total; page.value = next;
      if (!rows.value.length && next > 1 && total.value > 0) return load(Math.max(1, Math.ceil(total.value / pageSize.value)));
    }
    loadedAt.value = formatTime(Date.now());
  } catch (e) {
    if (current()) { error.value = e.message || '读取办理记录失败'; rows.value = []; total.value = 0; }
  } finally { if (current()) loading.value = false; }
}
function closeDetail() { ++detailRequest; selected.value = null; emergencyInfo.value = null; detailError.value = ''; detailLoading.value = false; }
function changeView(mode) { closeDetail(); view.value = mode; status.value = ''; load(1); }
function filterChanged() { closeDetail(); load(1); }
async function refresh(id, reloadList = true) {
  const seq = ++detailRequest;
  selected.value = null; emergencyInfo.value = null; detailError.value = ''; detailLoading.value = true;
  try {
    const detail = await disposalApi.detail(id);
    if (active && seq === detailRequest) {
      if (props.eventId && (detail.subject_kind !== 'UAV_EVENT' || detail.subject_id !== props.eventId)) throw new Error('授权记录不属于当前告警事件');
      selected.value = detail;
      if (reloadList) await load();
    }
    return detail;
  } catch (e) {
    if (active && seq === detailRequest) detailError.value = e.message || '读取详情失败';
    throw e;
  } finally { if (active && seq === detailRequest) detailLoading.value = false; }
}
async function show(id, stop = false, reloadList = false) {
  try {
    await refresh(id, reloadList);
    if (!active || selected.value?.authorization_id !== id) return;
    await nextTick();
    detailHost.value?.focus();
    if (stop) detailHost.value?.querySelector('.es-stop-button')?.focus();
  } catch { /* refresh 已显示原因 */ }
}
function mainAction(row) {
  const code = mainCode(row);
  if (!code || row.execution_block_reason) return show(row.authorization_id);
  actions[code]({ authorization: row, refresh: () => refresh(row.authorization_id) });
}
function stopAction(row) {
  if (!canStop(row)) return;
  if (usesEmergency(row)) return show(row.authorization_id, true);
  openDisposalStop({ authorization: row, refresh: () => refresh(row.authorization_id) });
}
function changePage(next) { if (view.value === 'pending') page.value = next; else load(next); }
function resize(size) { pageSize.value = size; if (view.value === 'pending') page.value = 1; else load(1); }
async function refreshCurrent() { subjects.value = {}; if (selected.value) await show(selected.value.authorization_id, false, true); else await load(); }
onMounted(() => props.initialAuthorizationId ? show(props.initialAuthorizationId, false, true) : load());
onUnmounted(() => { active = false; request++; detailRequest++; });
</script>

<template>
  <UPanel :title="false" class-name="authorization-queue"
    panel-style="flex:1;min-height:0;margin-top:12px;overflow:hidden"
    body-style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
    <div class="toolbar">
      <div class="view-switch" role="group" aria-label="办理记录范围">
        <button type="button" class="btn" :class="{ pri: view === 'pending' }" :aria-pressed="view === 'pending'" @click="changeView('pending')">待我处理</button>
        <button type="button" class="btn" :class="{ pri: view === 'all' }" :aria-pressed="view === 'all'" @click="changeView('all')">全部记录</button>
      </div>
      <label v-if="view === 'all'"><span>办理状态</span><UControl type="select" v-model="status" :options="options" :input-props="{ 'aria-label': '办理状态' }" @update:model-value="filterChanged" /></label>
      <button type="button" class="btn" :disabled="loading || detailLoading" @click="refreshCurrent">{{ loading || detailLoading ? '正在读取' : '刷新' }}</button>
      <span v-if="loadedAt" class="read-time">读取于 {{ loadedAt }}</span>
    </div>
    <p class="scope-note">{{ view === 'pending' ? '显示需要你审批或下发设备执行的事项；执行监测与历史请看“全部记录”。' : '查看设备执行进展、停止处置及历史记录。' }}<span v-if="eventId"> 仅限当前告警事件。</span></p>
    <div v-if="error" class="warnbox" role="alert">{{ error }}</div>
    <div v-if="detailError" class="warnbox" role="alert">{{ detailError }}</div>
    <div v-if="detailLoading" role="status" class="scope-note">正在读取办理详情</div>
    <div class="authorization-workspace">
      <aside class="record-queue" aria-label="反制办理记录">
        <div class="queue-heading"><strong>{{ view === 'pending' ? '待办记录' : '办理记录' }}</strong><span>{{ total }} 条</span></div>
        <div class="queue-scroll" :aria-busy="loading">
          <article v-for="row in visibleRows" :key="row.authorization_id" class="queue-record" :class="{ 'is-selected': selected?.authorization_id === row.authorization_id }">
            <button class="record-select" type="button" :aria-pressed="selected?.authorization_id === row.authorization_id" @click="show(row.authorization_id)">
              <strong>{{ subjectText(row) }}</strong>
              <span v-if="subjectExtra(row)" class="source-mode">{{ subjectExtra(row) }}</span>
              <span class="record-status">{{ statusText(row) }}</span>
              <span class="source-mode">{{ labelOf(DISPOSAL_ACTION_LABEL, row.action_type) }} · {{ labelOf(SOURCE_MODE_LABEL, row.source_mode) }}</span>
              <span class="source-mode">申请于 {{ formatTime(row.requested_at) }}</span>
              <span v-if="nextStep(row, userId)" class="record-next">{{ nextStep(row, userId) }}</span>
            </button>
            <div v-if="selected?.authorization_id !== row.authorization_id && (mainCode(row) || canStop(row))" class="record-actions">
              <button v-if="mainCode(row)" type="button" class="btn" :disabled="loading || detailLoading" @click="mainAction(row)">{{ mainLabel(row) }}</button>
              <button v-if="canStop(row)" type="button" class="btn stop-btn" :disabled="loading || detailLoading" @click="stopAction(row)">{{ cardStopLabel(row) }}</button>
            </div>
          </article>
          <p v-if="loading" class="queue-empty" role="status">正在读取办理记录</p>
          <p v-else-if="!error && !visibleRows.length" class="queue-empty">{{ view === 'pending' ? '当前没有需要你操作的事项' : '当前筛选下没有可见记录' }}</p>
        </div>
      </aside>
      <section v-if="selected" ref="detailHost" class="authorization-detail" aria-label="办理详情" tabindex="-1">
        <header class="detail-header">
          <div><h4>{{ subjectText(selected) }}</h4><span class="source-mode">{{ labelOf(DISPOSAL_ACTION_LABEL, selected.action_type) }} · {{ labelOf(SOURCE_MODE_LABEL, selected.source_mode) }}</span></div>
          <button v-if="selected.subject_kind === 'UAV_EVENT'" type="button" class="btn" @click="emit('event', selected.subject_id)">查看关联告警</button>
        </header>
        <div class="detail-columns">
          <div class="target-observation" aria-label="目标观察">
            <TargetLiveVideo v-if="['UAV_EVENT', 'TARGET'].includes(selected.subject_kind)" :key="selected.authorization_id"
              :default-expanded="true" :compact="true" :target-id="selectedSubject?.targetId || ''" :context-label="subjectText(selected)"
              :unavailable-reason="selectedSubject?.fallback && !selectedSubject?.targetId ? subjectText(selected) : ''" />
            <AuthorizationTargetMap v-if="['UAV_EVENT', 'TARGET'].includes(selected.subject_kind)" :key="`map-${selected.authorization_id}`"
              :target-id="selectedSubject?.targetId || ''" :unavailable-reason="selectedSubject?.fallback && !selectedSubject?.targetId ? subjectText(selected) : ''" />
            <div v-else class="queue-empty">此记录没有可关联的无人机目标，保留办理及历史资料供查阅。</div>
          </div>
          <aside class="handling-panel" aria-label="当前办理与授权资料">
            <div class="current-handling">
              <span class="section-label">当前进展</span>
              <h3>{{ statusText(selected) }}</h3>
              <p v-if="nextStep(selected, userId)">{{ nextStep(selected, userId) }}</p>
              <p v-if="resultText(selected)" class="result-text">{{ resultText(selected) }}</p>
              <p v-if="blockReasonText(selected)" class="block-reason">执行受阻：{{ blockReasonText(selected) }}</p>
              <div v-if="mainCode(selected) || (canStop(selected) && !usesEmergency(selected))" class="actions authorization-actions">
                <button v-if="mainCode(selected)" type="button" class="btn pri" :disabled="detailLoading" @click="actions[mainCode(selected)]({ authorization: selected, refresh: () => refresh(selected.authorization_id) })">{{ ({ APPROVE: '审批', EXECUTE: '执行' })[mainCode(selected)] }}</button>
                <button v-if="canStop(selected) && !usesEmergency(selected)" type="button" class="btn stop-btn" @click="stopAction(selected)">停止处置</button>
              </div>
            </div>
            <EmergencyStopPanel v-if="usesEmergency(selected)" :key="selected.subject_id" :event-id="selected.subject_id"
              @updated="emergencyInfo = $event" @changed="refreshCurrent" />
            <details :key="selected.authorization_id" class="authorization-dossier" open>
              <summary>授权资料与办理记录</summary>
              <dl class="detail-facts">
                <dt>授权编号</dt><dd>{{ selected.authorization_no || selected.authorization_id }}</dd>
                <dt>关联对象 ID</dt><dd>{{ selected.subject_id || '未提供' }}</dd>
                <dt>授权方式</dt><dd>{{ modeText(selected) }}</dd>
                <dt>{{ selected.authorization_mode === 'DIRECT' ? '直接操作人' : '申请人' }}</dt><dd>{{ selected.requested_by_name || '未提供' }}</dd>
                <dt>审批人</dt><dd>{{ approverText(selected) }}</dd>
                <dt>申请时间</dt><dd>{{ formatTime(selected.requested_at) }}</dd>
                <dt>有效至</dt><dd>{{ formatTime(selected.valid_until) }}</dd>
                <dt>执行通道</dt><dd>{{ labelOf(DISPOSAL_CHANNEL_LABEL, selected.channel) }}</dd>
                <dt>申请事由</dt><dd>{{ selected.reason || '未提供' }}</dd>
                <template v-if="selected.result_detail"><dt>结果说明</dt><dd>{{ selected.result_detail }}</dd></template>
                <template v-if="selected.result_code"><dt>原始结果码</dt><dd>{{ selected.result_code }}</dd></template>
                <template v-if="selected.decision_note"><dt>审批意见</dt><dd>{{ selected.decision_note }}</dd></template>
              </dl>
            </details>
          </aside>
        </div>
      </section>
      <div v-else class="workspace-empty" role="status"><strong>{{ detailLoading ? '正在读取办理详情' : '选择一条办理记录' }}</strong><p>目标画面、当前进展和可用操作将在这里显示</p></div>
    </div>
    <footer class="pager" v-if="!loading && !error">
      <span>{{ view === 'pending' ? '待我处理' : '全部记录' }} · 第 {{ page }} 页<span v-if="selected"> · 当前详情保持打开</span></span>
      <UPagination :page="page" :page-size="pageSize" :item-count="total" @update:page="changePage" @update:page-size="resize" />
    </footer>
  </UPanel>
</template>

<style scoped>
.toolbar, .view-switch, .actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.toolbar { margin-bottom:8px; flex:none; }
.view-switch, .toolbar > .btn { flex:none; }
.toolbar label { display:flex; align-items:center; gap:8px; flex:none; }
.toolbar label > span { flex:none; white-space:nowrap; }
.toolbar label :deep(.n-select) { width:168px; min-width:168px; flex:none; }
.scope-note, .read-time, .source-mode, .section-label { color:var(--txt-2); font-size:12px; line-height:1.6; }
.scope-note { flex:none; margin:0 0 8px; }.read-time { margin-left:auto; }
.btn { min-height:36px; white-space:normal; height:auto; }
.stop-btn { color:var(--red); border-color:var(--red); background:transparent; }
.authorization-workspace { display:grid; grid-template-columns:minmax(210px, 23%) minmax(0, 1fr); gap:12px; flex:1; min-height:0; }
.record-queue { display:flex; flex-direction:column; min-width:0; min-height:0; border:1px solid var(--line); border-radius:var(--r); background:var(--surface-gradient); }
.queue-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:12px; border-bottom:1px solid var(--line); }
.queue-heading span { color:var(--txt-2); font-size:12px; }.queue-heading strong { font-size:14px; }
.queue-scroll { overflow:auto; flex:1; min-height:0; }
.queue-record { border-bottom:1px solid var(--line); border-left:3px solid transparent; }
.queue-record.is-selected { border-left-color:var(--blue); background:color-mix(in srgb, var(--blue) 14%, var(--surface-1)); }
.record-select { display:flex; flex-direction:column; width:100%; text-align:left; gap:5px; padding:14px 12px; color:var(--txt); background:transparent; border:0; cursor:pointer; font:inherit; line-height:1.55; white-space:normal; overflow-wrap:anywhere; }
.record-select:hover { background:color-mix(in srgb, var(--blue) 8%, transparent); }
.record-select strong { font-size:14px; }.record-status { font-weight:600; font-size:13px; }.record-next { color:var(--txt-2); font-size:12px; }
.record-actions { display:flex; gap:8px; flex-wrap:wrap; padding:0 12px 12px; }
.queue-empty { padding:18px 12px; color:var(--txt-2); line-height:1.7; margin:0; }
.authorization-detail { display:flex; flex-direction:column; min-width:0; min-height:0; }
.authorization-detail:focus { outline:0; }.authorization-detail:focus-visible { outline:2px solid var(--blue); outline-offset:-2px; }
.detail-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:0 0 8px; flex:none; border-bottom:1px solid var(--line); }
.detail-header h4 { margin:0; font-size:16px; overflow-wrap:anywhere; }.detail-header > div { min-width:0; display:flex; gap:6px 12px; align-items:baseline; flex-wrap:wrap; }.detail-header > button { flex:none; }
.detail-columns { display:grid; grid-template-columns:minmax(0, 1.45fr) minmax(255px, 1fr); gap:12px; flex:1; min-height:0; padding-top:12px; }
.target-observation, .handling-panel { min-width:0; min-height:0; overflow:auto; }
.target-observation { display:flex; flex-direction:column; gap:12px; }
.target-observation :deep(.target-live-video) { margin:0; }
.handling-panel { background:var(--surface-gradient); border:1px solid var(--line); border-radius:var(--r); }
.current-handling { padding:16px; }.current-handling h3 { margin:6px 0 10px; font-size:21px; line-height:1.4; overflow-wrap:anywhere; }.current-handling p { margin:6px 0; line-height:1.6; font-size:13px; overflow-wrap:anywhere; }
.block-reason { color:var(--amber); }.authorization-actions { margin-top:14px; }
.handling-panel :deep(.emergency-stop-panel) { border:0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); border-radius:0; }
.handling-panel :deep(.es-header) { position:static; border-radius:0; padding:14px 16px; }
.handling-panel :deep(.es-header h3) { font-size:13px; color:var(--txt-2); }.handling-panel :deep(.es-stop-area) { width:100%; align-items:stretch; }
.authorization-dossier { padding:0 16px; }.authorization-dossier summary { cursor:pointer; padding:16px 0; font-weight:600; font-size:14px; }
.detail-facts { display:grid; grid-template-columns:80px minmax(0,1fr); gap:10px 12px; line-height:1.7; font-size:13px; margin:0 0 16px; }
.detail-facts dt { color:var(--txt-2); }.detail-facts dd { margin:0; overflow-wrap:anywhere; white-space:pre-wrap; }
.workspace-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px; border:1px solid var(--line); border-radius:var(--r); background:var(--surface-gradient); }.workspace-empty p { color:var(--txt-2); font-size:13px; }
.pager { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; flex:none; padding-top:10px; }.pager > span { color:var(--txt-2); font-size:12px; }.warnbox { flex:none; }
@media (max-width:1100px) { .authorization-workspace { grid-template-columns:205px minmax(0,1fr); gap:10px; }.detail-columns { grid-template-columns:minmax(0,1fr) minmax(235px,1fr); gap:10px; } }
@media (max-width:850px) { .detail-columns { display:flex; flex-direction:column; overflow:auto; }.target-observation,.handling-panel { flex:none; overflow:visible; }.authorization-workspace { grid-template-columns:180px minmax(0,1fr); } }
</style>
