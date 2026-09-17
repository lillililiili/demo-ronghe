<script setup>
import AutoSmsNotice from '@/components/disposal/AutoSmsNotice.vue';
import AutoVoiceNotice from '@/components/disposal/AutoVoiceNotice.vue';
import AdvisoryRecords from '@/components/disposal/AdvisoryRecords.vue';
import { useUavAdvisory } from '@/hooks/useUavAdvisory.js';
const props = defineProps({ eventId: { type: String, required: true }, alarmLabel: String, targetLabel: String });
const emit = defineEmits(['updated', 'open']);
const { data, loading, error, load } = useUavAdvisory(() => props.eventId, value => emit('updated', value));
</script>

<template>
  <section class="sit-advisory-card" aria-label="当前目标通知">
    <header><div><b>{{ targetLabel || '通知记录' }}</b><small>{{ alarmLabel }}</small></div><button class="btn sm" type="button" :disabled="loading" @click="load()">{{ error ? '重试' : '刷新' }}</button></header>
    <p v-if="error" role="alert">{{ error }} 当前发送结果未确认。</p>
    <p v-else-if="loading && !data">正在读取通知状态</p>
    <AutoSmsNotice v-if="data" :data="data" :disabled="!!error || loading" @changed="load()" />
    <AutoVoiceNotice v-if="data" :data="data" :disabled="!!error || loading" @changed="load()" />
    <details v-if="data?.records?.length"><summary>联系与观察记录（{{ data.records.length }}）</summary><AdvisoryRecords :records="data.records" /></details>
    <button class="sit-advisory-open" type="button" @click="emit('open')">查看此事件的处置详情</button>
  </section>
</template>

<style scoped>
.sit-advisory-card{padding:10px;border-top:1px solid var(--line);flex:0 1 auto;min-height:0;overflow:visible}.sit-advisory-card>header{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px}.sit-advisory-card header div{display:flex;flex-direction:column;min-width:0;gap:4px}.sit-advisory-card header b{font-size:12px;overflow-wrap:anywhere}.sit-advisory-card small,.sit-advisory-card>p{font-size:11px;line-height:1.5;color:var(--muted)}.sit-advisory-card details{margin-top:10px}.sit-advisory-card summary{font-size:12px;cursor:pointer}.sit-advisory-open{border:0;background:none;color:var(--cyan);padding:10px 0 0;text-align:left;font:inherit;font-size:12px;cursor:pointer}.sit-advisory-card button:focus-visible,.sit-advisory-card summary:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
</style>
