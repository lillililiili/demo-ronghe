<script setup>
import { computed } from 'vue';
import { autoSmsView } from './autoSmsView.js';
import { autoVoiceView } from './autoVoiceView.js';
import { completedHandoffProgress } from './autoHandoffView.js';
const props = defineProps({ summary: Object, counter: Object, compact: Boolean });
const summaryReady = computed(() => !!props.summary && !props.summary._unavailable);
const order = computed(() => summaryReady.value ? props.summary.response_order : null);
// PAUSED 是当前资格暂停，不能由 counter_priority=false 推断后台切回通知优先。
const orderTitle = computed(() => !order.value || order.value.voice_status === 'PAUSED' ? '处置进度'
  : order.value.counter_priority ? '反制优先' : '通知优先');
const orderDescription = computed(() => !order.value ? '正在更新' : order.value.voice_status === 'PAUSED'
  ? '当前条件未满足' : order.value.counter_priority ? '短信与反制并行' : '按后台顺序办理');
const sms = computed(() => autoSmsView(props.summary));
const voice = computed(() => autoVoiceView(props.summary));
const counterText = computed(() => {
  if (!summaryReady.value) return '正在更新当前资格';
  const counter = props.summary?.risk_case?.counter || props.counter;
  const status = counter?.status || props.summary?.counter_status;
  if (status === 'FAILED' && counter?.result_code === 'AUTHORIZATION_STOPPED') return '启动被拦截';
  const handoff = status === 'COMPLETED' ? completedHandoffProgress(props.summary) : '';
  if (handoff) return `已完成 · ${handoff}`;
  return { REQUESTED: '待审批', APPROVED: '已批准，等待启动', EXECUTING: '执行中', COMPLETED: '已完成', STOPPED: '已停止', FAILED: '启动失败', CANCELLED: '已取消', EXPIRED: '授权已失效' }[status]
    || (props.summary?.can_direct_counter === true ? '可直接反制'
      : props.summary?.can_request_counter === true ? '可申请反制（需审批）'
        : props.summary?.counter_block_reason || '等待核实与资格检查');
});
const voiceOrderText = computed(() => {
  // 已拨打的真实结果优先；顺序暂停不能把在途、未知或失败回执改写成未拨打。
  if (['CALLING', 'SIMULATED_PLAYED', 'UNKNOWN', 'FAILED'].includes(props.summary?.auto_voice?.status)) return '';
  if (order.value?.voice_status === 'PAUSED') {
    const risk = props.summary?.risk_case;
    if (risk?.stage === 'UNKNOWN') return '依据不足，电话暂停';
    if (['CLEARED', 'ENDED'].includes(risk?.stage)) return '风险已结束，不再拨打';
    if (['PREDICTED', 'ENTERED', 'OBSERVED'].includes(risk?.stage)
        && ['PENDING_VERIFICATION', 'PENDING'].includes(risk?.verification_status)) return risk.stage === 'PREDICTED' ? '等待人工核实，暂不拨打' : '等待核实，暂不拨打';
    // PAUSED 同时涵盖核实、依据和其他阻断，缺少明确状态时不推断为依据不足。
    return '条件未满足，电话暂停';
  }
  const wait = Number(order.value?.max_wait_seconds);
  const waiting = Number.isInteger(wait) && wait >= 5 && wait <= 300
    ? `电话等待启动确认（最长${wait}秒）` : '电话等待启动确认';
  return { WAITING_START: waiting, WAIT_TIMEOUT: '优先等待已到期，转电话资格判断', START_CONFIRMED: '已收到启动回执，核对电话条件', START_UNAVAILABLE: '无法启动，转电话资格判断', START_FAILED: '启动失败，转电话资格判断' }[order.value?.voice_status] || '';
});
// 通话已受理后的原因只使用本次发送冻结依据，不拿当前规则反推历史。
const voiceTriggerText = computed(() => {
  const basis = props.summary?.auto_voice?.response_order_basis;
  if (!basis || !['CALLING', 'SIMULATED_PLAYED', 'UNKNOWN', 'FAILED'].includes(props.summary?.auto_voice?.status)) return '';
  const wait = Number(basis.max_wait_seconds);
  if (basis.status === 'WAIT_TIMEOUT') return Number.isInteger(wait) && wait >= 5 && wait <= 300
    ? `优先等待已达${wait}秒，转电话通知` : '优先等待到期，转电话通知';
  return { START_CONFIRMED: '设备确认启动后拨打', START_FAILED: '设备启动失败，转电话通知',
    START_UNAVAILABLE: '反制设备不可用，转电话通知' }[basis.status] || '';
});
</script>
<template>
  <section class="risk-disposal-summary" :class="{ compact }" aria-label="风险处置进度">
    <p v-if="!summaryReady" class="risk-order-note" role="status">处置进度更新中，暂不能办理。</p>
    <div class="risk-order"><strong>{{ orderTitle }}</strong><span>{{ orderDescription }}</span></div>
    <dl class="risk-channels" :aria-busy="!summaryReady">
      <div><dt>短信</dt><dd>{{ summaryReady ? sms.title : '正在更新发送结果' }}</dd></div>
      <div><dt>反制</dt><dd>{{ counterText }}</dd></div>
      <div><dt>电话</dt><dd>{{ summaryReady ? voiceOrderText || voice.title : '正在更新通话结果' }}<small v-if="summaryReady && voiceTriggerText" class="voice-trigger">{{ voiceTriggerText }}</small></dd></div>
    </dl>
    <p v-if="!compact && order?.reason" class="risk-order-note">{{ order.reason }}</p>
  </section>
</template>
<style scoped>
.risk-disposal-summary{padding:10px 0;font-size:12px;color:var(--txt-2)}.risk-order{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}.risk-order strong{color:var(--cyan)}.risk-order span,.risk-order-note{color:var(--txt-3);font-size:11px}.risk-channels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}.risk-channels>div{padding:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px}.risk-channels dt{color:var(--txt-3);font-size:11px}.risk-channels dd{margin:4px 0 0;overflow-wrap:anywhere;line-height:1.5}.risk-order-note{margin:8px 0 0}.compact .risk-channels{grid-template-columns:1fr}.compact .risk-channels>div{display:flex;gap:9px;padding:5px 7px}.compact .risk-channels dt{flex:none;width:28px}.compact .risk-channels dd{margin:0;font-size:11px}
.voice-trigger{display:block;margin-top:3px;color:var(--txt-3);font-size:11px;line-height:1.5}
</style>
