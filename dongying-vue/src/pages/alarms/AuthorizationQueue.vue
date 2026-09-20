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
import { canStop, nextStep, primaryCode, readPending, resultText, usesEmergency } from './authorizationQueueView.js';

const props = defineProps({ initialAuthorizationId: { type: String, default: '' }, eventId: { type: String, default: '' }, initialStatus: { type: String, default: '' } });
const emit = defineEmits(['event']);
const rows = ref([]), selected = ref(null), page = ref(1), total = ref(0), status = ref(props.initialStatus);
const view = ref(props.initialAuthorizationId || props.initialStatus || props.eventId ? 'all' : 'pending');
const loading = ref(false), error = ref(''), detailError = ref(''), detailLoading = ref(false), loadedAt = ref('');
const pageSize = ref(20), detailHost = ref(null), emergencyInfo = ref(null);
const options = [{ label: '全部状态', value: '' }, ...['REQUESTED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'FAILED', 'REJECTED', 'EXPIRED', 'STOPPED', 'CANCELLED'].map(value => ({ value, label: disposalStatusText({ status: value }) }))];
const actions = { APPROVE: openDisposalApproval, EXECUTE: openDisposalExecution };
const userId = computed(() => authUser.value?.user_id);
const visibleRows = computed(() => view.value === 'pending' ? rows.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value) : rows.value);
const mainCode = row => primaryCode(row, userId.value);
const mainLabel = row => row.execution_block_reason ? '查看原因' : ({ APPROVE: '审批', EXECUTE: '执行' }[mainCode(row)] || (row.status === 'FAILED' ? '查看原因' : row.status === 'EXECUTING' && row.channel !== 'MANUAL' ? '查看执行情况' : '查看详情'));
const modeText = row => row?.authorization_mode === 'DIRECT' ? '免逐次审批' : row?.authorization_mode === 'REVIEW' ? '申请审批' : '方式未知';
const approverText = row => row?.authorization_mode === 'DIRECT' ? '不适用（免逐次审批）' : (row?.approved_by_name || (row.status === 'REQUESTED' ? '待审批' : '未提供'));
const statusText = row => row?.status === 'STOPPED' && emergencyInfo.value?.latest_stop && row.subject_id === emergencyInfo.value.event_id
  ? '授权已中止；设备反馈见停止区' : disposalStatusText(row);
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
    let text, extra = '';
    if (row.subject_kind === 'UAV_EVENT' && hasPermission('alarm:read')) {
      const event = await getUavEvent(row.subject_id);
      if (!active) return;
      if (!event?.alarm_id) throw new Error('未提供关联告警');
      const alarm = await getAlarm(event.alarm_id);
      text = alarm.alarm_no || '告警编号未提供';
      extra = alarm.target_no ? `目标 ${alarm.target_no}` : '';
    } else if (row.subject_kind === 'TARGET' && hasPermission('target:read')) {
      const target = await targetApi.detail(row.subject_id);
      text = target.target_no || '目标编号未提供';
    } else { text = '关联对象信息不可用'; }
    if (active) subjects.value[key] = { text, extra, fallback: !text || text.includes('未提供') || text.includes('不可用') };
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
async function refresh(id) {
  const seq = ++detailRequest;
  selected.value = null; emergencyInfo.value = null; detailError.value = ''; detailLoading.value = true;
  try {
    const detail = await disposalApi.detail(id);
    if (active && seq === detailRequest) {
      if (props.eventId && (detail.subject_kind !== 'UAV_EVENT' || detail.subject_id !== props.eventId)) throw new Error('授权记录不属于当前告警事件');
      selected.value = detail;
      await load();
    }
    return detail;
  } catch (e) {
    if (active && seq === detailRequest) detailError.value = e.message || '读取详情失败';
    throw e;
  } finally { if (active && seq === detailRequest) detailLoading.value = false; }
}
async function show(id, stop = false) {
  try {
    await refresh(id);
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
async function refreshCurrent() { subjects.value = {}; if (selected.value) await show(selected.value.authorization_id); else await load(); }
onMounted(() => props.initialAuthorizationId ? show(props.initialAuthorizationId) : load());
onUnmounted(() => { active = false; request++; detailRequest++; });
</script>

<template>
  <UPanel :title="eventId ? '当前事件的反制办理' : '反制办理'" class-name="authorization-queue"
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
    <div v-if="!selected" class="scroll table-scroll table-shell" :aria-busy="loading">
      <table class="tb">
        <thead><tr><th>关联告警 / 目标</th><th>处置动作</th><th>当前进展</th><th>需要你做什么</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in visibleRows" :key="row.authorization_id" :class="{ 'is-selected': selected?.authorization_id === row.authorization_id }">
            <td>{{ subjectText(row) }}<div v-if="subjectExtra(row)" class="source-mode">{{ subjectExtra(row) }}</div></td>
            <td>{{ labelOf(DISPOSAL_ACTION_LABEL, row.action_type) }}<div class="source-mode">{{ labelOf(SOURCE_MODE_LABEL, row.source_mode) }}</div></td>
            <td>{{ statusText(row) }}<div v-if="resultText(row)" class="result-text">{{ resultText(row) }}</div><div v-if="blockReasonText(row)" class="block-reason">{{ blockReasonText(row) }}</div></td>
            <td>{{ nextStep(row, userId) }}</td>
            <td><div class="row-operations" v-if="selected?.authorization_id !== row.authorization_id">
              <div class="actions">
                <button type="button" class="btn" :class="{ pri: !!mainCode(row) }" :disabled="loading || detailLoading" @click="mainAction(row)">{{ mainLabel(row) }}</button>
                <button v-if="mainCode(row) && !row.execution_block_reason" type="button" class="btn detail-link" :disabled="loading || detailLoading" @click="show(row.authorization_id)">查看详情</button>
              </div>
              <div v-if="canStop(row)" class="stop-action"><button type="button" class="btn stop-btn" :disabled="loading || detailLoading" @click="stopAction(row)">{{ usesEmergency(row) ? '停止 / 急停' : '停止处置' }}</button></div>
            </div><span v-else class="scope-note">正在查看下方详情</span></td>
          </tr>
          <tr v-if="loading"><td colspan="5" class="empty" role="status">正在读取办理记录</td></tr>
          <tr v-else-if="!error && !visibleRows.length"><td colspan="5" class="empty">{{ view === 'pending' ? '当前没有需要你操作的事项' : '当前筛选下没有可见记录' }}</td></tr>
        </tbody>
      </table>
    </div>
    <footer class="pager" v-if="!selected && !loading && !error">
      <span>{{ view === 'pending' ? '待我处理' : '记录' }} {{ total }} 条</span>
      <UPagination :page="page" :page-size="pageSize" :item-count="total" @update:page="changePage" @update:page-size="resize" />
    </footer>
    <section v-if="selected" ref="detailHost" class="sect authorization-detail" aria-label="办理详情" tabindex="-1">
      <header class="detail-header"><h4>{{ subjectText(selected) }} · {{ labelOf(DISPOSAL_ACTION_LABEL, selected.action_type) }}</h4><button type="button" class="btn" @click="closeDetail">返回列表</button></header>
      <p class="detail-progress">{{ statusText(selected) }} · {{ labelOf(SOURCE_MODE_LABEL, selected.source_mode) }}<span v-if="resultText(selected)"> · {{ resultText(selected) }}</span></p>
      <p v-if="blockReasonText(selected)" class="block-reason">执行受阻：{{ blockReasonText(selected) }}</p>
      <EmergencyStopPanel v-if="usesEmergency(selected)" :key="selected.subject_id" :event-id="selected.subject_id"
        @updated="emergencyInfo = $event" @changed="refreshCurrent" />
      <div class="actions authorization-actions">
        <button v-if="mainCode(selected)" type="button" class="btn pri" :disabled="detailLoading" @click="actions[mainCode(selected)]({ authorization: selected, refresh: () => refresh(selected.authorization_id) })">{{ ({ APPROVE: '审批', EXECUTE: '执行' })[mainCode(selected)] }}</button>
        <button v-if="canStop(selected) && !usesEmergency(selected)" type="button" class="btn stop-btn" @click="stopAction(selected)">停止处置</button>
        <button v-if="selected.subject_kind === 'UAV_EVENT'" type="button" class="btn" @click="emit('event', selected.subject_id)">查看关联告警</button>
      </div>
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
    </section>
  </UPanel>
</template>

<style scoped>
.toolbar, .view-switch, .actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.toolbar { margin-bottom:8px; flex:none; }
.view-switch, .toolbar > .btn { flex:none; }
.toolbar label { display:flex; align-items:center; gap:8px; flex:none; min-width:max-content; }
.toolbar label > span { flex:none; white-space:nowrap; }
.toolbar label :deep(.n-select) { width:168px; min-width:168px; flex:none; }
.scope-note, .read-time, .source-mode { color:var(--txt-2); font-size:12px; line-height:1.6; }
.scope-note { flex:none; margin:0 0 12px; }
.read-time { margin-left:auto; }
.tb { width:100%; table-layout:fixed!important; }
.tb th:nth-child(1) { width:24%!important; }.tb th:nth-child(2) { width:12%!important; }.tb th:nth-child(3) { width:22%!important; }.tb th:nth-child(4) { width:20%!important; }.tb th:nth-child(5) { width:22%!important; }
.tb td, .tb th { white-space:normal; overflow-wrap:anywhere; }
.tb td { vertical-align:top; padding-top:14px; padding-bottom:14px; }
.tb tbody tr { cursor:default; }
.tb .is-selected { background:color-mix(in srgb, var(--blue) 10%, transparent); }
.result-text { margin-top:4px; }.block-reason { color:var(--amber); margin-top:4px; }
.btn { min-height:36px; white-space:normal; height:auto; }
.detail-link { background:transparent; border-color:transparent; }
.stop-action { margin-top:12px; padding-top:8px; border-top:1px solid var(--line); }
.stop-btn { color:var(--red); border-color:var(--red); background:transparent; }
.table-scroll { flex:1; min-height:110px; }
.pager { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; flex:none; padding-top:10px; }
.pager > span { color:var(--txt-2); }
.warnbox { flex:none; }
.authorization-detail { flex:1; min-height:230px; overflow:auto; margin-top:12px; padding:0 12px 12px; }
.authorization-detail:focus { outline:2px solid var(--blue); outline-offset:-2px; }
.detail-header { display:flex; align-items:center; justify-content:space-between; gap:12px; position:sticky; top:0; z-index:3; background:var(--surface-1); padding:10px 0; }
.detail-header h4 { margin:0; }
.authorization-actions { margin:12px 0; }
.detail-progress { margin:0 0 12px; overflow-wrap:anywhere; }
.detail-facts { display:grid; grid-template-columns:90px minmax(0,1fr) 90px minmax(0,1fr); gap:10px 16px; line-height:1.6; }
.detail-facts dt { color:var(--txt-2); }.detail-facts dd { margin:0; overflow-wrap:anywhere; white-space:pre-wrap; }
@media (max-width:900px) { .detail-facts { grid-template-columns:90px minmax(0,1fr); } .tb th:nth-child(1) { width:20%!important; } .tb th:nth-child(5) { width:26%!important; } }
</style>
