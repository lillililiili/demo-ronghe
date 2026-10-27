<script setup>
import { computed } from 'vue';
import { riskCaseOf, riskSummaryMatches, riskCaseVerificationHint } from '@/services/riskCaseView.js';
import { predictionVerificationState } from '@/services/predictionView.js';
import { serverNow } from '@/services/serverClock.js';
import { displayBusinessNo } from '@/ui/deviceNumber.js';
import CounterLaunch from '@/pages/alarms/CounterLaunch.vue';
import { counterHiddenReason } from '@/components/disposal/counterNextStep.js';
import { uavProcessActions, uavProcessStatus } from './situationFlow.js';

/* 卡片「下一步」：紧挨「无人机现在」。能反制时放反制按钮；不能时按钮变灰并写原因（页面设计第 2 条）。 */
const props = defineProps({ alarm: { type: Object, required: true }, summary: Object, nowStatus: Object, now: Number, compact: Boolean });
const emit = defineEmits(['records', 'verify', 'updated', 'unavailable']);
const prediction = computed(() => predictionVerificationState(null, props.alarm, props.now || serverNow()));
const actions = computed(() => uavProcessActions(props.alarm));
const summary = computed(() => riskSummaryMatches(props.summary, props.alarm.eventId, riskCaseOf(props.alarm)?.risk_case_id, riskCaseOf(props.alarm)) ? props.summary : null);
const reason = computed(() => props.alarm._riskUnavailable ? '风险状态更新中，暂不能办理。' : prediction.value?.blocked ? prediction.value.message
  : riskCaseVerificationHint(props.alarm) || (prediction.value && props.alarm.eventState === 'PENDING_VERIFICATION' ? '本次核实预测入区风险，通知和反制以当前依据与授权校验为准。'
    : counterHiddenReason({
  alarm: props.alarm, actions: actions.value, processStatus: uavProcessStatus(props.alarm), summary: summary.value, nowStatus: props.nowStatus
})));
</script>

<template>
  <section v-if="!compact || !prediction?.terminal" class="sit-next-step" :class="{ 'is-compact': compact }" aria-label="下一步">
    <span v-if="!compact" class="sit-next-step-label">下一步</span>
    <div v-if="alarm._riskUnavailable || prediction?.terminal || (prediction?.blocked && alarm.eventState !== 'PENDING_VERIFICATION')" class="sit-next-step-row">
      <p>{{ alarm._riskUnavailable ? reason : compact ? '预测依据不足，暂不能办理。' : prediction.message }}</p>
    </div>
    <div v-else-if="actions.includes('verify')" class="sit-next-step-row">
      <button class="btn pri" type="button" @click="emit('verify', alarm)">核实</button>
      <p>{{ compact && prediction ? prediction.blocked ? '预测依据不足，暂不能确认风险属实。' : '请人工核实本次预测风险。' : reason }}</p>
    </div>
    <div v-else-if="reason" class="sit-next-step-row">
      <button class="btn pri" type="button" disabled :aria-describedby="`sit-next-${alarm.alarmId}`">发起反制</button>
      <p :id="`sit-next-${alarm.alarmId}`">暂不能反制：{{ reason }}</p>
    </div>
    <CounterLaunch v-if="alarm.eventId" :key="riskCaseOf(alarm)?.risk_case_id || alarm.eventId" :risk-case="riskCaseOf(alarm)" :event-id="alarm.eventId" :target-id="alarm.targetInternalId" :event-label="displayBusinessNo(alarm.id)"
      :summary="summary" active :show-launch="!reason && actions.includes('counter') && !alarm._riskUnavailable" :show-records="false" @records="emit('records', $event)"
      @updated="emit('updated', $event)" @unavailable="(id, startedAt, caseId) => emit('unavailable', id, startedAt, caseId)" />
  </section>
</template>

<style scoped>
.sit-next-step{display:flex;flex-direction:column;gap:6px;margin:0 12px;padding:8px 9px;border:1px solid var(--line);border-radius:8px;background:var(--surface-1)}
.sit-next-step.is-compact{margin:0;padding:0;border:0;background:transparent}
.sit-next-step-label{font-size:10px;letter-spacing:.04em;color:var(--txt-3)}
.sit-next-step-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.sit-next-step-row p{flex:1;min-width:140px;margin:0;font-size:11px;line-height:1.55;color:var(--txt-3);overflow-wrap:anywhere}
.sit-next-step-row .btn{min-height:30px;height:auto;padding:4px 12px;white-space:normal}
.sit-next-step-row .btn:disabled{background:var(--surface-2);border-color:var(--line);color:var(--txt-3);cursor:not-allowed}
.sit-next-step :deep(.counter-launch-actions){justify-content:flex-start}
</style>
