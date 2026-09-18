<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import DeviceAbnormalNoticeButton from './DeviceAbnormalNoticeButton.vue';
import { deviceCheckStatus } from '@/pages/flights/planDeviceCheck.js';
const props = defineProps({ markers: { type: Array, default: () => [] }, planId: { type: String, default: '' } });
// 图标来自系统内置资源，不插入设备接口返回的 HTML。
const { deviceIcon, deviceMeta, icon: windowIcon } = window.UI;
const abnormalActive = window.UI.abnormalActive;
const layer = ref(null), size = ref({ width: 0, height: 0 });
const legendBox = ref(null);
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
// 仅错开屏幕上的图标，连线端点仍保留地图投影坐标，不修改设备经纬度。
const placedMarkers = computed(() => {
  const placed = [];
  for (const marker of props.markers) {
    const clampX = x => Math.max(20, Math.min(size.value.width - 20, x));
    const clampY = y => Math.max(20, Math.min(size.value.height - 20, y));
    let point = { x: clampX(marker.x), y: clampY(marker.y) };
    const direction = marker.leftward ? -1 : 1;
    search: for (let ring = 0; ring <= Math.max(4, props.markers.length); ring++) {
      const offsets = ring === 0 ? [[0, 0]] : [[direction * ring * 44, 0], [0, ring * 44], [0, -ring * 44], [-direction * ring * 44, 0]];
      for (const [dx, dy] of offsets) {
        const candidate = { x: clampX(marker.x + dx), y: clampY(marker.y + dy) };
        const box = legendBox.value;
        if (box && candidate.x + 22 > box.left && candidate.x - 22 < box.right
          && candidate.y + 22 > box.top && candidate.y - 22 < box.bottom) continue;
        if (placed.every(other => Math.abs(candidate.x - other.displayX) >= 42 || Math.abs(candidate.y - other.displayY) >= 42)) {
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
</script>

<template>
  <div ref="layer" class="device-map-layer" aria-label="附近异常设备">
    <svg class="device-leaders" aria-hidden="true">
      <g v-for="marker in placedMarkers.filter(item => item.displaced)" :key="marker.device_id" :class="{ historical: !abnormalActive(marker) }">
        <line :x1="marker.x" :y1="marker.y" :x2="marker.displayX" :y2="marker.displayY" />
        <circle :cx="marker.x" :cy="marker.y" r="3" />
      </g>
    </svg>
    <div v-for="marker in placedMarkers" :key="marker.device_id" class="device-map-marker"
      :class="{ historical: !abnormalActive(marker), leftward: marker.leftward, downward: marker.downward }"
      :style="{ left: `${marker.displayX}px`, top: `${marker.displayY}px`,
        '--device-card-width': `${Math.max(0, (marker.leftward ? marker.displayX : size.width - marker.displayX) - 22)}px`,
        '--device-card-height': `${Math.max(0, (marker.downward ? size.height - marker.displayY : marker.displayY) - 8)}px` }">
      <button class="device-point" type="button" :aria-label="`${marker.name}，${deviceMeta(marker).label}，${deviceCheckStatus(marker)}，查看设备信息`">
        <span class="map-business-symbol" :class="{ 'map-alarm-active': abnormalActive(marker) }" aria-hidden="true" v-html="deviceIcon(marker)"></span><span class="device-status-corner" aria-hidden="true" v-html="windowIcon(abnormalActive(marker) ? 'warning' : 'clock')"></span>
      </button>
      <div class="device-map-card">
        <b>{{ marker.name }}</b>
        <span class="device-type">{{ deviceMeta(marker).label }}</span>
        <span>{{ deviceCheckStatus(marker) }}<template v-if="marker.simulated"> · 模拟设备</template></span>
        <DeviceAbnormalNoticeButton :plan-id="planId" :device="marker" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.device-map-layer { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 4; }
.device-leaders { position: absolute; inset: 0; width: 100%; height: 100%; color: var(--red); }
.device-leaders line { stroke: currentColor; stroke-width: 1.5; }
.device-leaders circle { fill: currentColor; stroke: var(--surface-1); stroke-width: 1; }
.device-leaders .historical { color: var(--amber); }
.device-map-marker { position: absolute; width: 36px; height: 36px; transform: translate(-50%, -50%); color: var(--red); pointer-events: auto; }
.device-map-marker:hover, .device-map-marker:focus-within { z-index: 1; }
.device-map-marker.historical { color: var(--amber); }
.device-point { position:relative;display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;color:inherit;background:transparent;cursor:pointer;font-size:32px;box-shadow:none; }
.device-point span { display: flex; }
.device-point :deep(.business-icon) { width:24px;height:24px; }
.device-status-corner{position:absolute;right:0;bottom:0;}
.device-status-corner :deep(svg){width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2;}
.device-map-card { position: absolute; left: calc(100% - 4px); bottom: 50%; width: min(300px, var(--device-card-width)); max-height: var(--device-card-height); overflow-y: auto; overscroll-behavior: contain; display: grid; gap: 5px; padding: 9px 11px; border: 1px solid currentColor; border-radius: 7px; background: var(--surface-1, #102033); box-shadow: 0 3px 12px #0004; visibility: hidden; opacity: 0; pointer-events: none; font-size: 12px; }
.device-map-marker:hover .device-map-card, .device-map-marker:focus-within .device-map-card { visibility: visible; opacity: 1; pointer-events: auto; }
.leftward .device-map-card { left: auto; right: calc(100% - 4px); }
.downward .device-map-card { bottom: auto; top: 50%; }
.device-map-card b { color: var(--txt); overflow-wrap: anywhere; }
.device-type { color: var(--txt-2); }
.device-point:hover { transform:scale(1.08); }
.device-point:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; }
</style>
