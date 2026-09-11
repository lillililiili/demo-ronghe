<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { NSlider } from 'naive-ui';
import { UField, UFormFooter } from '@/components/form/index.js';
import { closeModal } from '@/ui/modal.js';

const U = window.UI;
const KIND = {
  meas: { t: '实测', c: 't-green' },
  bridge: { t: '推算补全', c: 't-orange' },
  pred: { t: '预测', c: 't-cyan' }
};

const props = defineProps({
  mapTarget: { type: Object, required: true },
  points: { type: Array, required: true },
  alarmMark: { type: Object, default: null },
  alarmText: { type: String, default: '' }
});

const idx = ref(0);
const playing = ref(!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches));
const speed = ref(1);
const follow = ref(true);
const mapHost = ref(null);
let map = null;
let timer = null;
let readyTimer = null;
let fitted = false;

const total = computed(() => props.points.length);
const current = computed(() => {
  const i = Math.max(0, Math.min(total.value - 1, Math.round(Number(idx.value)) || 0));
  return props.points[i] || props.points[0];
});
const playLabel = computed(() => playing.value
  ? `${U.icon('pause')} 暂停`
  : `${U.icon('play')} 播放`);
const kind = computed(() => KIND[current.value?.kind] || KIND.meas);
const clock = computed(() => clockOf(current.value?.t));
const spanText = computed(() => {
  const first = props.points[0];
  const last = props.points[props.points.length - 1];
  return `${clockOf(first?.t)} ~ ${clockOf(last?.t)}`;
});
const altText = computed(() => current.value?.alt == null ? '—' : `${current.value.alt} m`);

function clockOf(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fitCoordinates(points) {
  return points.map(p => [p.lon, p.lat]);
}

function hostReady() {
  const el = mapHost.value;
  if (!el || el.clientWidth < 80 || el.clientHeight < 80) return false;
  const r = el.getBoundingClientRect();
  return Math.abs(r.width - el.clientWidth) < 8 && Math.abs(r.height - el.clientHeight) < 8;
}

function paint() {
  if (!map || !current.value) return;
  const point = current.value;
  map.sel = props.mapTarget.id;
  map.setData({
    airspaces: [],
    devices: [],
    alarms: [],
    targets: [{
      ...props.mapTarget,
      lon: point.lon,
      lat: point.lat,
      alt: point.alt,
      heading: point.heading,
      tracked: true,
      track: props.points
    }]
  });
  if (!fitted) fitCourse();
  else if (follow.value) map.centerAt(point.lon, point.lat);
}

function fitCourse() {
  if (!map || !props.points.length || !hostReady()) return;
  if (typeof map._resize === 'function') map._resize();
  map.fitTo(fitCoordinates(props.points), 0.14);
  fitted = true;
  if (follow.value && current.value) map.centerAt(current.value.lon, current.value.lat);
}

function togglePlay() { playing.value = !playing.value; }

function cycleSpeed() {
  speed.value = speed.value === 8 ? 1 : speed.value * 2;
}

function close() { closeModal(); }

watch(idx, paint);
watch(follow, on => {
  if (on) paint();
  else fitCourse();
});

function waitForHost() {
  return new Promise(resolve => {
    const started = Date.now();
    const tick = () => {
      if (hostReady() || Date.now() - started > 2000) return resolve();
      requestAnimationFrame(tick);
    };
    tick();
  });
}

onMounted(async () => {
  await nextTick();
  await waitForHost();
  if (!mapHost.value || typeof window.MapView !== 'function') return;
  map = new window.MapView(mapHost.value, {
    zoom: 2.2, maxZoom: 22, legend: false, layers: { device: false, alarm: false }
  });
  paint();
  const started = Date.now();
  readyTimer = setInterval(() => {
    if (!map) { clearInterval(readyTimer); readyTimer = null; return; }
    if (map.map || map.online || Date.now() - started > 4000) {
      clearInterval(readyTimer); readyTimer = null;
      fitCourse();
    }
  }, 80);
  timer = setInterval(() => {
    if (!playing.value || total.value < 2) return;
    const next = Math.round(Number(idx.value) || 0) + speed.value;
    idx.value = next >= total.value ? 0 : next;
  }, 400);
});

onUnmounted(() => {
  if (timer) { clearInterval(timer); timer = null; }
  if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
  if (map) { map.destroy(); map = null; }
});
</script>

<template>
  <div class="track-replay">
    <div ref="mapHost" class="track-replay-map" />
    <div class="track-replay-bar">
      <button type="button" class="btn track-replay-play" :title="playing ? '暂停' : '播放'"
        @click="togglePlay" v-html="playLabel"></button>
      <button type="button" class="btn ghost" :title="`当前 ${speed} 倍速`" @click="cycleSpeed">{{ speed }}x</button>
      <div class="track-replay-slider">
        <n-slider v-model:value="idx" :min="0" :max="Math.max(0, total - 1)" :step="1" :tooltip="false" />
        <span v-if="alarmMark" class="track-replay-alarm" :style="{ left: alarmMark.pct + '%' }"
          :title="alarmMark.title"></span>
      </div>
      <span class="mono track-replay-time">{{ clock }}</span>
      <UField type="checkbox" v-model="follow" box-label="跟随" variant="toolbar" size="small" />
    </div>
    <div class="track-replay-info">
      <span>点位 <b class="mono">{{ Math.round(idx) + 1 }}/{{ total }}</b></span>
      <span>高度 <b class="mono">{{ altText }}</b></span>
      <span>点类型 <span class="tag" :class="kind.c">{{ kind.t }}</span></span>
      <span class="track-replay-span">时段 {{ spanText }}</span>
    </div>
    <div v-if="alarmText" class="track-replay-alarm-note">
      <span class="inline-icon" v-html="U.icon('flag')"></span>
      告警时刻落在本段轨迹内：{{ alarmText }}
    </div>
    <div class="track-replay-note">回放的是该目标最新一条轨迹的实测点，不是视频，也不是飞行计划航线。</div>
    <UFormFooter hide-cancel confirm-text="关闭" @confirm="close" />
  </div>
</template>

<style scoped>
.track-replay { display: flex; flex-direction: column; min-width: 0; }
.track-replay-map {
  position: relative; width: 100%; height: 340px; min-height: 220px;
  border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden;
}
.track-replay-bar { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.track-replay-play { width: 76px; justify-content: center; flex: none; }
.track-replay-slider { position: relative; flex: 1; min-width: 0; padding-top: 2px; }
.track-replay-time { width: 70px; flex: none; text-align: right; font-size: 12px; }
.track-replay-alarm {
  position: absolute; top: 3px; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%;
  background: var(--red); box-shadow: 0 0 0 3px rgba(255, 91, 97, .25); pointer-events: none; z-index: 1;
}
.track-replay-info {
  display: flex; gap: 16px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--txt-2);
}
.track-replay-span { color: var(--txt-3); }
.track-replay-alarm-note {
  display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11.5px; color: #ff8b95;
}
.track-replay-note { margin-top: 6px; font-size: 11.5px; line-height: 1.6; color: var(--txt-3); }
.track-replay :deep(.u-form-footer) { margin-top: 12px; }
.track-replay :deep(.u-field.is-toolbar) { margin: 0; flex: none; }
.track-replay :deep(.u-field.is-toolbar .u-field__control) { min-width: 0; flex: none; }
</style>
