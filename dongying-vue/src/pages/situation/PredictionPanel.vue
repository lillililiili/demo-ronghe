<script setup>
import { computed } from 'vue';
import { predictionDetailsHtml } from '@/ui/predictionDetails.js';
const props = defineProps({ prediction: Object, riskCase: Object, now: Number, unavailable: Boolean });
const html = computed(() => predictionDetailsHtml(props.prediction, { now: props.now, unavailable: props.unavailable, showProximity: true, riskCase: props.riskCase }));
</script>
<template><section class="prediction-panel" aria-label="未来位置预测" v-html="html"></section></template>
<style scoped>
.prediction-panel{padding:10px 12px;border-top:1px solid var(--line-2);font-size:12px;line-height:1.5;color:var(--txt-2)}
.prediction-panel :deep(.prediction-title){display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--txt)}
.prediction-panel :deep(.prediction-message){margin:8px 0;color:var(--txt-3)}
.prediction-panel :deep(.kv){display:grid;grid-template-columns:78px 1fr;gap:4px 8px;margin:8px 0}.prediction-panel :deep(dd){margin:0;overflow-wrap:anywhere}
.prediction-panel :deep(summary){cursor:pointer;padding:6px 0;color:var(--txt)}
.prediction-panel :deep(.prediction-table-scroll){overflow:auto}.prediction-panel :deep(table){width:100%;border-collapse:collapse;font-size:11px}.prediction-panel :deep(th),.prediction-panel :deep(td){padding:6px 5px;text-align:left;white-space:nowrap;border-bottom:1px solid var(--line-2)}
.prediction-panel :deep(.prediction-warning){display:flex;flex-direction:column;gap:3px;padding:8px 0;border-top:1px solid var(--line-2)}.prediction-panel :deep(.prediction-warning b){color:var(--tag-amber-text)}.prediction-panel :deep(.prediction-warning small){color:var(--txt-3);overflow-wrap:anywhere}
</style>
