/* 轨迹回放播放器的纯计算：时间轴、当前点、推算地速、录像时段。
   不改写观测点，只读取已校验的 WGS-84 点（lon/lat/t/alt/kind/break_before）。 */

export const REPLAY_SPEEDS = [1, 2, 4, 8, 16];
/* 光电取证录像最长 1 分钟；时长读到之前按这个上限判断是否落在轨迹时段内。 */
export const MAX_VIDEO_MS = 60_000;

/** 观测时间齐全且不倒序、首末不同刻，才能按真实时间回放；否则只能逐点查看。 */
export function replayTiming(points = []) {
  const timed = points.length > 0 && points.every((p, i) => Number.isFinite(p.t) && (!i || p.t >= points[i - 1].t));
  const start = timed ? points[0].t : null;
  const end = timed ? points[points.length - 1].t : null;
  return { timed, canReplay: timed && points.length > 1 && end > start, start, end };
}

/** 时刻 → 不晚于该时刻的最后一个观测点下标。 */
export function indexAt(points, time) {
  if (!points.length) return 0;
  let low = 0, high = points.length - 1;
  if (!(time >= points[0].t)) return 0;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid].t <= time) low = mid;
    else high = mid - 1;
  }
  return low;
}

const R = 6371008.8;
export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad)
    - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  if (x === 0 && y === 0) return null;
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** 两点同属一段连续实测（未断开、同类型、时间前进）才可推算地速。 */
function joined(a, b) {
  return !!a && !!b && !b.break_before && (a.kind || 'meas') === (b.kind || 'meas')
    && Number.isFinite(a.t) && Number.isFinite(b.t) && b.t > a.t;
}

/**
 * 当前点的读数：设备上报的速度/航向优先；没有时用与前一观测点的距离和时间推算，并标明是推算。
 * 断点后的第一个点没有可用的前一点，速度显示未记录。
 */
export function pointReadout(points, index) {
  const point = points[index];
  if (!point) return null;
  const previous = points[index - 1];
  const next = points[index + 1];
  let speed = Number.isFinite(point.speed) ? point.speed : null;
  let speedDerived = false;
  if (speed == null && joined(previous, point)) {
    speed = distanceMeters(previous, point) / ((point.t - previous.t) / 1000);
    speedDerived = true;
  }
  let heading = Number.isFinite(point.heading) ? point.heading : null;
  if (heading == null) {
    if (joined(previous, point)) heading = bearingDegrees(previous, point);
    else if (joined(point, next)) heading = bearingDegrees(point, next);
  }
  return { point, speed, speedDerived, heading };
}

const COMPASS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
export function compassText(deg) {
  if (!Number.isFinite(deg)) return '未记录';
  return `${COMPASS[Math.round(deg / 45) % 8]} ${Math.round(deg)}°`;
}

/** 录像只取与轨迹时段可能重叠的（采集时刻在轨迹开始前 1 分钟内到轨迹结束之间），按采集时刻排序。 */
export function videosForSpan(videos = [], start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return videos.filter(v => Number.isFinite(v.capturedAt) && v.capturedAt <= end && v.capturedAt >= start - MAX_VIDEO_MS)
    .sort((a, b) => a.capturedAt - b.capturedAt);
}

/** 某时刻正在播放的录像：采集开始之后、时长之内；同时多段时取开始最晚的一段。 */
export function videoAt(videos, time, durations) {
  let found = null;
  for (const video of videos) {
    const duration = durations[video.id];
    const length = Number.isFinite(duration) && duration > 0 ? duration * 1000 : null;
    if (length == null) continue;
    if (time >= video.capturedAt && time < video.capturedAt + length) found = video;
  }
  return found;
}

/** 时间轴上的位置（0~100）。 */
export function pctOf(time, start, end) {
  if (!Number.isFinite(time) || !(end > start)) return 0;
  return Math.max(0, Math.min(100, (time - start) / (end - start) * 100));
}

/* 平台统一按北京时间显示，与证据、告警时间一致，不随浏览器所在时区变化。 */
const BEIJING = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function beijingParts(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return Object.fromEntries(BEIJING.formatToParts(d).map(part => [part.type, part.value]));
}

export function clockText(ms) {
  const p = beijingParts(ms);
  return p ? `${p.hour}:${p.minute}:${p.second}` : '—';
}

export function dateText(ms) {
  const p = beijingParts(ms);
  return p ? `${p.year}-${p.month}-${p.day}` : '—';
}

export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
