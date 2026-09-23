<script setup>
import { computed } from 'vue';
import AutoSmsNotice from './AutoSmsNotice.vue';
import AutoVoiceNotice from './AutoVoiceNotice.vue';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';

const props = defineProps({
  eventId: { type: String, required: true }, confirmed: Boolean,
  handoffId: { type: String, default: '' },
  interval: { type: Number, default: 5000 }
});
const emit = defineEmits(['updated']);
const { data, loading, error, load } = useUavAdvisory(() => props.eventId, result => emit('updated', result), props.interval);
const current = computed(() => data.value?.event_id === props.eventId && !loading.value && !error.value);
const autoHandoff = computed(() => data.value?.auto_handoff);
const autoTransferred = computed(() => !!autoHandoff.value?.handoff_id
  && !['FAILED', 'DISABLED', 'BLOCKED', 'WAITING'].includes(autoHandoff.value.status));
const transferredId = computed(() => autoTransferred.value ? autoHandoff.value.handoff_id : (props.handoffId || ''));
const handoffTitle = computed(() => {
  if (autoTransferred.value) {
    return ['MANUAL_CONFIRMATION', 'RULE_ILLEGAL', 'JAMMING_COMPLETED'].includes(autoHandoff.value?.trigger_source) ? '已自动移送到处罚' : '已移送到处罚';
  }
  if (autoHandoff.value?.status) {
    return ({ WAITING: '等待自动移送到处罚', BLOCKED: '自动移送暂不可办理',
      DISABLED: '自动移送尚未启用', FAILED: '自动移送失败' })[autoHandoff.value.status] || '自动移送状态暂不可用';
  }
  return props.handoffId ? '已移送到处罚' : '自动移送尚未启用';
});
function openHandoff() {
  if (transferredId.value) window.location.hash = `/punish?handoff=${encodeURIComponent(transferredId.value)}`;
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
      <div v-if="confirmed || data.auto_handoff || transferredId" class="ua-handoff" aria-label="处罚移送进度">
        <p>{{ handoffTitle }}<button v-if="transferredId" type="button" class="ua-link" @click="openHandoff">查看处罚交接</button></p>
        <p v-if="!transferredId && data.auto_handoff?.reason" class="ua-note">{{ data.auto_handoff.reason }}</p>
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
.uav-advisory button:focus-visible{outline:2px solid var(--cyan);outline-offset:3px}.uav-advisory button:disabled{opacity:.5;cursor:not-allowed}
</style>
