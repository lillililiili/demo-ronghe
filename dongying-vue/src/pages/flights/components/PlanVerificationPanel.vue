<script setup>
import { computed, onUnmounted, ref, watch } from 'vue';
import { flightApi } from '@/services/flightApi.js';
import { isUncertainOutcome } from '@/services/apiClient.js';
import PlanDeviceCheck from '@/pages/flights/components/PlanDeviceCheck.vue';
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
  return [...groups.values()];
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
const canNotify = computed(() => !!(data.value?.can_feedback && data.value.recipient_id && data.value.recipient_name));
const canFeedback = computed(() => canNotify.value && latest.value && !feedbackExists.value);
function date(value) { return value == null ? '未记录' : new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function isAutomatic(record) { return ['AUTO_DEVICE_ABNORMAL','SUSPECTED_NOT_TAKEN_OFF','CHECK_INCOMPLETE'].includes(record?.conclusion); }
async function reload() {
  const current = ++token, id = props.plan.plan_id;
  checkedAt.value = Date.now();
  data.value = null; error.value = ''; errorStatus.value = 0; loading.value = true;
  try { const result = await flightApi.verifications(id); if (current === token) data.value = result; }
  catch (reason) { if (current === token) { error.value = reason.message || '核实记录读取失败'; errorStatus.value = reason.status || 0; } }
  finally { if (current === token) loading.value = false; }
}
function notificationMessage(result) {
  if (result?.delivery_status === 'DELIVERED') return '检查结果已保存，通知已送达。';
  if (result?.blocked_reason || result?.delivery_status === 'FAILED') return '检查结果已保存，通知尚未发出，请查看记录中的原因。';
  return '检查结果已保存，通知已提交，可在记录中查看发送进度。';
}
async function verify() {
  if (!needsVerification.value || !data.value?.can_verify || !canNotify.value || !deviceCheck.value || busy.value) return;
  const id = props.plan.plan_id, revision = data.value.revision, receiver = data.value.recipient_id;
  const isCurrent = () => !disposed && props.plan.plan_id === id;
  busy.value = true;
  actionNotice.value = '';
  let saved = false;
  try {
    const verification = await flightApi.automaticCheck(id, { expected_revision: revision }, crypto.randomUUID());
    saved = true;
    if (!isCurrent()) return;
    if (!verification?.verification_id) throw new Error('未收到检查记录编号，请刷新核对。');
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
    <p class="workflow-note">检查设备当前是否正常；起飞前请结合风险记录确认现场情况。</p>
  </section>
  <div v-if="error" class="warnbox">核实与通知记录暂时无法读取：{{ error }} <button v-if="![401,403].includes(errorStatus)" class="btn" type="button" @click="reload">重试</button></div>
  <section v-else-if="showPanel" class="sect plan-verification">
    <h4>{{ needsVerification ? '自动检查与通知' : '历史检查与通知' }}</h4>
    <template v-if="data">
      <p v-if="actionNotice" class="workflow-note" role="status">{{ actionNotice }}</p>
      <PlanDeviceCheck v-if="needsVerification" :key="plan.plan_id" :plan="plan" @checked="deviceCheck = $event" @map-devices="emit('map-devices', { planId: plan.plan_id, check: $event })" />
      <p v-if="needsVerification && !latest && blockerText" class="workflow-note">{{ blockerText }}</p>
      <div class="workflow-actions"><button v-if="needsVerification && !latest" class="btn pri" type="button" :disabled="!data.can_verify || !canNotify || !deviceCheck || busy" :title="blockerText" @click="verify">{{ busy ? '正在检查并通知…' : '通知报送单位确认' }}</button><button v-else-if="latest && !feedbackExists" class="btn pri" type="button" :disabled="!canFeedback || busy" @click="feedback">{{ busy ? '正在提交…' : '继续通知报送单位' }}</button><button v-if="hasHistory" class="btn ghost" type="button" :disabled="busy" @click="reload">刷新记录</button></div>
      <template v-if="!feedbackExists && (latest || needsVerification)">
        <p v-if="!data.recipient_id || !data.recipient_name" class="workflow-note">尚未设置接收单位，请联系管理员设置后再通知。</p>
        <p v-else class="workflow-note">接收单位：{{ data.recipient_name }}<template v-if="!data.can_feedback"> · 你没有发送通知的权限</template><template v-else-if="!latest"> · 自动附上设备检查结果，请对方确认是否起飞</template></p>
      </template>
      <article v-for="group in recordGroups" :key="group.key" class="verification-record">
        <b>{{ group.verification ? (conclusions[group.verification.conclusion] || '未知结论') : '核实内容暂不可用' }}</b>
        <dl class="kv">
          <template v-if="group.verification">
            <dt>依据</dt><dd>{{ group.verification.evidence }}</dd>
            <template v-if="!isAutomatic(group.verification)"><dt>说明</dt><dd>{{ group.verification.note }}</dd></template>
            <dt>{{ isAutomatic(group.verification) ? '提交人 / 时间' : '核实人 / 时间' }}</dt><dd>{{ group.verification.handled_by_name }} / {{ date(group.verification.handled_at) }}</dd>
          </template>
          <template v-for="item in group.notifications" :key="item.feedback_id">
            <dt class="notification-start">接收单位</dt><dd class="notification-start">{{ item.recipient_name }}</dd>
            <dt>通知提交时间</dt><dd>{{ date(item.created_at) }}</dd>
            <dt>发送情况</dt><dd>{{ delivery[item.delivery_status] || '暂不清楚' }}</dd>
            <dt>对方是否收到</dt><dd>{{ receipt[item.receipt_status] || '暂不清楚' }}<template v-if="item.acknowledged_at"> · {{ date(item.acknowledged_at) }}</template></dd>
            <dt>处理结果</dt><dd>{{ item.processing_result || '对方还没有回复处理结果' }}</dd>
            <template v-if="item.blocked_reason"><dt>未完成原因</dt><dd>{{ item.blocked_reason === 'CHANNEL_NOT_CONNECTED' ? '通知功能尚未接通，记录已保存但还未发出。' : item.blocked_reason }}</dd></template>
          </template>
        </dl>
        <details v-if="group.verification && group.verification.verification_id === latest?.verification_id && needsVerification && data.can_verify" class="record-more"><summary>更多操作</summary><button class="btn ghost" type="button" :disabled="busy || !canNotify || !deviceCheck" @click="verify">重新检查并通知</button></details>
      </article>
    </template>
  </section>
</template>
<style scoped>
.workflow-note { color: var(--txt-3); font-size: 12px; line-height: 1.6; margin: 8px 0; }
.record-more { margin-top: 8px; font-size: 12px; color: var(--txt-3); }
.record-more summary { cursor: pointer; }
.workflow-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.verification-record { margin-top: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 6px; }
.verification-record .kv { margin-top: 8px; }
.verification-record .notification-start { padding-top: 10px; }
.verification-record dd { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
