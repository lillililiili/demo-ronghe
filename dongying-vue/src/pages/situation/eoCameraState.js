import { serverNow } from '../../services/serverClock.js';

const STATES = { IDLE: '空闲', STOPPED: '已停止跟踪', TURNING: '转向寻找中', TRACKING: '跟踪中', LOST: '目标丢失', UNKNOWN: '状态未知' };
const REASONS = {
  CAMERA_REPORT_MISSING: '尚未收到镜头朝向', CAMERA_REPORT_STALE: '镜头朝向已过期',
  CAMERA_REFERENCE_UNKNOWN: '镜头方向尚未校准', CAMERA_ANGLES_INVALID: '镜头角度无效'
};
const number = value => typeof value === 'number' && Number.isFinite(value);

/** Only the scoped device telemetry response supplies angles; target bearings never replace it. */
export function eoCameraState(device, raw, now = serverNow()) {
  const unknown = reason => ({ available: false, state: 'UNKNOWN', label: '朝向未知', reason, validUntil: 0 });
  if (!raw || raw.device_id !== device.deviceId) return unknown('尚未收到镜头朝向');
  if (raw.source_mode !== device.sourceMode || raw.simulated !== device.simulated) return unknown('镜头来源与设备不一致');
  if (device.status !== '在线') return unknown('光电当前不在线');
  if (raw.status !== 'READY') return unknown(REASONS[raw.reason] || '镜头朝向暂不可用');
  if (!number(raw.observed_at) || !number(raw.valid_until) || raw.observed_at > now + 2000 || raw.valid_until <= now
    || raw.valid_until <= raw.observed_at) return unknown('镜头朝向已过期或时间无效');
  const azimuth = raw.azimuth_deg, fov = raw.horizontal_fov_deg;
  if (!number(azimuth) || azimuth < 0 || azimuth >= 360 || !number(fov) || fov <= 0 || fov > 180) return unknown('镜头角度无效');
  const state = Object.hasOwn(STATES, raw.tracking_state) ? raw.tracking_state : 'UNKNOWN';
  return { available: true, state, label: STATES[state], reason: '', azimuth, fov,
    elevation: raw.elevation_deg, verticalFov: raw.vertical_fov_deg,
    observedAt: raw.observed_at, validUntil: raw.valid_until, taskId: raw.task_id, targetId: raw.target_id };
}

export function attachEoCameraStates(devices, reports, now = serverNow()) {
  const byId = new Map();
  for (const report of reports || []) {
    // Ambiguous duplicate identities must not win by array order.
    byId.set(report.device_id, byId.has(report.device_id) ? null : report);
  }
  return devices.map(device => device.typeCode !== 'EO' ? device
    : { ...device, eoView: eoCameraState(device, byId.get(device.deviceId), now) });
}

export function eoCameraText(view, now = serverNow()) {
  if (!view?.available || view.validUntil <= now) return view?.reason || '镜头朝向未知或已过期';
  return `${view.label} · 朝向 ${view.azimuth.toFixed(1)}° · 水平视场 ${view.fov.toFixed(1)}°`;
}
