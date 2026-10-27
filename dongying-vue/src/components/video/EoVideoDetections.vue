<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import RectangleSelection from './RectangleSelection.vue';
import { containedVideoRect, detectionPresentation, selectableDetection, validDetectionBox } from './deviceVideoState.js';
import { pointsWithin } from '@/pages/situation/eoSelection.js';
const props = defineProps({ frame: Object, playback: Object, mode: String, candidates: Array, selected: Array });
const emit = defineEmits(['select']);
const host = ref(null), size = ref({ width: 0, height: 0 }), selectionNotice = ref('');
let selectionSnapshot = null;
let observer;
onMounted(() => { observer = new ResizeObserver(entries => { const r = entries[0].contentRect; size.value = {width:r.width,height:r.height}; }); observer.observe(host.value); });
onUnmounted(() => observer?.disconnect());
const content = computed(() => containedVideoRect(size.value.width, size.value.height, props.playback?.width, props.playback?.height));
const boxes = computed(() => {
  const r = content.value;
  if (!r || !props.playback?.playing) return [];
  return (props.frame?.detections || []).filter(d => validDetectionBox(d.bbox)).map(d => {
    const candidates = selectableDetection(d) ? props.candidates?.filter(row => row.targetId === d.target_id && !row.unavailable) || [] : [];
    const candidate = candidates[0];
    const b = d.bbox;
    return { ...d, candidate, candidates, presentation: detectionPresentation(candidate), selected: props.selected?.some(row => row.targetId === d.target_id),
      x:r.x+(b.x+b.width/2)*r.width,y:r.y+(b.y+b.height/2)*r.height,
      style:{left:`${r.x+b.x*r.width}px`,top:`${r.y+b.y*r.height}px`,width:`${b.width*r.width}px`,height:`${b.height*r.height}px`} };
  });
});
function select(rect) {
  const snapshot=selectionSnapshot;
  selectionSnapshot=null;
  if(snapshot && performance.now()-snapshot.startedAt>2000){selectionNotice.value='视频帧已更新，请重新框选当前识别框';return;}
  const usable=snapshot?.boxes || boxes.value.filter(b=>b.candidate);
  const found=rect.point ? usable.filter(b=>Math.abs(b.x-rect.x)<20 && Math.abs(b.y-rect.y)<20).slice(0,1) : pointsWithin(usable,rect);
  if(!found.length){selectionNotice.value='框选范围没有覆盖当前关联识别框，请重试';return;}
  selectionNotice.value='';
  emit('select',found.flatMap(b=>b.candidates));
}
function beginSelection(){selectionNotice.value='';selectionSnapshot={startedAt:performance.now(),boxes:boxes.value.filter(b=>b.candidate)};}
</script>
<template>
  <div ref="host" class="eo-detections">
    <button v-for="box in boxes" :key="box.detection_id" type="button" class="eo-detection" :class="{selected:box.selected,unlinked:!box.candidate,alert:box.presentation.alert}"
      :style="box.style" :disabled="!box.candidate || mode === 'box'" :aria-pressed="box.selected" :aria-label="box.candidate ? `选择关联告警${box.candidate.label}` : '识别目标未关联可操作告警'"
      @click.stop="emit('select',box.candidates)"><span>{{ box.presentation.label }}{{box.candidates.length>1?` · ${box.candidates.length}项风险`:''}}</span></button>
    <RectangleSelection :active="mode === 'box'" @start="beginSelection" @cancel="selectionSnapshot=null" @select="select" />
    <span v-if="selectionNotice" class="eo-no-detections" role="status">{{ selectionNotice }}</span>
    <span v-if="!frame || !playback?.playing" class="eo-no-detections">{{ playback?.playing ? '当前播放帧没有可用识别框，可在地图选目标' : '画面未播放，识别框已暂停' }}</span>
  </div>
</template>
<style scoped>
.eo-detections{position:absolute;inset:0;pointer-events:none}.eo-detection{position:absolute;pointer-events:auto;border:1px solid var(--cyan);border-radius:0;background:transparent;cursor:pointer;color:#fff;padding:0}.eo-detection span{position:absolute;left:-1px;bottom:100%;background:var(--surface-2);padding:3px 6px;font-size:12px;white-space:nowrap}.eo-detection.alert{border-color:#ff566a;background:rgba(255,86,106,.08)}.eo-detection.alert span{background:#9c2337;color:#fff;font-weight:700}.eo-detection.selected{border:2px solid #168fff;background:rgba(22,143,255,.12)}.eo-detection.selected span{background:#1266b9}.eo-detection.selected.alert span{background:#9c2337}.eo-detection.unlinked{border-color:var(--amber);pointer-events:none}.eo-detection:focus-visible{outline:3px solid #fff;outline-offset:3px}.eo-no-detections{position:absolute;left:12px;bottom:12px;padding:5px 8px;background:rgba(6,13,32,.8);font-size:12px;color:#dbe9fb}
</style>
