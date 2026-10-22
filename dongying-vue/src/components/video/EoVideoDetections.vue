<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import RectangleSelection from './RectangleSelection.vue';
import { containedVideoRect, selectableDetection, validDetectionBox } from './deviceVideoState.js';
import { pointsWithin } from '@/pages/situation/eoSelection.js';
const props = defineProps({ frame: Object, playback: Object, mode: String, candidates: Array, selected: Array });
const emit = defineEmits(['select']);
const host = ref(null), size = ref({ width: 0, height: 0 });
let observer;
onMounted(() => { observer = new ResizeObserver(entries => { const r = entries[0].contentRect; size.value = {width:r.width,height:r.height}; }); observer.observe(host.value); });
onUnmounted(() => observer?.disconnect());
const content = computed(() => containedVideoRect(size.value.width, size.value.height, props.playback?.width, props.playback?.height));
const boxes = computed(() => {
  const r = content.value;
  if (!r || !props.playback?.playing) return [];
  return (props.frame?.detections || []).filter(d => validDetectionBox(d.bbox)).map(d => {
    const candidate = selectableDetection(d) && props.candidates?.find(row => row.targetId === d.target_id);
    const b = d.bbox;
    return { ...d, candidate, selected: props.selected?.some(row => row.eventId === candidate?.eventId),
      x:r.x+(b.x+b.width/2)*r.width,y:r.y+(b.y+b.height/2)*r.height,
      style:{left:`${r.x+b.x*r.width}px`,top:`${r.y+b.y*r.height}px`,width:`${b.width*r.width}px`,height:`${b.height*r.height}px`} };
  });
});
function select(rect) {
  const usable=boxes.value.filter(b=>b.candidate);
  const found=rect.point ? usable.filter(b=>Math.abs(b.x-rect.x)<20 && Math.abs(b.y-rect.y)<20).slice(0,1) : pointsWithin(usable,rect);
  emit('select',found.map(b=>b.candidate));
}
</script>
<template>
  <div ref="host" class="eo-detections">
    <button v-for="box in boxes" :key="box.detection_id" type="button" class="eo-detection" :class="{selected:box.selected,unlinked:!box.candidate}"
      :style="box.style" :disabled="!box.candidate || mode === 'box'" :aria-pressed="box.selected" :aria-label="box.candidate ? `选择${box.candidate.label}` : '识别目标未关联可操作告警'"
      @click.stop="emit('select',[box.candidate])"><span>{{ box.candidate?.label || '未关联告警' }}</span></button>
    <RectangleSelection :active="mode === 'box'" @select="select" />
    <span v-if="!frame || !playback?.playing" class="eo-no-detections">{{ playback?.playing ? '当前播放帧没有可用识别框，可在地图选目标' : '画面未播放，识别框已暂停' }}</span>
  </div>
</template>
<style scoped>
.eo-detections{position:absolute;inset:0;pointer-events:none}.eo-detection{position:absolute;pointer-events:auto;border:1px solid var(--cyan);border-radius:0;background:transparent;cursor:pointer;color:#fff;padding:0}.eo-detection span{position:absolute;left:-1px;bottom:100%;background:var(--surface-2);padding:3px 6px;font-size:12px;white-space:nowrap}.eo-detection.selected{border:2px solid #168fff;background:rgba(22,143,255,.12)}.eo-detection.selected span{background:#1266b9}.eo-detection.unlinked{border-color:var(--amber);pointer-events:none}.eo-detection:focus-visible{outline:3px solid #fff;outline-offset:3px}.eo-no-detections{position:absolute;left:12px;bottom:12px;padding:5px 8px;background:rgba(6,13,32,.8);font-size:12px;color:#dbe9fb}
</style>
