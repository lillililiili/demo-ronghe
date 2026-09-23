<script setup>
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
  return reason === 'CHANNEL_NOT_CONNECTED' ? '通知渠道尚未接通' : reason || '';
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
      : e.status === 404 ? '通知接口或交接记录不可用，请确认配套后端已更新。' : e.message || '通知状态读取失败，请重新查询。';
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
      if (!current() || props.handoffId !== id || sending.value) return true;
      const request = pending.value || { key: newHandoffIdempotencyKey(), attempt };
      try { savePending(request); }
      catch { error.value = '无法保存本次提交编号，请允许浏览器会话存储后重试。'; return true; }
      sending.value = true; error.value = '';
      try {
        await handoffApi.notifyHandoff(id, request.attempt, request.key);
        if (!current()) return true;
        savePending(null);
        await load();
        if (current()) toast('通知记录已更新，请查看送达与签收结果。', 'ok');
      } catch (e) {
        if (!current()) return true;
        const uncertain = !e.status || e.status >= 500;
        if (!uncertain) savePending(null);
        await load();
        if (current()) error.value = uncertain
          ? '本次提交结果未确认，已保留提交编号。请先查询；仍未发出时可重试原通知。'
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
  <Teleport to="#pnNotifyDock">
    <template v-if="needsNotification">
      <button class="btn pri notify-send" type="button" :disabled="!result.can_notify || loading || sending || !!error" @click="notifyDepartment">{{ sending ? '正在通知' : buttonLabel }}</button>
      <p v-if="!result.can_notify" class="notify-block">{{ result.blocked_reason || '当前暂不能通知，请核对通知记录。' }}</p>
    </template>
  </Teleport>
  <section class="sect punishment-notification" aria-label="处罚部门通知">
    <header>
      <h4>处罚部门通知</h4>
      <button class="btn sm" type="button" :disabled="loading || sending" @click="load">查询送达与回执</button>
    </header>
    <p v-if="loading">正在查询通知记录</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="result">
      <dl class="kv kv-surface">
        <dt>送达状态</dt><dd>{{ deliveryText }}</dd>
        <dt>签收回执</dt><dd>{{ receiptText }}</dd>
        <template v-if="failureReason"><dt>上次尝试说明</dt><dd>{{ failureReason }}</dd></template>
        <template v-if="result.latest_delivery?.submitted_at"><dt>发送时间</dt><dd>{{ date(result.latest_delivery.submitted_at) }}</dd></template>
        <template v-if="result.latest_delivery?.delivered_at"><dt>送达时间</dt><dd>{{ date(result.latest_delivery.delivered_at) }}</dd></template>
        <template v-if="result.latest_delivery?.acknowledged_at"><dt>签收时间</dt><dd>{{ date(result.latest_delivery.acknowledged_at) }}</dd></template>
      </dl>
      <p v-if="result.simulated" class="notification-mode">模拟通知通道，不代表真实通知或真实回执。</p>
    </template>
    <p class="notification-help">查询仅更新送达和签收记录，不会再次发送。处罚决定及办理进度见“处罚办理结果”。</p>
  </section>
</template>

<style scoped>
.punishment-notification header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.punishment-notification h4{margin:0}
.punishment-notification p{font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.notification-help{color:var(--muted)}
.notification-mode{color:var(--amber)}
.punishment-notification .btn{white-space:normal;height:auto;min-height:32px}
</style>
