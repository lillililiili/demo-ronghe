<script setup>
import { computed } from 'vue';
import TargetTrackingPanel from '@/components/video/TargetTrackingPanel.vue';

const props = defineProps({
  risk: { type: Object, default: null },
  target: { type: Object, default: null }
});
const targetId = computed(() => props.target?.target_id || props.risk?.target_id || '');
// 气象风险没有可引导的光电目标；异物风险在目标缺失时仍说明阻断原因。
const visible = computed(() => props.risk?.risk_type !== 'WEATHER'
  && (!!props.target || ['SPACE_OBJECT', 'FOREIGN_OBJECT'].includes(props.risk?.risk_type) || !!targetId.value));
const unavailableReason = computed(() => !targetId.value ? '监测目标尚未就绪，请刷新记录后重试。' : '');
</script>

<template>
  <section v-if="visible" class="sect optical-panel">
    <TargetTrackingPanel :target-id="targetId" :unavailable-reason="unavailableReason"
      :begin-reason="risk ? '风险详情人工发起光电追踪' : '监测目标详情人工发起光电追踪'" compact />
  </section>
</template>

<style scoped>
.optical-panel :deep(.target-tracking-panel) { margin:0; }
</style>
