<script setup>
import { computed, nextTick, reactive, ref, shallowRef, useId, watch } from 'vue';
import { makeFrame, validPoint } from './airspaceVolume.js';
import { heightFromDrag, makeViewFrame, project, unproject } from './airspaceVolumeView.js';
import { useAirspaceFloorMap } from './airspaceFloorMap.js';

const props = defineProps({ polygons: { type: Array, required: true }, lower: Number, upper: Number,
  part: { type: Number, default: 0 }, ring: { type: Number, default: 0 }, disabled: Boolean,
  selected: { type: Number, default: -1 } });
const emit = defineEmits(['point', 'append', 'lower', 'upper', 'select']);
// 新增空域（还没有边界点）直接以正北朝上的俯视角度进入描点：在地图上点击加点。
const blank = !props.polygons.flat(2).some(validPoint);
const svg = ref(null), drawing = ref(blank), drag = shallowRef(null), enhanceHeight = ref(true);
const home = { yaw: blank ? 0 : -.55, pitch: blank ? 1.3 : .65, zoom: 1 };
const camera = reactive({ ...home });
// 地图包覆盖范围：加载中为 null，不可用为 false。
const coverage = shallowRef(null);
// 手动视野 { lon, lat, extent }：描点时冻结画面，按住拖动平移、滚轮缩放时更新；为空时按边界自动取景。
const view = shallowRef(null);
const points = computed(() => props.polygons.flat(2).filter(validPoint));
// 还没有边界点时，与业务地图默认视野一致：以地图包中心取景，地图铺满画面不露底。
const defaultView = computed(() => {
  const b = coverage.value;
  if (points.value.length || !b) return null;
  const f = makeFrame([[[[b[0], b[1]], [b[2], b[3]]]]], null, null);
  const width = (b[2] - b[0]) * f.mx, depth = (b[3] - b[1]) * f.my;
  return { lon: f.lon, lat: f.lat, extent: 330 / Math.max(800 / width, 520 / (depth * Math.sin(camera.pitch))) };
});
const canDraw = computed(() => points.value.length > 0 || !!coverage.value);
const drawingOn = computed(() => drawing.value && canDraw.value);
const autoFrame = computed(() => makeViewFrame(props.polygons, props.lower, props.upper, camera, enhanceHeight.value, view.value || defaultView.value));
const frame = computed(() => drag.value && !['rotate', 'pan'].includes(drag.value.type) ? drag.value.frame : autoFrame.value);
const shape = computed(() => makeFrame(props.polygons, props.lower, props.upper));
const heightScaleLabel = computed(() => frame.value.heightScale.toLocaleString('zh-CN', { maximumFractionDigits: 2 }));
const ready = computed(() => Number.isFinite(props.lower) && Number.isFinite(props.upper) && props.upper > props.lower);
const base = computed(() => ready.value ? props.lower : 0);
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
// 底面贴本地离线地图，便于看出空域落在哪里；图片按其自身绘制时的中心和范围贴到下限平面。
// 地图半径按当前缩放和俯仰铺满整个画面（含缩小、压低视角时露出的远处），淡出边缘落在画面外；
// 半径按 2^(1/4) 档向上取整，旋转和小幅调整不重画。
const FLOOR_FADE_START = .88;
const floorMap = useAirspaceFloorMap(computed(() => {
  if (!points.value.length && !view.value && !defaultView.value) return null;
  const f = autoFrame.value, scale = f.scale * camera.zoom;
  const [lon, lat] = unproject({ x: 400, y: 260 }, base.value, f, camera);
  const shift = Math.hypot((lon - f.lon) * f.mx, (lat - f.lat) * f.my);
  const cover = (Math.hypot(400 / scale, 260 / (scale * Math.sin(camera.pitch))) + shift) / FLOOR_FADE_START;
  return { lon: f.lon, lat: f.lat, radius: f.extent * 2 ** (Math.ceil(Math.log2(cover / f.extent) * 4) / 4) };
}), coverage);
const floorMaskId = `airspace-floor-${useId()}`;
const floorMatrix = computed(() => {
  const m = floorMap.value, f = frame.value;
  if (!m) return '';
  const dx = m.radius / f.mx, dy = m.radius / f.my;
  const nw = pp([m.lon - dx, m.lat + dy], base.value), ne = pp([m.lon + dx, m.lat + dy], base.value), sw = pp([m.lon - dx, m.lat - dy], base.value);
  return `matrix(${ne.x - nw.x},${ne.y - nw.y},${sw.x - nw.x},${sw.y - nw.y},${nw.x},${nw.y})`;
});
// 高度标尺放在空域东侧略偏北，避开同在东侧的「东 E」字样。
const heightPoint = computed(() => [shape.value.lon + shape.value.extent * .65 / shape.value.mx, shape.value.lat + shape.value.extent * .25 / shape.value.my]);
const east = computed(() => pp([frame.value.lon + frame.value.extent * .72 / frame.value.mx, frame.value.lat], base.value));
const north = computed(() => pp([frame.value.lon, frame.value.lat + frame.value.extent * .72 / frame.value.my], base.value));
function screen(event) {
  const point = svg.value.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
  return point.matrixTransform(svg.value.getScreenCTM().inverse());
}
const round = value => Math.round(value * 1e7) / 1e7;
const frozenView = () => ({ lon: frame.value.lon, lat: frame.value.lat, extent: frame.value.extent });
// 画面上的点击和拖动由视图自己改坐标，不需要重新取景；右侧改坐标、增删点后重新取景，保证改动落在画面里。
let ownEdit = false;
function own(change) { ownEdit = true; change(); nextTick(() => { ownEdit = false; }); }
watch(() => points.value.map(point => point.join(',')).join(';'), () => { if (!ownEdit) view.value = null; });
function fit() {
  Object.assign(camera, home);
  view.value = null;
}
function toggleDrawing() {
  drawing.value = !drawingOn.value;
  // 开始描点时冻结当前画面，点了点地图不跳；结束后按边界重新取景。
  view.value = drawing.value ? frozenView() : null;
}
function down(event, type = 'rotate', index = -1) {
  if (event.button !== 0 || props.disabled) return;
  event.preventDefault(); event.stopPropagation();
  // 阻止了默认行为，焦点不会自己离开右侧输入框：按在手柄上时交给手柄（方向键可微调），按在地图上时移开。
  if (type !== 'rotate') event.currentTarget.focus({ preventScroll: true });
  else if (!svg.value.contains(document.activeElement)) document.activeElement?.blur();
  if (type === 'point') emit('select', index);
  if (type === 'rotate' && drawing.value) {
    if (!drawingOn.value) return;
    // 描点：点一下加点，按住拖动平移地图。
    if (!view.value) view.value = frozenView();
    type = 'pan';
  }
  const start = screen(event);
  const altitude = type === 'upper' ? props.upper : type === 'lower' ? props.lower : base.value;
  drag.value = { type, index, start, frame: { ...frame.value }, camera: { ...camera }, altitude, view: view.value, moved: false,
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
  } else if (state.type === 'pan') {
    if (!state.moved && Math.hypot(dx, dy) < 4) return;
    state.moved = true;
    const from = unproject(state.start, state.altitude, state.frame, state.camera), to = unproject(current, state.altitude, state.frame, state.camera);
    view.value = { ...state.view, lon: state.view.lon - (to[0] - from[0]), lat: state.view.lat - (to[1] - from[1]) };
  } else if (state.type === 'point') {
    const origin = project(state.point, state.altitude, state.frame, state.camera);
    const point = unproject({ x: origin.x + dx, y: origin.y + dy }, state.altitude, state.frame, state.camera).map(round);
    if (validPoint(point)) own(() => emit('point', state.index, point));
  } else {
    const altitude = Math.round(heightFromDrag(state.altitude, dy, state.frame, state.camera) * 10) / 10;
    emit(state.type, state.type === 'upper' ? Math.max(props.lower + .1, altitude) : Math.min(props.upper - .1, altitude));
  }
}
function up(event) {
  const state = drag.value;
  if (state?.pointer !== event.pointerId) return;
  if (svg.value.hasPointerCapture(event.pointerId)) svg.value.releasePointerCapture(event.pointerId);
  drag.value = null;
  if (state.type !== 'pan' || state.moved || event.type !== 'pointerup') return;
  const point = unproject(state.start, state.altitude, state.frame, state.camera).map(round);
  if (validPoint(point)) own(() => emit('append', point));
}
// 滚轮以光标处为中心缩放地图。
function wheel(event) {
  if (props.disabled || (!points.value.length && !view.value && !defaultView.value)) return;
  event.preventDefault();
  const f = frame.value, cursor = screen(event);
  const delta = event.deltaY * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1);
  const extent = Math.max(50, Math.min(400000, f.extent * Math.exp(delta * .002)));
  const target = unproject(cursor, base.value, f, camera), k = extent / f.extent;
  const next = { lon: target[0] + (f.lon - target[0]) * k, lat: target[1] + (f.lat - target[1]) * k, extent };
  // 画面原点不在下限平面上，换比例后光标处地面点会偏一点，再按偏移修正一次。
  const moved = unproject(cursor, base.value, makeViewFrame(props.polygons, props.lower, props.upper, camera, enhanceHeight.value, next), camera);
  view.value = { lon: next.lon + target[0] - moved[0], lat: next.lat + target[1] - moved[1], extent };
}
function pointKey(event, index) {
  if (props.disabled) return;
  const offset = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
  if (!offset) return;
  event.preventDefault();
  const point = active.value[index], amount = event.shiftKey ? 10 : 1;
  const changed = [point[0] + offset[0] * amount / frame.value.mx, point[1] + offset[1] * amount / frame.value.my].map(round);
  if (validPoint(changed)) own(() => emit('point', index, changed));
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
      <button class="btn ghost" type="button" @click="fit">适应范围</button>
      <button class="btn" :class="{ primary: enhanceHeight }" type="button" :aria-pressed="enhanceHeight" @click="enhanceHeight = true">突出高度</button>
      <button class="btn" :class="{ primary: !enhanceHeight }" type="button" :aria-pressed="!enhanceHeight" @click="enhanceHeight = false">真实比例</button>
      <button class="btn" :class="{ primary: drawingOn }" type="button" :disabled="disabled || !canDraw" :aria-pressed="drawingOn" @click="toggleDrawing">{{ drawingOn ? '结束描点' : '描点添加边界' }}</button>
    </div>
    <div v-if="ready" class="volume-altitude-summary">
      <span>海拔下限 <b>{{ lower }} 米</b></span>
      <span>海拔上限 <b>{{ upper }} 米</b></span>
      <span>实际厚度 <b>{{ Number((upper - lower).toFixed(2)) }} 米</b></span>
      <span v-if="frame.heightScale > 1" class="volume-scale-note">高度显示放大 {{ heightScaleLabel }} 倍，仅影响画面，保存值不变。</span>
      <span v-else class="volume-scale-note">水平与垂直按真实比例显示。</span>
    </div>
    <div class="volume-canvas">
      <svg ref="svg" viewBox="0 0 800 520" role="group" :aria-label="drawingOn ? '空域三维视图：点击地图添加边界点，按住拖动移动地图' : '空域三维视图：拖动背景旋转，拖动顶点修改经纬度，拖动高度手柄修改海拔'"
        :class="{ drawing: drawingOn }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="drag = null" @wheel="wheel">
        <template v-if="points.length || floorMap">
          <g v-if="floorMap" class="volume-floor" :transform="floorMatrix">
            <defs>
              <radialGradient :id="`${floorMaskId}-fade`" cx=".5" cy=".5" r=".5"><stop :offset="FLOOR_FADE_START" stop-color="#fff" /><stop offset="1" stop-color="#fff" stop-opacity="0" /></radialGradient>
              <mask :id="floorMaskId" maskContentUnits="objectBoundingBox"><rect width="1" height="1" :fill="`url(#${floorMaskId}-fade)`" /></mask>
            </defs>
            <image :href="floorMap.href" width="1" height="1" preserveAspectRatio="none" :mask="`url(#${floorMaskId})`" />
          </g>
          <g v-else-if="points.length" class="volume-grid"><polyline v-for="(segment, index) in grid" :key="index" :points="line(segment)" /></g>
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
              <circle :cx="pp(point, base).x" :cy="pp(point, base).y" r="7" class="vertex-handle" :class="{ selected: index === selected }" tabindex="0" role="button" :aria-label="`边界点 ${index + 1}，经度 ${point[0]}，纬度 ${point[1]}`" @pointerdown="down($event, 'point', index)" @focus="emit('select', index)" @keydown="pointKey($event, index)" />
              <text :x="pp(point, base).x + 11" :y="pp(point, base).y - 10" class="vertex-label" :class="{ selected: index === selected }">{{ index + 1 }}</text>
            </template>
          </g>
        </template>
        <text v-else x="400" y="240" text-anchor="middle" class="volume-empty">{{ coverage === false ? '先在右侧填写边界经纬度' : '正在加载地图…' }}</text>
        <text v-if="drawingOn" x="16" y="30" class="volume-prompt">{{ floorMap ? '点击地图添加边界点' : '点击添加边界点' }}</text>
        <text v-if="points.length && !ready" x="400" y="485" text-anchor="middle" class="volume-empty">填写有效的海拔上下限后显示立体空域</text>
      </svg>
    </div>
    <div class="volume-help">
      <span>{{ drawingOn ? '点击地图添加边界点，首尾自动闭合；按住拖动移动地图，滚轮缩放。' : '拖动背景旋转，滚轮缩放，拖动编号点调整经纬度，拖动右侧手柄调整海拔。' }}</span>
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
svg.drawing { cursor: crosshair; }
.volume-floor { pointer-events: none; }
.volume-grid polyline { fill: none; stroke: var(--line); stroke-width: 1; }
.axis-label, .volume-empty { fill: var(--txt-3); font-size: 15px; }
.volume-empty { paint-order: stroke; stroke: var(--panel-2); stroke-width: 4px; }
.volume-face { fill: var(--blue); fill-opacity: .12; stroke: var(--blue); stroke-opacity: .55; stroke-width: 1.2; }
.volume-face.active { fill: var(--cyan); stroke: var(--cyan); }
.volume-face.cap { fill-opacity: .22; }
.volume-outline { fill: none; stroke: var(--txt-3); stroke-width: 1.5; stroke-dasharray: 5 4; }
.vertex-handle { fill: var(--panel); stroke: var(--cyan); stroke-width: 3; cursor: move; }
.vertex-handle:focus, .height-handle:focus, .vertex-handle.selected { outline: none; stroke: var(--amber); stroke-width: 4; }
.vertex-label.selected { fill: var(--amber); }
.volume-prompt { fill: var(--txt); font-size: 14px; paint-order: stroke; stroke: var(--panel-2); stroke-width: 4px; pointer-events: none; }
.vertex-label { fill: var(--txt); font-size: 14px; font-weight: 700; paint-order: stroke; stroke: var(--panel-2); stroke-width: 3px; }
.height-dimension line { stroke: var(--amber); stroke-width: 2; stroke-dasharray: 4 3; }
.height-handle { fill: var(--amber); stroke: var(--panel); cursor: ns-resize; }
.height-dimension text { fill: var(--amber); font-size: 13px; paint-order: stroke; stroke: var(--panel-2); stroke-width: 3px; }
.volume-help { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 10px; border-top: 1px solid var(--line); color: var(--txt-2); font-size: 12px; line-height: 1.7; }
@media (max-width: 800px) { svg { min-height: 230px; } }
</style>
