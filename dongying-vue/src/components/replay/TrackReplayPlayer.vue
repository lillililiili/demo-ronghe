<script setup>
/* 轨迹回放播放器：地图 + 光电录像 + 一条共用时间轴（参照飞行记录回放类产品的布局）。
   - 地图：已飞过的轨迹按原有航线关系着色，未飞到的部分画浅灰虚线，当前位置高亮；
   - 录像：画中画叠在地图右下角，可切换并排或收起；按录像采集时刻与轨迹时刻对齐播放；
   - 时间轴：播放/暂停、倍速、拖动定位；标出有录像的时段和告警时刻。
   只读展示，不补点、不平滑；录像只播放已入库并关联到该目标/事项的光电录像。 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { NSlider } from 'naive-ui';
import { hasPermission } from '@/services/accessControl.js';
import { previewEvidenceContent } from '@/services/evidenceApi.js';
import {
  REPLAY_SPEEDS, clockText, compassText, dateText, durationText, indexAt, pctOf, pointReadout, replayTiming,
  videoAt, videosForSpan
} from './trackReplayModel.js';

const U = window.UI;
const KIND = {
  meas: { t: '实测', c: 't-green' },
  bridge: { t: '推算补全', c: 't-orange' },
  pred: { t: '预测', c: 't-cyan' }
};

const props = defineProps({
  points: { type: Array, required: true },
  mapTarget: { type: Object, required: true },
  /** null 表示该处不提供录像；[] 表示查过但没有。项：{ id, no, capturedAt, status } */
  videos: { type: Array, default: null },
  videosLoading: Boolean,
  videoNote: { type: String, default: '' },
  marks: { type: Array, default: () => [] },
  autoplay: Boolean,
  /** 从轨迹末尾开始（证据查看时先看到整条轨迹），此时默认不跟随目标。 */
  startAtEnd: Boolean,
  /** 证据详情：读数里加日期和 WGS-84 坐标。 */
  details: Boolean,
  mapHeight: { type: String, default: 'clamp(300px, 52vh, 460px)' }
});

const timing = computed(() => replayTiming(props.points));
const canReplay = computed(() => timing.value.canReplay);
const start = computed(() => timing.value.start);
const end = computed(() => timing.value.end);
const total = computed(() => props.points.length);

const clock = ref(0);
const manualIndex = ref(0);
const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const playing = ref(false);
const speed = ref(1);
const follow = ref(!props.startAtEnd);
const layout = ref('pip');
const mapHost = ref(null);
const videoEl = ref(null);
const mapError = ref('');
let map = null;
let overlay = null;
let overlayRaf = 0;
let overlayDrawnAt = 0;
let timer = null;
let readyTimer = null;
let lastTick = 0;
let fitted = false;
let disposed = false;

const index = computed(() => canReplay.value ? indexAt(props.points, clock.value) : manualIndex.value);
const readout = computed(() => pointReadout(props.points, index.value));
const current = computed(() => readout.value?.point || props.points[0]);
const kind = computed(() => KIND[current.value?.kind] || KIND.meas);
const shownTime = computed(() => canReplay.value ? clock.value : current.value?.t);
const elapsedMs = computed(() => canReplay.value ? clock.value - start.value : null);
const spanMs = computed(() => canReplay.value ? end.value - start.value : null);
const gap = computed(() => {
  const next = props.points[index.value + 1];
  return canReplay.value && !!next?.break_before && clock.value > current.value.t;
});
const altText = computed(() => Number.isFinite(current.value?.alt) ? `${Math.round(current.value.alt * 10) / 10} m` : '未记录');
const aglText = computed(() => Number.isFinite(current.value?.agl) ? `离地 ${Math.round(current.value.agl * 10) / 10} m` : '');
const speedText = computed(() => Number.isFinite(readout.value?.speed) ? `${readout.value.speed.toFixed(1)} m/s` : '未记录');
const headingText = computed(() => compassText(readout.value?.heading));
const markPcts = computed(() => props.marks
  .filter(mark => canReplay.value && Number.isFinite(mark.t) && mark.t >= start.value && mark.t <= end.value)
  .map(mark => ({ ...mark, pct: pctOf(mark.t, start.value, end.value) })));

/* ---------- 录像 ---------- */
const videoEnabled = computed(() => Array.isArray(props.videos) || props.videosLoading || !!props.videoNote);
const canPreview = hasPermission('evidence:preview');
const spanVideos = computed(() => videosForSpan(props.videos || [], start.value, end.value));
const media = reactive({});
const durations = computed(() => Object.fromEntries(Object.entries(media).map(([id, m]) => [id, m.duration])));
const loadingVideos = computed(() => props.videosLoading || spanVideos.value.some(v => media[v.id]?.state === 'loading'));
const activeVideo = computed(() => canReplay.value ? videoAt(spanVideos.value, clock.value, durations.value) : null);
const activeMedia = computed(() => activeVideo.value ? media[activeVideo.value.id] : null);
const videoBands = computed(() => spanVideos.value.map(video => {
  const seconds = media[video.id]?.duration;
  const from = Math.max(video.capturedAt, start.value);
  const to = Number.isFinite(seconds) ? Math.min(video.capturedAt + seconds * 1000, end.value) : null;
  return {
    video,
    left: pctOf(from, start.value, end.value),
    width: to == null ? 0 : Math.max(0.6, pctOf(to, start.value, end.value) - pctOf(from, start.value, end.value)),
    ready: to != null && to > from
  };
}).filter(band => band.ready));
const nextVideo = computed(() => videoBands.value.map(b => b.video).find(v => v.capturedAt > clock.value) || null);
const videoMessage = computed(() => {
  if (props.videoNote) return props.videoNote;
  if (!canPreview) return '当前账号没有查看录像的权限';
  if (loadingVideos.value && !videoBands.value.length) return '正在读取这段时间的光电录像';
  if (!videoBands.value.length) {
    const failed = spanVideos.value.some(v => media[v.id]?.state === 'error');
    return failed ? '这段时间的录像读取失败，可到证据管理查看' : '这段轨迹时间内没有光电录像';
  }
  if (!activeVideo.value) return '这个时刻没有光电录像';
  return '';
});

async function readDuration(url) {
  return new Promise(resolve => {
    const probe = document.createElement('video');
    probe.preload = 'metadata'; probe.muted = true;
    let settled = false;
    const done = value => {
      if (settled) return; settled = true;
      probe.removeAttribute('src'); probe.load(); resolve(value);
    };
    probe.onloadedmetadata = () => {
      if (Number.isFinite(probe.duration)) return done(probe.duration);
      // 浏览器录制的 WebM 常不写时长：跳到末尾让浏览器算出真实时长。
      probe.ondurationchange = () => { if (Number.isFinite(probe.duration)) done(probe.duration); };
      probe.currentTime = 1e7;
    };
    probe.onerror = () => done(null);
    setTimeout(() => done(null), 15_000);
    probe.src = url;
  });
}

async function loadVideos() {
  if (!canPreview) return;
  for (const video of spanVideos.value) {
    if (disposed) return;
    if (media[video.id]) continue;
    if (video.status && video.status !== 'AVAILABLE') { media[video.id] = { state: 'error' }; continue; }
    media[video.id] = { state: 'loading' };
    try {
      const result = await previewEvidenceContent(video.id);
      if (disposed) return;
      const type = (result.blob.type || '').split(';')[0].toLowerCase();
      if (!['video/mp4', 'video/webm'].includes(type)) throw new Error('unsupported');
      const url = URL.createObjectURL(result.blob);
      const duration = await readDuration(url);
      if (disposed) { URL.revokeObjectURL(url); return; }
      media[video.id] = duration ? { state: 'ready', url, duration } : { state: 'error' };
      if (!duration) URL.revokeObjectURL(url);
    } catch {
      if (!disposed) media[video.id] = { state: 'error' };
    }
  }
}

function syncVideo() {
  const el = videoEl.value;
  const video = activeVideo.value;
  if (!el || !video || !activeMedia.value?.url || el.readyState < 1) return;
  const target = (clock.value - video.capturedAt) / 1000;
  if (playing.value) {
    if (el.playbackRate !== speed.value) el.playbackRate = speed.value;
    if (Math.abs(el.currentTime - target) > Math.max(0.6, speed.value * 0.3)) el.currentTime = target;
    if (el.paused) el.play().catch(() => {});
  } else {
    if (!el.paused) el.pause();
    if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
  }
}

/* ---------- 地图 ---------- */
function hostReady() {
  const el = mapHost.value;
  return !!el && el.clientWidth >= 80 && el.clientHeight >= 80;
}

function paint() {
  if (!map || !current.value) return;
  const point = current.value;
  map.sel = props.mapTarget.id;
  map.setData({
    airspaces: [], devices: [], alarms: [], flightPlans: [],
    targets: [{
      ...props.mapTarget,
      lon: point.lon, lat: point.lat, alt: point.alt,
      heading: readout.value?.heading ?? 0,
      tracked: true,
      track: props.points.slice(0, index.value + 1)
    }]
  });
  if (!fitted) fitCourse();
  else if (follow.value) map.centerAt(point.lon, point.lat);
}

function fitCourse() {
  if (!map || !props.points.length || !hostReady()) return;
  if (typeof map._resize === 'function') map._resize();
  map.fitTo(props.points.map(p => [p.lon, p.lat]), 0.16);
  fitted = true;
  if (follow.value && current.value) map.centerAt(current.value.lon, current.value.lat);
}

/* 未飞到的部分、起终点：画在地图业务层之上的独立透明层，不改公共地图组件。 */
function drawOverlay(now) {
  overlayRaf = requestAnimationFrame(drawOverlay);
  if (!overlay || !map || now - overlayDrawnAt < 60) return;
  overlayDrawnAt = now;
  const box = mapHost.value;
  if (!box) return;
  const dpr = window.devicePixelRatio || 1;
  const w = box.clientWidth, h = box.clientHeight;
  if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
    overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
    overlay.style.width = `${w}px`; overlay.style.height = `${h}px`;
  }
  const c = overlay.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const pts = props.points;
  if (pts.length < 2) return;
  const P = p => map.px(p.lon, p.lat);
  c.save();
  c.setLineDash([5, 5]); c.lineWidth = 2; c.strokeStyle = 'rgba(170, 186, 204, .62)'; c.lineCap = 'round';
  c.beginPath();
  let open = false;
  for (let i = index.value; i < pts.length; i += 1) {
    const [x, y] = P(pts[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { open = false; continue; }
    if (open && !pts[i].break_before) c.lineTo(x, y);
    else c.moveTo(x, y);
    open = true;
  }
  c.stroke();
  c.setLineDash([]);
  const terminal = (p, label, color) => {
    const [x, y] = P(p);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    c.beginPath(); c.arc(x, y, 9, 0, Math.PI * 2);
    c.fillStyle = color; c.fill();
    c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,.9)'; c.stroke();
    c.fillStyle = '#fff'; c.font = '600 10px "PingFang SC", sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, x, y + 0.5);
  };
  terminal(pts[0], '起', '#2f9e6b');
  terminal(pts[pts.length - 1], '终', '#5b6b80');
  props.marks.forEach(mark => {
    if (!Number.isFinite(mark.t)) return;
    const [x, y] = P(pts[indexAt(pts, mark.t)]);
    if (!Number.isFinite(x)) return;
    c.beginPath(); c.arc(x, y, 7, 0, Math.PI * 2);
    c.lineWidth = 2.5; c.strokeStyle = '#ff5b61'; c.stroke();
  });
  c.restore();
}

function mountMap() {
  if (!mapHost.value || !props.points.length) return;
  if (typeof window.MapView !== 'function') { mapError.value = '地图暂不可用，请稍后重新打开'; return; }
  try {
    map = new window.MapView(mapHost.value, {
      zoom: 2.2, maxZoom: 22, legend: false, layers: { device: false, alarm: false, flightPlan: false }
    });
  } catch { mapError.value = '地图未能打开，请稍后重试'; return; }
  overlay = document.createElement('canvas');
  overlay.className = 'replay-course';
  const base = mapHost.value.querySelector('.mapoverlay');
  mapHost.value.insertBefore(overlay, base ? base.nextSibling : null);
  paint();
  const started = Date.now();
  readyTimer = setInterval(() => {
    if (!map) { clearInterval(readyTimer); readyTimer = null; return; }
    if (map.map || map.online || Date.now() - started > 4000) {
      clearInterval(readyTimer); readyTimer = null;
      fitCourse();
    }
  }, 80);
  overlayRaf = requestAnimationFrame(drawOverlay);
}

/* ---------- 播放控制 ---------- */
function seek(time) {
  if (!canReplay.value) return;
  clock.value = Math.max(start.value, Math.min(end.value, time));
}
function scrub(value) { seek(start.value + value); }
function togglePlay() {
  if (!canReplay.value) return;
  if (!playing.value && clock.value >= end.value) seek(start.value);
  lastTick = performance.now();
  playing.value = !playing.value;
}
function restart() { seek(start.value); }
function setSpeed(value) { speed.value = value; }
function step(delta) {
  playing.value = false;
  const next = Math.max(0, Math.min(total.value - 1, index.value + delta));
  if (canReplay.value) seek(props.points[next].t);
  else manualIndex.value = next;
}
function jumpTo(video) { playing.value = false; seek(video.capturedAt); }
function onKey(event) {
  if (event.target.closest('input, textarea, select, .n-slider')) return;
  if (event.key === ' ') { event.preventDefault(); togglePlay(); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); seek(clock.value + 5000); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); seek(clock.value - 5000); }
}
function visibilityChanged() { if (document.hidden) playing.value = false; }

watch(index, paint);
watch(follow, on => { if (on) paint(); else fitCourse(); });
watch(layout, async () => {
  await nextTick();
  if (map && typeof map._resize === 'function') map._resize();
  fitted = false; paint();
});
watch(spanVideos, loadVideos);
watch([activeVideo, playing, speed], () => nextTick(syncVideo));
watch(() => activeMedia.value?.url, () => nextTick(syncVideo));

onMounted(async () => {
  clock.value = props.startAtEnd && canReplay.value ? end.value : (start.value ?? 0);
  manualIndex.value = props.startAtEnd ? Math.max(0, total.value - 1) : 0;
  await nextTick();
  const began = Date.now();
  while (!hostReady() && Date.now() - began < 2000) await new Promise(r => requestAnimationFrame(r));
  if (disposed) return;
  mountMap();
  loadVideos();
  playing.value = props.autoplay && canReplay.value && !reducedMotion;
  lastTick = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    if (playing.value && canReplay.value) {
      seek(clock.value + (now - lastTick) * speed.value);
      if (clock.value >= end.value) playing.value = false;
    }
    lastTick = now;
    syncVideo();
  }, 100);
  document.addEventListener('visibilitychange', visibilityChanged);
});

onBeforeUnmount(() => {
  disposed = true; playing.value = false;
  clearInterval(timer); clearInterval(readyTimer);
  cancelAnimationFrame(overlayRaf);
  document.removeEventListener('visibilitychange', visibilityChanged);
  if (videoEl.value) { videoEl.value.pause(); videoEl.value.removeAttribute('src'); videoEl.value.load(); }
  Object.values(media).forEach(m => m.url && URL.revokeObjectURL(m.url));
  if (map) { map.destroy(); map = null; }
  overlay = null;
});

defineExpose({ seek, togglePlay });
</script>

<template>
  <section class="replay-player" :class="[`is-${layout}`, { 'has-video': videoEnabled }]" tabindex="0"
    aria-label="轨迹回放" @keydown="onKey">
    <div class="replay-stage">
      <div class="replay-map-wrap" :style="{ height: mapHeight }">
        <div ref="mapHost" class="replay-map" aria-label="回放地图" />
        <p v-if="mapError" class="replay-map-error" role="alert">{{ mapError }}</p>

        <dl class="replay-hud" aria-label="当前点读数">
          <div class="hud-time"><dt>时间</dt><dd class="mono">{{ clockText(shownTime) }}</dd></div>
          <div v-if="details"><dt>日期</dt><dd class="mono">{{ dateText(shownTime) }}</dd></div>
          <div><dt>高度</dt><dd class="mono">{{ altText }}<small v-if="aglText"> {{ aglText }}</small></dd></div>
          <div><dt>速度</dt><dd class="mono" :title="readout?.speedDerived ? '按相邻两个观测点的距离和时间推算' : ''">
            {{ speedText }}<small v-if="readout?.speedDerived"> 推算</small></dd></div>
          <div><dt>方向</dt><dd class="mono">{{ headingText }}</dd></div>
          <div v-if="details"><dt>位置</dt><dd class="mono">{{ current.lon.toFixed(6) }}, {{ current.lat.toFixed(6) }}</dd></div>
          <div><dt>点类型</dt><dd><span class="tag" :class="kind.c">{{ kind.t }}</span></dd></div>
        </dl>
        <p v-if="gap" class="replay-gap" role="status">此时段轨迹中断，地图停在最后一次观测位置</p>

        <div v-if="videoEnabled && layout === 'pip'" class="replay-video is-pip">
          <video v-if="activeMedia?.url" ref="videoEl" :src="activeMedia.url" muted playsinline preload="auto"
            aria-label="光电录像" @loadedmetadata="syncVideo" />
          <div v-else class="replay-video-empty" role="status">
            <span class="inline-icon" v-html="U.icon('video')"></span>
            <span>{{ videoMessage }}</span>
            <button v-if="nextVideo && canReplay" type="button" class="btn ghost small" @click="jumpTo(nextVideo)">
              跳到 {{ clockText(nextVideo.capturedAt) }} 的录像</button>
          </div>
          <div class="replay-video-bar">
            <span class="replay-video-label">{{ activeVideo ? `光电录像 ${activeVideo.no || ''}` : '光电录像' }}</span>
            <button type="button" class="vbtn" title="录像和地图并排显示" @click="layout = 'side'" v-html="U.icon('expand')"></button>
            <button type="button" class="vbtn" title="收起录像" @click="layout = 'hidden'">✕</button>
          </div>
        </div>
        <button v-if="videoEnabled && layout === 'hidden'" type="button" class="btn replay-video-show" @click="layout = 'pip'">
          <span class="inline-icon" v-html="U.icon('video')"></span> 显示录像<b v-if="videoBands.length">（{{ videoBands.length }} 段）</b>
        </button>
      </div>

      <div v-if="videoEnabled && layout === 'side'" class="replay-video is-side" :style="{ height: mapHeight }">
        <video v-if="activeMedia?.url" ref="videoEl" :src="activeMedia.url" muted playsinline preload="auto"
          aria-label="光电录像" @loadedmetadata="syncVideo" />
        <div v-else class="replay-video-empty" role="status">
          <span class="inline-icon" v-html="U.icon('video')"></span>
          <span>{{ videoMessage }}</span>
          <button v-if="nextVideo && canReplay" type="button" class="btn ghost small" @click="jumpTo(nextVideo)">
            跳到 {{ clockText(nextVideo.capturedAt) }} 的录像</button>
        </div>
        <div class="replay-video-bar">
          <span class="replay-video-label">{{ activeVideo ? `光电录像 ${activeVideo.no || ''} · 采集 ${clockText(activeVideo.capturedAt)}` : '光电录像' }}</span>
          <button type="button" class="vbtn" title="缩小为画中画" @click="layout = 'pip'">画中画</button>
          <button type="button" class="vbtn" title="收起录像" @click="layout = 'hidden'">✕</button>
        </div>
      </div>
    </div>

    <div class="replay-transport">
      <button type="button" class="btn pri replay-play" :disabled="!canReplay" :title="playing ? '暂停（空格）' : '播放（空格）'"
        @click="togglePlay"><span class="inline-icon" v-html="U.icon(playing ? 'pause' : 'play')"></span>
        {{ playing ? '暂停' : canReplay && clock >= end ? '从头播放' : '播放' }}</button>
      <button type="button" class="btn ghost" :disabled="!canReplay" title="回到开头" @click="restart">回到开头</button>
      <div class="replay-speeds" role="group" aria-label="播放速度">
        <button v-for="s in REPLAY_SPEEDS" :key="s" type="button" class="speed" :class="{ on: speed === s }"
          :disabled="!canReplay" :aria-pressed="speed === s" @click="setSpeed(s)">{{ s }}×</button>
      </div>
      <span class="replay-clock mono">
        <template v-if="canReplay">{{ durationText(elapsedMs) }} / {{ durationText(spanMs) }}</template>
        <template v-else>第 {{ index + 1 }} / {{ total }} 点</template>
      </span>
      <button type="button" class="btn ghost" :disabled="index <= 0" title="上一个观测点" @click="step(-1)">上一点</button>
      <button type="button" class="btn ghost" :disabled="index >= total - 1" title="下一个观测点" @click="step(1)">下一点</button>
      <label class="replay-follow"><input v-model="follow" type="checkbox"> 跟随目标</label>
    </div>

    <div v-if="canReplay" class="replay-timeline">
      <div v-if="videoEnabled || markPcts.length" class="replay-lanes" aria-hidden="true">
        <button v-for="band in videoBands" :key="band.video.id" type="button" class="lane-video"
          :class="{ on: activeVideo?.id === band.video.id }"
          :style="{ left: band.left + '%', width: band.width + '%' }"
          :title="`光电录像 ${band.video.no || ''} ${clockText(band.video.capturedAt)} 开始`" tabindex="-1"
          @click="jumpTo(band.video)"></button>
        <span v-for="(mark, i) in markPcts" :key="'m' + i" class="lane-mark" :style="{ left: mark.pct + '%' }"
          :title="mark.title"></span>
      </div>
      <NSlider :value="clock - start" :min="0" :max="spanMs" :step="100" :tooltip="false"
        aria-label="回放时间，可拖动定位" @update:value="scrub" />
      <div class="replay-ticks">
        <span>{{ clockText(start) }}</span>
        <b class="mono">{{ clockText(clock) }}</b>
        <span>{{ clockText(end) }}</span>
      </div>
      <div class="replay-key">
        <span><i class="k-pass"></i>已飞过（绿 符合航线 · 红 偏离 · 黄 关系未知）</span>
        <span><i class="k-rest"></i>未飞到</span>
        <span v-if="videoEnabled"><i class="k-video"></i>有录像的时段</span>
        <span v-if="markPcts.length"><i class="k-mark"></i>告警时刻</span>
        <span class="replay-hint">空格 播放/暂停 · ←/→ 跳 5 秒</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.replay-player { display: flex; flex-direction: column; gap: 10px; min-width: 0; outline: none; }
.replay-stage { display: flex; gap: 10px; min-width: 0; }
.replay-map-wrap { position: relative; flex: 1 1 auto; min-width: 0; min-height: 240px;
  border: 1px solid var(--line-2); border-radius: 8px; overflow: hidden; }
.replay-map { position: absolute; inset: 0; }
.replay-map :deep(canvas.replay-course) { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 1; }
.replay-map-error { position: absolute; inset: auto 12px 12px; margin: 0; padding: 8px 10px; font-size: 12px;
  color: var(--orange, #ffb020); background: rgba(10, 16, 26, .82); border-radius: 6px; z-index: 3; }

.replay-hud { position: absolute; left: 54px; top: 10px; z-index: 3; margin: 0; display: grid;
  grid-template-columns: auto auto; gap: 4px 12px; padding: 9px 12px; min-width: 176px;
  background: rgba(8, 14, 24, .78); border: 1px solid rgba(255, 255, 255, .08); border-radius: 8px;
  backdrop-filter: blur(4px); font-size: 12px; pointer-events: none; }
.replay-hud > div { display: contents; }
.replay-hud dt { color: rgba(214, 224, 236, .62); }
.replay-hud dd { margin: 0; color: #eef3f8; text-align: right; white-space: nowrap; }
.replay-hud dd small { color: rgba(214, 224, 236, .6); font-size: 10.5px; }
.replay-hud .hud-time dd { font-size: 15px; font-weight: 600; color: #fff; }
.replay-hud .tag { pointer-events: none; }
.replay-gap { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); z-index: 3; margin: 0;
  padding: 6px 10px; font-size: 12px; color: #ffcf70; background: rgba(8, 14, 24, .82); border-radius: 6px; }

.replay-video { display: flex; flex-direction: column; background: #05080d; overflow: hidden; }
.replay-video.is-pip { position: absolute; right: 10px; bottom: 10px; z-index: 4; width: min(36%, 300px);
  aspect-ratio: 16 / 10; border: 1px solid rgba(255, 255, 255, .16); border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .45); }
.replay-video.is-side { flex: 1 1 0; min-width: 0; border: 1px solid var(--line-2); border-radius: 8px; }
.replay-video video { flex: 1 1 auto; min-height: 0; width: 100%; object-fit: contain; background: #000; display: block; }
.replay-video-empty { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 8px; padding: 10px; text-align: center; font-size: 12px; line-height: 1.6;
  color: rgba(214, 224, 236, .72); }
.replay-video-empty .inline-icon { opacity: .55; transform: scale(1.4); }
.replay-video-bar { display: flex; align-items: center; gap: 6px; padding: 4px 6px 4px 10px;
  background: rgba(12, 20, 32, .95); font-size: 11.5px; color: rgba(225, 233, 242, .85); }
.replay-video-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vbtn { flex: none; border: 0; background: transparent; color: inherit; cursor: pointer; padding: 3px 6px;
  border-radius: 4px; font-size: 11.5px; line-height: 1; display: inline-flex; align-items: center; }
.vbtn:hover { background: rgba(255, 255, 255, .1); }
.vbtn :deep(svg) { width: 13px; height: 13px; }
.replay-video-show { position: absolute; right: 10px; bottom: 10px; z-index: 4; }

.replay-transport { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.replay-play { min-width: 96px; justify-content: center; }
.replay-speeds { display: inline-flex; border: 1px solid var(--line-2); border-radius: 6px; overflow: hidden; }
.replay-speeds .speed { border: 0; background: transparent; color: var(--txt-2); padding: 5px 9px; cursor: pointer;
  font-size: 12px; font-variant-numeric: tabular-nums; }
.replay-speeds .speed + .speed { border-left: 1px solid var(--line-2); }
.replay-speeds .speed.on { background: var(--cyan, #22d3ee); color: #04131a; font-weight: 600; }
.replay-speeds .speed:disabled { opacity: .45; cursor: default; }
.replay-clock { margin-left: auto; font-size: 13px; color: var(--txt); }
.replay-follow { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--txt-2); cursor: pointer; }

.replay-timeline { min-width: 0; padding: 0 6px; }
.replay-lanes { position: relative; height: 8px; margin: 0 0 2px; border-radius: 4px; background: rgba(140, 160, 190, .14); }
.lane-video { position: absolute; top: 0; height: 8px; padding: 0; border: 0; border-radius: 4px; cursor: pointer;
  background: rgba(34, 211, 238, .55); }
.lane-video.on { background: rgba(34, 211, 238, .95); }
.lane-mark { position: absolute; top: -1px; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%;
  background: var(--red, #ff5b61); box-shadow: 0 0 0 3px rgba(255, 91, 97, .25); pointer-events: auto; }
.replay-ticks { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; color: var(--txt-3); }
.replay-ticks b { color: var(--txt); font-weight: 600; }
.replay-key { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; font-size: 11.5px; color: var(--txt-3); }
.replay-key span { display: inline-flex; align-items: center; gap: 5px; }
.replay-key i { display: inline-block; width: 16px; height: 0; border-top: 3px solid; }
.replay-key .k-pass { border-image: linear-gradient(90deg, #2fd06e 33%, #ff4d5e 33% 66%, #ffb020 66%) 1; }
.replay-key .k-rest { border-top: 2px dashed rgba(170, 186, 204, .8); }
.replay-key .k-video { height: 6px; border: 0; border-radius: 3px; background: rgba(34, 211, 238, .7); }
.replay-key .k-mark { width: 8px; height: 8px; border: 0; border-radius: 50%; background: var(--red, #ff5b61); }
.replay-hint { margin-left: auto; }

@media (max-width: 760px) {
  .replay-stage { flex-direction: column; }
  .replay-video.is-side { flex: none; }
  .replay-video.is-pip { width: 46%; }
  .replay-hint { display: none; }
}
</style>
