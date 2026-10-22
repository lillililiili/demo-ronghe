<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import RectangleSelection from '@/components/video/RectangleSelection.vue';
import { pointsWithin } from './eoSelection.js';
const props = defineProps({ getMap: Function, candidates: Array, selected: Array, mode: String });
const emit=defineEmits(['select']);
const points=ref([]);
let frame, last=0;
function update(now) {
  if (now-last>100) { last=now; const map=props.getMap?.(); points.value=(props.candidates||[]).flatMap(row=>{
    if (!map || !Number.isFinite(row.lon)||!Number.isFinite(row.lat)) return [];
    const p=map.getHitPoint('target',row.mapId)||map.px(row.lon,row.lat);
    return p ? [{...row,x:p[0],y:p[1]}] : [];
  }); }
  frame=requestAnimationFrame(update);
}
const rings=computed(()=>points.value.filter(p=>props.selected?.some(s=>s.eventId===p.eventId)));
function select(rect) {
  const found=rect.point ? points.value.filter(p=>Math.hypot(p.x-rect.x,p.y-rect.y)<25).slice(0,1) : pointsWithin(points.value,rect);
  emit('select',found);
}
onMounted(()=>{frame=requestAnimationFrame(update);});
onUnmounted(()=>cancelAnimationFrame(frame));
</script>
<template>
  <div class="eo-map-selection">
    <span v-for="p in rings" :key="p.eventId" class="eo-map-ring" :style="{left:`${p.x}px`,top:`${p.y}px`}" />
    <RectangleSelection :active="mode === 'box'" @select="select" />
  </div>
</template>
<style scoped>
.eo-map-selection{position:absolute;inset:0;z-index:5;pointer-events:none;overflow:hidden}.eo-map-ring{position:absolute;width:34px;height:34px;transform:translate(-50%,-50%);border:2px solid #54bcff;box-shadow:0 0 0 3px rgba(6,13,32,.7);border-radius:6px;background:rgba(22,143,255,.12)}
</style>
