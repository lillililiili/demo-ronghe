<script setup>
import { userFacingMessage } from '@/ui/labels.js';
import { computed } from 'vue';
import AutoSmsNotice from './AutoSmsNotice.vue';
import AutoVoiceNotice from './AutoVoiceNotice.vue';
import AdvisoryRecords from './AdvisoryRecords.vue';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';
import { autoHandoffView } from './autoHandoffView.js';

const props = defineProps({
  eventId: { type: String, required: true }, confirmed: Boolean,
  handoffId: { type: String, default: '' },
  interval: { type: Number, default: 5000 }
});
const emit = defineEmits(['updated', 'unavailable']);
const { data, loading, error, load } = useUavAdvisory(() => props.eventId, result => emit('updated', result), props.interval,
  (id, startedAt) => emit('unavailable', id, startedAt));
const current = computed(() => data.value?.event_id === props.eventId && !loading.value && !error.value);
const historicalObservations = computed(() => data.value?.event_id === props.eventId
  ? (data.value.records || []).filter(row => row.kind === 'OBSERVATION') : []);
const handoff = computed(() => autoHandoffView(data.value, props.handoffId));
const observation = computed(() => data.value?.departure_observation);
const observationTime = value => value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false });
function openHandoff() {
  if (handoff.value.handoffId) window.location.hash = `/punish?handoff=${encodeURIComponent(handoff.value.handoffId)}`;
}
</script>

<template>
  <section v-if="confirmed || loading || error || data || handoffId" class="uav-advisory" aria-label="飞手通知与处置进度">
    <header class="ua-head"><h3>处置进度</h3><button type="button" class="ua-link" :disabled="loading" @click="load()">{{ loading ? '正在读取' : error ? '重试' : '更新记录' }}</button></header>
    <p v-if="error" class="ua-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !data" class="ua-note">正在读取通知与处置进度</p>
    <template v-if="data">
      <AutoSmsNotice compact :data="data" :disabled="!current" @changed="load()" />
      <AutoVoiceNotice compact :data="data" :disabled="!current" @changed="load()" />
      <div v-if="observation?.started_at" class="ua-handoff" aria-label="通知后的位置核对依据">
        <p v-if="observation.status === 'RECORDED'" class="ua-note">已留存的通知终止依据；当前观测时效以告警信息为准。</p>
        <p>通知后位置判断：{{ ({ LEFT:'有效位置已确认离开', STILL_PRESENT:'仍在告警区域或仍有违规', UNKNOWN:'无法确认是否离开' })[observation.presence] }}</p>
        <p v-if="observation.status === 'RECORDED'" class="ua-note">历史观察开始 {{ observationTime(observation.started_at) }}；判断起点 {{ observationTime(observation.deadline_at) }}（北京时间）</p>
        <p v-else class="ua-note">{{ observation.channel === 'VOICE' ? '电话播放完成' : '短信送达' }} {{ observationTime(observation.started_at) }}（北京时间）</p>
        <p v-if="observation.position" class="ua-note">采用观测 {{ observationTime(observation.position.observed_at) }} · WGS84 {{ observation.position.longitude }}, {{ observation.position.latitude }}</p>
        <p v-else class="ua-note">没有当前可用或可见的位置依据，不能把停报当成飞离。</p>
        <p class="ua-note">依据：{{ ({SMS_AIRSPACE:'通知送达时所处空域与后续实测位置',LATEST_LEGALITY:'通知后的实测位置及最新合法性研判',AIRSPACE_BOUNDARY:'位置压在空域边界，无法确认',NO_CURRENT_POSITION:'没有时效内的新实测位置'})[observation.basis] || '尚未形成判断' }}；本次核对 {{ observationTime(observation.evaluated_at) }}。</p>
      </div>
      <details v-if="historicalObservations.length" class="ua-history">
        <summary>历史现场观察记录（{{ historicalObservations.length }}）</summary>
        <AdvisoryRecords :records="historicalObservations" />
      </details>
      <div v-if="confirmed || data.auto_handoff || handoff.handoffId" class="ua-handoff" aria-label="上级通知进度" :data-state="data.auto_handoff?.status">
        <p><span :class="`ua-${handoff.tone}`">{{ handoff.title }}</span><button v-if="handoff.handoffId" type="button" class="ua-link" @click="openHandoff">查看通知事项</button></p>
        <p v-if="handoff.reason" class="ua-note">{{ userFacingMessage(handoff.reason) }}</p>
        <p v-if="handoff.partyUnidentified" class="ua-note">当事人不明：{{ handoff.partyReasons.join('；') || '没有可用的当事人信息' }}。移送时会写明按待补线索移送。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.uav-advisory{margin:12px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);min-width:0}
.ua-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ua-head h3{font-size:16px;margin:0}
.ua-note{color:var(--muted);font-size:12px!important;line-height:1.6}.ua-error{font-size:13px;color:var(--red);line-height:1.6}
.ua-link{padding:0;border:0;background:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;white-space:normal}
.ua-handoff{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.ua-handoff p{display:flex;flex-wrap:wrap;gap:8px 12px;font-size:13px;line-height:1.65;margin:0;overflow-wrap:anywhere}.ua-handoff .ua-note{margin-top:6px}
.ua-success{color:var(--green,#52d6a5)}.ua-warning{color:var(--amber,#ffc160)}.ua-muted{color:var(--txt)}
.ua-submit{margin-top:8px;white-space:normal;height:auto;min-height:30px}
.ua-history{margin-top:12px}.ua-history summary{cursor:pointer;font-size:13px;line-height:1.6}.ua-history summary:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}
.uav-advisory button:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.uav-advisory button:disabled{opacity:.5;cursor:not-allowed}
</style>
