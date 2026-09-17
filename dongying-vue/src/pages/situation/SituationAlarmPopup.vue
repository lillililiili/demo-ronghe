<script setup>
import { onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({ getAnchor: { type: Function, required: true } });
const popup = ref(null);
let frame;

// 只跟随地图投影调整浮窗位置；事件读取与业务状态仍由原有组件负责。
function positionPopup() {
  const element = popup.value;
  const stage = element?.parentElement;
  if (stage && !document.hidden) {
    const leftDock = stage.querySelector('.sit-device-dock');
    const rightDock = stage.querySelector('.sit-alert-dock');
    const leftBound = (leftDock ? leftDock.offsetLeft + leftDock.offsetWidth : 0) + 12;
    const rightBound = (rightDock ? rightDock.offsetLeft : stage.clientWidth) - 12;
    element.style.width = `${Math.max(240, Math.min(360, rightBound - leftBound))}px`;
    const width = element.offsetWidth;
    const point = props.getAnchor();
    const [x, y] = point || [(leftBound + rightBound) / 2, stage.clientHeight / 2];
    const preferredLeft = point ? (x + width + 16 < rightBound ? x + 16 : x - width - 16) : x - width / 2;
    const left = Math.max(8, Math.min(Math.max(leftBound, preferredLeft), rightBound - width));
    const availableHeight = Math.max(120, stage.clientHeight - 122);
    const overlapsTarget = point && x >= left - 16 && x <= left + width + 16
      && y >= 58 && y <= stage.clientHeight - 64;
    const above = y - 76, below = stage.clientHeight - y - 82;
    const placeAbove = above >= below;
    // 中间地图较窄时改在目标上方/下方展示，不能把无人机点位盖住。
    element.style.maxHeight = `${overlapsTarget ? Math.min(availableHeight, Math.max(120, above, below)) : availableHeight}px`;
    const height = element.offsetHeight;
    const preferredTop = overlapsTarget ? (placeAbove ? y - height - 18 : y + 18) : y - height / 2;
    const top = Math.max(58, Math.min(preferredTop, stage.clientHeight - height - 64));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.dataset.positioned = point ? 'target' : 'unavailable';
  }
  frame = requestAnimationFrame(positionPopup);
}

onMounted(positionPopup);
onUnmounted(() => cancelAnimationFrame(frame));
</script>

<template>
  <section ref="popup" class="sit-alarm-popup sit-glass" role="region" aria-label="无人机告警详情">
    <slot />
  </section>
</template>

<style scoped>
.sit-alarm-popup{position:absolute;z-index:13;width:340px;max-width:calc(100% - 16px);max-height:calc(100% - 122px);overflow:auto;overscroll-behavior:contain;background:rgba(5,24,43,.97);border:1px solid var(--cyan);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.4);overflow-wrap:anywhere}
</style>
