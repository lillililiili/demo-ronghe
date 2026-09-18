<script setup>
import { computed, onUnmounted } from 'vue';
import AutoSmsNotice from './AutoSmsNotice.vue';
import AutoVoiceNotice from './AutoVoiceNotice.vue';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';
import { ADVISORY_KIND, isAdvisoryContact, lastObservation, orderedRecords, OBSERVATION_DANGER, OBSERVATION_OUTCOME } from './advisoryView.js';
import { openCounterBasis } from './counterBasisModal.js';

const props = defineProps({
  eventId: { type: String, required: true }, eventLabel: String, confirmed: Boolean,
  counterBlock: { type: String, default: '' }, counterStatus: { type: String, default: '' },
  authorizationId: { type: String, default: '' }, counterActive: Boolean,
  handoffId: { type: String, default: '' }, refreshAuthorization: Function
});
const emit = defineEmits(['updated', 'authorization']);
const { data, loading, error, load } = useUavAdvisory(() => props.eventId, result => emit('updated', result));
let alive = true;
onUnmounted(() => { alive = false; });
const observation = computed(() => lastObservation(data.value?.records));
const contact = computed(() => orderedRecords(data.value?.records).filter(isAdvisoryContact).at(-1));
const observationPredatesContact = computed(() => {
  const latest = orderedRecords(data.value?.records).filter(record => record.kind === 'OBSERVATION' || isAdvisoryContact(record)).at(-1);
  return !!observation.value && !!latest && latest.kind !== 'OBSERVATION';
});
const current = computed(() => data.value?.event_id === props.eventId && !loading.value && !error.value);
const transferredId = computed(() => data.value?.auto_handoff?.handoff_id || props.handoffId);
const canPrepareCounter = computed(() => current.value && props.confirmed && !props.counterActive && !props.counterBlock && data.value?.can_write === true);
const handoffTitle = computed(() => {
  if (transferredId.value) return ['MANUAL_CONFIRMATION', 'RULE_ILLEGAL'].includes(data.value?.auto_handoff?.trigger_source) ? '已自动移送到处罚' : '已移送到处罚';
  return ({ WAITING: '等待自动移送到处罚', BLOCKED: '自动移送暂不可办理',
    DISABLED: '自动移送尚未启用', FAILED: '自动移送失败' })[data.value?.auto_handoff?.status] || '自动移送状态暂不可用';
});
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';
function openHandoff() {
  if (transferredId.value) window.location.hash = `/punish?handoff=${encodeURIComponent(transferredId.value)}`;
}
function recordSituation() {
  if (!canPrepareCounter.value) return;
  const eventId = props.eventId;
  return openCounterBasis({ data: data.value, reload: load,
    isCurrent: () => alive && props.eventId === eventId && canPrepareCounter.value });
}
</script>

<template>
  <section v-if="confirmed || loading || error || data || handoffId" class="uav-advisory" aria-label="飞手通知与处置进度">
    <header class="ua-head"><h3>处置进度</h3><button type="button" class="ua-link" :disabled="loading" @click="load()">{{ loading ? '正在读取' : error ? '重试' : '更新记录' }}</button></header>
    <p v-if="error" class="ua-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !data" class="ua-note">正在读取联系与观察记录</p>
    <template v-if="data">
      <AutoSmsNotice compact :data="data" :disabled="!current" @changed="load()" />
      <AutoVoiceNotice compact :data="data" :disabled="!current" @changed="load()" />
      <div class="ua-parallel-status" aria-label="现场情况与人工补充">
        <section aria-label="现场情况">
          <h4>现场情况</h4>
          <template v-if="observation">
            <p><b>{{ OBSERVATION_OUTCOME[observation.outcome] || '结果未知' }}</b> · 危险度{{ OBSERVATION_DANGER[observation.danger] || '待核查' }}</p>
            <p class="ua-note">记录时间：{{ time(observation.created_at) }}</p>
            <p v-if="observationPredatesContact" class="ua-note">此记录早于最近一次联系，不代表当前现场结论。</p>
          </template>
          <p v-else class="ua-note"><template v-if="contact">已保存{{ ADVISORY_KIND[contact.kind] || '联系记录' }}；</template>尚无现场观察记录，无法确认是否飞离。</p>
          <div class="ua-actions">
            <button type="button" class="btn" :disabled="!canPrepareCounter" @click="recordSituation">人工补充现场情况</button>
          </div>
        </section>
      </div>
      <div v-if="confirmed || data.auto_handoff || transferredId" class="ua-handoff" aria-label="处罚移送进度">
        <p>{{ handoffTitle }}<button v-if="transferredId" type="button" class="ua-link" @click="openHandoff">查看处罚交接</button></p>
        <p v-if="!transferredId && data.auto_handoff?.reason" class="ua-note">{{ data.auto_handoff.reason }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ua-parallel-status{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,210px),1fr));gap:12px;margin-top:14px}.ua-parallel-status section{min-width:0;border-top:1px solid var(--line);padding-top:12px}.uav-advisory h4{font-size:13px;margin:0 0 8px}.ua-parallel-status p{font-size:13px;line-height:1.65;margin:7px 0;overflow-wrap:anywhere}
.uav-advisory{margin:12px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);min-width:0}
.ua-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ua-head h3{font-size:16px;margin:0}
.ua-note{color:var(--muted);font-size:12px!important;line-height:1.6}.ua-error{font-size:13px;color:var(--red);line-height:1.6}
.ua-link{padding:0;border:0;background:none;color:var(--muted);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;white-space:normal}
.ua-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.ua-actions .btn{white-space:normal}
.ua-handoff{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.ua-handoff p{display:flex;flex-wrap:wrap;gap:8px 12px;font-size:13px;line-height:1.65;margin:0;overflow-wrap:anywhere}.ua-handoff .ua-note{margin-top:6px}
.uav-advisory button:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.uav-advisory button:disabled{opacity:.5;cursor:not-allowed}
</style>
