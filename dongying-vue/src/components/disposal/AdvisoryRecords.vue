<script setup>
import { computed } from 'vue';
import { ADVISORY_KIND, OBSERVATION_OUTCOME, OBSERVATION_DANGER, orderedRecords } from './advisoryView.js';
import { AUTO_VOICE_STATUS } from './autoVoiceView.js';
const props = defineProps({ records: { type: Array, default: () => [] } });
const rows = computed(() => orderedRecords(props.records).reverse());
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未提供';
</script>

<template>
  <ol class="advisory-records">
    <li v-for="row in rows" :key="row.record_id">
      <div class="ar-heading"><b>{{ ADVISORY_KIND[row.kind] || '处置记录' }}</b><span v-if="row.trigger_mode === 'AUTO'" class="tag t-cyan">系统自动</span><span v-if="row.simulated" class="tag t-amber">模拟</span></div>
      <p v-if="row.kind === 'OBSERVATION'">{{ OBSERVATION_OUTCOME[row.outcome] || '结果未知' }} · 危险度{{ OBSERVATION_DANGER[row.danger] || '待核查' }}<span v-if="row.urgent"> · 紧急处置申请依据</span></p>
      <p v-else>{{ row.recipient_name || '接收主体未提供' }}<span v-if="row.kind === 'SMS_SIMULATED'"> · {{ row.delivery_status === 'SIMULATED_DELIVERED' ? '模拟送达' : '模拟发送记录' }}，未发送真实短信</span><span v-else-if="row.kind === 'VOICE_SIMULATED'"> · {{ AUTO_VOICE_STATUS[row.delivery_status] || '通话结果未确认' }}，未拨打真实电话</span></p>
      <p v-if="row.contact_basis" class="ar-muted">联系依据：{{ row.contact_basis }}</p>
      <p v-if="row.content">{{ row.content }}</p>
      <p v-if="row.note">{{ row.note }}</p>
      <small>{{ time(row.created_at) }} · {{ row.actor_name || '办理人未提供' }}</small>
    </li>
  </ol>
</template>

<style scoped>
.advisory-records{list-style:none;margin:0;padding:0}.advisory-records li{padding:12px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.ar-heading{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.advisory-records p{margin:6px 0;line-height:1.6;font-size:13px}.advisory-records small,.ar-muted{color:var(--muted);font-size:12px}.ar-heading b{font-size:13px}
</style>
