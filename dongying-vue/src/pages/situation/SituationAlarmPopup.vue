<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { selectionLayout } from './selectionLayout.js';

const props = defineProps({ getAnchor: { type: Function, required: true }, label: { type: String, default: '无人机告警详情' } });
const popup = ref(null);
let frame;

// 详情与地图聚焦共用布局；内容增长时局部滚动，不盖住选中图标。
function positionPopup() {
  const element = popup.value;
  const stage = element?.parentElement;
  if (stage && !document.hidden) {
    const layout = selectionLayout(stage);
    const point = props.getAnchor();
    element.style.width = `${layout.width}px`;
    element.style.maxHeight = `${layout.maxHeight}px`;
    element.style.left = `${layout.left}px`;
    element.style.top = `${layout.top}px`;
    element.dataset.positioned = point ? 'target' : 'unavailable';
  }
  frame = requestAnimationFrame(positionPopup);
}

onMounted(positionPopup);
onUnmounted(() => cancelAnimationFrame(frame));
</script>

<template>
  <section ref="popup" class="sit-alarm-popup sit-glass" role="region" :aria-label="label">
    <slot />
  </section>
</template>

<style scoped>
.sit-alarm-popup{position:absolute;z-index:13;width:340px;max-width:calc(100% - 16px);max-height:calc(100% - 122px);overflow:auto;overscroll-behavior:contain;background:rgba(5,24,43,.97);border:1px solid var(--cyan);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.4);overflow-wrap:anywhere}
</style>
