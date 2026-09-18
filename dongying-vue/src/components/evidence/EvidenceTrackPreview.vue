<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NSlider } from 'naive-ui';
import { prepareEvidenceTrack, trackSnapshotRows } from '@/services/evidenceTrackData.js';
import { fmtEvidenceTime } from '@/ui/evidenceFileDetail.js';
import { SOURCE_MODE_LABEL, labelOf, targetTypeLabel } from '@/ui/labels.js';

const props = defineProps({
  snapshot: { type: Object, required: true },
  file: { type: Object, default: null },
  details: { type: Boolean, default: false },
});
const model = computed(() => prepareEvidenceTrack(trackSnapshotRows(props.snapshot)));
const points = computed(() => model.value.points);
const firstTime = computed(() => points.value[0]?.t ?? 0);
const duration = computed(() => model.value.canReplay ? (points.value.at(-1).t - firstTime.value) / 1000 : 0);
const elapsed = ref(0);
const pointIndex = ref(0);
const playing = ref(false);
const speed = ref(1);
const mapHost = ref(null);
const mapError = ref('');
let map;
let timer;
let fitTimer;
let lastTick = 0;
let disposed = false;
let mounted = false;
const current = computed(() => points.value[pointIndex.value]);
const currentTime = computed(() => firstTime.value + elapsed.value * 1000);
const gap = computed(() => model.value.canReplay && points.value[pointIndex.value + 1]?.break_before
  && currentTime.value > current.value.t);
const sourceMode = computed(() => props.file?.source_mode || props.snapshot.source_mode);
const partial = computed(() => Number(props.snapshot.points?.total) > trackSnapshotRows(props.snapshot).length);
const sourceNote = computed(() => props.snapshot.simulated === true || props.snapshot.demo === true
  ? (props.details ? '模拟轨迹，不代表现场采集证据' : '模拟轨迹')
  : labelOf(SOURCE_MODE_LABEL, sourceMode.value, '来源未记录'));
const relationText = computed(() => ({ WITHIN: '符合规划', OUTSIDE: '偏离规划', UNKNOWN: '航线关系未知', BOUNDARY: '航线边界关系待确认' }[current.value?.corridor_relation] || '航线关系未知'));
const timeLabel = value => fmtEvidenceTime(value);
const rawText = computed(() => JSON.stringify(props.snapshot, null, 2));

function paint() {
  if (!map || !current.value) return;
  const point = current.value;
  const targetId = props.snapshot.target?.target_no || '当前观测点';
  map.sel = targetId;
  const target = props.snapshot.target;
  map.setData({ targets: [{ id: targetId, sourceMode: sourceMode.value || '',
    type: targetTypeLabel(null, target?.object_type_code, '目标'),
    subtype: targetTypeLabel(target?.subtype, target?.object_type_code, '目标'),
    lon: point.lon, lat: point.lat, alt: point.alt, speed: point.speed, heading: point.heading,
    tracked: true, track: points.value.slice(0, pointIndex.value + 1) }] });
}
function fit() {
  if (!map || !points.value.length) return;
  map._resize();
  map.fitTo(points.value.map(point => [point.lon, point.lat]), .16);
}
function seek(seconds) {
  elapsed.value = Math.max(0, Math.min(duration.value, seconds));
  const time = currentTime.value;
  let low = 0, high = points.value.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points.value[mid].t <= time) low = mid;
    else high = mid - 1;
  }
  pointIndex.value = low;
}
function scrub(value) { playing.value = false; seek(value); }
function step(delta) {
  playing.value = false;
  pointIndex.value = Math.max(0, Math.min(points.value.length - 1, pointIndex.value + delta));
  if (model.value.canReplay) elapsed.value = (current.value.t - firstTime.value) / 1000;
}
function togglePlay() {
  if (!model.value.canReplay) return;
  if (!playing.value && elapsed.value >= duration.value) seek(0);
  lastTick = performance.now();
  playing.value = !playing.value;
}
function cycleSpeed() { speed.value = speed.value === 8 ? 1 : speed.value * 2; }
function visibilityChanged() { if (document.hidden) playing.value = false; }
function reconcileMap() {
  clearTimeout(fitTimer);
  if (map && (map.box !== mapHost.value || !points.value.length)) { map.destroy(); map = null; }
  if (disposed || !mounted || !mapHost.value || !points.value.length) return;
  mapError.value = '';
  if (typeof window.MapView !== 'function') { mapError.value = '地图暂不可用，请稍后重新打开'; return; }
  try {
    if (!map) map = new window.MapView(mapHost.value, { legend: false, maxZoom: 22,
      layers: { device: false, alarm: false, flightPlan: false } });
    paint(); fit();
    fitTimer = setTimeout(fit, 350);
  } catch { mapError.value = '地图未能打开，请稍后重试'; }
}
watch(pointIndex, paint);
watch(() => props.snapshot, async () => {
  playing.value = false;
  pointIndex.value = Math.max(0, points.value.length - 1);
  elapsed.value = duration.value;
  await nextTick();
  reconcileMap();
}, { immediate: true });
onMounted(async () => {
  mounted = true;
  await nextTick();
  if (disposed) return;
  reconcileMap();
  timer = setInterval(() => {
    const now = performance.now();
    if (playing.value) {
      seek(elapsed.value + (now - lastTick) / 1000 * speed.value);
      if (elapsed.value >= duration.value) playing.value = false;
    }
    lastTick = now;
  }, 100);
  document.addEventListener('visibilitychange', visibilityChanged);
});
onBeforeUnmount(() => {
  disposed = true; playing.value = false;
  clearInterval(timer); clearTimeout(fitTimer);
  document.removeEventListener('visibilitychange', visibilityChanged);
  map?.destroy(); map = null;
});
</script>

<template>
  <section class="evidence-track-preview" aria-label="轨迹证据回放">
    <div class="track-summary">
      <b>轨迹回放 <span v-if="details">{{ points.length }} 点</span></b>
      <span class="tag t-gray">{{ sourceNote }}</span>
    </div>
    <p v-if="!points.length" class="track-notice" role="status">没有可用的观测位置，无法显示轨迹。</p>
    <template v-else>
      <div ref="mapHost" class="evidence-track-map" aria-label="观测轨迹地图" />
      <p v-if="mapError" class="track-notice" role="alert">{{ mapError }}</p>
      <div v-if="details || model.canReplay || points.length > 1" class="track-controls">
        <button v-if="details || model.canReplay" class="btn pri" type="button" :disabled="!model.canReplay" @click="togglePlay">{{ playing ? '暂停' : elapsed >= duration && model.canReplay ? '从头回放' : '播放' }}</button>
        <button v-if="details || model.canReplay" class="btn" type="button" :disabled="!model.canReplay" @click="cycleSpeed">{{ speed }} 倍速</button>
        <template v-if="details || !model.canReplay && points.length > 1">
          <button class="btn" type="button" :disabled="pointIndex === 0" @click="step(-1)">上一点</button>
          <button class="btn" type="button" :disabled="pointIndex >= points.length - 1" @click="step(1)">下一点</button>
          <span>观测点 {{ pointIndex + 1 }} / {{ points.length }}</span>
        </template>
        <span v-if="!details && model.canReplay" class="track-current-time">{{ timeLabel(currentTime) }}</span>
      </div>
      <div v-if="model.canReplay" class="track-timeline">
        <NSlider :value="elapsed" :min="0" :max="duration" :step="0.001" :tooltip="false" aria-label="轨迹回放时间" @update:value="scrub" />
        <div v-if="details" class="track-time-labels"><span>{{ timeLabel(firstTime) }}</span><b>{{ timeLabel(currentTime) }}</b><span>{{ timeLabel(points.at(-1).t) }}</span></div>
      </div>
      <p v-if="gap" class="track-notice" role="status">此时段轨迹中断，地图停留在最后一次观测位置。</p>
      <dl v-if="details" class="track-point-facts">
        <div><dt>观测时间</dt><dd>{{ timeLabel(current.t) }}</dd></div>
        <div><dt>观测位置（WGS84）</dt><dd>{{ current.lon }}，{{ current.lat }}</dd></div>
        <div><dt>海拔高度</dt><dd>{{ current.alt == null ? '未记录' : `${current.alt} 米` }}</dd></div>
        <div><dt>观测速度</dt><dd>{{ current.speed == null ? '未记录' : `${current.speed} 米/秒` }}</dd></div>
        <div><dt>点类型</dt><dd>{{ { meas: '观测点', pred: '预测点', bridge: '推算补全点' }[current.kind] || '类型未记录' }}</dd></div>
        <div><dt>航线比对</dt><dd>{{ relationText }}</dd></div>
      </dl>
      <div class="track-legend"><span class="within">绿色：符合规划</span><span class="outside">红色：偏离规划</span><span class="unknown">黄色：关系未知</span></div>
      <p v-if="details" class="track-description">按原始观测点展示，不补点、不平滑；没有匹配航线依据的点显示为关系未知。</p>
      <p v-if="model.timingIncomplete" class="track-notice">观测时间缺失或顺序异常，仅支持逐点查看。</p>
      <p v-else-if="points.length === 1" class="track-notice">仅有一个观测位置，无法回放。</p>
      <p v-if="model.rejected || model.breaks || partial" class="track-notice">{{ model.rejected ? `${model.rejected} 个位置无效，未绘制。` : '' }}{{ model.breaks ? `轨迹有 ${model.breaks} 处中断。` : '' }}{{ partial ? '仅包含部分轨迹。' : '' }}</p>
    </template>
    <p v-if="details && snapshot.note" class="track-description">{{ snapshot.note }}</p>
    <details v-if="details && file" class="track-original"><summary>查看轨迹原始数据</summary><pre>{{ rawText }}</pre></details>
  </section>
</template>

<style scoped>
.evidence-track-preview { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.track-summary, .track-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.track-controls > span { margin-left: auto; }
.track-summary b { font-size: 15px; }.track-summary b span { color: var(--cyan); margin-left: 8px; }
.evidence-track-map { position: relative; height: clamp(240px, 38vh, 420px); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.track-controls, .track-time-labels { font-size: 12px; color: var(--txt-2); }
.track-current-time { color: var(--txt); font-variant-numeric: tabular-nums; }
.track-time-labels { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.track-time-labels b { color: var(--txt); }.track-timeline { min-width: 0; padding: 0 5px; }
.track-point-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 12px; background: var(--panel, rgba(0,0,0,.15)); border: 1px solid var(--line); border-radius: 8px; font-size: 12px; }
.track-point-facts dt { color: var(--txt-3); }.track-point-facts dd { margin: 4px 0 0; overflow-wrap: anywhere; color: var(--txt); }
.track-notice, .track-description { font-size: 12px; line-height: 1.7; margin: 0; overflow-wrap: anywhere; }
.track-notice { color: var(--orange, #ffb020); padding: 10px; border: 1px solid var(--line); border-radius: 6px; }
.track-description { color: var(--txt-3); }.track-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 12px; }
.within { color: #2fd06e; }.outside { color: #ff4d5e; }.unknown { color: #ffb020; }
.track-original summary { cursor: pointer; font-size: 12px; color: var(--txt-2); padding: 8px 0; }
.track-original pre { max-height: 280px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 monospace; }
@media (max-width: 720px) { .track-point-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
