<script setup>
import { onUnmounted, ref, watch } from 'vue';
const props = defineProps({ markers: { type: Array, default: () => [] } });
defineEmits(['select']);
const targetIcon = window.UI.targetIcon;
const statusIcon = window.UI.icon('warning');
const glowCanvas = ref(null);
const elements = new Map();
let view = null, camera = '', sprite = null;
const keyOf = marker => `${marker.kind}:${marker.id}`;
function bindMarker(key, element) {
  if (!element) elements.delete(key);
  else if (elements.get(key)?.element !== element) elements.set(key, { element, position: '' });
}
function glowSprite() {
  if (sprite) return sprite;
  sprite = document.createElement('canvas');
  sprite.width = sprite.height = 70;
  // 固定像素红光缓存为图片；不为每个 SVG 持续计算多层 drop-shadow。
  const context = sprite.getContext('2d');
  window.UI.paintAlarmGlow(context, 35, 35, 30, 1);
  // 只缓存透明度轮廓，统一红色，避免大量重叠时渐变透明端的黑色累积成黑圈。
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--icon-alarm').trim();
  context.fillRect(0, 0, 70, 70);
  return sprite;
}
function draw(map, force = false) {
  view = map;
  const canvas = glowCanvas.value;
  if (!canvas || !map?.w || map._dead) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const nextCamera = [map.w, map.h, dpr, ...map.px(118, 37), ...map.px(119, 38)].join(',');
  if (!force && nextCamera === camera) return;
  camera = nextCamera;
  const width = Math.round(map.w * dpr), height = Math.round(map.h * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, map.w, map.h);
  let hasGlow = false;
  for (const marker of props.markers) {
    const entry = elements.get(keyOf(marker));
    if (!entry) continue;
    const [x, y] = map.px(...marker.point);
    const visible = Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= map.w && y <= map.h;
    const position = visible ? `translate(${x}px, ${y}px) translate(-50%, -50%)` : '';
    if (entry.position !== position || entry.visible !== visible) {
      entry.element.style.visibility = visible ? 'visible' : 'hidden';
      entry.element.style.transform = position;
      entry.element.querySelector('.object-label')?.classList.toggle('leftward', x > map.w - 200);
      entry.position = position; entry.visible = visible;
    }
    if (visible && marker.activeRisk) { c.drawImage(glowSprite(), x - 35, y - 35); hasGlow = true; }
  }
  canvas.style.display = hasGlow ? '' : 'none';
}
watch(() => props.markers, () => { camera = ''; if (view) draw(view, true); }, { flush: 'post' });
onUnmounted(() => { elements.clear(); view = null; sprite = null; });
defineExpose({ draw });
</script>
<template>
  <div class="airspace-object-markers">
    <canvas ref="glowCanvas" class="object-glows" aria-hidden="true"></canvas>
    <button v-for="marker in markers" :key="keyOf(marker)" :ref="element => bindMarker(keyOf(marker), element)" class="object-marker" :class="{ active: marker.active }" type="button"
      :data-risk-id="marker.kind === 'risk' ? marker.id : null" :data-target-id="marker.kind === 'target' ? marker.id : null"
      :style="{ color: marker.color }" :aria-label="`定位${marker.title}`" :aria-pressed="marker.active" @click.stop="$emit('select', marker)">
      <span class="object-symbol"><span v-html="targetIcon(marker)"></span></span><span class="object-risk-state" aria-hidden="true" v-html="statusIcon"></span>
      <span class="object-label"><b>{{ marker.title }}</b><span>{{ marker.note }}</span></span>
    </button>
  </div>
</template>
<style scoped>
.airspace-object-markers { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 3; }
.object-marker { position: absolute; left: 0; top: 0; visibility: hidden; width: 30px; height: 30px; padding: 0; border: 0; background: transparent; pointer-events: auto; cursor: pointer; font: inherit; }
.object-glows { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; animation: object-glow-pulse 1.4s ease-in-out infinite; }
@keyframes object-glow-pulse { 0%,100% { opacity: .065; } 35%,65% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .object-glows { animation: none; opacity: .85; } }
.object-marker.active { z-index: 2; }
.object-symbol { display: grid; place-items: center; width: 30px; height: 30px; box-sizing: border-box; background:transparent;border:0;box-shadow:none; }
.object-symbol :deep(svg) { width:22px;height:22px; }.object-symbol span { display: flex; }
.object-risk-state{position:absolute;right:0;bottom:0;display:flex}.object-risk-state :deep(svg){width:10px;height:10px;fill:none;stroke:currentColor;stroke-width:2}
.object-label { position: absolute; left: 38px; top: -3px; min-width: 94px; background: var(--surface-gradient); border-left: 2px solid currentColor; border-radius: 4px; padding: 5px 8px; display: grid; gap: 2px; text-align: left; font-size: 11px; white-space: nowrap; }
.object-marker:not(.active):not(:hover):not(:focus-visible) .object-label { display: none; }
.object-label b { color: var(--txt-1); }.object-label > span { font-size: 10px; color: var(--txt-2); }.object-label.leftward { left: auto; right: 38px; }
.object-marker:focus-visible { outline: 2px solid var(--cyan); outline-offset: 4px; }
.object-marker.active .object-symbol { border-bottom:3px solid var(--blue); }
</style>
