<script setup>
import { computed, watch } from 'vue';
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { authUser } from '@/services/auth.js';
import { maintenanceStateLabel } from '@/pages/flights/deviceMaintenance.js';
import { deviceReportState, loadDeviceReport, submitDeviceReport } from './deviceReport.js';

const props = defineProps({ deviceId: { type: String, required: true } });
const state = computed(() => deviceReportState(props.deviceId));
const task = computed(() => state.value.context?.task);
const openCase = computed(() => task.value && !['COMPLETED', 'LEGACY_HANDLED'].includes(task.value.workflow_state));
const reported = computed(() => openCase.value && task.value.my_reported_at != null);
const disabled = computed(() => state.value.pending || state.value.reading
  || (!state.value.requestKey && (!state.value.context?.can_report || !!state.value.readError || reported.value)));
const label = computed(() => state.value.pending ? '正在上报…' : state.value.requestKey ? '用原提交重试'
  : reported.value ? '已上报后台' : '上报设备异常');
const date = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const reload = () => loadDeviceReport(props.deviceId);
const submit = () => submitDeviceReport(props.deviceId);
watch(() => [props.deviceId, authUser.value?.user_id], reload, { immediate: true });
useRealtimeRefresh(['device', 'device_state'], () => loadDeviceReport(props.deviceId, { quiet: true }), { minIntervalMs: 2_000 });
</script>

<template>
  <section class="device-report" aria-label="设备异常上报">
    <div class="report-actions">
      <button type="button" class="btn" :disabled="disabled" @click="submit">{{ label }}</button>
      <button type="button" class="btn secondary" :disabled="state.reading || state.pending" @click="reload">刷新进度</button>
    </div>
    <p v-if="!state.context && !state.readError">正在读取上报资格和办理进度…</p>
    <p v-if="state.readError" class="warning" role="status">{{ state.readError }}<template v-if="state.loadedAt">（最后成功更新 {{ date(state.loadedAt) }}）</template></p>
    <p v-else-if="state.context?.blocked_reason && !reported" class="muted">{{ state.context.blocked_reason }}</p>
    <p v-if="state.requestKey && !state.pending" class="warning">提交结果尚未确认，请用原提交重试，避免重复上报。</p>
    <p v-if="state.error" class="warning" role="status">{{ state.error }}</p>
    <p v-if="state.result" class="result" role="status">{{ state.result.text }}</p>
    <p v-else-if="openCase && !reported">后台已有未办结处置单，本次上报将关联原单。</p>
    <p v-if="task"><strong>{{ state.readError ? '上次处置进度' : '处置进度' }}：{{ maintenanceStateLabel(task) }}</strong></p>
    <p v-if="task?.workflow_state === 'READY_TO_COMPLETE' && !state.readError" class="result">设备已恢复，等待后台确认办结。</p>
    <details v-if="task">
      <summary>查看处置单</summary>
      <p>后台“设备异常处理” → {{ task.device_name }}</p>
      <p>处置单编号：{{ task.task_id }}</p>
      <p>首次记录：{{ date(task.reported_at) }}</p>
      <p v-if="task.my_reported_at">我的上报：{{ date(task.my_reported_at) }}</p>
    </details>
  </section>
</template>

<style scoped>
.device-report { padding: 10px 12px 12px; border-top: 1px solid var(--line); font-size: 12px; line-height: 1.6; color: var(--txt-2); }
.report-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.device-report p { margin: 7px 0 0; white-space: normal; overflow-wrap: anywhere; }
.device-report .btn { font: inherit; }
.device-report .secondary,.muted { color: var(--txt-3); }
.device-report .warning { color: var(--amber); }
.device-report .result,summary { color: var(--cyan); }
.device-report summary { margin-top: 6px; cursor: pointer; width: fit-content; }
.device-report button:focus-visible,.device-report summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; }
</style>
