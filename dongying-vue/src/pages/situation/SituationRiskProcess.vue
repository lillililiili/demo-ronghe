<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { riskApi } from '@/services/riskApi.js';
import { handoffApi } from '@/services/handoffApi.js';
import { hasPermission } from '@/services/accessControl.js';
import { useRealtimeRefresh } from '@/hooks/useRealtimeRefresh.js';
import { openRiskVerification } from '@/ui/riskVerificationModal.js';
import { openRiskNotification } from '@/ui/riskNotificationModal.js';
import { notificationBlockedReason, notificationSubmissionMessage, RECEIPT_RESULT_LABEL, RISK_STATE_LABEL, labelOf } from '@/ui/labels.js';
import { toast } from '@/ui/nv.js';

const props = defineProps({ riskId: { type: String, required: true }, revision: { type: Number, default: 0 } });
const emit = defineEmits(['updated']);
const risk = ref(null), loading = ref(false), error = ref('');
const history = ref([]), historyTotal = ref(0), historyError = ref('');
const notices = ref([]), noticesTotal = ref(0), noticesError = ref(''), recordsOpen = ref(false);
let generation = 0, alive = true;
const deliveryLabels = { PENDING_DELIVERY: '等待发送', SUBMITTED: '送达待确认', DELIVERED: '已送达', FAILED: '发送失败' };
const receiptLabels = { NOT_EXPECTED: '尚未进入回执阶段', PENDING: '等待回执', ACKNOWLEDGED: '已回执', TIMEOUT: '回执超时' };
const submitted = computed(() => notices.value.find(row => row.delivery_status && row.delivery_status !== 'FAILED'));
const canVerify = computed(() => !loading.value && !error.value
  && ['PENDING_VERIFICATION', 'PENDING_NOTIFICATION'].includes(risk.value?.state) && risk.value.allowed_actions?.includes('VERIFY'));
const canNotify = computed(() => !loading.value && !error.value && !noticesError.value && !submitted.value
  && hasPermission('handoff:create') && risk.value?.state === 'PENDING_NOTIFICATION');
const verifyReason = computed(() => loading.value ? '正在读取办理状态，请稍候' : canVerify.value ? '提交核验通过或排除结论' : '未授予核验权限，或当前风险状态不允许核验');
const notifyReason = computed(() => !hasPermission('handoff:create') ? '当前账号没有通知上级的操作权限'
  : noticesError.value ? '通知记录读取失败，请刷新核对后再提交'
    : submitted.value ? `已提交通知（${deliveryLabels[submitted.value.delivery_status] || '状态未知'}），不能重复提交`
      : risk.value?.state === 'PENDING_VERIFICATION' ? '人工核验通过后可通知上级' : '');
const time = value => value == null ? '未知' : new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
const message = reason => reason.status === 401 ? '登录已失效，请重新登录。'
  : reason.status === 403 ? '当前账号没有查看或办理这项记录的权限。' : reason.message || '读取失败，请重试。';
const receiptText = row => [receiptLabels[row.receipt_status] || '回执状态未知', labelOf(RECEIPT_RESULT_LABEL, row.receipt_result, '')].filter(Boolean).join(' · ');

async function load({ quiet = false } = {}) {
  if (quiet && loading.value) return null;
  const token = ++generation, id = props.riskId;
  const current = () => alive && token === generation && id === props.riskId;
  loading.value = true; error.value = '';
  try {
    if (!hasPermission('risk:read')) throw Object.assign(new Error(), { status: 403 });
    const latest = await riskApi.getRisk(id);
    if (!current()) return null;
    if (latest?.risk_id !== id) throw new Error('风险详情与当前记录不一致，请重新读取。');
    risk.value = latest;
    const results = await Promise.allSettled([
      riskApi.listRiskVerifications(id, { page: 1, size: 10 }),
      hasPermission('handoff:read') ? handoffApi.listHandoffs({ source_kind: 'RISK', source_id: id, page: 1, size: 20 })
        : Promise.reject(Object.assign(new Error(), { status: 403 }))
    ]);
    if (!current()) return null;
    const [verification, notification] = results;
    history.value = verification.status === 'fulfilled' ? verification.value.items || [] : [];
    historyTotal.value = verification.status === 'fulfilled' ? verification.value.total || 0 : 0;
    historyError.value = verification.status === 'rejected' ? message(verification.reason) : '';
    notices.value = notification.status === 'fulfilled' ? notification.value.items || [] : [];
    noticesTotal.value = notification.status === 'fulfilled' ? notification.value.total || 0 : 0;
    noticesError.value = notification.status === 'rejected' ? message(notification.reason) : '';
    return latest;
  } catch (reason) {
    if (current()) { error.value = message(reason); risk.value = null; history.value = []; notices.value = []; }
    return null;
  } finally { if (current()) loading.value = false; }
}
async function refreshAfterAction(id) {
  if (!alive || id !== props.riskId) return riskApi.getRisk(id);
  const latest = await load();
  if (alive && id === props.riskId) emit('updated');
  return latest;
}
function verify() {
  if (!canVerify.value) return;
  const id = props.riskId;
  openRiskVerification({ risk: risk.value, refresh: () => refreshAfterAction(id) });
}
function notify() {
  if (!canNotify.value) return;
  const id = props.riskId;
  const showRecords = () => { if (alive && props.riskId === id) recordsOpen.value = true; };
  openRiskNotification({ risk: risk.value, refresh: () => refreshAfterAction(id), onExisting: showRecords,
    onDone: created => { showRecords(); toast(notificationSubmissionMessage(created).message, 'ok'); } });
}
watch(() => props.riskId, () => {
  risk.value = null; history.value = []; notices.value = []; recordsOpen.value = false; load();
}, { immediate: true });
watch(() => props.revision, () => load({ quiet: true }));
useRealtimeRefresh(['risk', 'punishment'], () => load({ quiet: true }), { minIntervalMs: 1500 });
function accessChanged() { load(); }
onMounted(() => window.addEventListener('auth-access-change', accessChanged));
onUnmounted(() => { alive = false; generation++; window.removeEventListener('auth-access-change', accessChanged); });
</script>

<template>
  <section class="situation-risk-process" :data-risk-id="riskId" aria-label="风险核验与通知">
    <div class="process-heading"><b>人工核验 → 通知上级 → 回执</b><button class="btn ghost" type="button" :disabled="loading" @click="load()">刷新</button></div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!risk" role="status">正在读取办理状态…</p>
    <template v-else>
      <p>办理状态：{{ labelOf(RISK_STATE_LABEL, risk.state, '状态待确认') }}</p>
      <p v-if="risk.state === 'PENDING_VERIFICATION'">{{ canVerify ? '核验通过后可通知上级。' : verifyReason }}</p>
      <p v-else-if="risk.state === 'PENDING_NOTIFICATION' && notifyReason">{{ notifyReason }}</p>
      <div class="process-actions">
        <button v-if="risk.state === 'PENDING_VERIFICATION' || (risk.state === 'PENDING_NOTIFICATION' && canVerify)"
          class="btn" :class="{ pri: risk.state === 'PENDING_VERIFICATION' }" type="button" :disabled="!canVerify" :title="verifyReason" @click="verify">{{ risk.state === 'PENDING_NOTIFICATION' ? '改判为排除' : '人工核验' }}</button>
        <button v-if="['PENDING_VERIFICATION', 'PENDING_NOTIFICATION'].includes(risk.state)" class="btn" :class="{ pri: canNotify }"
          type="button" :disabled="!canNotify" :title="notifyReason" @click="notify">通知上级</button>
        <button class="btn ghost" type="button" :aria-expanded="recordsOpen" @click="recordsOpen = !recordsOpen">{{ recordsOpen ? '收起通知与回执' : '通知与回执' }}{{ noticesTotal ? `（${noticesTotal}）` : '' }}</button>
      </div>
      <div v-if="recordsOpen" class="process-records">
        <p v-if="noticesError" role="alert">{{ noticesError }}</p>
        <p v-else-if="!notices.length">这条风险尚无通知记录。</p>
        <article v-for="notice in notices" :key="notice.handoff_id">
          <b>通知上级 · {{ deliveryLabels[notice.delivery_status] || '发送状态未知' }}</b>
          <p>{{ time(notice.created_at) }}</p><p>对方回复：{{ receiptText(notice) }}</p>
          <p v-if="notificationBlockedReason(notice)">未完成原因：{{ notificationBlockedReason(notice) }}</p>
        </article>
        <p v-if="noticesTotal > notices.length">共 {{ noticesTotal }} 条，当前展示最近 {{ notices.length }} 条通知。</p>
      </div>
      <details class="process-history"><summary>核验历史{{ historyTotal ? `（${historyTotal}）` : '' }}</summary>
        <p v-if="historyError" role="alert">{{ historyError }}</p><p v-else-if="!history.length">尚无已保存的核验记录。</p>
        <article v-for="item in history" :key="item.history_id">
          <b>{{ item.conclusion === 'EXCLUDED' ? '排除' : item.conclusion === 'CONFIRMED' ? '核验通过' : '结论未提供' }}</b>
          <p>{{ item.note || '未补充说明' }}</p><p>{{ time(item.created_at) }} · {{ item.actor_name || '操作人员' }}</p>
        </article>
        <p v-if="historyTotal > history.length">共 {{ historyTotal }} 条，当前展示最近 {{ history.length }} 条核验。</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.situation-risk-process{padding:10px;border-top:1px solid var(--line);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.process-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.process-heading>b{font-size:12px;color:var(--txt)}
p{margin:6px 0;color:var(--txt-2)}.process-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.process-actions .btn{min-height:32px;white-space:normal}
.process-records article,.process-history article{padding:8px 0;border-top:1px solid var(--line)}.process-history{margin-top:8px}.process-history summary{cursor:pointer;color:var(--txt-2)}
</style>
