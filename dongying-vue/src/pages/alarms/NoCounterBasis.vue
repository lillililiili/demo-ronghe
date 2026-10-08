<script setup>
import { computed } from 'vue';
import { LEGALITY_LABEL, VIOLATION_CODE_LABEL, REASON_CODE_LABEL, labelOf } from '@/ui/labels.js';
import { ruleReasonText } from '@/ui/legalityReviewModal.js';

const props = defineProps({ basis: Object });
const time = value => value == null ? '未提供' : new Date(value).toLocaleString('zh-CN', { hour12: false });
const reasons = computed(() => (props.basis?.violation_reasons || []).map(reason => {
  const code = typeof reason === 'string' ? reason : reason?.code;
  const currentReason = ruleReasonText(code);
  if (currentReason && currentReason !== code) return currentReason;
  return VIOLATION_CODE_LABEL[code] || REASON_CODE_LABEL[code] || reason?.message || code || '未提供具体原因';
}));
</script>

<template>
  <dl class="no-counter-basis">
    <dt>观测时间</dt><dd>{{ time(basis?.observed_at) }}</dd>
    <dt>研判时间</dt><dd>{{ time(basis?.evaluated_at) }}</dd>
    <dt>系统研判</dt><dd>{{ labelOf(LEGALITY_LABEL, basis?.legal_status, '未提供') }}</dd>
    <template v-if="reasons.length"><dt>研判原因</dt><dd><ul><li v-for="(reason, index) in reasons" :key="index">{{ reason }}</li></ul></dd></template>
  </dl>
</template>

<style scoped>
.no-counter-basis{display:grid;grid-template-columns:70px minmax(0,1fr);gap:9px 14px;font-size:12px;line-height:1.7;margin:12px 0}.no-counter-basis dt{color:var(--txt-3)}.no-counter-basis dd{margin:0;color:var(--txt-2);overflow-wrap:anywhere}.no-counter-basis ul{margin:0;padding-left:16px}
</style>
