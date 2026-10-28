<script setup>
import { computed } from 'vue';
import { predictionEntrySeconds, predictionWarnings } from '@/services/predictionView.js';
const props = defineProps({ prediction: Object, now: Number, unavailable: Boolean });
// 只说一句：多久后进哪个区；没有入区预计就说没有。完整预测依据不在这里展示。
const text = computed(() => {
  const seconds = predictionEntrySeconds(props.prediction, props.now ?? Date.now(), props.unavailable);
  if (seconds == null) return '暂无入区预计';
  const warning = predictionWarnings(props.prediction).find(row => row.state === 'ACTIVE');
  return `预计约 ${seconds} 秒后进入${warning?.airspace_name ? ` ${warning.airspace_name}` : ''}`;
});
</script>
<template><section class="prediction-panel" aria-label="未来位置预测" role="status">{{ text }}</section></template>
<style scoped>
.prediction-panel{padding:10px 12px;border-top:1px solid var(--line-2);font-size:13px;line-height:1.5;color:var(--tag-amber-text)}
</style>
