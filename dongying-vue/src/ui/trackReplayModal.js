/* 告警页轨迹回放：用目标最新一条轨迹的可信 WGS-84 点在独立地图上走航线。
   不是视频，也不是飞行计划航线。点位不足两条就不打开。 */
import { h } from 'vue';
import { openModal } from './modal.js';
import { toast } from './nv.js';
import { targetApi } from '@/services/targetApi.js';
import { coordOf } from '@/services/positionMap.js';
import { ALARM_TYPE_LABEL, LEGALITY_LABEL, labelOf, readableNo, targetTypeLabel } from '@/ui/labels.js';
import TrackReplayModal from '@/components/modals/TrackReplayModal.vue';

let replaySeq = 0;

export function trackPointsOf(raw) {
  const points = [];
  for (const item of raw || []) {
    const c = coordOf(item.location);
    if (!c) continue;
    const kind = String(item.point_kind || item.kind || 'meas').toLowerCase();
    points.push({
      lon: c.lon,
      lat: c.lat,
      alt: item.altitude_amsl_m == null ? null : Number(item.altitude_amsl_m),
      t: item.sort_time,
      kind: kind === 'bridge' || kind === 'pred' ? kind : 'meas'
    });
  }
  return withHeadings(points);
}

function headingBetween(from, to) {
  const dLon = (to.lon - from.lon) * Math.PI / 180;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  if (x === 0 && y === 0) return null;
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function withHeadings(points) {
  let heading = 0;
  return points.map((point, i) => {
    const next = points[i + 1];
    if (next) {
      const h = headingBetween(point, next);
      if (h != null) heading = h;
    }
    return { ...point, heading };
  });
}

function clockOf(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function alarmMarkOf(alarm, points) {
  const start = points[0]?.t;
  const end = points[points.length - 1]?.t;
  const ts = alarm?.occurred_at ?? alarm?.received_at;
  if (ts == null || start == null || end == null || end <= start || ts < start || ts > end) return null;
  const type = ALARM_TYPE_LABEL[alarm.alarm_type] || alarm.alarm_type || '告警';
  return {
    pct: Math.max(0, Math.min(100, (ts - start) / (end - start) * 100)),
    title: `${type} ${clockOf(ts)}`
  };
}

function mapTargetOf(target, alarm) {
  const t = target || {};
  const ls = t.latest_state;
  const id = t.target_no || alarm?.target_no || t.target_id || alarm?.target_id || '目标';
  return {
    id,
    type: targetTypeLabel(null, t.object_type_code, '目标'),
    subtype: targetTypeLabel(t.subtype, t.object_type_code, '目标'),
    legal: t.legality_summary && t.legality_summary.legal_status
      ? labelOf(LEGALITY_LABEL, t.legality_summary.legal_status, t.legality_summary.legal_status) : '—',
    risk: t.risk_summary && t.risk_summary.severity ? String(t.risk_summary.severity) : '—',
    speed: ls && ls.speed_mps != null ? Number(ls.speed_mps) : null,
    tracked: true
  };
}

export async function openTrackReplay({ target, trackId, points, alarm } = {}) {
  const my = ++replaySeq;
  let pts = trackPointsOf(points);
  if (pts.length < 2 && trackId) {
    try {
      const page = await targetApi.pointsAll(trackId);
      if (my !== replaySeq) return;
      pts = trackPointsOf(page && page.items);
    } catch (error) {
      if (my !== replaySeq) return;
      return toast(error.message || '读取轨迹失败，无法回放', 'err');
    }
  }
  if (my !== replaySeq) return;
  if (pts.length < 2) return toast('没有足够的轨迹点，无法走航线回放', 'err');
  const mapTarget = mapTargetOf(target, alarm);
  const titleId = readableNo(mapTarget.id) || mapTarget.id;
  const mark = alarmMarkOf(alarm, pts);
  openModal({
    title: `轨迹回放 · ${titleId}`,
    width: '860px',
    footer: false,
    render: () => h(TrackReplayModal, {
      mapTarget,
      points: pts,
      alarmMark: mark,
      alarmText: mark ? mark.title : ''
    })
  });
}
