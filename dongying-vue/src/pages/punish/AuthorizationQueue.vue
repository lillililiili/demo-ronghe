<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import UPanel from '@/components/UPanel.vue';
import UControl from '@/components/form/UControl.vue';
import UPagination from '@/components/UPagination.vue';
import { disposalApi } from '@/services/disposalApi.js';
import { DISPOSAL_ACTION_LABEL, DISPOSAL_BLOCK_REASON_LABEL, DISPOSAL_CHANNEL_LABEL, SOURCE_MODE_LABEL, disposalStatusText, labelOf } from '@/ui/labels.js';
import { openDisposalApproval, openDisposalExecution, openDisposalManualResult, openDisposalStop } from '@/ui/disposalAuthModal.js';
import EmergencyStopPanel from '@/components/disposal/EmergencyStopPanel.vue';

const props = defineProps({ initialAuthorizationId: { type: String, default: '' } });
const rows = ref([]), selected = ref(null), page = ref(1), total = ref(0), status = ref('');
const loading = ref(false), error = ref('');
const pageSize = ref(20);
const options = [{ label: '全部状态', value: '' }, ...['REQUESTED', 'APPROVED', 'EXECUTING', 'FAILED', 'REJECTED', 'EXPIRED', 'STOPPED', 'CANCELLED'].map(value => ({ value, label: disposalStatusText({ status: value }) }))];
const actions = [
  { codes: ['APPROVE', 'REJECT'], label: '审批', open: openDisposalApproval },
  { codes: ['EXECUTE'], label: '执行', open: openDisposalExecution },
  { codes: ['MANUAL_RESULT'], label: '登记执行结果', open: openDisposalManualResult },
  { codes: ['STOP'], label: '停止', open: openDisposalStop }
];
let request = 0, detailRequest = 0, active = true;
function allowed(row) { return actions.filter(a => a.codes.some(code => row?.allowed_actions?.includes(code))
  && !(row?.subject_kind === 'UAV_EVENT' && ['COUNTERMEASURE', 'JAMMING'].includes(row.action_type) && a.codes.includes('STOP'))); }
const usesEmergency = row => row?.subject_kind === 'UAV_EVENT' && ['COUNTERMEASURE', 'JAMMING'].includes(row.action_type);
const emergencyInfo = ref(null);
const modeText = row => row?.authorization_mode === 'DIRECT' ? '免逐次审批' : row?.authorization_mode === 'REVIEW' ? '申请审批' : '方式未知';
const operatorLabel = row => row?.authorization_mode === 'DIRECT' ? '直接操作人' : '申请人';
const approverText = row => row?.authorization_mode === 'DIRECT' ? '不适用（免逐次审批）' : (row?.approved_by_name || '待审批');
const statusText = row => row?.status === 'STOPPED' && emergencyInfo.value?.latest_stop && row.subject_id === emergencyInfo.value.event_id
  ? '授权已中止；设备反馈见急停区'
  : disposalStatusText(row);
const blockReasonText = row => row?.execution_block_reason
  ? labelOf(DISPOSAL_BLOCK_REASON_LABEL, row.execution_block_reason)
  : '';
async function refreshEmergency() { if (selected.value) await refresh(selected.value.authorization_id); else await load(); }
function formatRequestedAt(value) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}
async function load(next = page.value) {
  const seq = ++request;
  loading.value = true; error.value = '';
  try {
    const result = await disposalApi.list({
      page: next, size: pageSize.value,
      ...(status.value ? { status: status.value } : { exclude_status: 'COMPLETED' })
    });
    if (!active || seq !== request) return;
    const items = (result?.items || []).filter(row => row.status !== 'COMPLETED');
    rows.value = items; total.value = result?.total || 0; page.value = next;
  } catch (e) {
    if (active && seq === request) { error.value = e.message || '读取处置授权失败'; rows.value = []; }
  } finally { if (active && seq === request) loading.value = false; }
}
async function refresh(id) {
  const seq = ++detailRequest;
  try {
    const detail = await disposalApi.detail(id);
    if (active && seq === detailRequest) {
      selected.value = detail;
      await load();
    }
    return detail;
  } catch (e) {
    if (active && seq === detailRequest) error.value = e.message || '读取授权详情失败';
    throw e;
  }
}
async function show(id) {
  try { await refresh(id); } catch { /* refresh 已显示失败原因 */ }
}
function resize(size) { pageSize.value = size; load(1); }
function act(action, row) { action.open({ authorization: row, refresh: () => refresh(row.authorization_id) }); }
onMounted(() => props.initialAuthorizationId ? show(props.initialAuthorizationId) : load());
onUnmounted(() => { active = false; request++; detailRequest++; });
</script>

<template>
  <UPanel title="处置授权" sub="先申请并取得有效授权，再执行和核查现场结果；处罚移送按违法事实独立办理"
    panel-style="flex:1;min-height:0;margin-top:12px;overflow:hidden"
    body-style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
    <div class="toolbar">
      <label>授权状态 <UControl type="select" v-model="status" :options="options" :input-props="{ 'aria-label': '授权状态' }" @update:model-value="load(1)" /></label>
      <button class="btn" :disabled="loading" @click="load()">{{ loading ? '正在读取' : '刷新授权' }}</button>
    </div>
    <div v-if="error" class="warnbox" role="alert">{{ error }}</div>
    <div class="scroll table-scroll table-shell">
      <table class="tb">
        <thead><tr><th>授权编号</th><th>授权方式</th><th>动作 / 来源</th><th>操作人</th><th>申请时间</th><th>审批人</th><th>执行通道</th><th>状态 / 结果</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.authorization_id">
            <td><span class="mono" :title="row.authorization_id">{{ row.authorization_no }}</span></td>
            <td>{{ modeText(row) }}</td>
            <td>{{ labelOf(DISPOSAL_ACTION_LABEL, row.action_type) }} · {{ labelOf(SOURCE_MODE_LABEL, row.source_mode) }}</td>
            <td>{{ row.requested_by_name || '未提供' }}</td>
            <td class="num" :title="formatRequestedAt(row.requested_at)">{{ formatRequestedAt(row.requested_at) }}</td>
            <td>{{ approverText(row) }}</td>
            <td>{{ labelOf(DISPOSAL_CHANNEL_LABEL, row.channel) }}</td>
            <td>{{ statusText(row) }}<div v-if="blockReasonText(row)">受阻原因：{{ blockReasonText(row) }}</div><div v-if="row.result_code">{{ row.result_code }}</div></td>
            <td><div class="actions"><button v-for="action in selected?.authorization_id === row.authorization_id ? [] : allowed(row)" :key="action.label" class="btn" @click="act(action, row)">{{ action.label }}</button>
              <button v-if="usesEmergency(row)" type="button" class="btn" @click="show(row.authorization_id)">查看处置与急停</button>
            </div></td>
          </tr>
          <tr v-if="!loading && !rows.length"><td colspan="9" class="empty">当前筛选下没有可见授权。</td></tr>
        </tbody>
      </table>
    </div>
    <footer class="pager">
      <UPagination :page="page" :page-size="pageSize" :item-count="total" @update:page="load" @update:page-size="resize" />
    </footer>
    <section v-if="selected" class="sect" aria-label="所选授权详情">
      <EmergencyStopPanel v-if="usesEmergency(selected)" :key="selected.subject_id" :event-id="selected.subject_id"
        @updated="emergencyInfo = $event" @changed="refreshEmergency" />
      <h4>{{ selected.authorization_no }} · {{ statusText(selected) }}</h4>
      <p>{{ selected.reason }}</p>
      <p>{{ modeText(selected) }} · {{ operatorLabel(selected) }}：{{ selected.requested_by_name || '未提供' }} · 审批人：{{ approverText(selected) }}</p>
      <p v-if="blockReasonText(selected)">执行受阻：{{ blockReasonText(selected) }}</p>
      <p v-if="selected.result_code">设备结果：{{ selected.result_code }} · {{ selected.result_detail }}</p>
      <div class="actions"><button v-for="action in allowed(selected)" :key="action.label" class="btn" @click="act(action, selected)">{{ action.label }}</button></div>
    </section>
  </UPanel>
</template>

<style scoped>
.toolbar { display:flex; gap:12px; flex-wrap:wrap; align-items:end; margin-bottom:12px; flex:none; }
.actions { display:flex; gap:8px; flex-wrap:wrap; }
.tb td { overflow-wrap:anywhere; }
.tb td.num { white-space:nowrap; font-variant-numeric:tabular-nums; }
.table-scroll { flex:1; min-height:0; }
.pager { display:flex; justify-content:flex-end; flex:none; padding-top:10px; }
.warnbox { flex:none; }
</style>
