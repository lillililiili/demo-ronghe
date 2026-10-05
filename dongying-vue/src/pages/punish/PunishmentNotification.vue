<script setup>
import { userFacingMessage } from '@/ui/labels.js';
import { computed, onUnmounted, ref, watch } from 'vue';
import { handoffApi, newHandoffIdempotencyKey } from '@/services/handoffApi.js';
import { authSession, authUser } from '@/services/auth.js';
import { openConfirm } from '@/ui/confirm.js';
import { toast } from '@/ui/nv.js';
import { deliveryView, receiptView } from './handoffStatus.js';

const props = defineProps({ handoffId: { type: String, required: true }, recipientName: String });
const emit = defineEmits(['status']);
const result = ref(null), loading = ref(false), sending = ref(false), error = ref(''), pending = ref(null);
let active = true, sequence = 0;
const session = authSession.value;
const current = () => active && session === authSession.value;
const storageKey = () => `punishment-notification:${authUser.value?.user_id || 'unknown'}:${props.handoffId}`;
function readPending() {
  try { pending.value = JSON.parse(sessionStorage.getItem(storageKey()) || 'null'); }
  catch { pending.value = null; }
}
function savePending(value) {
  if (value) sessionStorage.setItem(storageKey(), JSON.stringify(value));
  else sessionStorage.removeItem(storageKey());
  pending.value = value;
}
const deliveryText = computed(() => deliveryView(result.value).label);
const receiptText = computed(() => receiptView(result.value).label);
const failureReason = computed(() => {
  if (!['PENDING_DELIVERY', 'FAILED'].includes(result.value?.delivery_status)) return '';
  const reason = result.value?.latest_delivery?.blocked_reason;
  return userFacingMessage(reason);
});
const needsNotification = computed(() => ['PENDING_DELIVERY', 'FAILED'].includes(result.value?.delivery_status)
  && result.value?.receipt_status !== 'ACKNOWLEDGED');
const buttonLabel = computed(() => pending.value ? '重试原通知' : result.value?.delivery_status === 'FAILED' ? '重试通知' : '通知处罚部门');
const date = value => value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false });
async function load() {
  const seq = ++sequence, id = props.handoffId;
  loading.value = true; error.value = '';
  try {
    const data = await handoffApi.getHandoffNotification(id);
    if (!current() || seq !== sequence) return;
    result.value = data;
    if (pending.value && data.expected_attempt_no > pending.value.attempt) savePending(null);
    emit('status', data);
  } catch (e) {
    if (current() && seq === sequence) error.value = e.status === 403 ? '当前账号没有查看通知记录的权限。'
      : e.status === 404 ? '未找到通知记录，请返回交接列表重新选择；仍无法查看时联系管理员。' : e.message || '通知状态读取失败，请重新查询。';
  } finally { if (current() && seq === sequence) loading.value = false; }
}
function notifyDepartment() {
  if (!current() || loading.value || sending.value || error.value || !result.value?.can_notify) return;
  const id = props.handoffId, attempt = result.value.expected_attempt_no;
  const recipient = result.value.recipient_snapshot?.recipient_name || props.recipientName || '原处罚接收方';
  openConfirm({
    title: buttonLabel.value,
    message: `向「${recipient}」发送这份已提交的处罚交接材料。${result.value.simulated ? '本次使用模拟通道，不会发送真实通知。' : ''}送达和签收不代表处罚已办结。`,
    confirmText: '确认通知',
    onConfirm: async () => {
      if (!current() || props.handoffId !== id || loading.value || sending.value || error.value || !result.value?.can_notify) return true;
      const request = pending.value || { key: newHandoffIdempotencyKey(), attempt };
      try { savePending(request); }
      catch { error.value = '浏览器无法保存本次操作，通知尚未发送。请检查浏览器存储设置后重试。'; return true; }
      sending.value = true; error.value = '';
      try {
        await handoffApi.notifyHandoff(id, request.attempt, request.key);
        if (!current()) return true;
        savePending(null);
        await load();
        if (current() && !error.value) toast('通知状态已更新', 'ok');
      } catch (e) {
        if (!current()) return true;
        const uncertain = !e.status || e.status >= 500;
        if (!uncertain) savePending(null);
        await load();
        if (current()) error.value = uncertain
          ? '发送结果尚未确认，请先刷新通知状态，再按最新状态处理。'
          : e.message || '通知未能提交，请核对当前状态。';
      } finally { if (current()) sending.value = false; }
      return true;
    }
  });
}
watch(() => props.handoffId, () => { result.value = null; readPending(); load(); }, { immediate: true });
onUnmounted(() => { active = false; ++sequence; });
</script>

<template>
  <Teleport to="#pnNotifyDock" defer>
    <template v-if="needsNotification">
      <p v-if="error" class="notify-block" role="alert">{{ error }}</p>
      <p v-else-if="!result.can_notify" class="notify-block">{{ userFacingMessage(result.blocked_reason) || '当前暂不能通知，请核对通知记录。' }}</p>
      <button class="btn pri notify-send" type="button" :disabled="!result.can_notify || loading || sending || !!error" @click="notifyDepartment">{{ sending ? '正在通知' : buttonLabel }}</button>
    </template>
  </Teleport>
  <section class="sect punishment-notification" aria-label="处罚部门通知" :aria-busy="loading">
    <header>
      <h4>处罚部门通知 <span v-if="result?.simulated" class="tag t-amber" title="模拟通道，不代表真实通知或回执">模拟通道</span></h4>
      <button class="btn sm" type="button" :disabled="loading || sending" @click="load">{{ loading ? '正在刷新' : '刷新通知状态' }}</button>
    </header>
    <p v-if="loading && !result" role="status">正在读取通知记录</p>
    <p v-if="error && !needsNotification" role="alert">{{ error }}</p>
    <template v-if="result">
      <dl class="kv kv-surface">
        <dt>送达状态</dt><dd>{{ deliveryText }}</dd>
        <dt>签收回执</dt><dd>{{ receiptText }}</dd>
        <template v-if="failureReason && failureReason !== error && !(needsNotification && !error && !result.can_notify && failureReason === userFacingMessage(result.blocked_reason))"><dt>上次受阻原因</dt><dd>{{ failureReason }}</dd></template>
        <template v-if="result.latest_delivery?.submitted_at"><dt>发送时间</dt><dd>{{ date(result.latest_delivery.submitted_at) }}</dd></template>
        <template v-if="result.latest_delivery?.delivered_at"><dt>送达时间</dt><dd>{{ date(result.latest_delivery.delivered_at) }}</dd></template>
        <template v-if="result.latest_delivery?.acknowledged_at"><dt>签收时间</dt><dd>{{ date(result.latest_delivery.acknowledged_at) }}</dd></template>
      </dl>
    </template>
  </section>
</template>

<style scoped>
.punishment-notification header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.punishment-notification h4{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.punishment-notification p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.punishment-notification .btn{white-space:normal;height:auto;min-height:32px}
</style>
