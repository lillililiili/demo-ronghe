<script setup>
/* 融合感知「民航航班」图层（2026-10-26 用户确认的设计）。
   航班来自后台登记的 ADS-B 航班接收机，每 5 秒取一次。
   - 飞进反制设备「禁止反制范围」的航班标红，进「提醒范围」的标橙；高于规则高度的航班不算，显示为灰色。
   - 点开反制设备时在它周围画出两个范围圈。单独设置过距离的反制设备按它自己的数字画、按它自己的数字着色。
   - 鼠标停在飞机上显示航班号、高度、离反制设备多远、是否靠近。
   - 进了提醒或禁止范围的航班画飞行线：已经飞过的一段是暗虚线（本页收到的最近 10 分钟位置），前方两分钟要飞到的一段是亮虚线。
   地图上的颜色只作提示，能不能反制以反制弹窗里服务端的检查为准。 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { flightAvoidanceApi } from '@/services/flightAvoidanceApi.js';

const props = defineProps({
  visible: { type: Boolean, default: true },
  counterDevices: { type: Array, default: () => [] },
  selectedCounterId: { type: String, default: '' }
});

const POLL_MS = 5000;
const STALE_MS = 30000;
const TRAIL_MS = 10 * 60000;
const AHEAD_S = 120;
const COLOR = { BLOCK: '#ff6b7a', WARN: '#ffa940', HIGH: '#6b7890', NONE: '#8fb3d9' };
const traffic = ref(null);
const planes = ref([]);
const hover = ref(null);
/** 每架航班本页收到过的位置（后台只保留最新一点，飞过的线由页面自己记）。 */
const trails = new Map();
let timer = 0, lastMap = null, stopped = false;

async function load() {
  if (document.hidden) return;
  try {
    traffic.value = await flightAvoidanceApi.traffic();
    remember(traffic.value?.aircraft || []);
  } catch (error) {
    // 没有权限或后台还没有这项功能时不显示图层，不打扰值班人员。
    if (error?.status === 403 || error?.status === 404) traffic.value = null;
  }
  lastMap?.draw();
}

function remember(aircraft) {
  const now = Date.now();
  aircraft.forEach(a => {
    const points = trails.get(a.icao24) || [];
    const last = points[points.length - 1];
    const observedAt = Number(a.observed_at) || now;
    if (!last || last.observedAt < observedAt) points.push({ lon: a.longitude, lat: a.latitude, observedAt });
    trails.set(a.icao24, points.filter(point => now - point.observedAt <= TRAIL_MS));
  });
  for (const [icao24, points] of trails) if (!points.length || now - points[points.length - 1].observedAt > TRAIL_MS) trails.delete(icao24);
}

/** 按当前航向和速度，往前推 AHEAD_S 秒到的位置。 */
function ahead(a) {
  if (!Number.isFinite(a.track_deg) || !(a.ground_speed_mps > 0)) return null;
  const rad = Math.PI / 180, km = a.ground_speed_mps * AHEAD_S / 1000;
  return [a.longitude + km * Math.sin(a.track_deg * rad) / (111.32 * Math.cos(a.latitude * rad)), a.latitude + km * Math.cos(a.track_deg * rad) / 111.32];
}

function polyline(c, map, points, color, dash, width) {
  if (points.length < 2) return;
  c.beginPath();
  points.forEach(([lon, lat], i) => { const [x, y] = map.px(lon, lat); i ? c.lineTo(x, y) : c.moveTo(x, y); });
  c.setLineDash(dash); c.lineWidth = width; c.strokeStyle = color; c.stroke(); c.setLineDash([]);
}

/** 飞行线：飞过的一段暗一些，前方要飞的一段亮一些，颜色跟飞机一样。 */
function drawTrail(c, map, a, color) {
  const past = (trails.get(a.icao24) || []).map(point => [point.lon, point.lat]);
  past.push([a.longitude, a.latitude]);
  c.save();
  c.globalAlpha = .55;
  polyline(c, map, past, color, [4, 4], 2);
  c.globalAlpha = 1;
  const next = ahead(a);
  if (next) polyline(c, map, [[a.longitude, a.latitude], next], color, [2, 5], 1.5);
  c.restore();
}

onMounted(() => {
  load();
  timer = window.setInterval(() => { if (!stopped) load(); }, POLL_MS);
});
onUnmounted(() => { stopped = true; window.clearInterval(timer); });

const receivers = computed(() => traffic.value?.receivers || []);
const freshAircraft = computed(() => {
  const servedAt = Number(traffic.value?.served_at) || Date.now();
  return (traffic.value?.aircraft || []).filter(a => servedAt - Number(a.observed_at) <= STALE_MS);
});

/** 左侧感知设备里的「ADS-B 航班接收机」一行。 */
const summary = computed(() => ({
  receivers: receivers.value.length,
  online: receivers.value.filter(r => r.online).length,
  offline: receivers.value.filter(r => !r.online).length,
  aircraft: freshAircraft.value.length
}));

function distanceKm(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function approaching(a, device) {
  if (!Number.isFinite(a.track_deg) || !(a.ground_speed_mps > 0)) return false;
  const rad = Math.PI / 180;
  const toward = Math.atan2((device.lon - a.longitude) * Math.cos(a.latitude * rad), device.lat - a.latitude);
  return Math.cos(toward - a.track_deg * rad) > 0.2;
}

/** 这台反制设备用的距离：单独设置过的用自己的，否则用规则管理里的默认值。 */
function policyFor(device) {
  return (traffic.value?.device_distances || []).find(item => item.device_id === (device.deviceId || device.id)) || traffic.value?.policy || null;
}

const ZONE_RANK = { BLOCK: 3, WARN: 2, NONE: 1, HIGH: 0 };

/** 每架航班对各台反制设备在哪个范围（按迫降的距离，迫降的范围最大），取最严重的；一样时取最近的设备。 */
function zoneOf(a) {
  let best = null, nearest = null;
  props.counterDevices.forEach(device => {
    const km = distanceKm(device.lon, device.lat, a.longitude, a.latitude);
    if (!nearest || km < nearest.km) nearest = { km, device };
    const p = policyFor(device);
    if (!p) return;
    const zone = a.altitude_m != null && a.altitude_m > p.force_land_max_altitude_m ? 'HIGH'
      : km <= p.force_land_block_km ? 'BLOCK' : km <= p.force_land_warn_km ? 'WARN' : 'NONE';
    if (!best || ZONE_RANK[zone] > ZONE_RANK[best.zone] || ZONE_RANK[zone] === ZONE_RANK[best.zone] && km < best.km) best = { zone, km, device };
  });
  if (!best) return { zone: 'NONE', nearest };
  return { zone: best.zone, nearest: best.zone === 'BLOCK' || best.zone === 'WARN' ? { km: best.km, device: best.device } : nearest };
}

function circle(c, map, device, km, color, dash, fill) {
  const [x, y] = map.px(device.lon, device.lat);
  const r = map._metersToPx(km * 1000, device.lat);
  if (!(r > 0)) return;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = fill; c.fill();
  c.setLineDash(dash); c.lineWidth = dash.length ? 1.5 : 2; c.strokeStyle = color; c.stroke(); c.setLineDash([]);
  return [x, y, r];
}

function label(c, x, y, text, color) {
  c.font = '12px "Noto Sans SC"'; c.textAlign = 'left'; c.textBaseline = 'bottom';
  c.lineWidth = 3; c.strokeStyle = '#08122a'; c.strokeText(text, x, y);
  c.fillStyle = color; c.fillText(text, x, y);
}

// 复用宿主 MapView 的绘制周期：范围圈画在画布上，飞机用页面元素，便于鼠标悬停。
function draw(map) {
  lastMap = map;
  if (!props.visible || !map?.w || !traffic.value) { if (planes.value.length) planes.value = []; return; }
  const selected = props.counterDevices.find(device => device.id === props.selectedCounterId);
  const p = selected ? policyFor(selected) : null;
  if (selected && p) {
    const c = map.ctx;
    c.save();
    const warn = circle(c, map, selected, Number(p.force_land_warn_km), '#fa8c16', [8, 5], 'rgba(250,140,22,.06)');
    const block = circle(c, map, selected, Number(p.force_land_block_km), '#f0384b', [], 'rgba(240,56,75,.10)');
    if (warn) label(c, warn[0] + warn[2] * .71 - 60, warn[1] - warn[2] * .71 - 6, `提醒范围 ${Number(p.force_land_warn_km)} 公里`, '#ffb366');
    if (block) label(c, block[0] + block[2] * .71 - 10, block[1] - block[2] * .71 - 6, `禁止反制范围 ${Number(p.force_land_block_km)} 公里`, '#ff8a95');
    c.restore();
  }
  const next = freshAircraft.value.flatMap(a => {
    const [x, y] = map.px(a.longitude, a.latitude);
    const { zone, nearest } = zoneOf(a);
    if (zone === 'WARN' || zone === 'BLOCK') drawTrail(map.ctx, map, a, COLOR[zone]);
    if (!(x > -20 && y > -20 && x < map.w + 20 && y < map.h + 20)) return [];
    return [{ id: a.icao24, x: Math.round(x), y: Math.round(y), heading: Number(a.track_deg) || 0, color: COLOR[zone], zone,
      name: a.callsign || a.icao24, airline: a.airline || '', altitude: a.altitude_m,
      km: nearest ? nearest.km : null, approaching: nearest ? approaching(a, nearest.device) : false }];
  });
  if (JSON.stringify(next) !== JSON.stringify(planes.value)) planes.value = next;
}

function kmText(km) {
  return km >= 10 ? Math.round(km) : Math.round(km * 10) / 10;
}

const ZONE_TEXT = { BLOCK: '在禁止反制范围内', WARN: '在提醒范围内', HIGH: '飞得高，不影响反制' };
defineExpose({ draw, summary });
</script>

<template>
  <div v-if="visible && planes.length" class="flight-traffic" aria-label="民航航班">
    <span v-for="plane in planes" :key="plane.id" class="flight-plane" :class="`is-${plane.zone.toLowerCase()}`"
      :style="{ left: `${plane.x}px`, top: `${plane.y}px`, color: plane.color }"
      @mouseenter="hover = plane" @mouseleave="hover = null">
      <svg viewBox="-10 -10 20 20" :style="{ transform: `rotate(${plane.heading}deg)` }" aria-hidden="true">
        <path d="M0,-9 L2,-3 L9,1 L9,3 L2,1 L1.5,6 L4,8 L4,9.5 L0,8.5 L-4,9.5 L-4,8 L-1.5,6 L-2,1 L-9,3 L-9,1 L-2,-3Z" fill="currentColor" stroke="#0a1530" stroke-width=".6" />
      </svg>
      <b v-if="plane.zone !== 'HIGH'">{{ plane.name }}</b>
    </span>
    <div v-if="hover" class="flight-tip" :style="{ left: `${hover.x}px`, top: `${hover.y}px`, borderColor: hover.color }">
      <b :style="{ color: hover.zone === 'NONE' || hover.zone === 'HIGH' ? 'var(--txt)' : hover.color }">{{ hover.name }} {{ hover.airline }}</b>
      <span>{{ hover.altitude == null ? '高度不明' : `高度 ${hover.altitude} 米` }}</span>
      <span v-if="hover.km != null">距反制设备 <strong>{{ kmText(hover.km) }} 公里</strong>，{{ hover.approaching ? '正在靠近' : '正在飞远' }}</span>
      <span v-if="ZONE_TEXT[hover.zone]" :style="{ color: hover.zone === 'HIGH' ? 'var(--txt-3)' : hover.color }">{{ ZONE_TEXT[hover.zone] }}</span>
    </div>
  </div>
</template>

<style scoped>
.flight-traffic { position:absolute; inset:0; pointer-events:none; z-index:3; overflow:hidden; }
.flight-plane { position:absolute; display:flex; align-items:center; gap:3px; transform:translate(-12px,-12px); pointer-events:auto; cursor:default; }
.flight-plane svg { width:24px; height:24px; flex:none; }
.flight-plane b { font-size:12px; font-weight:500; white-space:nowrap; text-shadow:0 0 3px #08122a, 0 0 2px #08122a, 0 0 1px #08122a; }
.flight-plane.is-none b { color:#a9c3e6; }
.flight-plane.is-high { opacity:.7; }
.flight-tip { position:absolute; z-index:1; transform:translate(-50%, 18px); display:flex; flex-direction:column; min-width:190px; padding:9px 12px; border:1px solid; border-radius:8px; background:rgba(8,20,48,.94); color:#c9d6ee; font-size:12.5px; line-height:1.75; box-shadow:0 6px 18px rgba(0,0,0,.5); white-space:nowrap; }
.flight-tip b { font-size:14px; }
.flight-tip strong { color:#fff; }
</style>
