<script setup>
import { computed, ref } from 'vue';
import { rectangle } from '@/pages/situation/eoSelection.js';
const props = defineProps({ active: Boolean });
const emit = defineEmits(['select']);
const surface = ref(null), start = ref(null), end = ref(null);
const box = computed(() => start.value && end.value ? rectangle(start.value, end.value) : null);
const boxStyle = computed(() => box.value ? { left: `${box.value.x}px`, top: `${box.value.y}px`, width: `${box.value.width}px`, height: `${box.value.height}px` } : {});
function point(event) { const rect = surface.value.getBoundingClientRect(); return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) }; }
function down(event) {
  if (!props.active || event.button !== 0) return;
  start.value = end.value = point(event); surface.value.setPointerCapture(event.pointerId);
}
function move(event) { if (start.value) end.value = point(event); }
function cancel() { start.value = end.value = null; }
function up(event) {
  if (!start.value) return;
  end.value = point(event);
  if (box.value.width > 3 && box.value.height > 3) emit('select', box.value);
  else emit('select', { ...box.value, point: true });
  cancel();
}
</script>
<template>
  <div ref="surface" class="eo-rectangle-surface" :class="{ active }" @pointerdown.stop.prevent="down" @pointermove.stop="move"
    @pointerup.stop="up" @pointercancel="cancel" @lostpointercapture="cancel" @click.stop @keydown.esc="cancel">
    <div v-if="box" class="eo-drag-rectangle" :style="boxStyle" />
    <slot />
  </div>
</template>
<style scoped>
.eo-rectangle-surface{position:absolute;inset:0;pointer-events:none;overflow:hidden}.eo-rectangle-surface.active{pointer-events:auto;cursor:crosshair;touch-action:none}.eo-drag-rectangle{position:absolute;border:1px dashed var(--cyan);background:rgba(22,143,255,.14);pointer-events:none;z-index:3}
</style>
