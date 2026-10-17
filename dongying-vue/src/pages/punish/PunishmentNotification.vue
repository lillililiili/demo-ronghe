<script setup>
import { userFacingMessage, notificationBlockedReason } from '@/ui/labels.js';
import { computed, onUnmounted, ref, watch } from 'vue';
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { authSession, authUser } from '@/services/auth.js';
import { openConfirm } from '@/ui/confirm.js';
import { openFormModal } from '@/ui/formModal.js';
import { toast } from '@/ui/nv.js';
import { deliveryView, receiptView, notificationActions, declineReasonError, pendingOperationSettled } from './handoffStatus.js';

const props = defineProps({ handoffId: { type: String, required: true }, recipientName: String, riskNotice: Boolean });
const emit = defineEmits(['status', 'changed']);
const result = ref(null), loading = ref(false), sending = ref(false), error = ref(''), pending = ref(null);
const pendingChecked = ref(false);
const history = ref([]), historyPage = ref(1), historyTotal = ref(0), historyError = ref('');
const historySize = 10;
const decisionWorkflow = computed(() => !props.riskNotice && !!result.value?.notification_decision);
const heading = computed(() => props.riskNotice || decisionWorkflow.value ? '通知上级' : '处罚部门通知');
let active = true, sequence = 0;
const session = authSession.value;
const current = () => active && session === authSession.value;
const storageKey = () => `punishment-notification:${authUser.value?.user_id || 'unknown'}:${props.handoffId}`;
function readPending() {
  pendingChecked.value = false;
  try { pending.value = JSON.parse(sessionStorage.getItem(storageKey()) || 'null'); }
  catch { pending.value = null; }
}
function savePending(value) {
  if (value) sessionStorage.setItem(storageKey(), JSON.stringify(value));
  else sessionStorage.removeItem(storageKey());
  pending.value = value;
  pendingChecked.value = false;
}
const deliveryText = computed(() => deliveryView(result.value).label);
const receiptText = computed(() => receiptView(result.value).label);
const failureReason = computed(() => {
  if (result.value?.notification_decision?.state === 'DO_NOT_NOTIFY') return '';
  if (!['PENDING_DELIVERY', 'FAILED'].includes(result.value?.delivery_status)) return '';
  const reason = result.value?.latest_delivery?.blocked_reason;
  if (reason === 'PENDING_NOTIFICATION_DECISION') return '';
  return userFacingMessage(reason);
});
const needsNotification = computed(() => ['PENDING_DELIVERY', 'FAILED'].includes(result.value?.delivery_status)
  && result.value?.receipt_status !== 'ACKNOWLEDGED' && result.value?.notification_decision?.state !== 'DO_NOT_NOTIFY');
const actions = computed(() => notificationActions(result.value, decisionWorkflow.value ? pending.value : null, pendingChecked.value));
const buttonLabel = computed(() => pending.value ? '重试原通知' : result.value?.delivery_status === 'FAILED' ? '重试通知' : props.riskNotice || decisionWorkflow.value ? '通知上级' : '通知处罚部门');
const date = value => value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
async function load() {
  const seq = ++sequence, id = props.handoffId;
  loading.value = true; error.value = '';
  pendingChecked.value = false;
  try {
    const data = await handoffApi.getHandoffNotification(id);
    if (!current() || seq !== sequence) return;
    result.value = data;
    if (pendingOperationSettled(pending.value, data)) savePending(null);
    pendingChecked.value = !!pending.value;
    emit('status', data);
    if (props.riskNotice || decisionWorkflow.value) {
      historyError.value = '';
      try {
        const attempts = await handoffApi.listHandoffDeliveries(id, { page: historyPage.value, size: historySize });
        if (!current() || seq !== sequence) return;
        history.value = attempts.items || []; historyTotal.value = attempts.total;
      } catch (e) { if (current() && seq === sequence) historyError.value = e.message || '发送记录读取失败，请刷新重试。'; }
    }
  } catch (e) {
    if (current() && seq === sequence) error.value = e.status === 403 ? '当前账号没有查看通知记录的权限。'
      : e.status === 404 ? '未找到通知记录，请返回交接列表重新选择；仍无法查看时联系管理员。' : e.message || '通知状态读取失败，请重新查询。';
  } finally { if (current() && seq === sequence) loading.value = false; }
}
function notifyDepartment() {
  if (!current() || loading.value || sending.value || error.value || !result.value?.can_notify) return;
  if (decisionWorkflow.value) {
    if (actions.value.canNotify) void sendNotification(props.handoffId, result.value.expected_attempt_no);
    return;
  }
  const id = props.handoffId, attempt = result.value.expected_attempt_no;
  const recipient = result.value.recipient_snapshot?.recipient_name || props.recipientName || (props.riskNotice ? '上级' : '原处罚接收方');
  openConfirm({
    title: buttonLabel.value,
    message: `向「${recipient}」发送这份已提交的${props.riskNotice ? '风险通知' : '处罚交接'}材料。${result.value.simulated ? '本次使用模拟通道，不会发送真实通知。' : ''}${props.riskNotice ? '送达和签收不代表风险已解除。' : '送达和签收不代表处罚已办结。'}`,
    confirmText: '确认通知',
    onConfirm: async () => {
      if (!current() || props.handoffId !== id || loading.value || sending.value || error.value || !result.value?.can_notify) return true;
      await sendNotification(id, attempt);
      return true;
    }
  });
}

async function sendNotification(id, attempt) {
  const request = pending.value || { kind: 'notify', key: newHandoffIdempotencyKey(), attempt };
  try { savePending(request); }
  catch { error.value = '浏览器无法保存本次操作，通知尚未发送。请检查浏览器存储设置后重试。'; return; }
  sending.value = true; error.value = '';
  try {
    await handoffApi.notifyHandoff(id, request.attempt, request.key);
    if (!current() || props.handoffId !== id) return;
    savePending(null);
    await load();
    if (current() && !error.value) { toast('通知状态已更新', 'ok'); emit('changed'); }
  } catch (e) {
    if (!current() || props.handoffId !== id) return;
    const uncertain = !e.status || e.status >= 500;
    if (!uncertain) savePending(null);
    await load();
    if (current()) {
      const resolved = uncertain && !pending.value && !error.value
        && (['DELIVERED', 'FAILED'].includes(result.value?.delivery_status) || result.value?.notification_decision?.state === 'DO_NOT_NOTIFY');
      if (resolved) emit('changed');
      else error.value = uncertain ? '发送结果尚未确认，请先刷新通知状态，再按最新状态处理。'
        : e.message || '通知未能提交，请核对当前状态。';
    }
  } finally { if (current() && props.handoffId === id) sending.value = false; }
}

async function retryOriginalOperation() {
  if (!current() || loading.value || sending.value || !actions.value.canRetryOriginal) return;
  try {
    if (pending.value.kind === 'decline') await submitDecline(props.handoffId, pending.value);
    else await sendNotification(props.handoffId, pending.value.attempt);
  } catch (e) { if (current()) error.value = e.message || '原操作未能提交，请刷新后重试。'; }
}

async function submitDecline(id, request, modal = null) {
  try { savePending(request); }
  catch { throw new Error('浏览器无法保存本次操作，决定尚未提交。请检查浏览器存储设置后重试。'); }
  sending.value = true; error.value = '';
  try {
    await handoffApi.declineHandoffNotification(id, request.version, request.reason, request.key);
    if (!current() || props.handoffId !== id) return;
    savePending(null); if (modal?.isCurrent()) modal.close();
    await load(); emit('changed');
    toast('已记录本次不通知决定', 'ok');
  } catch (e) {
    if (!current() || props.handoffId !== id) return;
    const uncertain = !e.status || e.status >= 500;
    if (!uncertain) savePending(null);
    await load();
    if (uncertain) {
      if (modal?.isCurrent()) modal.close();
      if (!pending.value && !error.value && result.value?.notification_decision?.state !== 'PENDING_DECISION') emit('changed');
      else error.value = '不通知决定的提交结果尚未确认，请刷新状态，暂勿重复决定。';
    } else if (modal?.isCurrent()) throw new Error(e.message || '决定未能保存，请刷新后重试。');
    else error.value = e.message || '决定未能保存，请刷新后重试。';
  } finally { if (current() && props.handoffId === id) sending.value = false; }
}

function declineNotification() {
  if (!current() || loading.value || sending.value || error.value || !actions.value.canDecline) return;
  const id = props.handoffId, version = result.value.notification_decision.version;
  const modal = openFormModal({
    title: '本次不通知上级', confirmText: '确认不通知',
    notice: '本决定仅表示不发本次接口通知，不等于认定无违法或免予处罚。',
    fields: [{ key: 'reason', label: '不通知原因', type: 'textarea', required: true,
      placeholder: '请填写本次不通知的原因', inputProps: { maxlength: 1000, showCount: true } }],
    initial: { reason: '' }, validate: value => declineReasonError(value.reason),
    onSubmit: async value => {
      if (!current() || props.handoffId !== id || !modal.isCurrent() || loading.value || sending.value || !actions.value.canDecline) throw new Error('事项状态已有变化，请刷新后再决定。');
      const request = { kind: 'decline', key: newHandoffIdempotencyKey(), version, reason: value.reason.trim() };
      await submitDecline(id, request, modal);
    }
  });
}
watch(() => props.handoffId, () => { result.value = null; history.value = []; historyPage.value = 1; historyTotal.value = 0; readPending(); load(); }, { immediate: true });
onUnmounted(() => { active = false; ++sequence; });
defineExpose({ refresh: load });
</script>

<template>
  <Teleport :to="riskNotice ? 'body' : '#pnNotifyDock'" :disabled="riskNotice" defer>
    <template v-if="decisionWorkflow && (actions.showNotify || actions.showDecline || actions.refreshOnly)">
      <p v-if="error" class="notify-block" role="alert">{{ error }}</p>
      <p v-else-if="actions.refreshOnly" class="notify-block">{{ sending ? (pending?.kind === 'decline' ? '正在记录决定' : '正在通知上级') : actions.canRetryOriginal ? '查询后仍未记录原操作，可沿用原请求重试。' : pending?.kind === 'decline' ? '决定结果尚未确认，请刷新状态。' : '发送结果尚未确认，请刷新通知状态。' }}</p>
      <p v-else-if="!actions.canNotify" class="notify-block">{{ userFacingMessage(result.blocked_reason) || '当前暂不能通知，请核对通知记录。' }}</p>
      <p v-if="actions.showDecline && !actions.canDecline" class="notify-block">{{ userFacingMessage(result.decline_blocked_reason) || '当前账号暂不能作出不通知决定。' }}</p>
      <button v-if="actions.refreshOnly" class="btn" type="button" :disabled="loading || sending" @click="load">刷新状态</button>
      <button v-if="actions.canRetryOriginal" class="btn pri" type="button" :disabled="loading || sending" @click="retryOriginalOperation">重试原操作</button>
      <button v-if="actions.showDecline" class="btn" type="button" :disabled="!actions.canDecline || loading || sending || !!error" @click="declineNotification">不通知</button>
      <button v-if="actions.showNotify" class="btn pri notify-send" type="button" :disabled="!actions.canNotify || loading || sending || !!error" @click="notifyDepartment">{{ sending ? '正在通知' : buttonLabel }}</button>
    </template>
    <template v-else-if="!decisionWorkflow && needsNotification">
      <p v-if="error" class="notify-block" role="alert">{{ error }}</p>
      <p v-else-if="!result.can_notify" class="notify-block">{{ userFacingMessage(result.blocked_reason) || '当前暂不能通知，请核对通知记录。' }}</p>
      <button class="btn pri notify-send" type="button" :disabled="!result.can_notify || loading || sending || !!error" @click="notifyDepartment">{{ sending ? '正在通知' : buttonLabel }}</button>
    </template>
  </Teleport>
  <section class="sect punishment-notification" :aria-label="heading" :aria-busy="loading">
    <header>
      <h4>{{ heading }} <span v-if="result?.simulated" class="tag t-amber" title="模拟通道，不代表真实通知或回执">模拟通道</span></h4>
      <button class="btn sm" type="button" :disabled="loading || sending" @click="load">{{ loading ? '正在刷新' : '刷新通知状态' }}</button>
    </header>
    <p v-if="loading && !result" role="status">正在读取通知记录</p>
    <p v-if="error && !needsNotification" role="alert">{{ error }}</p>
    <template v-if="result">
      <dl class="kv kv-surface">
        <dt>{{ decisionWorkflow ? '通知状态' : '送达状态' }}</dt><dd>{{ deliveryText }}</dd>
        <dt>签收回执</dt><dd>{{ receiptText }}</dd>
        <template v-if="decisionWorkflow && result.notification_decision.state !== 'PENDING_DECISION'">
          <dt>决定人</dt><dd>{{ result.notification_decision.decided_by_name || '姓名未记录' }}</dd>
          <dt>决定时间</dt><dd>{{ date(result.notification_decision.decided_at) }}</dd>
          <template v-if="result.notification_decision.state === 'DO_NOT_NOTIFY'"><dt>不通知原因</dt><dd>{{ result.notification_decision.reason || '未记录' }}</dd></template>
        </template>
        <template v-if="failureReason && failureReason !== error && !(needsNotification && !error && !result.can_notify && failureReason === userFacingMessage(result.blocked_reason))"><dt>上次受阻原因</dt><dd>{{ failureReason }}</dd></template>
        <template v-if="result.latest_delivery?.submitted_at"><dt>发送时间</dt><dd>{{ date(result.latest_delivery.submitted_at) }}</dd></template>
        <template v-if="result.latest_delivery?.delivered_at"><dt>送达时间</dt><dd>{{ date(result.latest_delivery.delivered_at) }}</dd></template>
        <template v-if="result.latest_delivery?.acknowledged_at"><dt>签收时间</dt><dd>{{ date(result.latest_delivery.acknowledged_at) }}</dd></template>
      </dl>
      <p v-if="decisionWorkflow && result.notification_decision.state === 'DO_NOT_NOTIFY'">本次不通知（已记录），不等于认定无违法或免予处罚。</p>
      <details v-if="riskNotice || (decisionWorkflow && (historyTotal || historyError))">
        <summary>{{ decisionWorkflow ? '通知记录' : '发送尝试记录' }}（{{ historyTotal }}）</summary>
        <p v-if="historyError" role="alert">{{ historyError }}</p>
        <p v-for="attempt in history" :key="attempt.delivery_id"><template v-if="decisionWorkflow && attempt.blocked_reason === 'PENDING_NOTIFICATION_DECISION'">待办建立（尚未发送） · {{ date(attempt.created_at) }}</template><template v-else>{{ decisionWorkflow ? '实际发送' : `第 ${attempt.attempt_no} 次` }} · {{ date(attempt.submitted_at || attempt.created_at) }} · {{ deliveryView(attempt).label }} · {{ receiptView(attempt).label }}<template v-if="notificationBlockedReason(attempt)"> · {{ notificationBlockedReason(attempt) }}</template></template></p>
        <div v-if="historyTotal > historySize" class="pager">
          <button class="btn sm" :disabled="loading || sending || historyPage <= 1" @click="historyPage--; load()">上一页</button>
          <span>第 {{ historyPage }} / {{ Math.ceil(historyTotal / historySize) }} 页</span>
          <button class="btn sm" :disabled="loading || sending || historyPage * historySize >= historyTotal" @click="historyPage++; load()">下一页</button>
        </div>
      </details>
    </template>
  </section>
</template>

<style scoped>
.punishment-notification header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.punishment-notification h4{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.punishment-notification p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.punishment-notification .btn{white-space:normal;height:auto;min-height:32px}
</style>
