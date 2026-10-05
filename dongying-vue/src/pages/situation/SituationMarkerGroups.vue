<script setup>
import { computed, onMounted, onUnmounted, shallowRef } from 'vue';
import { selectionLayout } from './selectionLayout.js';
import { weatherRiskIcon } from '@/ui/weatherRiskIcon.js';

const props = defineProps({ getMap: { type: Function, required: true } });
const emit = defineEmits(['select']);
const layout = shallowRef(null);
const panelPosition = shallowRef({});
const opened = computed(() => layout.value?.groups.find(group => group.expanded));
const U = window.UI;
let frame, last = 0;
function panelLayout(map) {
  const free = selectionLayout(map.box.parentElement);
  const wide = free.right - free.left >= 640;
  const width = Math.min(wide ? 280 : 360, Math.max(180, free.right - free.left));
  const height = Math.min(wide ? 480 : 220, Math.max(140, free.bottom - free.top));
  return { free, wide, left: free.left, top: wide ? free.top : free.bottom - height, width, height };
}
function sync(time) {
  frame = requestAnimationFrame(sync);
  if (time - last < 80) return;
  last = time;
  const map = props.getMap();
  if (!map || map._dead) { layout.value = null; return; }
  if (layout.value !== map._markerLayout) layout.value = map._markerLayout;
  if (opened.value) {
    const box = panelLayout(map);
    panelPosition.value = { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, maxHeight: `${box.height}px` };
    map._markerObstacles = [{ x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height }];
  } else map._markerObstacles = [];
}
function toggle(group) {
  const map = props.getMap();
  if (!map) return;
  if (group.expanded) { close(); return; }
  const box = panelLayout(map), point = map.unpx(group.x, group.y);
  const x = box.wide ? (box.left + box.width + box.free.right) / 2 : (box.free.left + box.free.right) / 2;
  const y = box.wide ? (box.free.top + box.free.bottom) / 2 : (box.free.top + box.top) / 2;
  map.expandMarkerGroup(group.id);
  map.centerAt(point[0], point[1], { scale: map.zoom, offset: [x - map.w / 2, y - map.h / 2] });
}
function close() {
  const map = props.getMap();
  if (map) { map._markerObstacles = []; map.expandMarkerGroup(''); }
}
function select(member) { close(); emit('select', { kind: member.kind, data: member.data }); }
function zoomIn() {
  const map = props.getMap(), group = opened.value;
  if (!map || !group) return;
  const point = map.unpx(group.x, group.y);
  close();
  map.centerAt(point[0], point[1], { scale: map.zoom * 2 });
}
function name(member) { return member.data.name || member.data.targetNo || member.data.id; }
function composition(group) {
  return [['device', '设备'], ['target', '目标'], ['weather', '气象风险']]
    .map(([kind, label]) => [label, group.members.filter(member => member.kind === kind).length])
    .filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(' · ');
}
function kind(member) { return { device: '设备', target: '目标', weather: '气象风险' }[member.kind]; }
function icon(member) {
  return member.kind === 'device' ? U.deviceIcon(member.data)
    : member.kind === 'target' ? U.targetIcon(member.data) : weatherRiskIcon(member.data);
}
onMounted(() => { frame = requestAnimationFrame(sync); });
onUnmounted(() => cancelAnimationFrame(frame));
</script>

<template>
  <div class="sit-marker-groups" @keydown.esc.stop="close">
    <button v-for="group in layout?.groups || []" :key="group.id" type="button" class="sit-marker-group"
      :class="{ 'is-open': group.expanded }" :style="{ left: `${group.x}px`, top: `${group.y}px` }"
      :aria-expanded="group.expanded" :aria-label="`查看重叠点位，共${group.members.length}项，异常${group.abnormalCount}项`"
      :title="composition(group)"
      @click.stop="toggle(group)">
      <b>{{ group.members.length }} 项 <span aria-hidden="true">{{ group.expanded ? '−' : '+' }}</span></b>
      <small :class="{ 'has-risk': group.abnormalCount }">{{ group.abnormalCount ? `异常 ${group.abnormalCount}` : '点击展开' }}</small>
    </button>
    <section v-if="opened" class="sit-marker-list" :style="panelPosition" aria-label="重叠点位清单">
      <header><strong>重叠点位 · {{ opened.members.length }} 项</strong><button type="button" class="zoom" @click="zoomIn">放大查看</button><button type="button" aria-label="收起重叠点位" @click="close">×</button></header>
      <p>{{ composition(opened) }}<br>{{ opened.shownCount }} 项已展开，可选择下方任一对象。</p>
      <div class="sit-marker-rows">
        <button v-for="member in opened.members" :key="member.key" type="button" @click="select(member)">
          <span class="sit-member-icon" aria-hidden="true" v-html="icon(member)"></span>
          <span><b>{{ name(member) }}</b><small>{{ kind(member) }}<template v-if="member.data.type"> · {{ member.data.type }}</template></small><small v-if="name(member) !== member.data.id">{{ member.data.id }}</small></span>
          <em v-if="member.abnormal">异常</em>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sit-marker-groups { position:absolute; inset:0; z-index:11; pointer-events:none; }
.sit-marker-group { position:absolute; transform:translate(-50%,-50%); width:104px; height:48px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; border:1px solid var(--control-line); border-radius:6px; color:var(--txt); background:var(--surface-1); box-shadow:var(--shadow); font:inherit; cursor:pointer; pointer-events:auto; }
.sit-marker-group b { font-size:14px; }.sit-marker-group b span { margin-left:6px; color:var(--cyan); }
.sit-marker-group small { color:var(--txt-2); font-size:11px; }.sit-marker-group .has-risk { color:var(--red); }
.sit-marker-group:hover,.sit-marker-group.is-open { border-color:var(--cyan); background:linear-gradient(var(--surface-hover),var(--surface-hover)),var(--surface-1); }
button:focus-visible { outline:2px solid var(--cyan); outline-offset:3px; }
.sit-marker-list { position:absolute; display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--control-line); border-radius:6px; background:var(--surface-1); color:var(--txt); box-shadow:var(--shadow); pointer-events:auto; }
.sit-marker-list header { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; gap:8px; border-bottom:1px solid var(--line); }
.sit-marker-list header button { border:0; background:transparent; color:var(--txt-2); font-size:22px; cursor:pointer; min-width:28px; }
.sit-marker-list header .zoom { margin-left:auto; padding:4px 0; color:var(--cyan); font-size:12px; white-space:nowrap; }
.sit-marker-list p { margin:0; padding:8px 12px; font-size:12px; color:var(--txt-2); }
.sit-marker-rows { overflow:auto; overscroll-behavior:contain; padding:0 8px 8px; }
.sit-marker-rows button { display:flex; align-items:center; gap:8px; width:100%; padding:9px 6px; border:0; border-bottom:1px solid var(--line); background:transparent; color:inherit; text-align:left; cursor:pointer; font:inherit; }
.sit-marker-rows button:hover { background:var(--surface-hover); }
.sit-member-icon { display:flex; flex:0 0 30px; }.sit-member-icon :deep(svg) { width:28px; height:28px; }
.sit-marker-rows button>span:nth-child(2) { display:flex; flex:1; min-width:0; flex-direction:column; overflow-wrap:anywhere; gap:3px; }
.sit-marker-rows b { font-size:12px; font-weight:500; }.sit-marker-rows small { color:var(--txt-3); font-size:11px; }
.sit-marker-rows em { flex:none; font-style:normal; font-size:11px; color:var(--red); }
</style>
