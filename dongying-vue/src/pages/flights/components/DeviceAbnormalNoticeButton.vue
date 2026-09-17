<script setup>
import { computed, watch } from 'vue';
import { hasPermission } from '@/services/accessControl.js';
import { toast } from '@/ui/nv.js';
import { deviceNoticeState, loadDeviceMaintenanceNotice, notifyDeviceAbnormal } from '@/pages/flights/deviceMaintenance.js';
import { authUser } from '@/services/auth.js';
import RecipientSnapshotFields from '@/components/notifications/RecipientSnapshotFields.vue';

const props = defineProps({ planId: { type: String, default: '' }, device: { type: Object, required: true } });
const abnormal = computed(() => props.device.abnormal || props.device.incidents?.some(item => !item.closed_at));
const state = computed(() => deviceNoticeState(props.planId, props.device.device_id));
const blocker = computed(() => !props.planId ? '未选择飞行计划' : !hasPermission('handoff:create') ? '没有通知提交权限' : '');
const deliveryText = computed(() => ({ PENDING_DELIVERY: '尚未发送', SUBMITTED: '已提交渠道', DELIVERED: '已送达', FAILED: '未送达' })[state.value.task?.notification_delivery_status] || '未记录通知结果');
const receiptText = computed(() => ({ NOT_EXPECTED: '不要求回执', PENDING: '等待回执', ACKNOWLEDGED: '已收到回执', TIMEOUT: '回执超时' })[state.value.task?.notification_receipt_status] || '未记录回执');
const taskText = computed(() => state.value.task?.status === 'HANDLED' ? '运维待办已处理' : '运维待办已生成');
const reload = () => loadDeviceMaintenanceNotice(props.planId, props.device.device_id);
watch(() => [props.planId, props.device.device_id, authUser.value?.user_id], reload, { immediate: true });
async function submit() {
  if (blocker.value || state.value.pending || !abnormal.value) return;
  try {
    const task = await notifyDeviceAbnormal(props.planId, props.device.device_id);
    if (task) toast(task.notification_blocked_reason ? `运维待办已保留；通知未完成：${task.notification_blocked_reason}` : task.reused ? '后台已有这台设备的运维待办，未重复创建。' : '已生成后台运维待办。', task.notification_blocked_reason ? 'warn' : 'ok');
  } catch (error) { toast(error.message, 'err'); }
}
</script>

<template>
  <span v-if="abnormal || state.task || state.readError" class="device-notice">
    <button v-if="abnormal" class="device-notice-button" type="button" :disabled="!!blocker || state.pending"
      :aria-label="`通知${device.name}设备异常`" @click="submit">{{ state.pending ? '正在通知' : '通知设备异常' }}</button>
    <small v-if="blocker || state.error" role="status">{{ blocker || state.error }}</small>
    <small v-if="state.readError" role="alert">通知记录暂时无法读取：{{ state.readError }} <button class="btn ghost" type="button" :disabled="state.reading || state.pending" @click="reload">重试读取</button></small>
    <details v-if="state.task" class="notice-result">
      <summary>{{ taskText }} · {{ deliveryText }}</summary>
      <dl><dt>待办编号</dt><dd>{{ state.task.task_no || state.task.task_id }}</dd>
        <RecipientSnapshotFields :snapshot="state.task.recipient_snapshot" historical show-name />
        <dt>通知结果</dt><dd>{{ deliveryText }}<small v-if="state.task.recipient_snapshot?.channel_type === 'MOCK'">模拟通知</small></dd>
        <dt>回执情况</dt><dd>{{ receiptText }}</dd>
        <template v-if="state.task.notification_blocked_reason"><dt>未完成原因</dt><dd>{{ state.task.notification_blocked_reason }}</dd></template>
      </dl>
      <small>通知结果与待办处理分别记录；收到通知不代表设备已经恢复。</small>
      <button class="btn ghost" type="button" :disabled="state.reading || state.pending" @click="reload">{{ state.reading ? '正在读取' : '刷新通知记录' }}</button>
    </details>
  </span>
</template>

<style scoped>
.device-notice { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 5px; max-width: 100%; min-width: 0; font-size: 12px; }
.device-notice small { display: block; white-space: normal; overflow-wrap: anywhere; color: var(--txt-3); line-height: 1.6; }
.notice-result { width: 100%; white-space: normal; overflow-wrap: anywhere; }
.notice-result summary { cursor: pointer; line-height: 1.6; }
.notice-result dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 10px; margin: 8px 0; }
.notice-result :deep(dd) { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.notice-result :deep(dt) { color: var(--txt-3); }
.device-notice-button { justify-self: start; color: var(--cyan); padding: 4px 8px; border: 1px solid currentColor; border-radius: 4px; background: transparent; font: inherit; cursor: pointer; }
.device-notice-button:hover:not(:disabled) { background: color-mix(in srgb, var(--cyan) 12%, transparent); }
.device-notice-button:disabled { opacity: .55; cursor: not-allowed; }
.device-notice-button:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
</style>
