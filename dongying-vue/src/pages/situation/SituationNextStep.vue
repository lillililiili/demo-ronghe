<script setup>
import { computed } from 'vue';
import { predictionVerificationState } from '@/services/predictionView.js';
import { serverNow } from '@/services/serverClock.js';
import { displayBusinessNo } from '@/ui/deviceNumber.js';
import CounterLaunch from '@/pages/alarms/CounterLaunch.vue';
import { counterHiddenReason } from '@/components/disposal/counterNextStep.js';
import { uavProcessActions, uavProcessStatus } from './situationFlow.js';

/* 卡片「下一步」：紧挨「无人机现在」。能反制时放反制按钮；不能时按钮变灰并写原因（页面设计第 2 条）。 */
const props = defineProps({ alarm: { type: Object, required: true }, summary: Object, nowStatus: Object, now: Number });
const emit = defineEmits(['records', 'verify', 'updated', 'unavailable', 'open']);
const prediction = computed(() => predictionVerificationState(null, props.alarm, props.now || serverNow()));
const actions = computed(() => uavProcessActions(props.alarm));
const summary = computed(() => props.summary?.event_id && props.summary.event_id === props.alarm.eventId ? props.summary : null);
const reason = computed(() => prediction.value?.blocked ? prediction.value.message
  : prediction.value && props.alarm.eventState === 'PENDING_VERIFICATION' ? '本次核实预测入区风险，通知和反制以当前依据与授权校验为准。'
    : counterHiddenReason({
  alarm: props.alarm, actions: actions.value, processStatus: uavProcessStatus(props.alarm), summary: summary.value, nowStatus: props.nowStatus
}));
</script>

<template>
  <section class="sit-next-step" aria-label="下一步">
    <span class="sit-next-step-label">下一步</span>
    <div v-if="prediction?.terminal || (prediction?.blocked && alarm.eventState !== 'PENDING_VERIFICATION')" class="sit-next-step-row">
      <p>{{ prediction.message }}</p><button class="btn" type="button" @click="emit('open')">查看预测预警与办理进度</button>
    </div>
    <div v-else-if="actions.includes('verify')" class="sit-next-step-row">
      <button class="btn pri" type="button" @click="emit('verify')">{{ prediction ? prediction.blocked ? '核实为误报' : '核实预测风险' : '核实' }}</button>
      <p>{{ reason }}</p>
    </div>
    <CounterLaunch v-else-if="!reason && alarm.eventId" :key="alarm.eventId" :event-id="alarm.eventId" :event-label="displayBusinessNo(alarm.id)"
      :summary="summary" active show-launch :show-records="false" @records="emit('records', $event)"
      @updated="emit('updated', $event)" @unavailable="(id, startedAt) => emit('unavailable', id, startedAt)" />
    <div v-else class="sit-next-step-row">
      <button class="btn pri" type="button" disabled :aria-describedby="`sit-next-${alarm.alarmId}`">发起反制</button>
      <p :id="`sit-next-${alarm.alarmId}`">暂不能反制：{{ reason }}</p>
    </div>
  </section>
</template>

<style scoped>
.sit-next-step{display:flex;flex-direction:column;gap:6px;margin:0 12px;padding:8px 9px;border:1px solid var(--line);border-radius:8px;background:var(--surface-1)}
.sit-next-step-label{font-size:10px;letter-spacing:.04em;color:var(--txt-3)}
.sit-next-step-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.sit-next-step-row p{flex:1;min-width:140px;margin:0;font-size:11px;line-height:1.55;color:var(--txt-3);overflow-wrap:anywhere}
.sit-next-step-row .btn{min-height:30px;height:auto;padding:4px 12px;white-space:normal}
.sit-next-step-row .btn:disabled{background:var(--surface-2);border-color:var(--line);color:var(--txt-3);cursor:not-allowed}
.sit-next-step :deep(.counter-launch-actions){justify-content:flex-start}
</style>
