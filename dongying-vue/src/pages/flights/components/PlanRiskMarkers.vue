<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { weatherRiskIcon } from '@/ui/weatherRiskIcon.js';

const props = defineProps({ markers: { type: Array, default: () => [] }, selectedId: String,
  obstacles: { type: Array, default: () => [] } });
const emit = defineEmits(['select']);
const layer = ref(null), size = ref({ width: 0, height: 0 }), legendBox = ref(null);
let observer;
onMounted(() => {
  const legend = layer.value.parentElement.querySelector('.plan-map-legend');
  observer = new ResizeObserver(() => {
    const bounds = layer.value.getBoundingClientRect();
    size.value = { width: bounds.width, height: bounds.height };
    const rect = legend?.getBoundingClientRect();
    legendBox.value = rect ? { left: rect.left - bounds.left, top: rect.top - bounds.top,
      right: rect.right - bounds.left, bottom: rect.bottom - bounds.top } : null;
  });
  observer.observe(layer.value);
  if (legend) observer.observe(legend);
});
onUnmounted(() => observer?.disconnect());
// 重叠事件仅错开图标，连线指向真实投影位置；风险身份始终使用 risk_id。
const placedMarkers = computed(() => {
  const placed = [];
  for (const marker of props.markers) {
    const clampX = x => Math.max(24, Math.min(size.value.width - 24, x));
    const clampY = y => Math.max(24, Math.min(size.value.height - 24, y));
    let point = { x: clampX(marker.x), y: clampY(marker.y) };
    search: for (let ring = 0; ring <= Math.max(4, props.markers.length); ring++) {
      const offsets = ring ? [[ring * 46, 0], [-ring * 46, 0], [0, ring * 46], [0, -ring * 46]] : [[0, 0]];
      for (const [dx, dy] of offsets) {
        const candidate = { x: clampX(marker.x + dx), y: clampY(marker.y + dy) };
        const box = legendBox.value;
        if (box && candidate.x + 23 > box.left && candidate.x - 23 < box.right
          && candidate.y + 23 > box.top && candidate.y - 23 < box.bottom) continue;
        if (candidate.x < 48 && candidate.y < 118) continue;
        if (candidate.x > size.value.width - 110 && candidate.y < 48) continue;
        if ([...placed.map(item => ({ x: item.displayX, y: item.displayY })), ...props.obstacles]
          .every(other => Math.abs(candidate.x - other.x) >= 44 || Math.abs(candidate.y - other.y) >= 44)) {
          point = candidate; break search;
        }
      }
    }
    placed.push({ ...marker, displayX: point.x, displayY: point.y,
      displaced: point.x !== marker.x || point.y !== marker.y,
      leftward: point.x > size.value.width / 2, downward: point.y < size.value.height / 2 });
  }
  return placed;
});
const icon = risk => risk.risk_type === 'WEATHER' ? weatherRiskIcon(risk) : window.UI.targetIcon(risk);
</script>

<template>
  <div ref="layer" class="plan-risk-map-layer" aria-label="本任务风险位置">
    <svg class="risk-leaders" aria-hidden="true">
      <g v-for="marker in placedMarkers.filter(item => item.displaced)" :key="marker.id" :class="marker.severityClass">
        <line :x1="marker.x" :y1="marker.y" :x2="marker.displayX" :y2="marker.displayY" />
        <circle :cx="marker.x" :cy="marker.y" r="3" />
      </g>
    </svg>
    <div v-for="marker in placedMarkers" :key="marker.id" class="plan-risk-marker" :data-risk-id="marker.id"
      :class="[marker.severityClass, { selected: marker.id === selectedId, uncertain: marker.currentStatus !== 'CURRENT', leftward: marker.leftward, downward: marker.downward }]"
      :style="{ left: `${marker.displayX}px`, top: `${marker.displayY}px`,
        '--risk-card-width': `${Math.max(0, (marker.leftward ? marker.displayX : size.width - marker.displayX) - 24)}px`,
        '--risk-card-height': `${Math.max(0, (marker.downward ? size.height - marker.displayY : marker.displayY) - 32)}px` }">
      <button class="plan-risk-point" type="button" :aria-pressed="marker.id === selectedId"
        :aria-label="`风险${marker.number}，${marker.title}，${marker.currentStatus === 'CURRENT' ? '当前仍存在' : '状态待确认'}，${marker.sourceLabel}，定位风险记录`"
        @click.stop="emit('select', marker.id)">
        <span aria-hidden="true" v-html="icon(marker.risk)"></span><b>{{ marker.number }}</b>
      </button>
      <div class="plan-risk-card">
        <strong>{{ marker.title }} · {{ marker.severityLabel }}</strong>
        <span>{{ marker.currentStatus === 'CURRENT' ? '当前仍存在' : '状态待确认' }} · {{ marker.sourceLabel }}</span>
        <span>{{ marker.locationNote }}</span>
        <span>发生时间：{{ marker.occurredAt }}</span>
        <span v-if="marker.currentStatus !== 'CURRENT'">{{ marker.currentReason || '缺少当前风险依据' }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-risk-map-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 5; }
.risk-leaders { position: absolute; inset: 0; width: 100%; height: 100%; }
.risk-leaders g { color: var(--tag-c, var(--gray)); }
.risk-leaders line { stroke: currentColor; stroke-width: 1.5; }
.risk-leaders circle { fill: currentColor; stroke: var(--surface-1); stroke-width: 1; }
.plan-risk-marker { position: absolute; width: 36px; height: 36px; transform: translate(-50%, -50%); color: var(--tag-c, var(--gray)); pointer-events: auto; }
.plan-risk-point { position: relative; display: grid; place-items: center; width: 36px; height: 36px; padding: 4px; color: inherit; background: var(--surface-1); border: 2px solid currentColor; border-radius: 8px; cursor: pointer; }
.uncertain .plan-risk-point { border-style: dashed; }
.plan-risk-point span { display: flex; }
.plan-risk-point :deep(svg) { width: 23px; height: 23px; }
.plan-risk-point b { position: absolute; right: -9px; top: -9px; min-width: 19px; padding: 0 3px; border-radius: 4px; background: var(--surface-1); color: inherit; font-size: 12px; line-height: 19px; font-variant-numeric: tabular-nums; }
.selected .plan-risk-point { outline: 2px solid var(--cyan); outline-offset: 3px; }
.plan-risk-point:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
.plan-risk-marker:hover, .plan-risk-marker:focus-within { z-index: 2; }
.plan-risk-marker.selected { z-index: 1; }
.plan-risk-card { position: absolute; left: calc(100% + 7px); bottom: calc(100% + 10px); width: min(260px, var(--risk-card-width)); max-height: var(--risk-card-height); overflow-y: auto; overscroll-behavior: contain; display: grid; gap: 5px; padding: 8px 10px; border: 1px solid currentColor; border-radius: 6px; background: var(--surface-gradient); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; visibility: hidden; pointer-events: none; }
.plan-risk-card strong { color: var(--txt); }
.plan-risk-card span { color: var(--txt-2); }
.plan-risk-marker:hover .plan-risk-card, .plan-risk-marker:focus-within .plan-risk-card, .selected .plan-risk-card { visibility: visible; pointer-events: auto; }
.leftward .plan-risk-card { left: auto; right: calc(100% + 7px); }
.downward .plan-risk-card { bottom: auto; top: calc(100% + 10px); }
</style>
