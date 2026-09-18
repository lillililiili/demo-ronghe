<script setup>
import { computed, onUnmounted, watch } from 'vue';
import { hasPermission } from '@/services/accessControl.js';
import { toast } from '@/ui/nv.js';
import { deviceNoticeState, loadDeviceMaintenanceNotice, notifyDeviceAbnormal, resendDeviceNotice,
  retryDeviceNoticeSubmission } from '@/pages/flights/deviceMaintenance.js';
import { authUser } from '@/services/auth.js';
import RecipientSnapshotFields from '@/components/notifications/RecipientSnapshotFields.vue';

const props = defineProps({ planId: { type: String, default: '' }, device: { type: Object, required: true } });
const abnormal = computed(() => props.device.abnormal || props.device.incidents?.some(item => !item.closed_at));
const state = computed(() => deviceNoticeState(props.planId, props.device.device_id));
const blocker = computed(() => !props.planId ? '未选择飞行计划' : !hasPermission('handoff:create') ? '没有通知提交权限' : '');
const attempts = computed(() => state.value.task?.notification_attempts || []);
const latestUnknown = computed(() => attempts.value[0]?.outcome_state === 'UNKNOWN');
const previousDeliveries = computed(() => attempts.value.slice(1).filter(item => item.delivery_status === 'DELIVERED').length);
const taskText = computed(() => state.value.task?.status === 'HANDLED' ? '运维待办已处理' : '运维待办已生成');
const noticeText = computed(() => {
  if (state.value.pending) return state.value.request?.kind === 'resend' ? '正在再次通知' : '正在通知';
  if (state.value.uncertain) return '本次提交结果待确认';
  if (latestUnknown.value) return '通知结果未知';
  if (attempts.value[0]?.outcome_state === 'NOT_SENT') return '通知未发出';
  return deliveryText(state.value.task?.notification_delivery_status);
});
const tone = computed(() => state.value.pending || state.value.uncertain || latestUnknown.value ? 't-amber'
  : deliveryTone(state.value.task?.notification_delivery_status));
const noticeReceiptText = computed(() => latestUnknown.value ? '回执状态未知' : attempts.value[0]?.outcome_state === 'NOT_SENT' ? '尚未产生回执'
  : `${state.value.pending || state.value.uncertain ? '上次' : ''}${receiptText(state.value.task?.notification_receipt_status)}`);
const simulated = computed(() => isSimulated(state.value.task?.recipient_snapshot));
const showCreate = computed(() => abnormal.value && state.value.loaded && !state.value.uncertain
  && (!state.value.task || state.value.task.status === 'HANDLED'));
const showResend = computed(() => abnormal.value && state.value.task?.status === 'PENDING' && !state.value.uncertain);
const resendLabel = computed(() => state.value.task?.notification_delivery_status === 'FAILED' ? '重试通知' : '再次通知');
const busy = computed(() => state.value.pending || state.value.reading);
const reload = () => loadDeviceMaintenanceNotice(props.planId, props.device.device_id);
function date(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function deliveryText(status) {
  return ({ PENDING_DELIVERY: '待发送', SUBMITTED: '已提交渠道 · 待确认送达', DELIVERED: '已送达', FAILED: '通知失败' })[status] || '通知结果未知';
}
function receiptText(status) {
  return ({ NOT_EXPECTED: '不要求回执', PENDING: '等待回执', ACKNOWLEDGED: '已收到回执', TIMEOUT: '回执超时' })[status] || '回执状态未知';
}
function deliveryTone(status) { return ({ DELIVERED: 't-cyan', FAILED: 't-red', SUBMITTED: 't-blue', PENDING_DELIVERY: 't-amber' })[status] || 't-gray'; }
function isSimulated(snapshot) { return ['MOCK', 'SMS_SIMULATED', 'VOICE_SIMULATED'].includes(snapshot?.channel_type); }
function attemptOutcome(attempt) {
  return attempt.outcome_state === 'UNKNOWN' ? '通知结果未知'
    : attempt.outcome_state === 'NOT_SENT' ? '通知未发出' : deliveryText(attempt.delivery_status);
}

watch(() => [props.planId, props.device.device_id, authUser.value?.user_id], reload, { immediate: true });
// 只在后台给出的发送间隔到期后回读资格，不在浏览器中自行推进状态。
let cooldownTimer;
watch(() => [state.value.task?.task_id, state.value.task?.resend_available_at, state.value.task?.can_resend_notification], () => {
  clearTimeout(cooldownTimer);
  const remaining = Number(state.value.task?.resend_available_at) - Date.now();
  if (remaining > 0 && remaining < 2147483000 && !state.value.task?.can_resend_notification)
    cooldownTimer = setTimeout(reload, remaining + 100);
}, { immediate: true });
onUnmounted(() => clearTimeout(cooldownTimer));

async function submit(kind) {
  if (blocker.value || busy.value || state.value.readError) return;
  if (kind !== 'retry' && !abnormal.value) return;
  const planId = props.planId, deviceId = props.device.device_id, actor = authUser.value?.user_id;
  try {
    const task = await (kind === 'resend' ? resendDeviceNotice(planId, deviceId)
      : kind === 'retry' ? retryDeviceNoticeSubmission(planId, deviceId) : notifyDeviceAbnormal(planId, deviceId));
    if (!task || planId !== props.planId || deviceId !== props.device.device_id || actor !== authUser.value?.user_id) return;
    const delivered = task.notification_delivery_status === 'DELIVERED';
    const message = task.notification_blocked_reason
      ? '通知尚未完成，原因及本次记录已保留。'
      : delivered ? (isSimulated(task.recipient_snapshot) ? '模拟通知已送达，本次记录已保存。' : '通知已送达，本次记录已保存。')
        : task.reused ? '已读取已有运维待办，通知状态已更新。' : '通知记录已保存，请查看发送结果。';
    toast(message, task.notification_blocked_reason ? 'warn' : 'ok');
  } catch (error) {
    if (planId === props.planId && deviceId === props.device.device_id && actor === authUser.value?.user_id)
      toast(error.message, 'err');
  }
}
</script>

<template>
  <div v-if="abnormal || state.task || state.readError || state.uncertain" class="device-notice">
    <div v-if="state.task || state.pending || state.uncertain" class="notice-summary" role="status">
      <span class="tag" :class="tone">{{ noticeText }}</span>
      <span v-if="state.task" class="notice-receipt">{{ noticeReceiptText }}</span>
      <span v-if="simulated" class="tag t-gray">模拟通知</span>
    </div>
    <small v-if="state.task">{{ taskText }}<template v-if="attempts.length > 1"> · 共 {{ attempts.length }} 次通知记录</template></small>
    <small v-if="previousDeliveries && state.task?.notification_delivery_status !== 'DELIVERED'">此前已有 {{ previousDeliveries }} 次送达记录，本次结果不改变历史送达事实。</small>
    <small v-if="!state.pending && !state.uncertain && !latestUnknown && state.task?.notification_blocked_reason" class="notice-blocker">{{ state.task.notification_blocked_reason }}</small>
    <div class="notice-actions">
      <button v-if="showCreate" class="device-notice-button" type="button"
        :disabled="!!blocker || busy || !!state.readError" :aria-label="'通知' + device.name + '设备异常'" @click="submit('create')">
        {{ state.pending ? '正在通知' : state.task ? '报告仍有异常' : '通知设备异常' }}
      </button>
      <button v-if="showResend" class="device-notice-button secondary" type="button"
        :disabled="!!blocker || busy || !!state.readError || !state.task.can_resend_notification" @click="submit('resend')">
        {{ state.pending ? '正在再次通知' : resendLabel }}
      </button>
      <button v-if="state.task || state.uncertain || state.readError" class="notice-link" type="button" :disabled="busy" @click="reload">
        {{ state.reading ? '正在读取' : state.readError ? '重试读取' : '刷新状态' }}
      </button>
      <button v-if="state.uncertain && state.request" class="notice-link" type="button"
        :disabled="!!blocker || busy || !!state.readError" @click="submit('retry')">重试原提交</button>
    </div>
    <small v-if="!state.loaded && state.reading" role="status">正在读取通知记录</small>
    <small v-if="blocker && abnormal" role="status">{{ blocker }}</small>
    <small v-if="state.readError" role="alert">通知记录暂时无法读取：{{ state.readError }}</small>
    <small v-if="state.error" role="alert">{{ state.error }}</small>
    <small v-if="state.uncertain">请先刷新状态；重试原提交会沿用同一次提交编号。</small>
    <small v-else-if="showResend && !state.task.can_resend_notification && !busy" class="notice-blocker">
      {{ state.task.resend_blocked_reason || '再次通知暂不可用，请刷新状态。' }}
      <template v-if="state.task.resend_available_at"> · 可重试时间：{{ date(state.task.resend_available_at) }}</template>
    </small>
    <details v-if="state.task" :key="state.task.task_id" class="notice-result">
      <summary><span class="expand-label">查看记录</span><span class="collapse-label">收起记录</span></summary>
      <dl>
        <dt>待办编号</dt><dd>{{ state.task.task_no || state.task.task_id }}</dd>
        <dt>报告时间</dt><dd>{{ date(state.task.reported_at) }}</dd>
        <template v-if="state.task.handled_at"><dt>处理时间</dt><dd>{{ date(state.task.handled_at) }}</dd></template>
        <template v-if="state.task.handling_note"><dt>处理结果</dt><dd>{{ state.task.handling_note }}</dd></template>
      </dl>
      <ol v-if="attempts.length" class="notice-attempts">
        <li v-for="attempt in attempts" :key="attempt.attempt_id">
          <div class="notice-summary"><b>第 {{ attempt.attempt_no }} 次通知</b><span class="tag" :class="deliveryTone(attempt.delivery_status)">{{ attemptOutcome(attempt) }}</span><span v-if="isSimulated(attempt.recipient_snapshot)" class="tag t-gray">模拟通知</span><span v-if="attempt.historical" class="tag t-gray">历史通知</span></div>
          <small v-if="attempt.historical">沿用原待办保存的通知资料，未记录的发送及回执时间保持未知。</small>
          <dl>
            <dt>{{ attempt.historical ? '原待办上报时间' : '通知提交时间' }}</dt><dd>{{ date(attempt.requested_at) }}</dd>
            <dt>{{ attempt.historical ? '原上报人' : '通知提交人' }}</dt><dd>{{ attempt.requested_by_name || '未记录' }}</dd>
            <template v-if="attempt.reason"><dt>通知原因</dt><dd>{{ attempt.reason }}</dd></template>
            <RecipientSnapshotFields :snapshot="attempt.recipient_snapshot" historical show-name />
            <template v-if="attempt.submitted_at"><dt>渠道提交时间</dt><dd>{{ date(attempt.submitted_at) }}</dd></template>
            <template v-if="attempt.delivered_at"><dt>送达时间</dt><dd>{{ date(attempt.delivered_at) }}</dd></template>
            <dt>回执情况</dt><dd>{{ attempt.outcome_state === 'UNKNOWN' ? '回执状态未知' : attempt.outcome_state === 'NOT_SENT' ? '尚未产生回执' : receiptText(attempt.receipt_status) }}</dd>
            <template v-if="attempt.acknowledged_at"><dt>回执时间</dt><dd>{{ date(attempt.acknowledged_at) }}</dd></template>
            <template v-if="attempt.receipt_result"><dt>回执内容</dt><dd>{{ attempt.receipt_result }}</dd></template>
            <template v-if="attempt.blocked_reason"><dt>未完成原因</dt><dd>{{ attempt.blocked_reason }}</dd></template>
          </dl>
        </li>
      </ol>
      <dl v-else>
        <RecipientSnapshotFields :snapshot="state.task.recipient_snapshot" historical show-name />
        <dt>通知结果</dt><dd>{{ deliveryText(state.task.notification_delivery_status) }}</dd>
        <dt>回执情况</dt><dd>{{ receiptText(state.task.notification_receipt_status) }}</dd>
        <template v-if="state.task.notification_blocked_reason"><dt>未完成原因</dt><dd>{{ state.task.notification_blocked_reason }}</dd></template>
      </dl>
      <small>通知送达、待办处理与设备恢复分别记录。</small>
    </details>
  </div>
</template>

<style scoped>
.device-notice { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 6px; max-width: 100%; min-width: 0; font-size: 12px; font-weight: 400; }
.device-notice small { display: block; white-space: normal; overflow-wrap: anywhere; color: var(--txt-3); line-height: 1.6; }
.notice-summary,.notice-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; max-width: 100%; min-width: 0; }
.notice-summary .tag,.notice-receipt { max-width: 100%; white-space: normal; overflow-wrap: anywhere; line-height: 1.6; }
.notice-receipt { color: var(--txt-2); }
.notice-result { width: 100%; white-space: normal; overflow-wrap: anywhere; }
.notice-result summary { width: fit-content; max-width: 100%; color: var(--cyan); cursor: pointer; line-height: 1.8; }
.notice-result .collapse-label,.notice-result[open] .expand-label { display: none; }
.notice-result[open] .collapse-label { display: inline; }
.notice-result dl { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 6px 10px; margin: 8px 0; }
.notice-result :deep(dd) { margin: 0; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.notice-result :deep(dt) { color: var(--txt-3); white-space: normal; overflow-wrap: anywhere; }
.notice-attempts { list-style: none; padding: 0; margin: 10px 0; }
.notice-attempts li { padding: 10px 0; border-top: 1px solid var(--line); }
.device-notice-button,.notice-link { padding: 4px 8px; border: 1px solid currentColor; border-radius: 4px; background: transparent; color: var(--cyan); font: inherit; white-space: normal; overflow-wrap: anywhere; text-align: left; cursor: pointer; }
.device-notice-button.secondary { color: var(--txt-2); border-color: var(--line); }
.notice-link { padding: 3px 0; border-color: transparent; }
.device-notice-button:hover:not(:disabled),.notice-link:hover:not(:disabled) { background: color-mix(in srgb, var(--cyan) 12%, transparent); }
.device-notice-button:disabled,.notice-link:disabled { opacity: .55; cursor: not-allowed; }
.device-notice-button:focus-visible,.notice-link:focus-visible,.notice-result summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.device-notice .notice-blocker { color: var(--amber); }
</style>
