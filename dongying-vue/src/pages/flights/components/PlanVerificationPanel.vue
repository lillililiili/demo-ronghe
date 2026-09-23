<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { flightApi } from '@/services/flightApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import PlanDeviceCheck from '@/pages/flights/components/PlanDeviceCheck.vue';
import RecipientSnapshotFields from '@/components/notifications/RecipientSnapshotFields.vue';
const props = defineProps({ plan: { type: Object, required: true }, match: { type: Object, default: null } });
const emit = defineEmits(['map-devices']);
const data = ref(null), loading = ref(false), error = ref(''), errorStatus = ref(0), busy = ref(false);
const checkedAt = ref(Date.now());
const actionNotice = ref('');
const deviceCheck = ref(null);
let token = 0, disposed = false;
const conclusions = { AUTO_DEVICE_ABNORMAL: '系统检测到附近设备异常，是否起飞待确认', SUSPECTED_NOT_TAKEN_OFF: '附近无异常设备，疑似未按计划起飞', CHECK_INCOMPLETE: '设备信息不足，是否起飞待确认', NOT_TAKEN_OFF: '已确认未按计划起飞', DEVICE_ABNORMAL: '已确认监测设备异常，是否起飞还不清楚' };
const delivery = { PENDING_DELIVERY: '等待发送', SUBMITTED: '已提交发送，等待送达', DELIVERED: '已送达', FAILED: '发送失败' };
const receipt = { NOT_EXPECTED: '暂不等待对方确认', PENDING: '等待对方确认收到', ACKNOWLEDGED: '对方已确认收到', TIMEOUT: '对方未按时确认收到' };
const blockerText = computed(() => ({
  '没有计划核实权限': '你没有核实权限，请联系值班负责人。',
  '已取消计划不进入未起飞核实': '计划已取消，无需核实是否起飞。',
  '尚未到计划开始时间，不能核实未按计划起飞': '还没到计划起飞时间，暂时不用核实。',
  '没有实际对照查看权限，不能确认是否需要核实': '你没有查看飞行记录的权限，请联系值班负责人核实。',
  '实际对照暂不可用': '飞行记录暂时读不到，请稍后刷新再核实。',
  '已经关联感知目标，请查看实际轨迹与研判': '已找到这份计划对应的飞行目标，请查看地图上的轨迹和计划执行情况。'
}[data.value?.verification_blocker] || data.value?.verification_blocker || ''));
const latest = computed(() => data.value?.verifications?.[0]);
const recordGroups = computed(() => {
  const groups = new Map((data.value?.verifications || []).map(record => [record.verification_id,
    { key: record.verification_id, verification: record, notifications: [] }]));
  for (const item of data.value?.feedback || []) {
    const key = item.verification_id || `notification:${item.feedback_id}`;
    if (!groups.has(key)) groups.set(key, { key, verification: null, notifications: [] });
    groups.get(key).notifications.push(item);
  }
  return [...groups.values()].map(group => ({ ...group, summary: verificationSummary(group.verification) }));
});
const hasHistory = computed(() => !!(data.value?.verifications?.length || data.value?.feedback?.length));
const preflight = computed(() => ['PENDING', 'APPROVED'].includes(props.plan.status_code)
  && new Date(props.plan.start_at).getTime() > checkedAt.value);
// 状态决定这一步是否适用；权限仅决定适用时能否办理，不能把两者混为一谈。
const needsVerification = computed(() => {
  const start = props.plan.start_at == null ? NaN : new Date(props.plan.start_at).getTime();
  if (props.plan.status_code === 'CANCELLED' || !Number.isFinite(start) || start > checkedAt.value) return false;
  if (props.match?.target_id || data.value?.verification_blocker === '已经关联感知目标，请查看实际轨迹与研判') return false;
  return !!data.value?.can_verify || ['AVAILABLE', 'NO_EVALUATION'].includes(props.match?.availability);
});
const showPanel = computed(() => !!data.value && (needsVerification.value || hasHistory.value));
const feedbackExists = computed(() => data.value?.feedback?.some(item => item.verification_id === latest.value?.verification_id));
const canNotify = computed(() => !!(data.value?.can_feedback && data.value.recipient_id && data.value.recipient_name && !data.value.recipient_blocked_reason));
const recipientName = computed(() => data.value?.recipient_snapshot?.org_name || data.value?.recipient_snapshot?.recipient_name || data.value?.recipient_name);
const canFeedback = computed(() => canNotify.value && latest.value && !feedbackExists.value);
function date(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function isAutomatic(record) { return ['AUTO_DEVICE_ABNORMAL','SUSPECTED_NOT_TAKEN_OFF','CHECK_INCOMPLETE'].includes(record?.conclusion); }
function verificationSummary(record) {
  // 历史接口仅保存文字依据：原样展示已记录的摘要，不借用当前设备状态推算历史数量。
  const lines = typeof record?.evidence === 'string' ? record.evidence.split(/\r?\n/) : [];
  const basis = lines.find(line => line.startsWith('系统检查时间：')) || '';
  const sourceLines = lines.filter(line => line.startsWith('数据来源：'));
  return {
    basis, source: sourceLines.join('\n'),
    detailEvidence: lines.filter(line => line !== basis && !sourceLines.includes(line)).join('\n').trim()
  };
}
function deliveryTone(item) {
  return ({ DELIVERED: 't-cyan', FAILED: 't-red', SUBMITTED: 't-blue', PENDING_DELIVERY: 't-amber' })[item.delivery_status] || 't-gray';
}
function notificationBlocker(item) {
  if (item.blocked_reason === 'DELIVERY_OUTCOME_UNKNOWN') return '通知发送结果未知，请先核对原发送记录，不能重复通知。';
  return item.blocked_reason === 'CHANNEL_NOT_CONNECTED' ? '通知功能尚未接通，记录已保存但还未发出。' : item.blocked_reason;
}
async function reload() {
  const current = ++token, id = props.plan.plan_id;
  checkedAt.value = Date.now();
  data.value = null; error.value = ''; errorStatus.value = 0; loading.value = true;
  try { const result = await flightApi.verifications(id); if (current === token) data.value = result; }
  catch (reason) { if (current === token) { error.value = reason.message || '核实记录读取失败'; errorStatus.value = reason.status || 0; } }
  finally { if (current === token) loading.value = false; }
}
function notificationMessage(result) {
  if (result?.blocked_reason === 'DELIVERY_OUTCOME_UNKNOWN') return '检查结果已保存，通知发送结果未知，请先核对原发送记录。';
  if (result?.delivery_status === 'DELIVERED') return '检查结果已保存，通知已送达。';
  if (result?.blocked_reason || result?.delivery_status === 'FAILED') return '检查结果已保存，通知尚未发出，请查看记录中的原因。';
  return '检查结果已保存，通知已提交，可在记录中查看发送进度。';
}
async function verify() {
  if (!needsVerification.value || !data.value?.can_verify || !deviceCheck.value || busy.value) return;
  const id = props.plan.plan_id, revision = data.value.revision, receiver = data.value.recipient_id;
  const shouldNotify = canNotify.value;
  const notificationBlocker = data.value.recipient_blocked_reason
    || (!receiver || !data.value.recipient_name ? '尚未配置计划反馈接收对象' : '你没有发送通知的权限');
  const isCurrent = () => !disposed && props.plan.plan_id === id;
  busy.value = true;
  actionNotice.value = '';
  let saved = false;
  try {
    const verification = await flightApi.automaticCheck(id, { expected_revision: revision }, crypto.randomUUID());
    saved = true;
    if (!isCurrent()) return;
    if (!verification?.verification_id) throw new Error('未收到检查记录编号，请刷新核对。');
    if (!shouldNotify) {
      actionNotice.value = `检查结果已保存，未提交通知：${notificationBlocker}。`;
      return;
    }
    const result = await flightApi.feedbackPlan(id, { verification_id: verification.verification_id, recipient_id: receiver }, crypto.randomUUID());
    if (isCurrent()) actionNotice.value = notificationMessage(result);
  } catch (reason) {
    if (!isCurrent()) return;
    actionNotice.value = saved ? `检查结果已保存，通知未确认提交成功：${reason.message || '请求失败'}。请核对下方记录后继续通知。`
      : isUncertainOutcome(reason) ? '尚未确认检查结果是否保存，请刷新核对记录后再操作。'
        : reason.message || '检查未完成，未提交通知。';
  } finally {
    if (isCurrent()) await reload();
    busy.value = false;
  }
}
async function feedback() {
  if (!canFeedback.value || busy.value) return;
  const id = props.plan.plan_id, verification = latest.value, receiver = data.value.recipient_id;
  const isCurrent = () => !disposed && props.plan.plan_id === id;
  busy.value = true;
  actionNotice.value = '';
  try {
    const result = await flightApi.feedbackPlan(id, { verification_id: verification.verification_id, recipient_id: receiver }, crypto.randomUUID());
    if (!isCurrent()) return;
    actionNotice.value = notificationMessage(result);
  } catch (reason) {
    if (!isCurrent()) return;
    actionNotice.value = `通知未确认提交成功：${reason.message || '请求失败'}。请核对记录后再操作，检查结果已保留。`;
  } finally {
    if (isCurrent()) await reload();
    busy.value = false;
  }
}
watch(() => [props.plan.plan_id, props.plan.status_code, props.plan.start_at], () => {
  actionNotice.value = ''; deviceCheck.value = null;
  reload();
}, { immediate: true });
onUnmounted(() => { disposed = true; token++; });
</script>

<template>
  <section v-if="preflight" class="sect plan-preflight">
    <h4>起飞前 · 周边设备检查</h4>
    <PlanDeviceCheck :key="plan.plan_id" :plan="plan" @map-devices="emit('map-devices', { planId: plan.plan_id, check: $event })" />
  </section>
  <div v-if="error" class="warnbox">核实与通知记录暂时无法读取：{{ error }} <button v-if="![401,403].includes(errorStatus)" class="btn" type="button" @click="reload">重试</button></div>
  <section v-else-if="showPanel" class="sect plan-verification">
    <h4>{{ needsVerification ? '自动检查与通知' : '历史检查与通知' }}</h4>
    <template v-if="data">
      <p v-if="actionNotice" class="workflow-note" role="status">{{ actionNotice }}</p>
      <PlanDeviceCheck v-if="needsVerification" :key="plan.plan_id" :plan="plan" @checked="deviceCheck = $event" @map-devices="emit('map-devices', { planId: plan.plan_id, check: $event })" />
      <p v-if="needsVerification && !latest && blockerText" class="workflow-note">{{ blockerText }}</p>
      <div class="workflow-actions"><button v-if="needsVerification && !latest" class="btn pri" type="button" :disabled="!data.can_verify || !deviceCheck || busy" :title="blockerText" @click="verify">{{ busy ? (canNotify ? '正在检查并通知' : '正在保存检查') : (canNotify ? '通知报送单位确认' : '保存检查结果') }}</button><button v-else-if="latest && !feedbackExists" class="btn pri" type="button" :disabled="!canFeedback || busy" @click="feedback">{{ busy ? '正在提交' : '继续通知报送单位' }}</button><button v-if="hasHistory" class="btn ghost" type="button" :disabled="busy" @click="reload">刷新记录</button></div>
      <template v-if="!feedbackExists && (latest || needsVerification)">
        <p v-if="!data.recipient_id || !data.recipient_name" class="workflow-note">{{ data.recipient_blocked_reason || '尚未设置接收单位，请联系管理员设置后再通知。' }}</p>
        <p v-else class="workflow-note">接收单位：{{ recipientName }}<template v-if="data.recipient_blocked_reason"> · {{ data.recipient_blocked_reason }}</template><template v-else-if="!data.can_feedback"> · 你没有发送通知的权限</template><template v-else-if="!latest"> · 自动附上设备检查结果，请对方确认是否起飞</template></p>
        <dl v-if="data.recipient_snapshot" class="kv recipient-summary"><RecipientSnapshotFields :snapshot="data.recipient_snapshot" /></dl>
      </template>
      <article v-for="group in recordGroups" :key="group.key" class="verification-record">
        <b class="record-conclusion">{{ group.verification ? (conclusions[group.verification.conclusion] || '未知结论') : '核实内容暂不可用' }}</b>
        <p v-if="group.summary.basis" class="record-meta">{{ group.summary.basis }}</p>
        <p v-else-if="group.verification" class="record-meta">记录保存时间：{{ date(group.verification.handled_at) }} · 检查依据见详情</p>
        <p v-if="group.summary.source" class="record-source">{{ group.summary.source }}</p>
        <div v-if="!group.notifications.length" class="record-statuses"><span class="tag t-gray">未通知报送单位</span></div>
        <div v-for="item in group.notifications" :key="item.feedback_id" class="notification-summary">
          <div class="record-statuses">
            <span class="tag" :class="deliveryTone(item)">通知{{ item.blocked_reason === 'DELIVERY_OUTCOME_UNKNOWN' ? '发送结果未知' : delivery[item.delivery_status] || '结果未知' }}</span>
            <span class="tag" :class="item.receipt_status === 'ACKNOWLEDGED' ? 't-cyan' : item.receipt_status === 'TIMEOUT' ? 't-amber' : 't-gray'">{{ receipt[item.receipt_status] || '回执状态未知' }}</span>
            <span class="tag" :class="item.processing_result ? 't-blue' : 't-gray'">{{ item.processing_result ? '已回复处理结果' : '待回复处理结果' }}</span>
            <span v-if="['MOCK', 'SMS_SIMULATED', 'VOICE_SIMULATED'].includes(item.recipient_snapshot?.channel_type)" class="tag t-gray">模拟通知通道</span>
          </div>
          <p class="record-meta">通知提交于 {{ date(item.created_at) }} · {{ item.recipient_snapshot?.org_name || item.recipient_snapshot?.recipient_name || item.recipient_name || '接收单位未记录' }}</p>
          <p v-if="item.blocked_reason" class="record-blocker">{{ notificationBlocker(item) }}</p>
          <details class="record-details">
            <summary><span class="detail-expand">查看通知详情</span><span class="detail-collapse">收起通知详情</span></summary>
            <dl class="kv">
              <RecipientSnapshotFields :snapshot="item.recipient_snapshot" historical />
              <template v-if="item.delivered_at"><dt>送达时间</dt><dd>{{ date(item.delivered_at) }}</dd></template>
              <template v-if="item.acknowledged_at"><dt>签收时间</dt><dd>{{ date(item.acknowledged_at) }}</dd></template>
              <template v-if="item.processing_result"><dt>处理结果</dt><dd>{{ item.processing_result }}</dd></template>
            </dl>
          </details>
        </div>
        <details v-if="group.verification" class="record-details">
          <summary><span class="detail-expand">查看检查详情</span><span class="detail-collapse">收起检查详情</span></summary>
          <dl class="kv">
            <template v-if="group.verification">
              <template v-if="group.summary.detailEvidence"><dt>检查依据</dt><dd>{{ group.summary.detailEvidence }}</dd></template><template v-else-if="!group.verification.evidence"><dt>检查依据</dt><dd>未记录</dd></template>
              <template v-if="!group.summary.source"><dt>数据来源</dt><dd>原检查记录未注明</dd></template>
              <template v-if="!isAutomatic(group.verification)"><dt>说明</dt><dd>{{ group.verification.note || '未记录' }}</dd></template>
              <dt>{{ isAutomatic(group.verification) ? '提交人' : '核实人' }}</dt><dd>{{ group.verification.handled_by_name }}</dd>
              <template v-if="group.summary.basis"><dt>记录保存时间</dt><dd>{{ date(group.verification.handled_at) }}</dd></template>
            </template>
          </dl>
        </details>
        <details v-if="group.verification && group.verification.verification_id === latest?.verification_id && needsVerification && data.can_verify" class="record-more"><summary>更多操作</summary><button class="btn ghost" type="button" :disabled="busy || !deviceCheck" @click="verify">{{ canNotify ? '重新检查并通知' : '重新检查并保存' }}</button></details>
      </article>
    </template>
  </section>
</template>
<style scoped>
.workflow-note { color: var(--txt-3); font-size: 12px; line-height: 1.6; margin: 8px 0; }
.record-more { margin-top: 8px; font-size: 12px; color: var(--txt-3); }
.record-more summary { cursor: pointer; }
.workflow-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.recipient-summary { margin-top: 8px; }
.verification-record { margin-top: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; }
.record-conclusion { display: block; line-height: 1.6; overflow-wrap: anywhere; }
.record-meta,.record-source,.record-blocker { margin: 6px 0 0; font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.record-meta { color: var(--txt-3); }
.record-source { color: var(--txt-2); }
.record-blocker { color: var(--amber); }
.record-statuses { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 8px; }
.record-statuses .tag { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.notification-summary + .notification-summary { margin-top: 10px; padding-top: 2px; border-top: 1px solid var(--line); }
.record-details { margin-top: 10px; }
.record-details > summary { width: fit-content; max-width: 100%; cursor: pointer; color: var(--cyan); font-size: 12px; line-height: 1.8; }
.record-details > summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; border-radius: 3px; }
.record-details .detail-collapse,.record-details[open] .detail-expand { display: none; }
.record-details[open] .detail-collapse { display: inline; }
.verification-record .kv { grid-template-columns: minmax(0, auto) minmax(0, 1fr); margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.verification-record dt { white-space: normal; overflow-wrap: anywhere; }
.verification-record .notification-start { padding-top: 10px; }
.verification-record dd { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
