<script setup>
import { computed, reactive, ref, shallowRef } from 'vue';
import { validPoint } from './airspaceVolume.js';
import { heightFromDrag, makeViewFrame, project, unproject } from './airspaceVolumeView.js';

const props = defineProps({ polygons: { type: Array, required: true }, lower: Number, upper: Number,
  part: { type: Number, default: 0 }, ring: { type: Number, default: 0 }, disabled: Boolean });
const emit = defineEmits(['point', 'append', 'lower', 'upper']);
const svg = ref(null), drawing = ref(false), drag = shallowRef(null), enhanceHeight = ref(true);
const camera = reactive({ yaw: -.55, pitch: .65, zoom: 1 });
const autoFrame = computed(() => makeViewFrame(props.polygons, props.lower, props.upper, camera, enhanceHeight.value));
const frame = computed(() => drag.value && drag.value.type !== 'rotate' ? drag.value.frame : autoFrame.value);
const heightScaleLabel = computed(() => frame.value.heightScale.toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
const ready = computed(() => Number.isFinite(props.lower) && Number.isFinite(props.upper) && props.upper > props.lower);
const base = computed(() => ready.value ? props.lower : 0);
const points = computed(() => props.polygons.flat(2).filter(validPoint));
const active = computed(() => props.polygons[props.part]?.[props.ring] || []);
const pp = (point, altitude) => project(point, altitude, frame.value, camera);
const line = vertices => vertices.map(p => `${p.x},${p.y}`).join(' ');
function ringPath(ring, altitude) {
  const vertices = ring.filter(validPoint).map(point => pp(point, altitude));
  return vertices.length ? `M${line(vertices).replaceAll(' ', ' L')} Z` : '';
}
const faces = computed(() => {
  if (!ready.value) return [];
  const result = [];
  for (const [partIndex, part] of props.polygons.entries()) {
    if (part.some(ring => ring.length < 3 || ring.some(point => !validPoint(point)))) continue;
    for (const [ringIndex, ring] of part.entries()) for (let i = 0; i < ring.length; i++) {
      const next = ring[(i + 1) % ring.length];
      const vertices = [pp(ring[i], props.lower), pp(next, props.lower), pp(next, props.upper), pp(ring[i], props.upper)];
      result.push({ key: `${partIndex}-${ringIndex}-${i}`, path: `M${line(vertices).replaceAll(' ', ' L')} Z`,
        depth: vertices.reduce((n, p) => n + p.depth, 0) / 4, cap: false, active: partIndex === props.part });
    }
    for (const altitude of [props.lower, props.upper]) {
      const vertices = part[0].map(point => pp(point, altitude));
      result.push({ key: `${partIndex}-cap-${altitude}`, path: part.map(ring => ringPath(ring, altitude)).join(' '),
        depth: vertices.reduce((n, p) => n + p.depth, 0) / vertices.length, cap: true, active: partIndex === props.part });
    }
  }
  return result.sort((a, b) => b.depth - a.depth);
});
const grid = computed(() => {
  const f = frame.value, radius = f.extent * .65, result = [];
  for (let i = -2; i <= 2; i++) {
    const step = radius * i / 2;
    result.push([pp([f.lon - radius / f.mx, f.lat + step / f.my], base.value), pp([f.lon + radius / f.mx, f.lat + step / f.my], base.value)]);
    result.push([pp([f.lon + step / f.mx, f.lat - radius / f.my], base.value), pp([f.lon + step / f.mx, f.lat + radius / f.my], base.value)]);
  }
  return result;
});
const heightPoint = computed(() => [frame.value.lon + frame.value.extent * .65 / frame.value.mx, frame.value.lat]);
const east = computed(() => pp([frame.value.lon + frame.value.extent * .72 / frame.value.mx, frame.value.lat], base.value));
const north = computed(() => pp([frame.value.lon, frame.value.lat + frame.value.extent * .72 / frame.value.my], base.value));
function screen(event) {
  const point = svg.value.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  return point.matrixTransform(svg.value.getScreenCTM().inverse());
}
const round = value => Math.round(value * 1e7) / 1e7;
function down(event, type = 'rotate', index = -1) {
  if (event.button !== 0 || props.disabled) return;
  event.preventDefault(); event.stopPropagation();
  const start = screen(event);
  if (type === 'rotate' && drawing.value && points.value.length) {
    const point = unproject(start, base.value, frame.value, camera).map(round);
    if (validPoint(point)) emit('append', point);
    return;
  }
  const altitude = type === 'upper' ? props.upper : type === 'lower' ? props.lower : ready.value ? props.upper : 0;
  drag.value = { type, index, start, frame: { ...frame.value }, camera: { ...camera }, altitude,
    point: index >= 0 ? [...active.value[index]] : null, pointer: event.pointerId };
  svg.value.setPointerCapture(event.pointerId);
}
function move(event) {
  const state = drag.value;
  if (!state || state.pointer !== event.pointerId) return;
  const current = screen(event), dx = current.x - state.start.x, dy = current.y - state.start.y;
  if (state.type === 'rotate') {
    camera.yaw = state.camera.yaw + dx * .008;
    camera.pitch = Math.max(.2, Math.min(1.3, state.camera.pitch + dy * .005));
  } else if (state.type === 'point') {
    const origin = project(state.point, state.altitude, state.frame, state.camera);
    const point = unproject({ x: origin.x + dx, y: origin.y + dy }, state.altitude, state.frame, state.camera).map(round);
    if (validPoint(point)) emit('point', state.index, point);
  } else {
    const altitude = Math.round(heightFromDrag(state.altitude, dy, state.frame, state.camera) * 10) / 10;
    emit(state.type, state.type === 'upper' ? Math.max(props.lower + .1, altitude) : Math.min(props.upper - .1, altitude));
  }
}
function up(event) {
  if (drag.value?.pointer !== event.pointerId) return;
  if (svg.value.hasPointerCapture(event.pointerId)) svg.value.releasePointerCapture(event.pointerId);
  drag.value = null;
}
function pointKey(event, index) {
  if (props.disabled) return;
  const offset = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
  if (!offset) return;
  event.preventDefault();
  const point = active.value[index], amount = event.shiftKey ? 10 : 1;
  const changed = [point[0] + offset[0] * amount / frame.value.mx, point[1] + offset[1] * amount / frame.value.my].map(round);
  if (validPoint(changed)) emit('point', index, changed);
}
function heightKey(event, which) {
  if (props.disabled || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const value = props[which] + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1);
  if (which === 'upper' ? value > props.lower : value < props.upper) emit(which, value);
}
</script>

<template>
  <section class="volume-editor" aria-label="立体空域编辑器">
    <div class="volume-tools">
      <b>三维空域</b>
      <button class="btn ghost" type="button" @click="camera.yaw -= .3">向左旋转</button>
      <button class="btn ghost" type="button" @click="camera.yaw += .3">向右旋转</button>
      <button class="btn ghost" type="button" @click="camera.pitch = camera.pitch > 1 ? .65 : 1.3">{{ camera.pitch > 1 ? '立体视角' : '俯视角度' }}</button>
      <button class="btn ghost" type="button" aria-label="放大空域" @click="camera.zoom = Math.min(4, camera.zoom * 1.2)">＋</button>
      <button class="btn ghost" type="button" aria-label="缩小空域" @click="camera.zoom = Math.max(.3, camera.zoom / 1.2)">－</button>
      <button class="btn ghost" type="button" @click="Object.assign(camera, { yaw: -.55, pitch: .65, zoom: 1 })">适应范围</button>
      <button class="btn" :class="{ primary: enhanceHeight }" type="button" :aria-pressed="enhanceHeight" @click="enhanceHeight = true">突出高度</button>
      <button class="btn" :class="{ primary: !enhanceHeight }" type="button" :aria-pressed="!enhanceHeight" @click="enhanceHeight = false">真实比例</button>
      <button class="btn" :class="{ primary: drawing }" type="button" :disabled="disabled || !points.length" :aria-pressed="drawing" @click="drawing = !drawing">{{ drawing ? '结束描点' : '描点添加边界' }}</button>
    </div>
    <div v-if="ready" class="volume-altitude-summary">
      <span>海拔下限 <b>{{ lower }} 米</b></span>
      <span>海拔上限 <b>{{ upper }} 米</b></span>
      <span>实际厚度 <b>{{ Number((upper - lower).toFixed(2)) }} 米</b></span>
      <span v-if="frame.heightScale > 1" class="volume-scale-note">高度显示放大 {{ heightScaleLabel }} 倍，仅影响画面，保存值不变。</span>
      <span v-else class="volume-scale-note">水平与垂直按真实比例显示。</span>
    </div>
    <div class="volume-canvas">
      <svg ref="svg" viewBox="0 0 800 520" role="group" aria-label="空域三维视图：拖动背景旋转，拖动顶点修改经纬度，拖动高度手柄修改海拔"
        @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="drag = null">
        <template v-if="points.length">
          <g class="volume-grid"><polyline v-for="(segment, index) in grid" :key="index" :points="line(segment)" /></g>
          <text :x="east.x" :y="east.y" class="axis-label">东 E</text>
          <text :x="north.x" :y="north.y - 10" class="axis-label">北 N</text>
          <path v-for="face in faces" :key="face.key" :d="face.path" fill-rule="evenodd" class="volume-face" :class="{ cap: face.cap, active: face.active }" />
          <path v-for="(partRings, index) in polygons" :key="`outline-${index}`" :d="partRings.map(r => ringPath(r, base)).join(' ')" class="volume-outline" />
          <g v-if="ready" class="height-dimension">
            <line :x1="pp(heightPoint, lower).x" :y1="pp(heightPoint, lower).y" :x2="pp(heightPoint, upper).x" :y2="pp(heightPoint, upper).y" />
            <g v-for="which in ['lower', 'upper']" :key="which" :transform="`translate(${pp(heightPoint, props[which]).x},${pp(heightPoint, props[which]).y})`">
              <rect x="-9" y="-7" width="18" height="14" rx="3" class="height-handle" tabindex="0" role="button" :aria-label="which === 'upper' ? '拖动海拔上限' : '拖动海拔下限'" @pointerdown="down($event, which)" @keydown="heightKey($event, which)" />
              <text x="14" y="5">{{ which === 'upper' ? '上限' : '下限' }} {{ props[which] }} m</text>
            </g>
          </g>
          <g v-for="(point, index) in active" :key="`vertex-${index}`">
            <template v-if="validPoint(point)">
              <circle :cx="pp(point, ready ? upper : 0).x" :cy="pp(point, ready ? upper : 0).y" r="7" class="vertex-handle" tabindex="0" role="button" :aria-label="`边界点 ${index + 1}，经度 ${point[0]}，纬度 ${point[1]}`" @pointerdown="down($event, 'point', index)" @keydown="pointKey($event, index)" />
              <text :x="pp(point, ready ? upper : 0).x + 11" :y="pp(point, ready ? upper : 0).y - 10" class="vertex-label">{{ index + 1 }}</text>
            </template>
          </g>
        </template>
        <text v-else x="400" y="240" text-anchor="middle" class="volume-empty">先在右侧填写边界经纬度</text>
        <text v-if="points.length && !ready" x="400" y="485" text-anchor="middle" class="volume-empty">填写有效的海拔上下限后显示立体空域</text>
      </svg>
    </div>
    <div class="volume-help">
      <span>{{ drawing ? '点击下限平面添加边界点，首尾自动闭合。' : '拖动背景旋转，拖动编号点调整经纬度，拖动右侧手柄调整海拔。' }}</span>
      <span>高度标注均为实际海拔米值。<template v-if="ready && frame.heightScale > 1">当前突出高度，可切换“真实比例”对照。</template></span>
    </div>
  </section>
</template>

<style scoped>
.volume-editor { min-width: 0; border: 1px solid var(--line); border-radius: 6px; background: var(--panel-2); }
.volume-tools { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 10px; border-bottom: 1px solid var(--line); }
.volume-tools b { margin-right: auto; }
.volume-tools .btn { font-size: 12px; padding: 5px 8px; }
.volume-altitude-summary { display: flex; flex-wrap: wrap; gap: 6px 20px; padding: 10px 12px; border-bottom: 1px solid var(--line); color: var(--txt-2); font-size: 12px; line-height: 1.7; }
.volume-altitude-summary b { color: var(--amber); font-variant-numeric: tabular-nums; }
.volume-scale-note { flex-basis: 100%; color: var(--txt-2); }
.volume-canvas { min-width: 0; overflow: hidden; }
svg { display: block; width: 100%; min-height: 300px; touch-action: none; cursor: grab; user-select: none; }
svg:active { cursor: grabbing; }
.volume-grid polyline { fill: none; stroke: var(--line); stroke-width: 1; }
.axis-label, .volume-empty { fill: var(--txt-3); font-size: 15px; }
.volume-face { fill: var(--blue); fill-opacity: .12; stroke: var(--blue); stroke-opacity: .55; stroke-width: 1.2; }
.volume-face.active { fill: var(--cyan); stroke: var(--cyan); }
.volume-face.cap { fill-opacity: .22; }
.volume-outline { fill: none; stroke: var(--txt-3); stroke-width: 1.5; stroke-dasharray: 5 4; }
.vertex-handle { fill: var(--panel); stroke: var(--cyan); stroke-width: 3; cursor: move; }
.vertex-handle:focus, .height-handle:focus { outline: none; stroke: var(--amber); stroke-width: 4; }
.vertex-label { fill: var(--txt); font-size: 14px; font-weight: 700; paint-order: stroke; stroke: var(--panel-2); stroke-width: 3px; }
.height-dimension line { stroke: var(--amber); stroke-width: 2; stroke-dasharray: 4 3; }
.height-handle { fill: var(--amber); stroke: var(--panel); cursor: ns-resize; }
.height-dimension text { fill: var(--amber); font-size: 13px; paint-order: stroke; stroke: var(--panel-2); stroke-width: 3px; }
.volume-help { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 10px; border-top: 1px solid var(--line); color: var(--txt-2); font-size: 12px; line-height: 1.7; }
@media (max-width: 800px) { svg { min-height: 230px; } }
</style>
