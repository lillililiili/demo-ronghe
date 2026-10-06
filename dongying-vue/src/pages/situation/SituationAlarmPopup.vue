<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { selectionLayout, selectionPopupPosition } from './selectionLayout.js';

const props = defineProps({
  getAnchor: { type: Function, required: true },
  getAvoidRect: { type: Function, default: null },
  label: { type: String, default: '无人机告警详情' },
  videoOpen: { type: Boolean, default: false }
});
const popup = ref(null);
const videoExpanded = ref(false);
let frame;
watch(() => props.videoOpen, () => { videoExpanded.value = false; });

// 详情与地图聚焦共用布局；内容增长时局部滚动，不盖住选中图标。
function positionPopup() {
  const element = popup.value;
  const stage = element?.parentElement;
  if (stage && !document.hidden) {
    const layout = selectionLayout(stage, { videoOpen: props.videoOpen, videoExpanded: videoExpanded.value });
    const point = props.getAnchor();
    const avoidRect = typeof props.getAvoidRect === 'function' ? props.getAvoidRect() : null;
    element.style.width = `${layout.width}px`;
    element.style.maxHeight = `${layout.maxHeight}px`;
    element.style.setProperty('--selection-height', `${layout.maxHeight}px`);
    element.classList.toggle('is-stacked', layout.stacked);
    const position = selectionPopupPosition(layout, point, element.offsetHeight, avoidRect);
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
    element.dataset.positioned = point ? 'target' : 'unavailable';
  }
  frame = requestAnimationFrame(positionPopup);
}

onMounted(positionPopup);
onUnmounted(() => cancelAnimationFrame(frame));
</script>

<template>
  <div ref="popup" class="sit-selection-group" :class="{ 'has-video': videoOpen, 'video-expanded': videoExpanded }"
    :data-video-open="videoOpen" :data-video-expanded="videoExpanded">
    <section v-show="!videoExpanded" class="sit-alarm-popup sit-glass" role="region" :aria-label="label"><slot /></section>
    <aside v-if="videoOpen" id="situation-video-window" class="sit-companion-pane sit-glass" aria-label="当前关联目标视频">
      <slot name="video" :expanded="videoExpanded" :toggle-expanded="() => videoExpanded = !videoExpanded" />
    </aside>
  </div>
</template>

<style scoped>
.sit-selection-group{position:absolute;z-index:13;width:360px;max-width:calc(100% - 16px);display:grid;gap:12px;pointer-events:none;align-items:start}
.sit-selection-group.has-video:not(.is-stacked):not(.video-expanded){grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.sit-selection-group.is-stacked:not(.video-expanded){height:var(--selection-height);grid-template-rows:minmax(0,1fr) auto}
.sit-alarm-popup,.sit-companion-pane{min-height:0;min-width:0;max-height:var(--selection-height);overflow:auto;overscroll-behavior:contain;pointer-events:auto;background:rgba(5,24,43,.97);border:1px solid var(--cyan);border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.4);overflow-wrap:anywhere}
.sit-selection-group.is-stacked:not(.video-expanded)>*{max-height:100%;width:100%}
.sit-selection-group.is-stacked:not(.video-expanded)>.sit-companion-pane{max-height:calc(var(--selection-height)*.5)}
.sit-companion-pane{border-color:var(--sit-line)}
</style>
