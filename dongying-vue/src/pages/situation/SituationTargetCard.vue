<script setup>
import { computed } from 'vue';
import { displayTargetNo } from '@/ui/deviceNumber.js';
import { isPredictionAlarm, alarmPredictionState, PREDICTION_STATES } from '@/services/predictionView.js';
import { pilotLocationText } from '@/services/pilotLocation.js';
import { pilotDistanceNote } from '@/ui/pilotDistanceNote.js';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';
import { riskCaseOf, riskStageLabel, riskCaseVerificationLabel, riskSummaryMatches } from '@/services/riskCaseView.js';
import RiskDisposalSummary from '@/components/disposal/RiskDisposalSummary.vue';
import SituationNextStep from './SituationNextStep.vue';

const props = defineProps({ target: { type: Object, required: true }, alarm: Object, nowStatus: Object,
  summary: Object, sourceNames: String, now: Number, videoOpen: Boolean });
const emit = defineEmits(['close', 'video', 'verify', 'records', 'open', 'updated', 'unavailable']);
const currentSummary = computed(() => {
  const risk = riskCaseOf(props.alarm);
  return !props.alarm?._riskUnavailable && riskSummaryMatches(props.summary, props.alarm?.eventId, risk?.risk_case_id, risk) ? props.summary : null;
});
const icon = computed(() => window.UI.targetIcon(props.target));
// Keep qualification updates independent of the collapsed information. Moving
// observations patch text nodes; they never replace the card or its controls.
const { error } = useUavAdvisory(() => props.alarm?.eventId || '', value => emit('updated', value), 1000,
  (id, at, caseId) => emit('unavailable', id, at, caseId), () => riskCaseOf(props.alarm)?.risk_case_id || '', () => riskCaseOf(props.alarm));
const predicted = computed(() => isPredictionAlarm(props.alarm));
const predictionState = computed(() => predicted.value ? alarmPredictionState(props.alarm, props.now) : null);
const terminal = computed(() => riskCaseOf(props.alarm) ? ['CLEARED', 'ENDED'].includes(riskCaseOf(props.alarm).stage) : ['WITHDRAWN', 'ENTERED'].includes(predictionState.value));
const state = computed(() => {
  const risk = riskCaseOf(props.alarm);
  if (props.alarm?._riskUnavailable) return { title: risk ? riskStageLabel(props.alarm) : '风险状态更新中', tone: 'grey' };
  if (risk) return { title: riskStageLabel(props.alarm), tone: risk.stage === 'ENTERED' ? 'red' : risk.stage === 'PREDICTED' ? 'amber' : risk.stage === 'CLEARED' ? 'green' : 'grey' };
  if (predicted.value) return { title: PREDICTION_STATES[predictionState.value] || '预测暂不可判断',
    tone: predictionState.value === 'ACTIVE' ? 'amber' : predictionState.value === 'ENTERED' ? 'red' : 'grey' };
  if (props.nowStatus) return props.nowStatus;
  return { title: props.target.timeUntrusted ? '数据过期 · 设备时间不准'
    : props.target.stale || props.target.freshness === 'STALE' ? '数据已过期'
      : props.target.activeRisk ? '风险持续' : '已观测', tone: props.target.activeRisk ? 'amber' : 'grey' };
});
const warning = computed(() => {
  const eventId = props.alarm?.eventId;
  const frozen = props.alarm?.prediction_snapshot;
  const latest = props.alarm?.prediction;
  const find = prediction => prediction?.warnings?.find(row => row.event_id === eventId)
    || (prediction?.warning?.event_id === eventId ? prediction.warning : null);
  return find(frozen) || find(latest);
});
const verification = computed(() => riskCaseOf(props.alarm) ? riskCaseVerificationLabel(props.alarm) : !predicted.value || terminal.value ? ''
  : props.alarm?.eventState === 'CONFIRMED' ? '已核实'
    : props.alarm?.eventState === 'FALSE_POSITIVE' ? '已核实为误报' : '待人工核实');
const sourceLabel = computed(() => props.target.simulated || ['replay', 'mock'].includes(props.target.sourceMode) ? '模拟／回放' : '');
const clock = value => Number.isFinite(Number(value)) && Number(value) > 0
  ? new Date(Number(value)).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '未提供';
const metric = (value, unit) => value !== null && value !== undefined && String(value).trim() && Number.isFinite(Number(value))
  ? `${Number(Number(value).toFixed(1))} ${unit}` : '未提供';
</script>

<template>
  <section class="sit-target-card" aria-label="目标概况">
    <header>
      <span class="sit-target-card-icon" aria-hidden="true" v-html="icon"></span>
      <div><b>{{ displayTargetNo(target.id) }}</b><small>{{ target.typeLabel }}<template v-if="sourceLabel"> · {{ sourceLabel }}</template></small></div>
      <button class="sit-target-close" type="button" aria-label="关闭目标详情" @click="emit('close')">×</button>
    </header>
    <div class="sit-target-current" :class="`is-${state.tone}`" role="status" aria-atomic="true">
      <strong>{{ state.title }}</strong><span v-if="verification">{{ verification }}</span>
    </div>
    <p v-if="riskCaseOf(alarm)" class="sit-target-context"><span>风险区域</span>{{ riskCaseOf(alarm).airspace_name || '区域名称未提供' }}</p>
    <p v-else-if="predicted" class="sit-target-context"><span>{{ terminal ? '原预警区域' : '预警区域' }}</span>{{ warning?.airspace_name || '禁飞区（名称未提供）' }}</p>
    <p v-else-if="!alarm && target.activeRisk" class="sit-target-context">{{ target.relatedRisks?.find(row => row.active)?.reasonText || '查看关联风险详情' }}</p>
    <dl class="sit-target-card-metrics">
      <div><dt>高度</dt><dd>{{ metric(target.alt, 'm') }}</dd></div>
      <div><dt>速度</dt><dd>{{ metric(target.speed, 'm/s') }}</dd></div>
      <div><dt>{{ target._lastObservationOnly ? '最后观测' : '最新上报' }}</dt><dd>{{ clock(target.lastSeenAt) }}</dd></div>
    </dl>
    <p v-if="alarm?._riskUnavailable" class="sit-target-read-error" role="status">{{ alarm._riskReadReason || '正在重新读取本次风险，暂停新操作。' }}</p>
    <p v-if="error" class="sit-target-read-error" role="alert">处置状态读取失败，请在详情中重试。</p>
    <RiskDisposalSummary v-if="alarm" :summary="currentSummary" compact />
    <SituationNextStep v-if="alarm" compact :alarm="alarm" :summary="currentSummary" :now-status="nowStatus" :now="now"
      @verify="emit('verify', $event)" @records="emit('records', $event)"
      @updated="emit('updated', $event)" @unavailable="(id, at, caseId) => emit('unavailable', id, at, caseId)" />
    <div class="sit-target-card-links">
      <button v-if="alarm && !terminal" type="button" @click="emit('open')">查看告警与处置</button>
      <button type="button" :aria-expanded="videoOpen" aria-controls="situation-video-window" @click="emit('video')">{{ videoOpen ? '收起视频' : '实时视频' }}</button>
    </div>
    <details class="sit-target-more">
      <summary>更多目标信息</summary>
      <dl><dt>感知来源</dt><dd>{{ sourceNames || '未提供' }}</dd>
        <template v-if="target.objectTypeCode === 'UAV'"><dt>遥控器位置</dt><dd>{{ pilotLocationText(target.pilotLocation) }}</dd></template>
      </dl>
      <p v-if="target.timeUntrusted">上报时间不可信，当前位置请核实。平台收到：{{ clock(target.receivedAt) }}</p>
      <p v-if="target.objectTypeCode === 'UAV' && pilotDistanceNote(target.legalitySummary)">{{ pilotDistanceNote(target.legalitySummary) }}</p>
      <p v-if="nowStatus?.detail">{{ nowStatus.detail }}</p>
      <p v-if="alarm">通知记录及办理历史见告警详情。</p>
    </details>
  </section>
</template>

<style scoped>
.sit-target-card{padding:12px;color:var(--txt-2);font-size:12px;line-height:1.5}
.sit-target-card header{display:flex;gap:9px;align-items:center;margin-bottom:12px}.sit-target-card header>div{min-width:0;flex:1}.sit-target-card header b{display:block;color:var(--txt);overflow-wrap:anywhere}.sit-target-card header small{display:block;color:var(--txt-3);font-size:11px}.sit-target-card-icon{display:flex;width:28px;height:28px;flex-shrink:0}.sit-target-card-icon :deep(svg),.sit-target-card-icon :deep(img){width:100%;height:100%}
.sit-target-card button{font:inherit;cursor:pointer}.sit-target-close{border:0;background:transparent;color:var(--txt-3);width:30px;height:30px;font-size:20px!important}
.sit-target-current{display:flex;align-items:baseline;justify-content:space-between;gap:8px;min-height:25px;color:var(--txt-2)}.sit-target-current strong{font-size:14px;overflow-wrap:anywhere}.sit-target-current span{flex-shrink:0;color:var(--txt-3);font-size:11px}.sit-target-current.is-amber strong{color:var(--tag-amber-text)}.sit-target-current.is-red strong{color:var(--red)}.sit-target-current.is-green strong{color:var(--green)}
.sit-target-context{margin:4px 0 10px;overflow-wrap:anywhere}.sit-target-context>span{color:var(--txt-3);margin-right:8px}
.sit-target-card-metrics{display:grid;grid-template-columns:1fr 1fr 1.25fr;margin:10px 0;gap:8px;padding:9px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.sit-target-card-metrics dt{font-size:11px;color:var(--txt-3)}.sit-target-card-metrics dd{margin:3px 0 0;color:var(--txt);font-variant-numeric:tabular-nums;white-space:nowrap}
.sit-target-card-links{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0 2px}.sit-target-card-links button{border:0;background:transparent;padding:3px 0;color:var(--cyan)}
.sit-target-more{margin-top:8px;border-top:1px solid var(--line);padding-top:8px}.sit-target-more summary{cursor:pointer;color:var(--txt-3)}.sit-target-more dl{display:grid;grid-template-columns:72px minmax(0,1fr);gap:6px;margin:10px 0}.sit-target-more dd{margin:0;overflow-wrap:anywhere}.sit-target-more dt,.sit-target-more p{color:var(--txt-3)}.sit-target-read-error{color:var(--tag-amber-text)}
.sit-target-card button:focus-visible,.sit-target-more summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
</style>
