<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { flightApi } from '@/services/flightApi.js';
import PlanDeviceCheck from '@/pages/flights/components/PlanDeviceCheck.vue';
import RecipientSnapshotFields from '@/components/notifications/RecipientSnapshotFields.vue';
const props = defineProps({ plan: { type: Object, required: true }, match: { type: Object, default: null } });
const emit = defineEmits(['map-devices']);
const data = ref(null), loading = ref(false), error = ref(''), errorStatus = ref(0);
const checkedAt = ref(Date.now());
let token = 0;
const conclusions = { AUTO_DEVICE_ABNORMAL: '系统检测到附近设备异常，是否起飞待确认', SUSPECTED_NOT_TAKEN_OFF: '附近无异常设备，疑似未按计划起飞', CHECK_INCOMPLETE: '设备信息不足，是否起飞待确认', NOT_TAKEN_OFF: '已确认未按计划起飞', DEVICE_ABNORMAL: '已确认监测设备异常，是否起飞还不清楚' };
const delivery = { PENDING_DELIVERY: '等待发送', SUBMITTED: '已提交发送，等待送达', DELIVERED: '已送达', FAILED: '发送失败' };
const receipt = { NOT_EXPECTED: '暂不等待对方确认', PENDING: '等待对方确认收到', ACKNOWLEDGED: '对方已确认收到', TIMEOUT: '对方未按时确认收到' };
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
watch(() => [props.plan.plan_id, props.plan.status_code, props.plan.start_at], () => {
  reload();
}, { immediate: true });
onUnmounted(() => { token++; });
</script>

<template>
  <section v-if="preflight" class="sect plan-preflight">
    <h4>起飞前 · 周边设备检查</h4>
    <PlanDeviceCheck :key="plan.plan_id" :plan="plan" @map-devices="emit('map-devices', { planId: plan.plan_id, check: $event })" />
  </section>
  <div v-if="error" class="warnbox">核实与通知记录暂时无法读取：{{ error }} <button v-if="![401,403].includes(errorStatus)" class="btn" type="button" @click="reload">重试</button></div>
  <section v-else-if="showPanel" class="sect plan-verification">
    <h4>{{ needsVerification ? '周边设备检查' : '历史检查与通知' }}</h4>
    <template v-if="data">
      <PlanDeviceCheck v-if="needsVerification" :key="plan.plan_id" :plan="plan" @map-devices="emit('map-devices', { planId: plan.plan_id, check: $event })" />
      <div v-if="hasHistory" class="workflow-actions"><button class="btn ghost" type="button" @click="reload">刷新记录</button></div>
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
      </article>
    </template>
  </section>
</template>
<style scoped>
.workflow-actions { display: flex; flex-wrap: wrap; gap: 8px; }
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
