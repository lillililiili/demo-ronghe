<script setup>
import { computed } from 'vue';
import { autoSmsView } from './autoSmsView.js';
import { autoVoiceView } from './autoVoiceView.js';
const props = defineProps({ summary: Object, counter: Object, compact: Boolean });
const order = computed(() => props.summary?.response_order);
const sms = computed(() => autoSmsView(props.summary));
const voice = computed(() => autoVoiceView(props.summary));
const counterText = computed(() => {
  const status = props.summary?.risk_case?.counter?.status || props.counter?.status || props.summary?.counter_status;
  // 反制中有航班飞进禁止反制范围、系统自动停止的，写明原因。
  const resultCode = props.summary?.risk_case?.counter?.result_code || props.counter?.result_code;
  if (status === 'STOPPED' && resultCode === 'STOPPED_BY_AIRCRAFT') return '已停止：附近有航班';
  return { REQUESTED: '待审批', APPROVED: '已批准，等待启动', EXECUTING: '执行中', COMPLETED: '已完成', STOPPED: '已停止', FAILED: '启动失败', CANCELLED: '已取消', EXPIRED: '授权已失效' }[status]
    || (props.summary?._unavailable ? '状态暂不可用' : props.summary?.counter_launch_visible ? '可人工发起' : props.summary?.counter_block_reason || '等待核实与资格检查');
});
const voiceOrderText = computed(() => {
  // 已拨打的真实结果优先；顺序暂停不能把在途、未知或失败回执改写成未拨打。
  if (['CALLING', 'SIMULATED_PLAYED', 'UNKNOWN', 'FAILED'].includes(props.summary?.auto_voice?.status)) return '';
  if (order.value?.voice_status === 'PAUSED') {
    const risk = props.summary?.risk_case;
    if (risk?.stage === 'UNKNOWN') return '依据不足，电话暂停';
    if (['CLEARED', 'ENDED'].includes(risk?.stage)) return '风险已结束，不再拨打';
    if (['PREDICTED', 'ENTERED', 'OBSERVED'].includes(risk?.stage)
        && ['PENDING_VERIFICATION', 'PENDING'].includes(risk?.verification_status)) return '等待人工核实，暂不拨打';
    // PAUSED 同时涵盖核实、依据和其他阻断，缺少明确状态时不推断为依据不足。
    return '条件未满足，电话暂停';
  }
  return { WAITING_START: '电话等待启动确认', WAIT_TIMEOUT: '优先等待已到期，转电话资格判断', START_CONFIRMED: '已收到启动回执，核对电话条件', START_UNAVAILABLE: '无法启动，转电话资格判断', START_FAILED: '启动失败，转电话资格判断' }[order.value?.voice_status] || '';
});
</script>
<template>
  <section v-if="summary" class="risk-disposal-summary" :class="{ compact }" aria-label="风险处置进度">
    <div v-if="order" class="risk-order"><strong>{{ order.counter_priority ? '反制优先' : '通知优先' }}</strong><span>{{ order.counter_priority ? '短信与反制并行' : '按后台顺序办理' }}</span></div>
    <dl class="risk-channels">
      <div><dt>短信</dt><dd>{{ sms.title }}</dd></div>
      <div><dt>反制</dt><dd :class="{ 'is-aircraft-stop': counterText === '已停止：附近有航班' }">{{ counterText }}</dd></div>
      <div><dt>电话</dt><dd>{{ voiceOrderText || voice.title }}</dd></div>
    </dl>
    <p v-if="!compact && order?.reason" class="risk-order-note">{{ order.reason }}</p>
  </section>
</template>
<style scoped>
.risk-disposal-summary{padding:10px 0;font-size:12px;color:var(--txt-2)}.risk-order{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}.risk-order strong{color:var(--cyan)}.risk-order span,.risk-order-note{color:var(--txt-3);font-size:11px}.risk-channels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0}.risk-channels>div{padding:8px;background:var(--surface-2);border:1px solid var(--line);border-radius:6px}.risk-channels dt{color:var(--txt-3);font-size:11px}.risk-channels dd{margin:4px 0 0;overflow-wrap:anywhere;line-height:1.5}.risk-order-note{margin:8px 0 0}.compact .risk-channels{grid-template-columns:1fr}.compact .risk-channels>div{display:flex;gap:9px;padding:5px 7px}.compact .risk-channels dt{flex:none;width:28px}.compact .risk-channels dd{margin:0;font-size:11px}.risk-channels dd.is-aircraft-stop{color:var(--red)}
</style>
