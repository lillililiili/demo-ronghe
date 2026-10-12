<script setup>
import { ref } from 'vue';
import { riskSnapshotTime } from './riskSnapshotMarkers.js';

const props = defineProps({ rows: { type: Array, default: () => [] }, selectedId: String,
  visible: { type: Boolean, default: true } });
defineEmits(['select']);
const markers = ref([]);
const U = window.UI;
const WIDTH = 112, HEIGHT = 58;
const atDiscoveryPosition = row => ['BALLOON', '气球'].includes(row.subtypeCode);
const modeText = row => row.simulated ? '模拟 · ' : ({ mock: '模拟 · ', replay: '回放 · ' })[row.sourceMode] || '';
const description = row => `${row.title} · ${modeText(row)}发现时位置（非实时） · ${riskSnapshotTime(row.occurredAt)}（北京时间）`;
function getMarkers(map) {
  if (!props.visible || !map?.w) return [];
  return props.rows.filter(row => !atDiscoveryPosition(row)).map(row => ({ kind: 'risk-snapshot', data: { id: row.id, historical: true },
    point: map.px(...row.anchor), width: WIDTH, height: HEIGHT, abnormal: false }));
}
// 气球固定在发现坐标，不参与向外避让；其余标记沿用共用布局。
function draw(map) {
  const next = props.visible && map?.w ? props.rows.flatMap(row => {
    const anchored = atDiscoveryPosition(row);
    const point = anchored ? map.px(...row.anchor) : null;
    const layout = anchored ? { point, anchor: point, visible: point?.every(Number.isFinite)
      && point[0] >= 0 && point[0] <= map.w && point[1] >= 0 && point[1] <= map.h }
      : map._markerLayout?.points.get(`risk-snapshot:${row.id}`);
    if (!layout?.visible) return [];
    return [{ id: row.id, anchored, x: layout.point[0], y: layout.point[1],
      anchorX: layout.anchor[0], anchorY: layout.anchor[1],
      icon: U.targetIcon({ subtypeCode: row.subtypeCode }), title: row.title,
      mode: modeText(row), description: description(row) }];
  }) : [];
  if (JSON.stringify(next) !== JSON.stringify(markers.value)) markers.value = next;
}
const groupFor = id => props.rows.find(row => row.id === id)?.group;
defineExpose({ getMarkers, draw });
</script>

<template>
  <div v-if="visible" class="sit-risk-snapshots" role="group" aria-label="航线风险发现时位置">
    <svg v-if="markers.some(marker => !marker.anchored)" class="snapshot-leaders" aria-hidden="true">
      <g v-for="marker in markers.filter(marker => !marker.anchored)" :key="marker.id">
        <line :x1="marker.anchorX" :y1="marker.anchorY" :x2="marker.x" :y2="marker.y" />
        <circle :cx="marker.anchorX" :cy="marker.anchorY" r="2.5" />
      </g>
    </svg>
    <button v-for="marker in markers" :key="marker.id" type="button" class="snapshot-marker"
      :class="{ selected: selectedId === marker.id, anchored: marker.anchored }" :style="{ left: `${marker.x}px`, top: `${marker.y}px` }"
      :aria-pressed="selectedId === marker.id" :aria-label="marker.description" :title="marker.description"
      @click.stop="$emit('select', groupFor(marker.id))">
      <span class="snapshot-icon" aria-hidden="true" v-html="marker.icon"></span>
      <span class="snapshot-label">{{ marker.title }} · 发现时位置</span>
      <small v-if="marker.mode">{{ marker.mode.replace(' · ', '') }}</small>
    </button>
  </div>
</template>

<style scoped>
.sit-risk-snapshots{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden}
.snapshot-leaders{position:absolute;width:100%;height:100%;overflow:visible}
.snapshot-leaders line{stroke:var(--txt-2);stroke-width:1;stroke-dasharray:3 3}
.snapshot-leaders circle{fill:var(--txt-2)}
.snapshot-marker{position:absolute;transform:translate(-50%,-50%);width:112px;height:58px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:0;border:0;background:transparent;color:var(--txt);font:inherit;cursor:pointer;pointer-events:auto}
.snapshot-icon{display:flex;width:24px;height:24px}
.snapshot-marker.anchored{transform:translate(-50%,-12px);justify-content:flex-start;width:24px;height:24px;overflow:visible}
.snapshot-marker.anchored .snapshot-icon{flex-shrink:0}
.snapshot-marker.anchored .snapshot-label,.snapshot-marker.anchored small{display:none}
.snapshot-marker.anchored:hover .snapshot-label,.snapshot-marker.anchored:hover small,
.snapshot-marker.anchored:focus-visible .snapshot-label,.snapshot-marker.anchored:focus-visible small,
.snapshot-marker.anchored.selected .snapshot-label,.snapshot-marker.anchored.selected small{display:block;flex-shrink:0}
.snapshot-marker.selected,.snapshot-marker:focus-visible,.snapshot-marker:hover{z-index:1}
.snapshot-icon :deep(img),.snapshot-icon :deep(svg){width:24px;height:24px}
.snapshot-label{font-size:10px;line-height:15px;white-space:nowrap;background:var(--surface-1);border-bottom:1px dashed var(--txt-2);padding:0 3px;border-radius:2px}
.snapshot-marker small{font-size:9px;line-height:11px;color:var(--txt-2);background:var(--surface-1);padding:0 3px}
.snapshot-marker.selected .snapshot-label{border-bottom:2px solid var(--cyan);color:var(--cyan)}
.snapshot-marker:focus-visible{outline:2px solid var(--cyan);outline-offset:2px;border-radius:4px}
</style>
